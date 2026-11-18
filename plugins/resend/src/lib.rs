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
#[serde(rename_all = "camelCase")]
struct EmailInput {
    to: Vec<String>,
    subject: String,
    text: Option<String>,
    html: Option<String>,
    reply_to: Option<Vec<String>>,
}

#[derive(Serialize)]
struct ResendRequest<'a> {
    from: &'a str,
    to: &'a [String],
    subject: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    html: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_to: Option<&'a [String]>,
}

#[derive(Deserialize)]
struct ResendResponse {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmailOutput {
    external_id: String,
}

fn required_configuration(name: &str) -> Result<String, String> {
    braino::plugin::host::configuration(name)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("plugin configuration {name} is missing"))
}

fn send(input: EmailInput) -> Result<String, String> {
    if input.to.is_empty()
        || input.to.iter().any(|recipient| recipient.trim().is_empty())
        || input.subject.trim().is_empty()
        || (input.text.as_deref().is_none_or(str::is_empty)
            && input.html.as_deref().is_none_or(str::is_empty))
    {
        return Err("email input is invalid".to_string());
    }
    let sender = required_configuration("sender")?;
    let api_key = braino::plugin::host::secret("api_key")?;
    let body = serde_json::to_vec(&ResendRequest {
        from: &sender,
        to: &input.to,
        subject: &input.subject,
        text: input.text.as_deref(),
        html: input.html.as_deref(),
        reply_to: input.reply_to.as_deref(),
    })
    .map_err(|_| "email request could not be encoded".to_string())?;
    let response = braino::plugin::host::request(&braino::plugin::host::HttpRequest {
        method: "POST".to_string(),
        url: "https://api.resend.com/emails".to_string(),
        headers: alloc::vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("authorization".to_string(), format!("Bearer {api_key}")),
        ],
        body,
    })?;
    if !(200..300).contains(&response.status) {
        return Err(format!("Resend email request failed ({})", response.status));
    }
    let result: ResendResponse = serde_json::from_slice(&response.body)
        .map_err(|_| "Resend email response is invalid".to_string())?;
    if result.id.trim().is_empty() {
        return Err("Resend returned an empty email identifier".to_string());
    }
    serde_json::to_string(&EmailOutput {
        external_id: result.id,
    })
    .map_err(|_| "email response could not be encoded".to_string())
}

struct ResendPlugin;

impl Guest for ResendPlugin {
    fn invoke(capability: String, input_json: String) -> Result<String, String> {
        if capability != "email.send" {
            return Err("unsupported capability".to_string());
        }
        send(serde_json::from_str(&input_json).map_err(|_| "email input is invalid".to_string())?)
    }
}

export!(ResendPlugin);
