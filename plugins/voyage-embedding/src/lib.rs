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
struct EmbeddingInput {
    inputs: Vec<String>,
    input_type: Option<String>,
}

#[derive(Serialize)]
struct VoyageRequest<'a> {
    model: &'a str,
    input: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    input_type: Option<&'a str>,
}

#[derive(Deserialize)]
struct EmbeddingDatum {
    index: usize,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct VoyageResponse {
    data: Vec<EmbeddingDatum>,
}

#[derive(Serialize)]
struct EmbeddingOutput {
    model: String,
    dimensions: usize,
    vectors: Vec<Vec<f32>>,
}

struct VoyageEmbeddingPlugin;

impl Guest for VoyageEmbeddingPlugin {
    fn invoke(capability: String, input_json: String) -> Result<String, String> {
        if capability != "embedding.embed" {
            return Err("unsupported capability".to_string());
        }
        let input: EmbeddingInput = serde_json::from_str(&input_json)
            .map_err(|_| "embedding input is invalid".to_string())?;
        if input.inputs.is_empty() || input.inputs.iter().any(|value| value.trim().is_empty()) {
            return Err("embedding input is empty".to_string());
        }
        if input
            .input_type
            .as_deref()
            .is_some_and(|value| !matches!(value, "document" | "query"))
        {
            return Err("embedding input type is invalid".to_string());
        }
        let model = braino::plugin::host::configuration("model")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "voyage-4".to_string());
        let api_key = braino::plugin::host::secret("api_key")?;
        let body = serde_json::to_vec(&VoyageRequest {
            model: &model,
            input: &input.inputs,
            input_type: input.input_type.as_deref(),
        })
        .map_err(|_| "embedding request could not be encoded".to_string())?;
        let response = braino::plugin::host::request(&braino::plugin::host::HttpRequest {
            method: "POST".to_string(),
            url: "https://api.voyageai.com/v1/embeddings".to_string(),
            headers: alloc::vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("authorization".to_string(), format!("Bearer {api_key}")),
            ],
            body,
        })?;
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "Voyage embedding request failed ({})",
                response.status
            ));
        }
        let mut result: VoyageResponse = serde_json::from_slice(&response.body)
            .map_err(|_| "Voyage embedding response is invalid".to_string())?;
        result.data.sort_by_key(|item| item.index);
        let dimensions = result
            .data
            .first()
            .map(|item| item.embedding.len())
            .unwrap_or(0);
        if dimensions == 0
            || result.data.len() != input.inputs.len()
            || result
                .data
                .iter()
                .any(|item| item.embedding.len() != dimensions)
        {
            return Err("Voyage returned unexpected embedding dimensions".to_string());
        }
        serde_json::to_string(&EmbeddingOutput {
            model: format!("voyage:{model}"),
            dimensions,
            vectors: result.data.into_iter().map(|item| item.embedding).collect(),
        })
        .map_err(|_| "embedding response could not be encoded".to_string())
    }
}

export!(VoyageEmbeddingPlugin);
