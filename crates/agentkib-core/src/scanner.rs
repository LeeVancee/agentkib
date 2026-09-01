use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::Result;
use walkdir::WalkDir;

use crate::manifest::manifest_entry_exists;
use crate::{AgentDetection, AgentKind, AssetKind, AssetRecord, WorkspaceScan, canonical_project};

const MAX_NATIVE_CONFIG_BYTES: u64 = 1024 * 1024;

pub fn scan_workspace(project: &Path) -> Result<WorkspaceScan> {
    let root = canonical_project(project)?;
    let mut assets = Vec::new();
    let mut validation_warnings = Vec::new();

    for agent in AgentKind::ALL {
        for (path, kind, summary) in candidates(agent) {
            let absolute = root.join(path);
            if absolute.is_file() {
                assets.push(record(agent, kind, absolute, summary)?);
                if let Some(warning) = validate_native_config(&root.join(path)) {
                    validation_warnings.push((agent, warning));
                }
            } else if absolute.is_dir() {
                for entry in WalkDir::new(&absolute)
                    .max_depth(4)
                    .into_iter()
                    .filter_entry(|entry| agentkib_platform::path::is_safe_scan_entry(entry.path()))
                    .filter_map(|entry| entry.ok())
                {
                    if entry.file_type().is_file() {
                        let entry_path = entry.into_path();
                        if is_asset(agent, path, &entry_path) {
                            assets.push(record(agent, kind, entry_path, summary)?);
                        }
                    }
                }
            }
        }
    }

    assets.sort_by(|a, b| a.path.cmp(&b.path));
    assets.dedup_by(|a, b| a.agent == b.agent && a.path == b.path);
    let agents = AgentKind::ALL
        .into_iter()
        .map(|agent| {
            let agent_assets: Vec<_> = assets.iter().filter(|asset| asset.agent == agent).collect();
            let warnings = validation_warnings
                .iter()
                .filter(|(owner, _)| *owner == agent)
                .map(|(_, warning)| warning.clone())
                .collect();
            AgentDetection {
                agent,
                detected: !agent_assets.is_empty(),
                asset_count: agent_assets.len(),
                warnings,
            }
        })
        .collect();

    let mut warnings: Vec<_> = validation_warnings
        .into_iter()
        .map(|(_, warning)| warning)
        .collect();
    let manifest_exists = manifest_entry_exists(&root);
    if manifest_exists && let Err(error) = crate::load_manifest(&root) {
        warnings.push(error.to_string());
    }
    Ok(WorkspaceScan {
        root: root.clone(),
        manifest_exists,
        agents,
        assets,
        warnings,
    })
}

fn is_asset(agent: AgentKind, candidate: &str, path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            name == "SKILL.md"
                || name.ends_with(".toml")
                || name.ends_with(".json")
                || name.ends_with(".jsonc")
                || name.ends_with(".md")
                || name.ends_with(".mdc")
                || agent == AgentKind::OpenCode
                    && matches!(candidate, ".opencode/plugins" | ".opencode/tools")
                    && (name.ends_with(".js") || name.ends_with(".ts"))
        })
}

fn validate_native_config(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let format = if name.ends_with(".jsonc") {
        "JSONC"
    } else if name.ends_with(".json") {
        "JSON"
    } else if name.ends_with(".toml") {
        "TOML"
    } else {
        return None;
    };
    let invalid = |detail: String| {
        format!(
            "Configuration file is invalid: {} ({detail})",
            path.display()
        )
    };
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(_) => return Some(invalid("must be a regular file".into())),
        Err(error) => return Some(invalid(error.to_string())),
    };
    if metadata.len() > MAX_NATIVE_CONFIG_BYTES {
        return Some(invalid(format!(
            "{format} exceeds the 1 MiB validation limit"
        )));
    }
    let mut content = String::new();
    if let Err(error) = fs::File::open(path).and_then(|file| {
        file.take(MAX_NATIVE_CONFIG_BYTES + 1)
            .read_to_string(&mut content)
    }) {
        return Some(invalid(error.to_string()));
    }
    if content.len() as u64 > MAX_NATIVE_CONFIG_BYTES {
        return Some(invalid(format!(
            "{format} exceeds the 1 MiB validation limit"
        )));
    }
    let error = if format == "JSONC" {
        json5::from_str::<serde_json::Value>(&content)
            .err()
            .map(|error| error.to_string())
    } else if format == "JSON" {
        serde_json::from_str::<serde_json::Value>(&content)
            .err()
            .map(|error| error.to_string())
    } else {
        toml::from_str::<toml::Value>(&content)
            .err()
            .map(|error| error.to_string())
    };
    error.map(invalid)
}

