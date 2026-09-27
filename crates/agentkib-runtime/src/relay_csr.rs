//! This handler is wired only to the trusted local runtime stdio protocol.
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    private_key_der: String,
    hosts: Vec<String>,
}
pub(super) fn create(request: Request) -> Result<Value> {
    ensure!(request.private_key_der.len() <= 8192, "invalid-csr-key");
    let der = STANDARD
        .decode(&request.private_key_der)
        .map_err(|_| anyhow::anyhow!("invalid-csr-key"))?;
    let csr = agentkib_remote::create_csr(&der, request.hosts)?;
    let encoded = STANDARD.encode(csr);
    let mut pem = String::from("-----BEGIN CERTIFICATE REQUEST-----\n");
    for chunk in encoded.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk)?);
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE REQUEST-----\n");
    Ok(json!({"csrPem":pem}))
}
