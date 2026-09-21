//! ACP v1 client for the separately distributed official Antigravity ACP server.
//!
//! This does not connect to an IDE's private endpoints or import foreign history.
//! Requests return IDs immediately; callers keep pumping `Client::next_event`,
//! including while a prompt is running, so permission requests cannot deadlock.

mod blocking;
mod client;
mod protocol;

pub use blocking::BlockingClient;
pub use client::{Client, StdioClient};
pub use protocol::{Compatibility, Event, PermissionOption, PermissionRequest, RpcError, RpcId};

pub const PROTOCOL_VERSION: u64 = 1;
pub const CONTROL_AGENT_NAME: &str = "antigravity-acp";
pub const CONTROL_AGENT_VERSION: &str = "agy_acp_server_1.1.1";
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_PROMPT_BYTES: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ACP I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid ACP JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("ACP protocol error: {0}")]
    Protocol(&'static str),
    #[error("ACP capability is not supported: {0}")]
    Unsupported(&'static str),
    #[error("invalid ACP request: {0}")]
    Invalid(&'static str),
    #[error("ACP connection is closed or unusable")]
    Closed,
    #[error("ACP operation timed out; completion is unknown and the client must be closed")]
    Timeout,
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests;
