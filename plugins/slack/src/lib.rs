#![no_std]

extern crate alloc;

use alloc::{
    alloc::{alloc, handle_alloc_error, realloc, Layout},
    collections::BTreeMap,
    format,
    string::{String, ToString},
    vec::Vec,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}

#[unsafe(no_mangle)]
unsafe extern "C" fn memcmp(
    left: *const core::ffi::c_void,
    right: *const core::ffi::c_void,
    length: usize,
) -> i32 {
    let left = left.cast::<u8>();
    let right = right.cast::<u8>();
    for index in 0..length {
        let difference = i32::from(*left.add(index)) - i32::from(*right.add(index));
        if difference != 0 {
            return difference;
        }
    }
    0
}

#[unsafe(export_name = "cabi_realloc")]
unsafe extern "C" fn component_realloc(
    old_ptr: *mut u8,
    old_len: usize,
    align: usize,
    new_len: usize,
) -> *mut u8 {
    let layout = Layout::from_size_align_unchecked(old_len, align);
    let pointer = if old_len == 0 {
        alloc(Layout::from_size_align_unchecked(new_len, align))
    } else {
        realloc(old_ptr, layout, new_len)
    };
    if pointer.is_null() {
        handle_alloc_error(Layout::from_size_align_unchecked(new_len, align));
    }
    pointer
}

wit_bindgen::generate!({ world: "plugin", path: "../../packages/plugin-runtime/wit" });

use exports::braino::plugin::handler::Guest;

const SLACK_API: &str = "https://slack.com/api";
const SIGNATURE_TOLERANCE_SECONDS: i64 = 5 * 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectInput {
    installer: Option<Installer>,
    introduction_channel: Option<String>,
}