fn candidates(agent: AgentKind) -> Vec<(&'static str, AssetKind, &'static str)> {
    match agent {
        AgentKind::Codex => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "Codex project instructions",
            ),
            (".agents/skills", AssetKind::Skill, "Shared Agent Skill"),
            (
                ".codex/config.toml",
                AssetKind::Configuration,
                "Codex project configuration",
            ),
            (".codex/agents", AssetKind::Agent, "Codex custom Agent"),
            (".codex/hooks.json", AssetKind::Hook, "Codex Hooks"),
        ],
        AgentKind::ClaudeCode => vec![
            (
                "CLAUDE.md",
                AssetKind::Instruction,
                "Claude Code project instructions",
            ),
            (
                ".claude/CLAUDE.md",
                AssetKind::Instruction,
                "Claude Code project instructions",
            ),
            (
                ".claude/rules",
                AssetKind::Instruction,
                "Claude Code directory rules",
            ),
            (".claude/skills", AssetKind::Skill, "Claude Code Skills"),
            (".claude/agents", AssetKind::Agent, "Claude Code Subagents"),
            (
                ".claude/settings.json",
                AssetKind::Configuration,
                "Claude Code settings",
            ),
            (".mcp.json", AssetKind::Connection, "Claude Code MCP"),
        ],
        AgentKind::Cursor => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "Cursor project instructions",
            ),
            (
                ".cursor/rules",
                AssetKind::Instruction,
                "Cursor project rules",
            ),
            (
                ".cursor/commands",
                AssetKind::Instruction,
                "Cursor commands",
            ),
            (".cursor/skills", AssetKind::Skill, "Cursor Skills"),
            (".agents/skills", AssetKind::Skill, "Shared Agent Skill"),
            (".cursor/hooks.json", AssetKind::Hook, "Cursor Hooks"),
            (".cursor/mcp.json", AssetKind::Connection, "Cursor MCP"),
        ],
        AgentKind::OpenCode => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "OpenCode project instructions",
            ),
            (
                "CLAUDE.md",
                AssetKind::Instruction,
                "OpenCode fallback project instructions",
            ),
            (
                "opencode.json",
                AssetKind::Configuration,
                "OpenCode configuration",
            ),
            (
                "opencode.jsonc",
                AssetKind::Configuration,
                "OpenCode configuration",
            ),
            (
                ".opencode/opencode.json",
                AssetKind::Connection,
                "OpenCode project configuration and MCP",
            ),
            (
                ".opencode/opencode.jsonc",
                AssetKind::Connection,
                "OpenCode project configuration and MCP",
            ),
            (".opencode/skills", AssetKind::Skill, "OpenCode Skills"),
            (
                ".claude/skills",
                AssetKind::Skill,
                "Claude-compatible Skills",
            ),
            (".agents/skills", AssetKind::Skill, "Shared Agent Skill"),
            (
                ".opencode/agents",
                AssetKind::Agent,
                "OpenCode custom Agents",
            ),
            (
                ".opencode/commands",
                AssetKind::Instruction,
                "OpenCode commands",
            ),
            (
                ".opencode/plugins",
                AssetKind::Configuration,
                "OpenCode plugins",
            ),
            (
                ".opencode/tools",
                AssetKind::Configuration,
                "OpenCode custom tools",
            ),
        ],
        AgentKind::OpenClaw => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "OpenClaw workspace instructions",
            ),
            ("SOUL.md", AssetKind::Instruction, "OpenClaw persona"),
            ("IDENTITY.md", AssetKind::Instruction, "OpenClaw identity"),
            ("USER.md", AssetKind::Memory, "OpenClaw user profile"),
            ("MEMORY.md", AssetKind::Memory, "OpenClaw long-term memory"),
            ("TOOLS.md", AssetKind::Configuration, "OpenClaw tool notes"),
            ("skills", AssetKind::Skill, "OpenClaw Workspace Skills"),
            (".agents/skills", AssetKind::Skill, "Shared Agent Skill"),
        ],
        AgentKind::Hermes => vec![
            (
                ".hermes.md",
                AssetKind::Instruction,
                "Hermes project instructions",
            ),
            (
                "HERMES.md",
                AssetKind::Instruction,
                "Hermes project instructions",
            ),
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "Hermes-compatible project instructions",
            ),
            (
                "CLAUDE.md",
                AssetKind::Instruction,
                "Hermes-compatible project instructions",
            ),
            (
                ".cursorrules",
                AssetKind::Instruction,
                "Hermes Cursor-compatible rules",
            ),
        ],
        AgentKind::GrokBuild => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "Grok Build project instructions",
            ),
            (
                ".grok/rules",
                AssetKind::Instruction,
                "Grok Build project rules",
            ),
            (".grok/skills", AssetKind::Skill, "Grok Build Skills"),
            (".grok/agents", AssetKind::Agent, "Grok Build Agents"),
            (
                ".grok/plugins",
                AssetKind::Configuration,
                "Grok Build Plugins",
            ),
            (".grok/hooks", AssetKind::Hook, "Grok Build Hooks"),
            (
                ".grok/workflows",
                AssetKind::Configuration,
                "Grok Build Workflows",
            ),
            (
                ".grok/config.toml",
                AssetKind::Configuration,
                "Grok Build project configuration",
            ),
            (
                ".grok/lsp.json",
                AssetKind::Configuration,
                "Grok Build LSP configuration",
            ),
        ],
        AgentKind::DeepSeekHarness => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "DeepSeek Harness project instructions",
            ),
            (
                "CLAUDE.md",
                AssetKind::Instruction,
                "DeepSeek Harness project instructions",
            ),
            (
                "AGENTS.local.md",
                AssetKind::Instruction,
                "DeepSeek Harness local project instructions",
            ),
            (
                "CLAUDE.local.md",
                AssetKind::Instruction,
                "DeepSeek Harness local project instructions",
            ),
            (".dsh/skills", AssetKind::Skill, "DeepSeek Harness Skills"),
            (".agents/skills", AssetKind::Skill, "Shared Agent Skill"),
        ],
    }
}

