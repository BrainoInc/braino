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
use serde::Deserialize;
use serde_json::{Map, Value};
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

const SIGNATURE_TOLERANCE_SECONDS: i64 = 5 * 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventInput {
    body: String,
    headers: BTreeMap<String, String>,
    received_at: i64,
}

#[derive(Deserialize)]
struct GatewayEvents {
    events: Vec<Value>,
}

fn configuration(name: &str) -> Result<String, String> {
    braino::plugin::host::configuration(name)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("plugin configuration {name} is missing"))
}

fn gateway_request(body: Vec<u8>) -> Result<String, String> {
    let gateway = configuration("gateway_url")?;
    let installation = configuration("installation_id")?;
    let secret = braino::plugin::host::secret("gateway_secret")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "gateway credential is invalid".to_string())?;
    mac.update(&body);
    let signature = encode_hex(&mac.finalize().into_bytes());
    let response = braino::plugin::host::request(&braino::plugin::host::HttpRequest {
        method: "POST".to_string(),
        url: format!(
            "{}/v1/installations/{installation}/github",
            gateway.trim_end_matches('/')
        ),
        headers: alloc::vec![
            ("content-type".to_string(), "application/json".to_string()),
            (
                "x-braino-gateway-signature".to_string(),
                format!("v0={signature}")
            )
        ],
        body,
    })?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Braino plugin gateway rejected the request ({})",
            response.status
        ));
    }
    String::from_utf8(response.body)
        .map_err(|_| "gateway response is not UTF-8".to_string())
}

fn action(input_json: &str, action: &str) -> Result<String, String> {
    let mut value: Map<String, Value> = serde_json::from_str(input_json)
        .map_err(|_| "GitHub action input is invalid".to_string())?;
    value.insert("action".to_string(), Value::String(action.to_string()));
    let body = serde_json::to_vec(&value)
        .map_err(|_| "GitHub action could not be encoded".to_string())?;
    gateway_request(body)
}

fn verify_delivery(input: &EventInput) -> Result<(), String> {
    let installation = configuration("installation_id")?;
    if input.headers.get("x-braino-gateway-installation") != Some(&installation) {
        return Err("gateway installation does not match".to_string());
    }
    let timestamp = input
        .headers
        .get("x-braino-gateway-timestamp")
        .ok_or_else(|| "gateway timestamp is missing".to_string())?;
    let timestamp_number = timestamp
        .parse::<i64>()
        .map_err(|_| "gateway timestamp is invalid".to_string())?;
    if (input.received_at - timestamp_number).abs() > SIGNATURE_TOLERANCE_SECONDS {
        return Err("gateway timestamp is stale".to_string());
    }
    let supplied = input
        .headers
        .get("x-braino-gateway-signature")
        .and_then(|value| value.strip_prefix("v0="))
        .and_then(decode_hex)
        .ok_or_else(|| "gateway signature is invalid".to_string())?;
    let secret = braino::plugin::host::secret("gateway_secret")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "gateway credential is invalid".to_string())?;
    mac.update(format!("v0:{timestamp}:{}", input.body).as_bytes());
    mac.verify_slice(&supplied)
        .map_err(|_| "gateway signature is invalid".to_string())
}

fn receive(input: EventInput) -> Result<String, String> {
    verify_delivery(&input)?;
    let envelope: GatewayEvents = serde_json::from_str(&input.body)
        .map_err(|_| "gateway event body is invalid".to_string())?;
    serde_json::to_string(&envelope.events)
        .map_err(|_| "gateway events could not be encoded".to_string())
}

fn encode_hex(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value {
        encoded.push(char::from(HEX[(byte >> 4) as usize]));
        encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    encoded
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

struct GithubPlugin;

impl Guest for GithubPlugin {
    fn invoke(capability: String, input_json: String) -> Result<String, String> {
        match capability.as_str() {
            "event.receive" => receive(
                serde_json::from_str(&input_json)
                    .map_err(|_| "event input is invalid".to_string())?,
            ),
            "scm.request" => action(&input_json, "request"),
            "scm.check.publish" => action(&input_json, "check.publish"),
            "scm.ruleset.reconcile" => action(&input_json, "ruleset.reconcile"),
            _ => Err("unsupported capability".to_string()),
        }
    }
}

export!(GithubPlugin);
