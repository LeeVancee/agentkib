//! Experimental, opt-in follower of an existing Codex client. Never starts Codex.
//! Used by the opt-in runtime Web facade and the local compatibility probe.

#[cfg(target_os = "macos")]
mod transport;
#[cfg(target_os = "macos")]
pub use transport::Connection;
mod native_requests;
mod state;
pub use native_requests::{
    native_approval_options, project_native_questions, validate_native_answers,
    validate_native_approval,
};
pub use state::{Approval, Decision, SessionState, Status};
mod compatibility;
pub use compatibility::Compatibility;
#[cfg(target_os = "macos")]
mod bridge;
#[cfg(target_os = "macos")]
pub use bridge::Bridge;

#[cfg(test)]
mod state_tests;
#[cfg(test)]
mod transport_tests;

pub const CLIENT_TYPE: &str = "agentkib-codex-bridge";
/// Minimum Desktop build eligible for the basic follower protocol.
pub const DESKTOP_VERSION: &str = "26.917.62051";
/// Minimum Desktop build eligible for the thread-settings v2 protocol.
pub const DESKTOP_VERSION_CURRENT: &str = "26.924.22138";
pub const EXTENSION_VERSION: &str = "26.908.40401";

pub fn validate_send_text(text: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !text.trim().is_empty() && text.len() <= 16 * 1024,
        "text must be 1–16384 bytes"
    );
    Ok(())
}

/// These are per-method versions, not the unrelated App Server protocol version.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn method_version(method: &str) -> Option<u64> {
    match method {
        "initialize" => Some(0),
        "thread-owner-discovery"
        | "thread-stream-following-changed"
        | "thread-stream-following-status-requested"
        | "client-status-changed"
        | "ipc-connection-reset"
        | "thread-follower-command-approval-decision"
        | "thread-follower-submit-user-input"
        | "thread-follower-file-approval-decision" => Some(1),
        "thread-follower-update-thread-settings" => Some(2),
        "thread-follower-start-turn" => Some(2),
        "thread-follower-interrupt-turn" => Some(4),
        "thread-stream-state-changed" => Some(11),
        _ => None,
    }
}
