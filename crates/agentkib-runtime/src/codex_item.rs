//! Native item vocabulary shared by the managed and follower projections.
use serde_json::Value;

pub(crate) fn item_kind(item: &Value) -> Option<&'static str> {
    match item["type"].as_str() {
        Some("agentMessage" | "plan") => Some("agent-message"),
        Some("userMessage") => Some("user-message"),
        Some("commandExecution" | "fileChange" | "mcpToolCall" | "webSearch") => {
            Some("tool-summary")
        }
        _ => None,
    }
}

pub(crate) fn content_parts_text(item: &Value) -> String {
    item["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}
