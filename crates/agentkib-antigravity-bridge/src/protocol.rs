use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CONTROL_AGENT_NAME, CONTROL_AGENT_VERSION, Error, PROTOCOL_VERSION, Result};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(i64),
    String(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Negotiated capabilities, not a claim about CLI/IDE storage interoperability.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Compatibility {
    pub load_session: bool,
    pub list_sessions: bool,
    pub resume_session: bool,
}

impl Compatibility {
    pub fn from_initialize(value: &Value) -> Result<Self> {
        if value.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            return Err(Error::Unsupported("protocol version (requires ACP v1)"));
        }
        let caps = value
            .get("agentCapabilities")
            .filter(|v| v.is_object())
            .ok_or(Error::Protocol("missing agentCapabilities"))?;
        Ok(Self {
            load_session: caps.get("loadSession").and_then(Value::as_bool) == Some(true),
            list_sessions: caps
                .pointer("/sessionCapabilities/list")
                .is_some_and(Value::is_object),
            resume_session: caps
                .pointer("/sessionCapabilities/resume")
                .is_some_and(Value::is_object),
        })
    }

    /// Mutating control is only enabled for the exact server build that was
    /// exercised by AgentKib. New server builds remain available to read-only
    /// discovery, but must be reviewed before they can execute prompts.
    pub fn verify_control_identity(value: &Value) -> Result<()> {
        if value.pointer("/agentInfo/name").and_then(Value::as_str) != Some(CONTROL_AGENT_NAME) {
            return Err(Error::Unsupported(
                "unverified Antigravity ACP server identity",
            ));
        }
        if value.pointer("/agentInfo/version").and_then(Value::as_str)
            != Some(CONTROL_AGENT_VERSION)
        {
            return Err(Error::Unsupported(
                "unverified Antigravity ACP server version",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    // Preserve future kinds for display; never infer authorization from this hint.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub session_id: String,
    pub tool_call: Value,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone)]
pub enum Event {
    Response {
        id: RpcId,
        method: String,
        result: std::result::Result<Value, RpcError>,
    },
    SessionUpdate {
        session_id: String,
        update: Value,
    },
    Permission {
        id: RpcId,
        request: PermissionRequest,
    },
    /// Includes late requests automatically cancelled after `cancel()`.
    PermissionCancelled {
        id: RpcId,
        session_id: String,
    },
    /// Unknown server requests are rejected with -32601, never executed.
    UnsupportedRequest {
        id: RpcId,
        method: String,
    },
    Notification {
        method: String,
        params: Value,
    },
}