#[derive(Deserialize)]
struct Installer {
    email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventInput {
    body: String,
    headers: BTreeMap<String, String>,
    received_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendInput {
    target: SendTarget,
    text: String,
    thread_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct SendTarget {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
struct AuthResponse {
    ok: bool,
    error: Option<String>,
    team_id: Option<String>,
    team: Option<String>,
    user_id: Option<String>,
}

#[derive(Deserialize)]
struct ChannelsResponse {
    ok: bool,
    error: Option<String>,
    channels: Option<Vec<SlackChannel>>,
}

#[derive(Deserialize)]
struct JoinResponse {
    ok: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
struct SlackChannel {
    id: Option<String>,
    name: Option<String>,
    is_archived: Option<bool>,
}

#[derive(Deserialize)]
struct UserLookupResponse {
    ok: bool,
    user: Option<SlackUser>,
}

#[derive(Deserialize)]
struct SlackUser {
    id: Option<String>,
    profile: Option<SlackProfile>,
}

#[derive(Deserialize)]
struct SlackProfile {
    email: Option<String>,
}

#[derive(Deserialize)]
struct PostMessageResponse {
    ok: bool,
    error: Option<String>,
    ts: Option<String>,
}

#[derive(Deserialize)]
struct EventEnvelope {
    #[serde(rename = "type")]
    kind: String,
    challenge: Option<String>,
    event_id: Option<String>,
    event_time: Option<i64>,
    event: Option<SlackEvent>,
}

#[derive(Deserialize)]
struct SlackEvent {
    #[serde(rename = "type")]
    kind: String,
    channel: Option<String>,
    channel_type: Option<String>,
    user: Option<String>,
    text: Option<String>,
    ts: Option<String>,
    thread_ts: Option<String>,
    bot_id: Option<String>,
    subtype: Option<String>,
    tokens: Option<RevokedTokens>,
}

#[derive(Deserialize)]
struct RevokedTokens {
    bot: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectOutput {
    external_workspace_id: String,
    workspace_name: String,
    bot_user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    installer_user_id: Option<String>,
    channels: Vec<ChannelOutput>,
}

#[derive(Serialize)]
struct ChannelOutput {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginEvent {
    id: String,
    occurred_at: String,
    kind: String,
    data: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendOutput {
    external_id: String,
}

fn request(method: &str, path: &str, body: Vec<u8>) -> Result<Vec<u8>, String> {
    let token = braino::plugin::host::secret("bot_token")?;
    let response = braino::plugin::host::request(&braino::plugin::host::HttpRequest {
        method: method.to_string(),
        url: format!("{SLACK_API}/{path}"),
        headers: alloc::vec![
            ("authorization".to_string(), format!("Bearer {token}")),
            (
                "content-type".to_string(),
                "application/json; charset=utf-8".to_string()
            ),
        ],
        body,
    })?;
    if !(200..300).contains(&response.status) {
        return Err(format!("Slack request failed ({})", response.status));
    }
    Ok(response.body)
}

fn slack_error(error: Option<String>) -> String {
    format!(
        "Slack rejected the request ({})",
        error.unwrap_or_else(|| "unknown_error".to_string())
    )
}

fn connect(input: ConnectInput) -> Result<String, String> {
    let preferred_channel = input.introduction_channel;
    let auth: AuthResponse = serde_json::from_slice(&request("POST", "auth.test", Vec::new())?)
        .map_err(|_| "Slack auth response is invalid".to_string())?;
    if !auth.ok {
        return Err(slack_error(auth.error));
    }
    let channels: ChannelsResponse = serde_json::from_slice(&request(
        "GET",
        "conversations.list?exclude_archived=true&limit=200&types=public_channel",
        Vec::new(),
    )?)
    .map_err(|_| "Slack channel response is invalid".to_string())?;
    if !channels.ok {
        return Err(slack_error(channels.error));
    }
    let installer_user_id = match input.installer.and_then(|value| value.email) {
        Some(email) if !email.trim().is_empty() => {
            let encoded = percent_encode(email.trim());
            let response: UserLookupResponse = serde_json::from_slice(&request(
                "GET",
                &format!("users.lookupByEmail?email={encoded}"),
                Vec::new(),
            )?)
            .map_err(|_| "Slack user response is invalid".to_string())?;
            if response.ok {
                response.user.and_then(|user| user.id)
            } else {
                None
            }
        }
        _ => None,
    };
    let channels: Vec<ChannelOutput> = channels
        .channels
        .unwrap_or_default()
        .into_iter()
        .filter(|channel| channel.is_archived != Some(true))
        .filter_map(|channel| {
            Some(ChannelOutput {
                id: channel.id?,
                name: channel.name?,
            })
        })
        .collect();
    if let Some(channel) = preferred_channel
        .as_deref()
        .map(|value| value.trim().trim_start_matches('#'))
        .filter(|value| !value.is_empty())
        .and_then(|name| channels.iter().find(|channel| channel.name == name))
    {
        let body = serde_json::to_vec(&serde_json::json!({ "channel": channel.id }))
            .map_err(|_| "Slack channel join could not be encoded".to_string())?;
        let joined: JoinResponse =
            serde_json::from_slice(&request("POST", "conversations.join", body)?)
                .map_err(|_| "Slack channel join response is invalid".to_string())?;
        if !joined.ok {
            return Err(slack_error(joined.error));
        }
    }
    let output = ConnectOutput {
        external_workspace_id: auth
            .team_id
            .ok_or_else(|| "Slack auth response has no workspace id".to_string())?,
        workspace_name: auth
            .team
            .ok_or_else(|| "Slack auth response has no workspace name".to_string())?,
        bot_user_id: auth
            .user_id
            .ok_or_else(|| "Slack auth response has no bot user id".to_string())?,
        installer_user_id,
        channels,
    };
    serde_json::to_string(&output).map_err(|_| "Slack connection could not be encoded".to_string())
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

fn verify_signature(input: &EventInput) -> Result<(), String> {
    let timestamp = input
        .headers
        .get("x-slack-request-timestamp")
        .ok_or_else(|| "Slack request timestamp is missing".to_string())?;
    let timestamp_number = timestamp
        .parse::<i64>()
        .map_err(|_| "Slack request timestamp is invalid".to_string())?;
    if (input.received_at - timestamp_number).abs() > SIGNATURE_TOLERANCE_SECONDS {
        return Err("Slack request timestamp is stale".to_string());
    }
    let signature = input
        .headers
        .get("x-slack-signature")
        .and_then(|value| value.strip_prefix("v0="))
        .ok_or_else(|| "Slack request signature is missing".to_string())?;
    let signature =
        decode_hex(signature).ok_or_else(|| "Slack request signature is invalid".to_string())?;
    let secret = braino::plugin::host::secret("signing_secret")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "Slack signing secret is invalid".to_string())?;
    mac.update(format!("v0:{timestamp}:{}", input.body).as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| "Slack request signature is invalid".to_string())
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| Some((hex_digit(pair[0])? << 4) | hex_digit(pair[1])?))
        .collect()
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn receive(input: EventInput) -> Result<String, String> {
    verify_signature(&input)?;
    let envelope: EventEnvelope =
        serde_json::from_str(&input.body).map_err(|_| "Slack event body is invalid".to_string())?;
    let occurred_at = envelope.event_time.unwrap_or(input.received_at).to_string();
    if envelope.kind == "url_verification" {
        let challenge = envelope
            .challenge
            .ok_or_else(|| "Slack verification challenge is missing".to_string())?;
        return serde_json::to_string(&alloc::vec![PluginEvent {
            id: format!("challenge:{challenge}"),
            occurred_at,
            kind: "webhook.challenge".to_string(),
            data: serde_json::json!({ "challenge": challenge }),
        }])
        .map_err(|_| "Slack event could not be encoded".to_string());
    }
    if envelope.kind != "event_callback" {
        return Ok("[]".to_string());
    }
    let event = match envelope.event {
        Some(event) => event,
        None => return Ok("[]".to_string()),
    };
    let id = envelope
        .event_id
        .or_else(|| event.ts.clone())
        .ok_or_else(|| "Slack event id is missing".to_string())?;
    if event.kind == "app_uninstalled"
        || (event.kind == "tokens_revoked"
            && event
                .tokens
                .and_then(|tokens| tokens.bot)
                .is_some_and(|tokens| !tokens.is_empty()))
    {
        return serde_json::to_string(&alloc::vec![PluginEvent {
            id,
            occurred_at,
            kind: "team_chat.uninstalled".to_string(),
            data: serde_json::json!({}),
        }])
        .map_err(|_| "Slack event could not be encoded".to_string());
    }
    if event.bot_id.is_some() || event.subtype.is_some() {
        return Ok("[]".to_string());
    }
    let direct = event.kind == "message" && event.channel_type.as_deref() == Some("im");
    if event.kind != "app_mention" && !direct {
        return Ok("[]".to_string());
    }
    let channel_id = event
        .channel
        .ok_or_else(|| "Slack event channel is missing".to_string())?;
    let sender_id = event
        .user
        .ok_or_else(|| "Slack event user is missing".to_string())?;
    let sender: UserLookupResponse = serde_json::from_slice(&request(
        "GET",
        &format!("users.info?user={}", percent_encode(&sender_id)),
        Vec::new(),
    )?)
    .map_err(|_| "Slack user response is invalid".to_string())?;
    let sender_email = sender
        .user
        .and_then(|user| user.profile)
        .and_then(|profile| profile.email)
        .filter(|email| !email.trim().is_empty())
        .ok_or_else(|| "Slack sender has no email".to_string())?;
    let text = event
        .text
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "Slack event text is missing".to_string())?;
    let message_id = event
        .ts
        .ok_or_else(|| "Slack event message id is missing".to_string())?;
    let reply_thread_id = if direct {
        event.thread_ts
    } else {
        Some(event.thread_ts.unwrap_or_else(|| message_id.clone()))
    };
    serde_json::to_string(&alloc::vec![PluginEvent {
        id,
        occurred_at,
        kind: "team_chat.message".to_string(),
        data: serde_json::json!({
            "channelId": channel_id,
            "senderId": sender_id,
            "senderEmail": sender_email,
            "text": text,
            "messageId": message_id,
            "replyThreadId": reply_thread_id,
            "direct": direct
        }),
    }])
    .map_err(|_| "Slack event could not be encoded".to_string())
}

fn send(input: SendInput) -> Result<String, String> {
    if input.target.kind != "channel" && input.target.kind != "user" {
        return Err("team chat target is invalid".to_string());
    }
    if input.text.trim().is_empty() {
        return Err("team chat text is empty".to_string());
    }
    let body = serde_json::to_vec(&serde_json::json!({
        "channel": input.target.id,
        "text": input.text,
        "thread_ts": input.thread_id
    }))
    .map_err(|_| "Slack message could not be encoded".to_string())?;
    let response: PostMessageResponse =
        serde_json::from_slice(&request("POST", "chat.postMessage", body)?)
            .map_err(|_| "Slack message response is invalid".to_string())?;
    if !response.ok {
        return Err(slack_error(response.error));
    }
    let output = SendOutput {
        external_id: response
            .ts
            .ok_or_else(|| "Slack response has no message id".to_string())?,
    };
    serde_json::to_string(&output)
        .map_err(|_| "Slack message response could not be encoded".to_string())
}

struct SlackPlugin;

impl Guest for SlackPlugin {
    fn invoke(capability: String, input_json: String) -> Result<String, String> {
        match capability.as_str() {
            "team_chat.connect" => connect(
                serde_json::from_str(&input_json)
                    .map_err(|_| "team chat connect input is invalid".to_string())?,
            ),
            "event.receive" => receive(
                serde_json::from_str(&input_json)
                    .map_err(|_| "event input is invalid".to_string())?,
            ),
            "team_chat.send" => send(
                serde_json::from_str(&input_json)
                    .map_err(|_| "team chat send input is invalid".to_string())?,
            ),
            _ => Err("unsupported capability".to_string()),
        }
    }
}

export!(SlackPlugin);
