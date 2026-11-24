#![no_std]

extern crate alloc;

use alloc::{
    alloc::{alloc, handle_alloc_error, realloc, Layout},
    format,
    string::{String, ToString},
    vec::Vec,
};
use serde::{Deserialize, Serialize};

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

#[derive(Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatInput {
    messages: Vec<ChatMessage>,
    response_schema: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: usize,
    messages: &'a [AnthropicMessage],
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicContent {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    model: String,
    content: Vec<AnthropicContent>,
}

#[derive(Serialize)]
struct ChatOutput {
    content: String,
    model: String,
}

struct AnthropicChatPlugin;

impl Guest for AnthropicChatPlugin {
    fn invoke(capability: String, input_json: String) -> Result<String, String> {
        if capability != "chat.complete" {
            return Err("unsupported capability".to_string());
        }
        let input: ChatInput =
            serde_json::from_str(&input_json).map_err(|_| "chat input is invalid".to_string())?;
        if input.messages.is_empty()
            || input.messages.iter().any(|message| {
                !matches!(
                    message.role.as_str(),
                    "system" | "user" | "assistant" | "tool"
                ) || message.content.trim().is_empty()
            })
        {
            return Err("chat messages are invalid".to_string());
        }

        let model = braino::plugin::host::configuration("model")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "claude-sonnet-4-6".to_string());
        let api_key = braino::plugin::host::secret("api_key")?;
        let mut system = input
            .messages
            .iter()
            .filter(|message| message.role == "system")
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        if let Some(schema) = input.response_schema {
            let encoded = serde_json::to_string(&schema)
                .map_err(|_| "response schema could not be encoded".to_string())?;
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str("Return only JSON matching this schema: ");
            system.push_str(&encoded);
        }
        let messages = input
            .messages
            .into_iter()
            .filter(|message| message.role != "system")
            .map(|message| AnthropicMessage {
                role: if message.role == "assistant" {
                    "assistant".to_string()
                } else {
                    "user".to_string()
                },
                content: message.content,
            })
            .collect::<Vec<_>>();
        if messages.is_empty() {
            return Err("chat messages are invalid".to_string());
        }
        let body = serde_json::to_vec(&AnthropicRequest {
            model: &model,
            max_tokens: 4096,
            messages: &messages,
            system: if system.is_empty() {
                None
            } else {
                Some(system)
            },
        })
        .map_err(|_| "chat request could not be encoded".to_string())?;
        let response = braino::plugin::host::request(&braino::plugin::host::HttpRequest {
            method: "POST".to_string(),
            url: "https://api.anthropic.com/v1/messages".to_string(),
            headers: alloc::vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("x-api-key".to_string(), api_key),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ],
            body,
        })?;
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "Anthropic chat request failed ({})",
                response.status
            ));
        }
        let result: AnthropicResponse = serde_json::from_slice(&response.body)
            .map_err(|_| "Anthropic chat response is invalid".to_string())?;
        let content = result
            .content
            .into_iter()
            .filter(|block| block.kind == "text")
            .filter_map(|block| block.text)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        if content.is_empty() {
            return Err("Anthropic returned an empty chat response".to_string());
        }
        serde_json::to_string(&ChatOutput {
            content,
            model: format!("anthropic:{}", result.model),
        })
        .map_err(|_| "chat response could not be encoded".to_string())
    }
}

export!(AnthropicChatPlugin);
