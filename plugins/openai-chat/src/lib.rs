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

#[derive(Deserialize, Serialize)]
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
struct JsonSchema<'a> {
    name: &'static str,
    strict: bool,
    schema: &'a serde_json::Value,
}

#[derive(Serialize)]
struct ResponseFormat<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    json_schema: JsonSchema<'a>,
}

#[derive(Serialize)]
struct OpenAiRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat<'a>>,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    model: String,
    choices: Vec<OpenAiChoice>,
}

#[derive(Serialize)]
struct ChatOutput {
    content: String,
    model: String,
}

struct OpenAiChatPlugin;

impl Guest for OpenAiChatPlugin {
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
            .unwrap_or_else(|| "gpt-4.1-mini".to_string());
        let api_key = braino::plugin::host::secret("api_key")?;
        let response_format = input.response_schema.as_ref().map(|schema| ResponseFormat {
            kind: "json_schema",
            json_schema: JsonSchema {
                name: "braino_response",
                strict: true,
                schema,
            },
        });
        let body = serde_json::to_vec(&OpenAiRequest {
            model: &model,
            messages: &input.messages,
            response_format,
        })
        .map_err(|_| "chat request could not be encoded".to_string())?;
        let response = braino::plugin::host::request(&braino::plugin::host::HttpRequest {
            method: "POST".to_string(),
            url: "https://api.openai.com/v1/chat/completions".to_string(),
            headers: alloc::vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("authorization".to_string(), format!("Bearer {api_key}")),
            ],
            body,
        })?;
        if !(200..300).contains(&response.status) {
            return Err(format!("OpenAI chat request failed ({})", response.status));
        }
        let result: OpenAiResponse = serde_json::from_slice(&response.body)
            .map_err(|_| "OpenAI chat response is invalid".to_string())?;
        let content = result
            .choices
            .into_iter()
            .next()
            .and_then(|choice| choice.message.content)
            .filter(|content| !content.trim().is_empty())
            .ok_or_else(|| "OpenAI returned an empty chat response".to_string())?;
        serde_json::to_string(&ChatOutput {
            content,
            model: format!("openai:{}", result.model),
        })
        .map_err(|_| "chat response could not be encoded".to_string())
    }
}

export!(OpenAiChatPlugin);
