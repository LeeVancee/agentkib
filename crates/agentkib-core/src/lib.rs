use anyhow::Context;

mod changeset;
mod context;
mod doctor;
mod manifest;
mod model;
mod path_policy;
mod scanner;
mod skill;

pub use changeset::{ApplyOptions, apply_changeset, hash_content};
pub use context::{
    opencode_managed_config_path, opencode_managed_instruction_is_registered, resolve_context,
};
pub use doctor::{diagnose_workspace, diagnose_workspace_with_mcp_error};
pub use manifest::{load_manifest, manifest_path, validate_manifest};
pub use model::*;
pub use path_policy::{canonical_project, ensure_allowed_target};
pub use scanner::scan_workspace;
pub use skill::{SkillPackage, inspect_skill_entrypoint, is_readable_skill_file};

/// Encodes a value for use as exactly one URL path segment.
///
/// Workspace IDs are user-controlled manifest values, so they can contain route delimiters such
/// as `/`, `?`, and `#`. Keeping the encoding here ensures every local MCP URL addresses the same
/// workspace rather than changing the route structure.
pub fn encode_url_path_segment(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// Decodes a single URL path segment without treating an encoded slash as a route separator.
pub fn decode_url_path_segment(value: &str) -> anyhow::Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes
                .get(index + 1)
                .context("URL path segment contains an incomplete percent escape")?;
            let low = *bytes
                .get(index + 2)
                .context("URL path segment contains an incomplete percent escape")?;
            decoded.push((hex_digit(high)? << 4) | hex_digit(low)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).context("URL path segment is not valid UTF-8")
}

fn hex_digit(value: u8) -> anyhow::Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => anyhow::bail!("URL path segment contains an invalid percent escape"),
    }
}

pub fn validate_workspace(project: &std::path::Path) -> anyhow::Result<WorkspaceValidation> {
    let scan = scan_workspace(project)?;
    Ok(WorkspaceValidation {
        valid: scan.warnings.is_empty(),
        warnings: scan.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::{decode_url_path_segment, encode_url_path_segment};

    #[test]
    fn encodes_url_path_delimiters_and_utf8_bytes() {
        assert_eq!(
            encode_url_path_segment("team/project?tag#one two/中文"),
            "team%2Fproject%3Ftag%23one%20two%2F%E4%B8%AD%E6%96%87"
        );
        assert_eq!(
            encode_url_path_segment("team%2Fproject"),
            "team%252Fproject"
        );
    }

    #[test]
    fn decodes_only_complete_utf8_percent_escapes() {
        assert_eq!(
            decode_url_path_segment("team%2Fproject%3Ftag%23one%20two%2F%E4%B8%AD%E6%96%87")
                .unwrap(),
            "team/project?tag#one two/中文"
        );
        for invalid in ["team%", "team%2", "team%GG", "%FF"] {
            assert!(decode_url_path_segment(invalid).is_err(), "{invalid}");
        }
    }
}