fn record(agent: AgentKind, kind: AssetKind, path: PathBuf, summary: &str) -> Result<AssetRecord> {
    let metadata = fs::metadata(&path)?;
    Ok(AssetRecord {
        agent,
        kind,
        path,
        exists: true,
        size: metadata.len(),
        summary: summary.into(),
        summary_key: summary_translation_key(summary).map(str::to_string),
        summary_params: Default::default(),
    })
}

fn summary_translation_key(summary: &str) -> Option<&'static str> {
    if summary.contains("Codex") && summary.to_ascii_lowercase().contains("instruction") {
        Some("assets.summary.codexInstructions")
    } else if summary.contains("Claude Code") && summary.contains("instruction") {
        Some("assets.summary.claudeInstructions")
    } else if summary.contains("OpenCode") && summary.contains("instruction") {
        Some("assets.summary.openCodeInstructions")
    } else if summary.contains("OpenClaw") && summary.contains("instruction") {
        Some("assets.summary.openClawInstructions")
    } else if summary.contains("Hermes") && summary.contains("instruction") {
        Some("assets.summary.hermesInstructions")
    } else if summary.contains("Grok Build") && summary.contains("instruction") {
        Some("assets.summary.grokBuildInstructions")
    } else if summary.contains("DeepSeek Harness") && summary.contains("instruction") {
        Some("assets.summary.deepseekHarnessInstructions")
    } else if summary.contains("Cursor") && summary.contains("instruction") {
        Some("assets.summary.cursorInstructions")
    } else if summary.contains("Skill") {
        Some("assets.summary.skillDirectory")
    } else if summary.contains("MCP") {
        Some("assets.summary.mcpConfig")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_grok_build_native_assets() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".grok/skills/reviewer")).unwrap();
        fs::write(
            dir.path().join(".grok/skills/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::write(
            dir.path().join(".grok/config.toml"),
            "[mcp_servers.example]\nurl = \"https://example.com/mcp\"\n",
        )
        .unwrap();

        let scan = scan_workspace(dir.path()).unwrap();
        let grok = scan
            .agents
            .iter()
            .find(|agent| agent.agent == AgentKind::GrokBuild)
            .unwrap();
        assert!(grok.detected);
        assert!(scan.assets.iter().any(|asset| {
            asset.agent == AgentKind::GrokBuild
                && asset.path.ends_with(".grok/skills/reviewer/SKILL.md")
        }));
    }
    use tempfile::tempdir;

    #[test]
    fn reports_broken_native_configuration() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".codex")).unwrap();
        fs::write(dir.path().join(".codex/config.toml"), "[broken").unwrap();
        let scan = scan_workspace(dir.path()).unwrap();
        assert!(
            scan.warnings
                .iter()
                .any(|warning| warning.contains("Configuration file is invalid"))
        );
        assert_eq!(
            scan.agents
                .iter()
                .find(|agent| agent.agent == AgentKind::Codex)
                .unwrap()
                .warnings
                .len(),
            1
        );
    }

    #[test]
    fn keeps_json_strict_while_accepting_jsonc_syntax() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".cursor")).unwrap();
        fs::create_dir_all(dir.path().join(".opencode")).unwrap();
        fs::write(
            dir.path().join(".cursor/mcp.json"),
            r#"{"mcpServers": {},}"#,
        )
        .unwrap();
        fs::write(
            dir.path().join(".opencode/opencode.jsonc"),
            "{ // supported comment\n mcp: {},\n}",
        )
        .unwrap();

        let scan = scan_workspace(dir.path()).unwrap();

        let cursor = scan
            .agents
            .iter()
            .find(|agent| agent.agent == AgentKind::Cursor)
            .unwrap();
        let opencode = scan
            .agents
            .iter()
            .find(|agent| agent.agent == AgentKind::OpenCode)
            .unwrap();
        assert_eq!(cursor.warnings.len(), 1);
        assert!(opencode.warnings.is_empty());
    }

    #[test]
    fn rejects_oversized_native_configuration_before_reading_it() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".codex")).unwrap();
        fs::File::create(dir.path().join(".codex/config.toml"))
            .unwrap()
            .set_len(MAX_NATIVE_CONFIG_BYTES + 1)
            .unwrap();

        let scan = scan_workspace(dir.path()).unwrap();

        assert!(
            scan.warnings
                .iter()
                .any(|warning| warning.contains("exceeds the 1 MiB validation limit"))
        );
    }

    #[test]
    fn reports_non_regular_manifest_entries_as_present_and_invalid() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".agentkib/manifest.yaml")).unwrap();

        let scan = scan_workspace(dir.path()).unwrap();

        assert!(scan.manifest_exists);
        assert!(
            scan.warnings
                .iter()
                .any(|warning| warning.contains("must be a regular file"))
        );
    }

    #[test]
    fn scans_cursor_rules_commands_hooks_and_mcp() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".cursor/rules")).unwrap();
        fs::create_dir_all(dir.path().join(".cursor/commands")).unwrap();
        fs::write(
            dir.path().join(".cursor/rules/project.mdc"),
            "---\nalwaysApply: true\n---\nRule",
        )
        .unwrap();
        fs::write(dir.path().join(".cursor/commands/review.md"), "Review").unwrap();
        fs::write(dir.path().join(".cursor/hooks.json"), "{}").unwrap();
        fs::write(dir.path().join(".cursor/mcp.json"), "{}").unwrap();
        fs::create_dir_all(dir.path().join(".agents/skills/reviewer")).unwrap();
        fs::write(
            dir.path().join(".agents/skills/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();

        let scan = scan_workspace(dir.path()).unwrap();
        let cursor = scan
            .agents
            .iter()
            .find(|agent| agent.agent == AgentKind::Cursor)
            .unwrap();
        assert!(cursor.detected);
        assert_eq!(cursor.asset_count, 5);
        assert!(scan.assets.iter().any(|asset| {
            asset.agent == AgentKind::Cursor
                && asset.kind == AssetKind::Skill
                && asset.path.ends_with(".agents/skills/reviewer/SKILL.md")
        }));
    }

    #[test]
    fn scans_opencode_javascript_and_typescript_plugins_and_tools() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".opencode/plugins")).unwrap();
        fs::create_dir_all(dir.path().join(".opencode/tools")).unwrap();
        fs::write(
            dir.path().join(".opencode/plugins/javascript.js"),
            "export default {}",
        )
        .unwrap();
        fs::write(
            dir.path().join(".opencode/plugins/typescript.ts"),
            "export default {}",
        )
        .unwrap();
        fs::write(
            dir.path().join(".opencode/tools/custom.ts"),
            "export default {}",
        )
        .unwrap();

        let scan = scan_workspace(dir.path()).unwrap();
        let opencode = scan
            .agents
            .iter()
            .find(|agent| agent.agent == AgentKind::OpenCode)
            .unwrap();

        assert!(opencode.detected);
        assert_eq!(opencode.asset_count, 3);
        assert!(
            scan.assets
                .iter()
                .any(|asset| asset.path.ends_with(".opencode/tools/custom.ts"))
        );
        assert!(scan.assets.iter().all(|asset| {
            asset.agent != AgentKind::OpenCode
                || asset.path.extension().and_then(|value| value.to_str()) == Some("js")
                || asset.path.extension().and_then(|value| value.to_str()) == Some("ts")
        }));
    }
}
