#![no_std]

extern crate alloc;

use alloc::{
    alloc::{alloc, handle_alloc_error, realloc, Layout},
    format,
    string::{String, ToString},
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
    messages: alloc::vec::Vec<ChatMessage>,
    response_schema: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct OllamaRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    think: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'a serde_json::Value>,
}

#[derive(Deserialize)]
struct OllamaResponse {
    model: String,
    message: ChatMessage,
}

#[derive(Serialize)]
struct ChatOutput {
    content: String,
    model: String,
}

struct OllamaChatPlugin;

impl Guest for OllamaChatPlugin {
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
            .unwrap_or_else(|| "qwen3.5:2b".to_string());
        let body = serde_json::to_vec(&OllamaRequest {
            model: &model,
            messages: &input.messages,
            stream: false,
            think: false,
            format: input.response_schema.as_ref(),
        })
        .map_err(|_| "chat request could not be encoded".to_string())?;
        let response = braino::plugin::host::request(&braino::plugin::host::HttpRequest {
            method: "POST".to_string(),
            url: "http://ollama:11434/api/chat".to_string(),
            headers: alloc::vec![("content-type".to_string(), "application/json".to_string())],
            body,
        })?;
        if !(200..300).contains(&response.status) {
            return Err(format!("Ollama chat request failed ({})", response.status));
        }
        let result: OllamaResponse = serde_json::from_slice(&response.body)
            .map_err(|_| "Ollama chat response is invalid".to_string())?;
        if result.message.content.trim().is_empty() {
            return Err("Ollama returned an empty chat response".to_string());
        }
        serde_json::to_string(&ChatOutput {
            content: result.message.content,
            model: format!("ollama:{}", result.model),
        })
        .map_err(|_| "chat response could not be encoded".to_string())
    }
}

export!(OllamaChatPlugin);
