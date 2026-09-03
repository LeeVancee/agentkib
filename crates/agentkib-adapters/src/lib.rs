use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use agentkib_core::{
    AdapterState, AgentKind, ChangeScope, ChangeSet, ConnectionDefinition, ConnectionTransport,
    FileChange, Manifest, McpConfigDocument, McpServerConfig, McpServerTransport, RiskLevel,
    hash_content, inspect_skill_entrypoint, manifest_path, opencode_managed_config_path,
    opencode_managed_instruction_is_registered,
};
use agentkib_platform::path::{canonicalize, is_safe_scan_entry, starts_with as path_starts_with};
use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::{Map as JsonMap, Value as JsonValue};
use uuid::Uuid;
use walkdir::WalkDir;

const START: &str = "<!-- agentkib:managed:start -->";
const END: &str = "<!-- agentkib:managed:end -->";
const TOML_START: &str = "# agentkib:managed:start";
const TOML_END: &str = "# agentkib:managed:end";
const MAX_HANDOFF_GITIGNORE_BYTES: u64 = 1024 * 1024;
const MAX_SKILL_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SKILL_FILES: usize = 512;
const MAX_SKILL_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct HomeTargets {
    pub openclaw_config: Option<PathBuf>,
    pub hermes_config: Option<PathBuf>,
}

pub fn default_manifest(project: &Path) -> Result<Manifest> {
    let name = project
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("workspace")
        .to_string();
    let agents = fs::read_to_string(project.join("AGENTS.md")).ok();
    let claude = fs::read_to_string(project.join("CLAUDE.md")).ok();
    let shared = agents
        .clone()
        .or_else(|| {
            claude
                .as_ref()
                .filter(|content| !content.lines().any(|line| line.trim() == "@AGENTS.md"))
                .cloned()
        })
        .unwrap_or_default();
    let mut platform_overrides = BTreeMap::new();
    if let Ok(content) = fs::read_to_string(project.join("AGENTS.override.md"))
        && let Some(override_text) = platform_delta(&shared, &content)
    {
        platform_overrides.insert(AgentKind::Codex, override_text);
    }
    if agents.is_some()
        && let Some(content) = claude
        && let Some(override_text) = claude_platform_override(&content)
    {
        platform_overrides.insert(AgentKind::ClaudeCode, override_text);
    }
    if let Ok(content) = fs::read_to_string(project.join(".cursor/rules/agentkib.mdc"))
        && let Some(override_text) = managed_content(&content)
        && !override_text.trim().is_empty()
    {
        platform_overrides.insert(AgentKind::Cursor, override_text.to_string());
    }
    if opencode_managed_instruction_is_registered(project)
        && let Ok(content) = fs::read_to_string(project.join(".opencode/agentkib-instructions.md"))
        && let Some(override_text) = managed_content(&content)
        && !override_text.trim().is_empty()
    {
        platform_overrides.insert(AgentKind::OpenCode, override_text.to_string());
    }
    if let Some(content) = [".hermes.md", "HERMES.md"]
        .into_iter()
        .find_map(|name| fs::read_to_string(project.join(name)).ok())
        && let Some(override_text) = platform_delta(&shared, &content)
    {
        platform_overrides.insert(AgentKind::Hermes, override_text);
    }
    let adapters = AgentKind::WRITABLE
        .into_iter()
        .map(|agent| {
            (
                agent,
                AdapterState {
                    enabled: true,
                    generated_hashes: BTreeMap::new(),
                },
            )
        })
        .collect();
    let skills = discover_shared_skills(project)?;
    let scoped = discover_scoped_instructions(project)?;
    Ok(Manifest {
        schema_version: 2,
        workspace: agentkib_core::WorkspaceIdentity {
            id: Uuid::new_v4().to_string(),
            name,
        },
        instructions: agentkib_core::InstructionSet {
            shared,
            scoped,
            platform_overrides,
        },
        skills,
        mcp: Default::default(),
        connections: Vec::new(),
        memories: Default::default(),
        adapters,
    })
}

fn discover_scoped_instructions(project: &Path) -> Result<Vec<agentkib_core::ScopedInstruction>> {
    let mut scoped = Vec::new();
    for entry in WalkDir::new(project)
        .min_depth(2)
        .max_depth(8)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            is_safe_scan_entry(entry.path())
                && (!entry.file_type().is_dir()
                    || !matches!(
                        entry.file_name().to_str(),
                        Some(".git" | ".agentkib" | "node_modules" | "target" | "dist")
                    ))
        })
    {
        let entry = entry?;
        if !entry.file_type().is_file() || entry.file_name() != "AGENTS.md" {
            continue;
        }
        let parent = entry
            .path()
            .parent()
            .context("Scoped rule has no parent directory")?;
        let relative = parent.strip_prefix(project)?;
        scoped.push(agentkib_core::ScopedInstruction {
            path: relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
            content: fs::read_to_string(entry.path())?,
        });
    }
    scoped.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(scoped)
}

fn platform_delta(shared: &str, platform_content: &str) -> Option<String> {
    let content = platform_content.trim();
    let shared = shared.trim();
    if content.is_empty() || content == shared {
        return None;
    }
    let delta = content
        .strip_prefix(shared)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(content);
    Some(delta.to_string())
}

fn claude_platform_override(content: &str) -> Option<String> {
    let imports_agents = content.lines().any(|line| line.trim() == "@AGENTS.md");
    if !imports_agents {
        return Some(content.trim().to_string()).filter(|value| !value.is_empty());
    }
    let remaining = content
        .lines()
        .filter(|line| {
            let line = line.trim();
            line != "@AGENTS.md"
                && line != "Claude Code uses AGENTS.md as the shared project instructions."
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(remaining.trim().to_string()).filter(|value| !value.is_empty())
}

fn managed_content(content: &str) -> Option<&str> {
    let (_, content) = content.split_once(START)?;
    let (content, _) = content.split_once(END)?;
    Some(content.trim())
}

fn discover_shared_skills(project: &Path) -> Result<Vec<agentkib_core::SkillDefinition>> {
    let directory = project.join(".agents/skills");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut skills = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let skill_file = entry.path().join("SKILL.md");
        if let Ok(package) = inspect_skill_entrypoint(&skill_file) {
            let Some(directory_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            skills.push(agentkib_core::SkillDefinition {
                name: package.name,
                path: format!(".agents/skills/{directory_name}"),
                targets: Vec::new(),
            });
        }
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(skills)
}

pub fn plan_workspace_changes(
    project: &Path,
    manifest: &Manifest,
    home: &HomeTargets,
) -> Result<ChangeSet> {
    agentkib_core::validate_manifest(manifest)?;
    let root = agentkib_core::canonical_project(project)?;
    let mut changes = Vec::new();
    let gateway_connections: Vec<_> = manifest
        .connections
        .iter()
        .filter(|connection| connection.name == "agentkib")
        .cloned()
        .collect();
    let legacy_connections: Vec<_> = manifest
        .connections
        .iter()
        .filter(|connection| connection.name != "agentkib")
        .collect();
    if !legacy_connections.is_empty() {
        let target = root.join(".agentkib").join(&manifest.mcp.config);
        let mut document: McpConfigDocument = fs::read_to_string(&target)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default();
        for connection in legacy_connections {
            let server = legacy_connection_server(connection);
            if let Some(existing) = document
                .servers
                .iter_mut()
                .find(|value| value.id == server.id)
            {
                *existing = server;
            } else {
                document.servers.push(server);
            }
        }
        document
            .servers
            .sort_by(|left, right| left.name.cmp(&right.name));
        push_change(
            &mut changes,
            target,
            format!("{}\n", serde_json::to_string_pretty(&document)?),
            ChangeScope::Project,
            RiskLevel::Medium,
            "json",
        )?;
    }

    let common_enabled = [
        AgentKind::Codex,
        AgentKind::Cursor,
        AgentKind::OpenCode,
        AgentKind::OpenClaw,
        AgentKind::Hermes,
        AgentKind::GrokBuild,
    ]
    .into_iter()
    .any(|agent| adapter_enabled(manifest, agent));
    if common_enabled {
        push_change(
            &mut changes,
            root.join("AGENTS.md"),
            managed_markdown(
                &fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default(),
                &manifest.instructions.shared,
            ),
            ChangeScope::Project,
            RiskLevel::Medium,
            "markdown",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::ClaudeCode) {
        let claude_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::ClaudeCode)
            .map(String::as_str)
            .unwrap_or_default();
        let claude_content = if claude_override.trim().is_empty() {
            "@AGENTS.md\n\nClaude Code uses AGENTS.md as the shared project instructions."
                .to_string()
        } else {
            format!("@AGENTS.md\n\n{claude_override}")
        };
        push_change(
            &mut changes,
            root.join("CLAUDE.md"),
            managed_markdown(
                &fs::read_to_string(root.join("CLAUDE.md")).unwrap_or_default(),
                &claude_content,
            ),
            ChangeScope::Project,
            RiskLevel::Medium,
            "markdown",
        )?;
        push_change(
            &mut changes,
            root.join(".mcp.json"),
            merge_claude_mcp(&root.join(".mcp.json"), &gateway_connections)?,
            ChangeScope::Project,
            RiskLevel::Medium,
            "json",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::Codex) {
        let codex_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::Codex)
            .map(String::as_str)
            .unwrap_or_default();
        let override_path = root.join("AGENTS.override.md");
        if !codex_override.trim().is_empty() || override_path.is_file() {
            let content = if codex_override.trim().is_empty() {
                manifest.instructions.shared.clone()
            } else {
                format!(
                    "{}\n\n{}",
                    manifest.instructions.shared.trim(),
                    codex_override.trim()
                )
            };
            push_change(
                &mut changes,
                override_path.clone(),
                managed_markdown(
                    &fs::read_to_string(&override_path).unwrap_or_default(),
                    &content,
                ),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
        push_change(
            &mut changes,
            root.join(".codex/config.toml"),
            merge_codex_config(&root.join(".codex/config.toml"), &gateway_connections)?,
            ChangeScope::Project,
            RiskLevel::Medium,
            "toml",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::GrokBuild) {
        push_change(
            &mut changes,
            root.join(".grok/config.toml"),
            merge_grok_config(&root.join(".grok/config.toml"), &gateway_connections)?,
            ChangeScope::Project,
            RiskLevel::Medium,
            "toml",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::Cursor) {
        let platform_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::Cursor)
            .map(String::as_str)
            .unwrap_or_default();
        let rule_path = root.join(".cursor/rules/agentkib.mdc");
        if !platform_override.trim().is_empty()
            || rule_path.is_file()
                && fs::read_to_string(&rule_path)
                    .unwrap_or_default()
                    .contains(START)
        {
            let rule = cursor_rule(
                &fs::read_to_string(&rule_path).unwrap_or_default(),
                platform_override,
            );
            push_change(
                &mut changes,
                rule_path,
                rule,
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
        push_change(
            &mut changes,
            root.join(".cursor/mcp.json"),
            merge_mcp_json(
                &root.join(".cursor/mcp.json"),
                &gateway_connections,
                AgentKind::Cursor,
            )?,
            ChangeScope::Project,
            RiskLevel::Medium,
            "json",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::OpenCode) {
        let platform_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::OpenCode)
            .map(String::as_str)
            .unwrap_or_default();
        let instruction_path = root.join(".opencode/agentkib-instructions.md");
        let existing_instruction = fs::read_to_string(&instruction_path).unwrap_or_default();
        let manages_instruction = !platform_override.trim().is_empty()
            || existing_instruction.contains(START)
                && opencode_managed_instruction_is_registered(&root);
        if manages_instruction {
            push_change(
                &mut changes,
                instruction_path,
                managed_markdown(&existing_instruction, platform_override),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
        let config_path = opencode_managed_config_path(&root);
        let format = if config_path.extension() == Some(OsStr::new("jsonc")) {
            "jsonc"
        } else {
            "json"
        };
        push_change(
            &mut changes,
            config_path.clone(),
            merge_opencode_config(&config_path, &gateway_connections, manages_instruction)?,
            ChangeScope::Project,
            RiskLevel::Medium,
            format,
        )?;
    }
    if adapter_enabled(manifest, AgentKind::OpenClaw) {
        let platform_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::OpenClaw)
            .map(String::as_str)
            .unwrap_or_default();
        let target = root.join("TOOLS.md");
        if !platform_override.trim().is_empty()
            || target.is_file()
                && fs::read_to_string(&target)
                    .unwrap_or_default()
                    .contains(START)
        {
            push_change(
                &mut changes,
                target.clone(),
                managed_markdown(
                    &fs::read_to_string(&target).unwrap_or_default(),
                    platform_override,
                ),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
    }
    if adapter_enabled(manifest, AgentKind::Hermes) {
        let platform_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::Hermes)
            .map(String::as_str)
            .unwrap_or_default();
        let target = root.join(".hermes.md");
        if !platform_override.trim().is_empty()
            || target.is_file()
                && fs::read_to_string(&target)
                    .unwrap_or_default()
                    .contains(START)
        {
            let content = if platform_override.trim().is_empty() {
                manifest.instructions.shared.clone()
            } else {
                format!(
                    "{}\n\n{}",
                    manifest.instructions.shared.trim(),
                    platform_override.trim()
                )
            };
            push_change(
                &mut changes,
                target.clone(),
                managed_markdown(&fs::read_to_string(&target).unwrap_or_default(), &content),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
    }

    for scoped in &manifest.instructions.scoped {
        let directory = root.join(&scoped.path);
        if common_enabled {
            let agents = directory.join("AGENTS.md");
            push_change(
                &mut changes,
                agents.clone(),
                managed_markdown(
                    &fs::read_to_string(&agents).unwrap_or_default(),
                    &scoped.content,
                ),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
        if adapter_enabled(manifest, AgentKind::ClaudeCode) {
            let claude = directory.join("CLAUDE.md");
            push_change(
                &mut changes,
                claude.clone(),
                managed_markdown(
                    &fs::read_to_string(&claude).unwrap_or_default(),
                    "@AGENTS.md",
                ),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
    }

    for skill in &manifest.skills {
        let shared_skill_enabled = [
            AgentKind::Codex,
            AgentKind::OpenCode,
            AgentKind::OpenClaw,
            AgentKind::Hermes,
        ]
        .into_iter()
        .any(|agent| {
            adapter_enabled(manifest, agent)
                && (skill.targets.is_empty() || skill.targets.contains(&agent))
        });
        let cursor_private_enabled = adapter_enabled(manifest, AgentKind::Cursor)
            && (skill.targets.is_empty() || skill.targets.contains(&AgentKind::Cursor))
            && !shared_skill_enabled;
        for (relative_path, content) in skill_source_files(&root, skill)? {
            if shared_skill_enabled {
                push_change(
                    &mut changes,
                    root.join(".agents/skills")
                        .join(&skill.name)
                        .join(&relative_path),
                    content.clone(),
                    ChangeScope::Project,
                    RiskLevel::Low,
                    validator_for_skill_file(&relative_path),
                )?;
            }
            if cursor_private_enabled {
                push_change(
                    &mut changes,
                    root.join(".cursor/skills")
                        .join(&skill.name)
                        .join(&relative_path),
                    content.clone(),
                    ChangeScope::Project,
                    RiskLevel::Low,
                    validator_for_skill_file(&relative_path),
                )?;
            }
            if adapter_enabled(manifest, AgentKind::ClaudeCode)
                && (skill.targets.is_empty() || skill.targets.contains(&AgentKind::ClaudeCode))
            {
                push_change(
                    &mut changes,
                    root.join(".claude/skills")
                        .join(&skill.name)
                        .join(&relative_path),
                    content.clone(),
                    ChangeScope::Project,
                    RiskLevel::Low,
                    validator_for_skill_file(&relative_path),
                )?;
            }
            if adapter_enabled(manifest, AgentKind::GrokBuild)
                && (skill.targets.is_empty() || skill.targets.contains(&AgentKind::GrokBuild))
            {
                push_change(
                    &mut changes,
                    root.join(".grok/skills")
                        .join(&skill.name)
                        .join(&relative_path),
                    content.clone(),
                    ChangeScope::Project,
                    RiskLevel::Low,
                    validator_for_skill_file(&relative_path),
                )?;
            }
        }
    }

    if adapter_enabled(manifest, AgentKind::OpenClaw)
        && let Some(path) = &home.openclaw_config
    {
        push_change(
            &mut changes,
            path.clone(),
            merge_openclaw(path, &gateway_connections)?,
            ChangeScope::AgentHome,
            RiskLevel::High,
            "json",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::Hermes)
        && let Some(path) = &home.hermes_config
    {
        push_change(
            &mut changes,
            path.clone(),
            merge_hermes(path, &root, &gateway_connections)?,
            ChangeScope::AgentHome,
            RiskLevel::High,
            "yaml",
        )?;
    }
    let mut persisted_manifest = manifest.clone();
    persisted_manifest.schema_version = 2;
    persisted_manifest.connections.clear();
    update_generated_hashes(&root, &mut persisted_manifest, &changes, home);
    changes.retain(|change| change.before != change.after);
    let manifest_target = manifest_path(&root);
    let manifest_after = serde_yaml::to_string(&persisted_manifest)?;
    let manifest_before = fs::read_to_string(&manifest_target).unwrap_or_default();
    if manifest_before != manifest_after {
        let original_hash = manifest_target
            .exists()
            .then(|| hash_content(manifest_before.as_bytes()));
        changes.insert(
            0,
            FileChange {
                target: manifest_target,
                scope: ChangeScope::Project,
                original_hash,
                before: manifest_before,
                after: manifest_after,
                risk: RiskLevel::Low,
                validator: "yaml".into(),
            },
        );
    }
    let requires_home_approval = changes
        .iter()
        .any(|change| matches!(change.scope, ChangeScope::AgentHome));
    Ok(ChangeSet {
        id: Uuid::new_v4().to_string(),
        project_root: root,
        created_at: Utc::now(),
        changes,
        requires_home_approval,
    })
}

/// Plans the smallest project-local change needed to expose the AgentKib gateway to a
/// continuation target. This intentionally bypasses the full manifest planner so connecting a
/// continuation cannot rewrite instructions or another agent's configuration.
pub fn plan_continuation_gateway(
    project: &Path,
    target_agent: AgentKind,
    workspace_id: &str,
    port: u16,
) -> Result<ChangeSet> {
    anyhow::ensure!(
        matches!(target_agent, AgentKind::Codex | AgentKind::ClaudeCode),
        "Continuation MCP setup only supports Codex and Claude Code"
    );
    anyhow::ensure!(!workspace_id.trim().is_empty(), "Workspace id is required");
    anyhow::ensure!(port > 0, "AgentKib MCP Hub port is unavailable");

    let root = agentkib_core::canonical_project(project)?;
    let connection = ConnectionDefinition {
        name: "agentkib".into(),
        transport: ConnectionTransport::Http {
            url: format!(
                "http://127.0.0.1:{port}/mcp/v1/workspaces/{workspace_id}/agents/{{agent}}"
            ),
        },
        env: BTreeMap::new(),
        allow_tools: Vec::new(),
        targets: vec![target_agent],
    };
    let target = match target_agent {
        AgentKind::Codex => root.join(".codex/config.toml"),
        AgentKind::ClaudeCode => root.join(".mcp.json"),
        _ => unreachable!("unsupported continuation target was rejected above"),
    };
    let after = match target_agent {
        AgentKind::Codex => merge_codex_continuation_config(&target, &connection)?,
        AgentKind::ClaudeCode => merge_claude_mcp(&target, std::slice::from_ref(&connection))?,
        _ => unreachable!("unsupported continuation target was rejected above"),
    };
    let target_existed = target.exists();
    let before = fs::read_to_string(&target).unwrap_or_default();
    let mut changes = Vec::new();
    if before != after {
        push_change_with_before(
            &mut changes,
            target,
            target_existed.then_some(before),
            after,
            ChangeScope::Project,
            RiskLevel::Medium,
            match target_agent {
                AgentKind::Codex => "toml",
                AgentKind::ClaudeCode => "json",
                _ => unreachable!("unsupported continuation target was rejected above"),
            },
        )?;
    }
    Ok(ChangeSet {
        id: Uuid::new_v4().to_string(),
        project_root: root,
        created_at: Utc::now(),
        changes,
        requires_home_approval: false,
    })
}

pub fn plan_changeset(
    project: &Path,
    manifest: &Manifest,
    home: &HomeTargets,
) -> Result<ChangeSet> {
    plan_workspace_changes(project, manifest, home)
}

pub fn plan_handoff_export(project: &Path, filename: &str, content: &str) -> Result<ChangeSet> {
    if filename.is_empty()
        || filename.contains(['/', '\\'])
        || filename.contains("..")
        || !(filename.ends_with(".md") || filename.ends_with(".json"))
    {
        anyhow::bail!("Handoff filename must be a Markdown or JSON basename");
    }
    if content.len() > 256 * 1024 * 1024 {
        anyhow::bail!("Handoff content exceeds 256 MiB");
    }
    let root = agentkib_core::canonical_project(project)?;
    let mut changes = Vec::new();
    let validator = if filename.ends_with(".json") {
        "json"
    } else {
        "markdown"
    };
    push_change(
        &mut changes,
        root.join(".agentkib/handoffs").join(filename),
        content.to_string(),
        ChangeScope::Project,
        RiskLevel::Low,
        validator,
    )?;
    let ignore_path = root.join(".gitignore");
    let before = read_handoff_gitignore(&ignore_path)?;
    let before_content = before.as_deref().unwrap_or_default();
    let ignore_rule = ".agentkib/handoffs/";
    if !before_content
        .lines()
        .any(|line| line.trim() == ignore_rule)
    {
        let mut after = before_content.to_string();
        if !after.is_empty() && !after.ends_with('\n') {
            after.push('\n');
        }
        after.push_str(ignore_rule);
        after.push('\n');
        push_change_with_before(
            &mut changes,
            ignore_path,
            before,
            after,
            ChangeScope::Project,
            RiskLevel::Low,
            "text",
        )?;
    }
    Ok(ChangeSet {
        id: Uuid::new_v4().to_string(),
        project_root: root,
        created_at: Utc::now(),
        changes,
        requires_home_approval: false,
    })
}

fn read_handoff_gitignore(path: &Path) -> Result<Option<String>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("Could not inspect {}", path.display()));
        }
    };
    if !metadata.file_type().is_file() {
        anyhow::bail!(
            "Handoff .gitignore must be a regular file: {}",
            path.display()
        );
    }
    if metadata.len() > MAX_HANDOFF_GITIGNORE_BYTES {
        anyhow::bail!("Handoff .gitignore exceeds the 1 MiB read limit");
    }
    let file = fs::File::open(path)
        .with_context(|| format!("Could not open handoff .gitignore: {}", path.display()))?;
    let mut content = String::new();
    file.take(MAX_HANDOFF_GITIGNORE_BYTES + 1)
        .read_to_string(&mut content)
        .with_context(|| format!("Handoff .gitignore must be UTF-8: {}", path.display()))?;
    if content.len() as u64 > MAX_HANDOFF_GITIGNORE_BYTES {
        anyhow::bail!("Handoff .gitignore exceeds the 1 MiB read limit");
    }
    Ok(Some(content))
}

fn adapter_enabled(manifest: &Manifest, agent: AgentKind) -> bool {
    manifest.adapters.get(&agent).map_or(
        !matches!(agent, AgentKind::OpenCode | AgentKind::GrokBuild),
        |state| state.enabled,
    )
}

fn skill_source_files(
    root: &Path,
    skill: &agentkib_core::SkillDefinition,
) -> Result<Vec<(PathBuf, String)>> {
    let source = root.join(&skill.path);
    fs::symlink_metadata(&source)
        .with_context(|| format!("Skill path does not exist: {}", source.display()))?;
    if !path_has_safe_ancestors(root, &source) {
        anyhow::bail!(
            "Skill path cannot contain symbolic links or non-directory ancestors: {}",
            source.display()
        );
    }
    let canonical = canonicalize(&source)?;
    if !path_starts_with(&canonical, root) {
        anyhow::bail!(
            "Skill path must be inside the project: {}",
            source.display()
        );
    }
    if canonical.is_file() {
        let file_name = canonical
            .file_name()
            .context("Skill file has no filename")?
            .into();
        if canonical.file_name() != Some(OsStr::new("SKILL.md")) {
            anyhow::bail!(
                "A single-file Skill source must be named SKILL.md: {}",
                source.display()
            );
        }
        let (content, _) = read_skill_text(&canonical)?;
        return Ok(vec![(file_name, content)]);
    }
    if !canonical.is_dir() {
        anyhow::bail!(
            "Skill path must be a regular file or directory: {}",
            source.display()
        );
    }

    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    let mut has_entrypoint = false;
    for entry in WalkDir::new(&canonical).follow_links(false) {
        let entry = entry?;
        if !is_safe_scan_entry(entry.path()) {
            anyhow::bail!(
                "Skill directories cannot contain symbolic links: {}",
                entry.path().display()
            );
        }
        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() {
            anyhow::bail!(
                "Skill directories can contain only regular files: {}",
                entry.path().display()
            );
        }
        if files.len() >= MAX_SKILL_FILES {
            anyhow::bail!("Skill source exceeds the {MAX_SKILL_FILES} file limit");
        }
        let path = canonicalize(entry.path())?;
        if !path_starts_with(&path, root) {
            anyhow::bail!(
                "Skill file must be inside the project: {}",
                entry.path().display()
            );
        }
        let relative = path.strip_prefix(&canonical)?.to_path_buf();
        let (content, bytes) = read_skill_text(&path)?;
        total_bytes = total_bytes
            .checked_add(bytes)
            .context("Skill source size overflow")?;
        if total_bytes > MAX_SKILL_TOTAL_BYTES {
            anyhow::bail!("Skill source exceeds the 32 MiB total read limit");
        }
        has_entrypoint |= relative == Path::new("SKILL.md");
        files.push((relative, content));
    }
    if !has_entrypoint {
        anyhow::bail!(
            "Skill directory has no SKILL.md entry point: {}",
            source.display()
        );
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn path_has_safe_ancestors(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return false;
        };
        current.push(component);
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            return false;
        };
        if !is_safe_scan_entry(&current) || current != path && !metadata.file_type().is_dir() {
            return false;
        }
    }
    true
}

fn read_skill_text(path: &Path) -> Result<(String, u64)> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("Could not inspect Skill file: {}", path.display()))?;
    if !metadata.file_type().is_file() {
        anyhow::bail!("Skill asset must be a regular file: {}", path.display());
    }
    if metadata.len() > MAX_SKILL_FILE_BYTES {
        anyhow::bail!(
            "Skill asset exceeds the 8 MiB read limit: {}",
            path.display()
        );
    }
    let mut content = String::new();
    fs::File::open(path)
        .with_context(|| format!("Could not read Skill file: {}", path.display()))?
        .take(MAX_SKILL_FILE_BYTES + 1)
        .read_to_string(&mut content)
        .with_context(|| {
            format!(
                "The MVP supports only UTF-8 text Skill assets; could not read: {}",
                path.display()
            )
        })?;
    if content.len() as u64 > MAX_SKILL_FILE_BYTES {
        anyhow::bail!(
            "Skill asset exceeds the 8 MiB read limit: {}",
            path.display()
        );
    }
    let bytes = content.len() as u64;
    Ok((content, bytes))
}

fn validator_for_skill_file(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("json") => "json",
        Some("toml") => "toml",
        Some("yaml" | "yml") => "yaml",
        Some("md") => "markdown",
        _ => "text",
    }
}

fn has_path_component(path: &Path, name: &str) -> bool {
    let name = OsStr::new(name);
    path.components()
        .any(|component| component.as_os_str() == name)
}

fn update_generated_hashes(
    root: &Path,
    manifest: &mut Manifest,
    changes: &[FileChange],
    home: &HomeTargets,
) {
    for (agent, state) in &mut manifest.adapters {
        let refreshes_home = match agent {
            AgentKind::OpenClaw => home.openclaw_config.is_some(),
            AgentKind::Hermes => home.hermes_config.is_some(),
            _ => false,
        };
        state.generated_hashes.retain(|target, _| {
            let path = Path::new(target);
            let project_scoped = !path.is_absolute() || path_starts_with(path, root);
            !project_scoped && !refreshes_home
        });
    }
    for change in changes {
        let key = change
            .target
            .strip_prefix(root)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| change.target.display().to_string());
        let hash = hash_content(change.after.as_bytes());
        let relative = change.target.strip_prefix(root).ok();
        let name = relative
            .unwrap_or(&change.target)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let scoped_path = relative.unwrap_or(change.target.as_path());
        let agents: &[AgentKind] = if has_path_component(scoped_path, ".opencode") {
            &[AgentKind::OpenCode]
        } else if has_path_component(scoped_path, ".openclaw")
            || home.openclaw_config.as_ref() == Some(&change.target)
            || name == "TOOLS.md"
        {
            &[AgentKind::OpenClaw]
        } else if has_path_component(scoped_path, ".hermes")
            || home.hermes_config.as_ref() == Some(&change.target)
            || name == ".hermes.md"
        {
            &[AgentKind::Hermes]
        } else if has_path_component(scoped_path, ".grok") {
            &[AgentKind::GrokBuild]
        } else if has_path_component(scoped_path, ".codex") || name == "AGENTS.override.md" {
            &[AgentKind::Codex]
        } else if has_path_component(scoped_path, ".cursor") {
            &[AgentKind::Cursor]
        } else if has_path_component(scoped_path, ".claude")
            || name == "CLAUDE.md"
            || name == ".mcp.json"
        {
            &[AgentKind::ClaudeCode]
        } else {
            &[
                AgentKind::Codex,
                AgentKind::Cursor,
                AgentKind::OpenCode,
                AgentKind::OpenClaw,
                AgentKind::Hermes,
                AgentKind::GrokBuild,
            ]
        };
        for agent in agents {
            if let Some(state) = manifest.adapters.get_mut(agent) {
                state.generated_hashes.insert(key.clone(), hash.clone());
            }
        }
    }
}

fn push_change(
    changes: &mut Vec<FileChange>,
    target: PathBuf,
    after: String,
    scope: ChangeScope,
    risk: RiskLevel,
    validator: &str,
) -> Result<()> {
    let before = if target.exists() {
        Some(fs::read_to_string(&target).with_context(|| {
            format!(
                "Could not read existing configuration: {}",
                target.display()
            )
        })?)
    } else {
        None
    };
    push_change_with_before(changes, target, before, after, scope, risk, validator)
}

fn push_change_with_before(
    changes: &mut Vec<FileChange>,
    target: PathBuf,
    before: Option<String>,
    after: String,
    scope: ChangeScope,
    risk: RiskLevel,
    validator: &str,
) -> Result<()> {
    let original_hash = before
        .as_ref()
        .map(|content| hash_content(content.as_bytes()));
    changes.push(FileChange {
        target,
        scope,
        original_hash,
        before: before.unwrap_or_default(),
        after,
        risk,
        validator: validator.into(),
    });
    Ok(())
}

fn managed_markdown(existing: &str, generated: &str) -> String {
    if !existing.contains(START) && existing.trim() == generated.trim() {
        return format!("{START}\n{}\n{END}\n", generated.trim());
    }
    replace_managed(
        existing,
        START,
        END,
        &format!("{START}\n{}\n{END}", generated.trim()),
    )
}

fn cursor_rule(existing: &str, generated: &str) -> String {
    let (header, body) = if existing.starts_with("---\n") {
        existing
            .split_once("\n---\n")
            .map(|(header, body)| (format!("{header}\n---\n\n"), body.trim_start()))
            .unwrap_or_else(|| (String::new(), existing))
    } else {
        (String::new(), existing)
    };
    let header = if header.is_empty() {
        "---\ndescription: AgentKib Cursor-specific instructions\nalwaysApply: true\n---\n\n"
            .to_string()
    } else {
        header
    };
    format!("{header}{}", managed_markdown(body, generated))
}

fn replace_managed(existing: &str, start: &str, end: &str, block: &str) -> String {
    if let (Some(a), Some(b)) = (existing.find(start), existing.find(end)) {
        let after_end = b + end.len();
        return format!("{}{}{}", &existing[..a], block, &existing[after_end..]);
    }
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

fn targeted(connection: &ConnectionDefinition, agent: AgentKind) -> bool {
    connection.targets.is_empty() || connection.targets.contains(&agent)
}

fn legacy_connection_server(connection: &ConnectionDefinition) -> McpServerConfig {
    let transport = match &connection.transport {
        ConnectionTransport::Stdio { command, args } => McpServerTransport::Stdio {
            command: command.clone(),
            args: args.clone(),
            cwd: None,
        },
        ConnectionTransport::Http { url } => {
            McpServerTransport::StreamableHttp { url: url.clone() }
        }
    };
    McpServerConfig {
        id: safe_key(&connection.name),
        name: connection.name.clone(),
        enabled: true,
        transport,
        // Values belong in mcp.local.json and must never enter a reviewed public Diff.
        env: Default::default(),
        headers: Default::default(),
        oauth_credentials: None,
        local_config_path: None,
        targets: connection.targets.clone(),
        allow_tools: connection.allow_tools.clone(),
        lan_allow_tools: Vec::new(),
        supports_parallel_tool_calls: false,
        package: None,
    }
}

fn merge_codex_config(path: &Path, connections: &[ConnectionDefinition]) -> Result<String> {
    merge_toml_mcp_config(path, connections, AgentKind::Codex, "Codex")
}

/// Adds the continuation gateway without changing other MCP servers that AgentKib already
/// manages. Unlike workspace synchronization, continuation setup must be an incremental update.
fn merge_codex_continuation_config(
    path: &Path,
    connection: &ConnectionDefinition,
) -> Result<String> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    let start_count = existing.matches(TOML_START).count();
    let end_count = existing.matches(TOML_END).count();
    match (start_count, end_count) {
        (0, 0) => return merge_codex_config(path, std::slice::from_ref(connection)),
        (1, 1) => {}
        _ => anyhow::bail!("AgentKib-managed Codex MCP block is incomplete or ambiguous"),
    }
    let start = existing
        .find(TOML_START)
        .expect("managed Codex MCP block count was checked");
    let content_start = start + TOML_START.len();
    let end = existing[content_start..]
        .find(TOML_END)
        .map(|offset| content_start + offset)
        .context("AgentKib-managed Codex MCP block is incomplete")?;
    let config =
        toml::from_str::<toml::Value>(&existing).context("Codex configuration is invalid")?;
    let mut managed = toml::from_str::<toml::Table>(&existing[content_start..end])
        .context("AgentKib-managed Codex MCP block is invalid")?;
    let key = safe_key(&connection.name);
    let servers = managed
        .entry("mcp_servers")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .context("AgentKib-managed Codex mcp_servers must be a table")?;
    let configured_outside_managed_block = config
        .get("mcp_servers")
        .and_then(toml::Value::as_table)
        .is_some_and(|values| values.contains_key(&key))
        && !servers.contains_key(&key);
    anyhow::ensure!(
        !configured_outside_managed_block,
        "Codex configuration already contains an unmanaged MCP with the same name: {}. Rename one entry or migrate it to AgentKib to preserve platform-specific fields.",
        connection.name
    );
    servers.insert(key, codex_server_value(connection));
    let managed = toml::to_string(&managed)?;
    let block = format!("{TOML_START}\n{managed}{TOML_END}");
    let after_end = end + TOML_END.len();
    Ok(format!(
        "{}{}{}",
        &existing[..start],
        block,
        &existing[after_end..]
    ))
}

fn merge_grok_config(path: &Path, connections: &[ConnectionDefinition]) -> Result<String> {
    merge_toml_mcp_config(path, connections, AgentKind::GrokBuild, "Grok Build")
}

fn merge_toml_mcp_config(
    path: &Path,
    connections: &[ConnectionDefinition],
    agent: AgentKind,
    label: &str,
) -> Result<String> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    if !existing.contains(TOML_START) {
        let parsed = toml::from_str::<toml::Value>(&existing).ok();
        let existing_servers = parsed
            .as_ref()
            .and_then(|value| value.get("mcp_servers"))
            .and_then(toml::Value::as_table);
        for connection in connections.iter().filter(|value| targeted(value, agent)) {
            let key = safe_key(&connection.name);
            let table = format!("[mcp_servers.{key}]");
            if existing_servers.is_some_and(|servers| servers.contains_key(&key))
                || existing.lines().any(|line| line.trim() == table)
            {
                anyhow::bail!(
                    "{label} configuration already contains an unmanaged MCP with the same name: {}. Rename one entry or migrate it to AgentKib to preserve platform-specific fields.",
                    connection.name
                );
            }
        }
    }
    let mut block = String::new();
    block.push_str(TOML_START);
    block.push('\n');
    for connection in connections.iter().filter(|value| targeted(value, agent)) {
        block.push_str(&format!("[mcp_servers.{}]\n", safe_key(&connection.name)));
        match &connection.transport {
            ConnectionTransport::Stdio { command, args } => {
                block.push_str(&format!("command = {}\n", toml_string(command)));
                block.push_str(&format!(
                    "args = {}\n",
                    serde_json::to_string(args).unwrap_or_else(|_| "[]".into())
                ));
            }
            ConnectionTransport::Http { url } => {
                block.push_str(&format!("url = {}\n", toml_string(&agent_url(url, agent))))
            }
        }
        if !connection.allow_tools.is_empty() {
            block.push_str(&format!(
                "enabled_tools = {}\n",
                serde_json::to_string(&connection.allow_tools).unwrap_or_else(|_| "[]".into())
            ));
        }
        block.push('\n');
    }
    block.push_str(TOML_END);
    Ok(replace_managed(&existing, TOML_START, TOML_END, &block))
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn codex_server_value(connection: &ConnectionDefinition) -> toml::Value {
    let mut server = toml::map::Map::new();
    match &connection.transport {
        ConnectionTransport::Stdio { command, args } => {
            server.insert("command".into(), toml::Value::String(command.clone()));
            server.insert(
                "args".into(),
                toml::Value::Array(args.iter().cloned().map(toml::Value::String).collect()),
            );
        }
        ConnectionTransport::Http { url } => {
            server.insert(
                "url".into(),
                toml::Value::String(agent_url(url, AgentKind::Codex)),
            );
        }
    }
    if !connection.allow_tools.is_empty() {
        server.insert(
            "enabled_tools".into(),
            toml::Value::Array(
                connection
                    .allow_tools
                    .iter()
                    .cloned()
                    .map(toml::Value::String)
                    .collect(),
            ),
        );
    }
    toml::Value::Table(server)
}
fn safe_key(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn merge_claude_mcp(path: &Path, connections: &[ConnectionDefinition]) -> Result<String> {
    merge_mcp_json(path, connections, AgentKind::ClaudeCode)
}

fn merge_opencode_config(
    path: &Path,
    connections: &[ConnectionDefinition],
    include_instructions: bool,
) -> Result<String> {
    let mut root = read_json_object(path)?;
    root.entry("$schema")
        .or_insert_with(|| "https://opencode.ai/config.json".into());
    if include_instructions {
        let instructions = root
            .entry("instructions")
            .or_insert_with(|| JsonValue::Array(Vec::new()))
            .as_array_mut()
            .context("OpenCode instructions must be an array")?;
        let managed = JsonValue::String(".opencode/agentkib-instructions.md".into());
        if !instructions.contains(&managed) {
            instructions.push(managed);
        }
    }
    let servers = root
        .entry("mcp")
        .or_insert_with(|| JsonValue::Object(JsonMap::new()))
        .as_object_mut()
        .context("OpenCode mcp must be an object")?;
    for connection in connections
        .iter()
        .filter(|value| targeted(value, AgentKind::OpenCode))
    {
        merge_json_server(servers, connection, AgentKind::OpenCode);
    }
    Ok(format!("{}\n", serde_json::to_string_pretty(&root)?))
}

fn merge_mcp_json(
    path: &Path,
    connections: &[ConnectionDefinition],
    agent: AgentKind,
) -> Result<String> {
    let mut root = read_json_object(path)?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| JsonValue::Object(JsonMap::new()))
        .as_object_mut()
        .context("mcpServers must be an object")?;
    for connection in connections.iter().filter(|value| targeted(value, agent)) {
        merge_json_server(servers, connection, agent);
    }
    Ok(format!("{}\n", serde_json::to_string_pretty(&root)?))
}

fn merge_openclaw(path: &Path, connections: &[ConnectionDefinition]) -> Result<String> {
    let mut root = read_json_object(path)?;
    let mcp = root
        .entry("mcp")
        .or_insert_with(|| JsonValue::Object(JsonMap::new()))
        .as_object_mut()
        .context("OpenClaw mcp must be an object")?;
    let servers = mcp
        .entry("servers")
        .or_insert_with(|| JsonValue::Object(JsonMap::new()))
        .as_object_mut()
        .context("OpenClaw mcp.servers must be an object")?;
    for connection in connections
        .iter()
        .filter(|value| targeted(value, AgentKind::OpenClaw))
    {
        merge_json_server(servers, connection, AgentKind::OpenClaw);
    }
    Ok(format!("{}\n", serde_json::to_string_pretty(&root)?))
}

fn merge_json_server(
    servers: &mut JsonMap<String, JsonValue>,
    connection: &ConnectionDefinition,
    agent: AgentKind,
) {
    let generated = connection_json(connection, agent);
    let existing = servers
        .entry(connection.name.clone())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if let (Some(existing), Some(generated)) = (existing.as_object_mut(), generated.as_object()) {
        for (key, value) in generated {
            existing.insert(key.clone(), value.clone());
        }
    } else {
        *existing = generated;
    }
}

fn connection_json(connection: &ConnectionDefinition, agent: AgentKind) -> JsonValue {
    let mut value = JsonMap::new();
    match &connection.transport {
        ConnectionTransport::Stdio { command, args } => {
            if agent == AgentKind::OpenCode {
                value.insert("type".into(), "local".into());
                value.insert(
                    "command".into(),
                    serde_json::json!(std::iter::once(command).chain(args).collect::<Vec<_>>()),
                );
                value.insert("enabled".into(), true.into());
            } else {
                value.insert("command".into(), command.clone().into());
                value.insert("args".into(), serde_json::json!(args));
            }
        }
        ConnectionTransport::Http { url } => {
            value.insert("url".into(), agent_url(url, agent).into());
            match agent {
                AgentKind::ClaudeCode => {
                    value.insert("type".into(), "http".into());
                }
                AgentKind::OpenClaw => {
                    value.insert("transport".into(), "streamable-http".into());
                }
                AgentKind::OpenCode => {
                    value.insert("type".into(), "remote".into());
                    value.insert("enabled".into(), true.into());
                }
                AgentKind::Codex
                | AgentKind::Cursor
                | AgentKind::Hermes
                | AgentKind::GrokBuild
                | AgentKind::DeepSeekHarness => {}
            }
        }
    }
    if !connection.env.is_empty() {
        let key = if agent == AgentKind::OpenCode {
            "environment"
        } else {
            "env"
        };
        value.insert(key.into(), serde_json::json!(connection.env));
    }
    if !connection.allow_tools.is_empty() {
        value.insert(
            "tools".into(),
            serde_json::json!({ "include": connection.allow_tools }),
        );
    }
    JsonValue::Object(value)
}

fn agent_url(url: &str, agent: AgentKind) -> String {
    let slug = match agent {
        AgentKind::Codex => "codex",
        AgentKind::ClaudeCode => "claude-code",
        AgentKind::Cursor => "cursor",
        AgentKind::OpenCode => "opencode",
        AgentKind::OpenClaw => "open-claw",
        AgentKind::Hermes => "hermes",
        AgentKind::GrokBuild => "grok-build",
        AgentKind::DeepSeekHarness => "deepseek-harness",
    };
    url.replace("{agent}", slug)
}

fn read_json_object(path: &Path) -> Result<JsonMap<String, JsonValue>> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "{}".into(),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Could not read JSON configuration: {}", path.display()));
        }
    };
    let is_jsonc = path.extension().and_then(|value| value.to_str()) == Some("jsonc");
    let value: JsonValue = if is_jsonc {
        json5::from_str(&content).with_context(|| format!("Invalid JSONC: {}", path.display()))?
    } else {
        serde_json::from_str(&content)
            .with_context(|| format!("Invalid JSON: {}", path.display()))?
    };
    value
        .as_object()
        .cloned()
        .context("JSON root must be an object")
}

fn merge_hermes(
    path: &Path,
    project: &Path,
    connections: &[ConnectionDefinition],
) -> Result<String> {
    let content = fs::read_to_string(path).unwrap_or_else(|_| "{}".into());
    let mut root: serde_yaml::Mapping = serde_yaml::from_str(&content)
        .with_context(|| format!("Invalid YAML: {}", path.display()))?;
    let servers_key = serde_yaml::Value::String("mcp_servers".into());
    let servers = root
        .entry(servers_key)
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()))
        .as_mapping_mut()
        .context("Hermes mcp_servers must be an object")?;
    for connection in connections
        .iter()
        .filter(|value| targeted(value, AgentKind::Hermes))
    {
        servers.insert(
            serde_yaml::Value::String(connection.name.clone()),
            serde_yaml::to_value(connection_json(connection, AgentKind::Hermes))?,
        );
    }
    let skills_key = serde_yaml::Value::String("external_skill_dirs".into());
    let skills = root
        .entry(skills_key)
        .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .context("Hermes external_skill_dirs must be an array")?;
    let shared = serde_yaml::Value::String(project.join(".agents/skills").display().to_string());
    if !skills.contains(&shared) {
        skills.push(shared);
    }
    Ok(serde_yaml::to_string(&root)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn continuation_gateway_only_changes_selected_codex_config() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".codex")).unwrap();
        fs::write(
            dir.path().join(".codex/config.toml"),
            "model = \"gpt-test\"\n\n[mcp_servers.other]\nurl = \"http://example.test\"\n",
        )
        .unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "keep me\n").unwrap();

        let plan =
            plan_continuation_gateway(dir.path(), AgentKind::Codex, "workspace-1", 47653).unwrap();

        assert_eq!(plan.changes.len(), 1);
        let change = &plan.changes[0];
        assert!(change.target.ends_with(".codex/config.toml"));
        assert!(change.after.contains("model = \"gpt-test\""));
        assert!(change.after.contains("[mcp_servers.other]"));
        assert!(change.after.contains("/workspace-1/agents/codex"));
        assert!(!plan.requires_home_approval);
    }

    #[test]
    fn continuation_gateway_preserves_other_managed_codex_servers() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".codex")).unwrap();
        let config = dir.path().join(".codex/config.toml");
        fs::write(
            &config,
            "model = \"gpt-test\"\n\n[mcp_servers.unmanaged]\ncommand = \"keep\"\n\n# agentkib:managed:start\n[mcp_servers.team_tools]\ncommand = \"team\"\nargs = [\"check\"]\nfuture = 42\n\n[mcp_servers.agentkib]\nurl = \"http://127.0.0.1:1234/old\"\n# agentkib:managed:end\n",
        )
        .unwrap();

        let plan =
            plan_continuation_gateway(dir.path(), AgentKind::Codex, "workspace-3", 47653).unwrap();

        assert_eq!(plan.changes.len(), 1);
        let after: toml::Value = toml::from_str(&plan.changes[0].after).unwrap();
        assert_eq!(
            after["mcp_servers"]["unmanaged"]["command"].as_str(),
            Some("keep")
        );
        assert_eq!(
            after["mcp_servers"]["team_tools"]["command"].as_str(),
            Some("team")
        );
        assert_eq!(
            after["mcp_servers"]["team_tools"]["args"].as_array(),
            Some(&vec![toml::Value::String("check".into())])
        );
        assert_eq!(
            after["mcp_servers"]["team_tools"]["future"].as_integer(),
            Some(42)
        );
        assert_eq!(
            after["mcp_servers"]["agentkib"]["url"].as_str(),
            Some("http://127.0.0.1:47653/mcp/v1/workspaces/workspace-3/agents/codex")
        );

        fs::write(&config, &plan.changes[0].after).unwrap();
        let repeated =
            plan_continuation_gateway(dir.path(), AgentKind::Codex, "workspace-3", 47653).unwrap();
        assert!(repeated.changes.is_empty());
    }

    #[test]
    fn continuation_gateway_rejects_an_incomplete_managed_codex_block() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".codex")).unwrap();
        let config = dir.path().join(".codex/config.toml");
        let before = "# agentkib:managed:start\n[mcp_servers.team_tools]\ncommand = \"team\"\n";
        fs::write(&config, before).unwrap();

        let error = plan_continuation_gateway(dir.path(), AgentKind::Codex, "workspace-4", 47653)
            .unwrap_err();

        assert!(error.to_string().contains("block is incomplete"));
        assert_eq!(fs::read_to_string(config).unwrap(), before);
    }

    #[test]
    fn continuation_gateway_rejects_an_unmanaged_codex_name_collision_outside_the_block() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".codex")).unwrap();
        let config = dir.path().join(".codex/config.toml");
        let before = "[mcp_servers.agentkib]\ncommand = \"user-managed\"\n\n# agentkib:managed:start\n[mcp_servers.team_tools]\ncommand = \"team\"\n# agentkib:managed:end\n";
        fs::write(&config, before).unwrap();

        let error = plan_continuation_gateway(dir.path(), AgentKind::Codex, "workspace-5", 47653)
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("unmanaged MCP with the same name")
        );
        assert_eq!(fs::read_to_string(config).unwrap(), before);
    }

    #[test]
    fn continuation_gateway_rejects_ambiguous_managed_codex_markers() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".codex")).unwrap();
        let config = dir.path().join(".codex/config.toml");
        let before = "# agentkib:managed:end\n# agentkib:managed:start\n[mcp_servers.team_tools]\ncommand = \"team\"\n# agentkib:managed:end\n";
        fs::write(&config, before).unwrap();

        let error = plan_continuation_gateway(dir.path(), AgentKind::Codex, "workspace-6", 47653)
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("block is incomplete or ambiguous")
        );
        assert_eq!(fs::read_to_string(config).unwrap(), before);
    }

    #[test]
    fn continuation_gateway_preserves_unknown_claude_configuration() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join(".mcp.json"),
            r#"{"custom":true,"mcpServers":{"other":{"command":"other"}}}"#,
        )
        .unwrap();

        let plan =
            plan_continuation_gateway(dir.path(), AgentKind::ClaudeCode, "workspace-2", 47653)
                .unwrap();

        assert_eq!(plan.changes.len(), 1);
        let after: serde_json::Value = serde_json::from_str(&plan.changes[0].after).unwrap();
        assert_eq!(after["custom"], true);
        assert_eq!(after["mcpServers"]["other"]["command"], "other");
        assert_eq!(
            after["mcpServers"]["agentkib"]["url"],
            "http://127.0.0.1:47653/mcp/v1/workspaces/workspace-2/agents/claude-code"
        );
    }

    #[test]
    fn continuation_gateway_rejects_other_agents() {
        let dir = tempdir().unwrap();
        assert!(
            plan_continuation_gateway(dir.path(), AgentKind::Cursor, "workspace", 47653).is_err()
        );
    }

    #[test]
    fn preserves_unmanaged_markdown() {
        let existing = "# User content\n";
        let first = managed_markdown(existing, "Shared");
        let second = managed_markdown(&first, "Updated");
        assert!(second.contains("# User content"));
        assert!(second.contains("Updated"));
        assert!(!second.contains("Shared\n"));
    }

    #[test]
    fn default_manifest_does_not_invent_shared_instructions() {
        let dir = tempdir().unwrap();
        let manifest = default_manifest(dir.path()).unwrap();

        assert!(manifest.instructions.shared.is_empty());
        assert!(!agentkib_core::manifest_path(dir.path()).exists());
        assert!(manifest.adapters[&AgentKind::GrokBuild].enabled);
    }

    #[test]
    fn default_manifest_uses_the_skill_frontmatter_name() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".agents/skills/folder-name")).unwrap();
        fs::write(
            dir.path().join(".agents/skills/folder-name/SKILL.md"),
            "---\nname: logical-name\n---\nBody",
        )
        .unwrap();

        let manifest = default_manifest(dir.path()).unwrap();

        assert_eq!(manifest.skills.len(), 1);
        assert_eq!(manifest.skills[0].name, "logical-name");
        assert_eq!(manifest.skills[0].path, ".agents/skills/folder-name");
    }

    #[test]
    fn legacy_manifest_without_grok_adapter_does_not_write_grok_files() {
        let dir = tempdir().unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.adapters.remove(&AgentKind::GrokBuild);

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();

        assert!(
            plan.changes
                .iter()
                .all(|change| !change.target.to_string_lossy().contains(".grok"))
        );
    }

    #[test]
    fn legacy_manifest_without_opencode_adapter_does_not_write_opencode_files() {
        let dir = tempdir().unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.adapters.remove(&AgentKind::OpenCode);

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();

        assert!(
            plan.changes
                .iter()
                .all(|change| !has_path_component(&change.target, ".opencode"))
        );
    }

    #[test]
    fn grok_build_writes_native_skills_and_preserves_unmanaged_toml() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".agents/skills/reviewer")).unwrap();
        fs::write(
            dir.path().join(".agents/skills/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join(".grok")).unwrap();
        fs::write(
            dir.path().join(".grok/config.toml"),
            "model = \"grok-code\"\n\n[mcp_servers.keep]\ncommand = \"keep\"\n",
        )
        .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.connections.push(ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Http {
                url: "http://127.0.0.1/workspaces/ws/agents/{agent}".into(),
            },
            env: BTreeMap::new(),
            allow_tools: Vec::new(),
            targets: vec![AgentKind::GrokBuild],
        });

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        assert!(plan.changes.iter().any(|change| {
            change.target.ends_with(".grok/skills/reviewer/SKILL.md")
                && change.after == "# Reviewer"
        }));
        let config = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".grok/config.toml"))
            .unwrap();
        assert!(config.after.contains("model = \"grok-code\""));
        assert!(config.after.contains("[mcp_servers.keep]"));
        assert!(config.after.contains("/agents/grok-build"));
    }

    #[test]
    fn grok_build_rejects_unmanaged_mcp_name_collision() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            "[mcp_servers.agentkib] # local gateway\nurl = \"https://user.example/mcp\"\n",
        )
        .unwrap();
        let connections = [ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Http {
                url: "http://127.0.0.1/{agent}".into(),
            },
            env: BTreeMap::new(),
            allow_tools: Vec::new(),
            targets: vec![AgentKind::GrokBuild],
        }];

        assert!(
            merge_grok_config(&path, &connections)
                .unwrap_err()
                .to_string()
                .contains("unmanaged MCP")
        );
    }

    #[test]
    fn first_import_wraps_matching_content_without_duplication() {
        let output = managed_markdown("# Shared\n", "# Shared");
        assert_eq!(output.matches("# Shared").count(), 1);
        assert!(output.contains(START));
    }

    #[test]
    fn first_import_separates_platform_overrides() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Shared rules\n").unwrap();
        fs::write(
            dir.path().join("CLAUDE.md"),
            "@AGENTS.md\n\nUse Claude-specific tools.\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("AGENTS.override.md"),
            "Shared rules\n\nUse Codex sandbox.\n",
        )
        .unwrap();
        fs::write(dir.path().join("HERMES.md"), "Hermes project rule.\n").unwrap();

        let manifest = default_manifest(dir.path()).unwrap();
        assert_eq!(manifest.instructions.shared, "Shared rules\n");
        assert_eq!(
            manifest.instructions.platform_overrides[&AgentKind::ClaudeCode],
            "Use Claude-specific tools."
        );
        assert_eq!(
            manifest.instructions.platform_overrides[&AgentKind::Codex],
            "Use Codex sandbox."
        );
        assert_eq!(
            manifest.instructions.platform_overrides[&AgentKind::Hermes],
            "Hermes project rule."
        );
    }

    #[test]
    fn first_import_ignores_unregistered_opencode_override() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".opencode")).unwrap();
        fs::write(
            dir.path().join(".opencode/agentkib-instructions.md"),
            managed_markdown("", "Use OpenCode tools."),
        )
        .unwrap();

        let unregistered = default_manifest(dir.path()).unwrap();
        assert!(
            !unregistered
                .instructions
                .platform_overrides
                .contains_key(&AgentKind::OpenCode)
        );

        fs::write(
            dir.path().join(".opencode/opencode.jsonc"),
            "{ instructions: ['.opencode/*.md'] }",
        )
        .unwrap();
        let registered = default_manifest(dir.path()).unwrap();
        assert_eq!(
            registered.instructions.platform_overrides[&AgentKind::OpenCode],
            "Use OpenCode tools."
        );
    }

    #[test]
    fn first_import_discovers_nested_agents_rules() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Root rules\n").unwrap();
        fs::create_dir_all(dir.path().join("packages/api")).unwrap();
        fs::write(
            dir.path().join("packages/api/AGENTS.md"),
            "API package rules\n",
        )
        .unwrap();

        let manifest = default_manifest(dir.path()).unwrap();
        assert_eq!(manifest.instructions.scoped.len(), 1);
        assert_eq!(manifest.instructions.scoped[0].path, "packages/api");
        assert_eq!(
            manifest.instructions.scoped[0].content,
            "API package rules\n"
        );
    }

    #[test]
    fn plan_contains_all_project_adapters() {
        let dir = tempdir().unwrap();
        let manifest = default_manifest(dir.path()).unwrap();
        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        let names: Vec<_> = plan
            .changes
            .iter()
            .filter_map(|c| c.target.file_name()?.to_str())
            .collect();
        assert!(names.contains(&"AGENTS.md"));
        assert!(names.contains(&"CLAUDE.md"));
        assert!(names.contains(&"config.toml"));
        assert!(names.contains(&".mcp.json"));
        assert!(
            plan.changes
                .iter()
                .any(|change| change.target.ends_with(".cursor/mcp.json"))
        );
        assert!(
            plan.changes
                .iter()
                .any(|change| change.target.ends_with(".opencode/opencode.json"))
        );
    }

    #[test]
    fn opencode_plan_preserves_unknown_config_and_uses_native_gateway_shape() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".opencode")).unwrap();
        fs::write(
            dir.path().join(".opencode/opencode.json"),
            r#"{"theme":"dark","mcp":{"existing":{"type":"remote","url":"https://example.com"}}}"#,
        )
        .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest
            .instructions
            .platform_overrides
            .insert(AgentKind::OpenCode, "Use OpenCode tools.".into());
        manifest.connections.push(ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Http {
                url: "http://127.0.0.1/mcp/{agent}".into(),
            },
            env: BTreeMap::new(),
            allow_tools: Vec::new(),
            targets: vec![AgentKind::OpenCode],
        });

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        assert!(plan.changes.iter().all(|change| {
            matches!(change.scope, ChangeScope::Project)
                && change.target.starts_with(&plan.project_root)
        }));
        let config = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".opencode/opencode.json"))
            .unwrap();
        let value: JsonValue = serde_json::from_str(&config.after).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["mcp"]["existing"]["url"], "https://example.com");
        assert_eq!(value["mcp"]["agentkib"]["type"], "remote");
        assert_eq!(value["mcp"]["agentkib"]["enabled"], true);
        assert_eq!(
            value["mcp"]["agentkib"]["url"],
            "http://127.0.0.1/mcp/opencode"
        );
        assert_eq!(
            value["instructions"],
            serde_json::json!([".opencode/agentkib-instructions.md"])
        );
        let instruction = plan
            .changes
            .iter()
            .find(|change| {
                change
                    .target
                    .ends_with(".opencode/agentkib-instructions.md")
            })
            .unwrap();
        assert!(instruction.after.contains("Use OpenCode tools."));
    }

    #[test]
    fn opencode_plan_updates_the_effective_jsonc_config() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".opencode")).unwrap();
        fs::write(
            dir.path().join(".opencode/opencode.jsonc"),
            "{ theme: 'dark', instructions: ['docs/team.md'] }",
        )
        .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest
            .instructions
            .platform_overrides
            .insert(AgentKind::OpenCode, "Use OpenCode tools.".into());

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        let config = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".opencode/opencode.jsonc"))
            .unwrap();
        let value: JsonValue = serde_json::from_str(&config.after).unwrap();

        assert_eq!(value["theme"], "dark");
        assert_eq!(
            value["instructions"],
            serde_json::json!(["docs/team.md", ".opencode/agentkib-instructions.md"])
        );
        assert!(
            plan.changes
                .iter()
                .all(|change| !change.target.ends_with(".opencode/opencode.json"))
        );
    }

    #[test]
    fn opencode_plan_updates_an_existing_root_config() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("opencode.jsonc"),
            "{ theme: 'dark', instructions: ['docs/team.md'] }",
        )
        .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest
            .instructions
            .platform_overrides
            .insert(AgentKind::OpenCode, "Use OpenCode tools.".into());

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        let config = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with("opencode.jsonc"))
            .unwrap();
        let value: JsonValue = serde_json::from_str(&config.after).unwrap();

        assert!(agentkib_platform::path::equivalent(
            &config.target,
            &dir.path().join("opencode.jsonc")
        ));
        assert_eq!(value["theme"], "dark");
        assert_eq!(
            value["instructions"],
            serde_json::json!(["docs/team.md", ".opencode/agentkib-instructions.md"])
        );
        assert!(
            plan.changes
                .iter()
                .all(|change| !change.target.ends_with(".opencode/opencode.json"))
        );
    }

    #[test]
    fn opencode_plan_does_not_reregister_disabled_managed_instruction() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".opencode")).unwrap();
        fs::write(
            dir.path().join(".opencode/opencode.json"),
            r#"{"instructions":[]}"#,
        )
        .unwrap();
        fs::write(
            dir.path().join(".opencode/agentkib-instructions.md"),
            format!(
                "Unmanaged text.\n\n{}",
                managed_markdown("", "Disabled override.")
            ),
        )
        .unwrap();

        let manifest = default_manifest(dir.path()).unwrap();
        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();

        assert!(plan.changes.iter().all(|change| {
            !change
                .target
                .ends_with(".opencode/agentkib-instructions.md")
        }));
        let config = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".opencode/opencode.json"))
            .unwrap();
        let value: JsonValue = serde_json::from_str(&config.after).unwrap();
        assert_eq!(value["instructions"], serde_json::json!([]));
    }

    #[test]
    fn plan_preserves_hashes_for_unchanged_managed_outputs() {
        let dir = tempdir().unwrap();
        let manifest = default_manifest(dir.path()).unwrap();
        let first = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        let agents = first
            .changes
            .iter()
            .find(|change| change.target.ends_with("AGENTS.md"))
            .unwrap();
        fs::write(&agents.target, &agents.after).unwrap();

        let second =
            plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        assert!(
            second
                .changes
                .iter()
                .all(|change| !change.target.ends_with("AGENTS.md"))
        );
        let manifest_change = second
            .changes
            .iter()
            .find(|change| change.target.ends_with(".agentkib/manifest.yaml"))
            .unwrap();
        let persisted: Manifest = serde_yaml::from_str(&manifest_change.after).unwrap();

        assert!(
            persisted.adapters[&AgentKind::Codex]
                .generated_hashes
                .contains_key("AGENTS.md")
        );
    }

    #[test]
    fn managed_hash_classification_ignores_parent_directory_names() {
        let dir = tempdir().unwrap();
        let project = dir.path().join(".opencode-demo/project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("AGENTS.md"), "Shared rules").unwrap();
        let manifest = default_manifest(&project).unwrap();

        let plan = plan_workspace_changes(&project, &manifest, &HomeTargets::default()).unwrap();
        let manifest_change = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".agentkib/manifest.yaml"))
            .unwrap();
        let persisted: Manifest = serde_yaml::from_str(&manifest_change.after).unwrap();

        for agent in [
            AgentKind::Codex,
            AgentKind::Cursor,
            AgentKind::OpenCode,
            AgentKind::OpenClaw,
            AgentKind::Hermes,
            AgentKind::GrokBuild,
        ] {
            assert!(
                persisted.adapters[&agent]
                    .generated_hashes
                    .contains_key("AGENTS.md")
            );
        }
    }

    #[test]
    fn grok_substring_in_workspace_parent_does_not_misclassify_generated_hashes() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("my.grok-project/repo");
        fs::create_dir_all(&root).unwrap();
        let manifest = default_manifest(&root).unwrap();

        let plan = plan_workspace_changes(&root, &manifest, &HomeTargets::default()).unwrap();
        let manifest_change = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".agentkib/manifest.yaml"))
            .unwrap();
        let persisted: Manifest = serde_yaml::from_str(&manifest_change.after).unwrap();

        for agent in [
            AgentKind::Codex,
            AgentKind::Cursor,
            AgentKind::OpenCode,
            AgentKind::OpenClaw,
            AgentKind::Hermes,
            AgentKind::GrokBuild,
        ] {
            assert!(
                persisted.adapters[&agent]
                    .generated_hashes
                    .contains_key("AGENTS.md")
            );
        }
        assert!(
            persisted.adapters[&AgentKind::Codex]
                .generated_hashes
                .contains_key(".codex/config.toml")
        );
        assert!(
            !persisted.adapters[&AgentKind::GrokBuild]
                .generated_hashes
                .contains_key(".codex/config.toml")
        );
    }

    #[test]
    fn project_plan_preserves_recorded_agent_home_hashes() {
        let dir = tempdir().unwrap();
        let home = tempdir().unwrap();
        let home_config = home.path().join(".openclaw/openclaw.json");
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest
            .adapters
            .get_mut(&AgentKind::OpenClaw)
            .unwrap()
            .generated_hashes
            .insert(
                home_config.display().to_string(),
                "recorded-home-hash".into(),
            );

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        let manifest_change = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".agentkib/manifest.yaml"))
            .unwrap();
        let persisted: Manifest = serde_yaml::from_str(&manifest_change.after).unwrap();

        assert_eq!(
            persisted.adapters[&AgentKind::OpenClaw]
                .generated_hashes
                .get(&home_config.display().to_string())
                .map(String::as_str),
            Some("recorded-home-hash")
        );
    }

    #[test]
    fn cursor_only_skill_is_written_to_the_private_skill_directory() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("skill-sources/reviewer")).unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.skills.push(agentkib_core::SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::Cursor],
        });

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();

        assert!(
            plan.changes
                .iter()
                .any(|change| { change.target.ends_with(".cursor/skills/reviewer/SKILL.md") })
        );
        assert!(
            plan.changes
                .iter()
                .all(|change| { !change.target.ends_with(".agents/skills/reviewer/SKILL.md") })
        );

        manifest
            .adapters
            .get_mut(&AgentKind::Cursor)
            .unwrap()
            .enabled = false;
        let disabled =
            plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        assert!(
            disabled
                .changes
                .iter()
                .all(|change| { !change.target.ends_with("skills/reviewer/SKILL.md") })
        );
    }

    #[test]
    fn cursor_plan_preserves_native_mcp_fields_and_writes_only_platform_override() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".cursor")).unwrap();
        fs::write(
            dir.path().join(".cursor/mcp.json"),
            r#"{"mcpServers":{"agentkib":{"url":"old","cursorOnly":true}},"native":7}"#,
        )
        .unwrap();
        fs::create_dir_all(dir.path().join(".cursor/rules")).unwrap();
        fs::write(
            dir.path().join(".cursor/rules/agentkib.mdc"),
            "---\ndescription: Custom label\nalwaysApply: true\nfutureField: keep\n---\n\n<!-- agentkib:managed:start -->\nOld override\n<!-- agentkib:managed:end -->\n",
        )
        .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.instructions.shared = "Shared project instructions.".into();
        manifest
            .instructions
            .platform_overrides
            .insert(AgentKind::Cursor, "Use Cursor browser tools.".into());
        manifest.connections.push(ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Http {
                url: "http://127.0.0.1:47653/mcp/v1/workspaces/ws/agents/{agent}".into(),
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::Cursor],
        });

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        let mcp = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".cursor/mcp.json"))
            .unwrap();
        let value: JsonValue = serde_json::from_str(&mcp.after).unwrap();
        assert_eq!(value["native"], 7);
        assert_eq!(value["mcpServers"]["agentkib"]["cursorOnly"], true);
        assert!(
            value["mcpServers"]["agentkib"]["url"]
                .as_str()
                .unwrap()
                .ends_with("/cursor")
        );
        let rule = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".cursor/rules/agentkib.mdc"))
            .unwrap();
        assert!(rule.after.contains("alwaysApply: true"));
        assert!(rule.after.contains("futureField: keep"));
        assert!(rule.after.contains("Use Cursor browser tools."));
        assert!(!rule.after.contains(&manifest.instructions.shared));
    }

    #[test]
    fn hermes_merge_preserves_unknown_fields_and_existing_entries() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.yaml");
        fs::write(&config, "theme: dark\nmcp_servers:\n  custom:\n    command: custom\nexternal_skill_dirs:\n  - /existing/skills\n").unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.connections.push(ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "/bin/agentkib-mcp".into(),
                args: vec![],
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::Hermes],
        });
        let merged = merge_hermes(&config, dir.path(), &manifest.connections).unwrap();
        assert!(merged.contains("theme: dark"));
        assert!(merged.contains("custom:"));
        assert!(merged.contains("/existing/skills"));
        assert!(merged.contains("agentkib:"));
    }

    #[test]
    fn claude_merge_preserves_unknown_server_fields() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".mcp.json");
        fs::write(
            &config,
            r#"{"mcpServers":{"agentkib":{"command":"old","platformOnly":true}},"topLevel":7}"#,
        )
        .unwrap();
        let connection = ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "/new".into(),
                args: vec![],
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::ClaudeCode],
        };
        let merged = merge_claude_mcp(&config, &[connection]).unwrap();
        let value: JsonValue = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["topLevel"], 7);
        assert_eq!(value["mcpServers"]["agentkib"]["platformOnly"], true);
        assert_eq!(value["mcpServers"]["agentkib"]["command"], "/new");
    }

    #[test]
    fn openclaw_merge_preserves_unknown_fields() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("openclaw.json");
        fs::write(
            &config,
            r#"{"theme":"dark","mcp":{"servers":{"agentkib":{"command":"old","platformOnly":true}}}}"#,
        )
        .unwrap();
        let connection = ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "/new".into(),
                args: vec![],
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::OpenClaw],
        };
        let merged = merge_openclaw(&config, &[connection]).unwrap();
        let value: JsonValue = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["mcp"]["servers"]["agentkib"]["platformOnly"], true);
        assert_eq!(value["mcp"]["servers"]["agentkib"]["command"], "/new");
    }

    #[test]
    fn hub_http_connection_uses_each_platform_native_shape() {
        let dir = tempdir().unwrap();
        let connection = ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Http {
                url: "http://127.0.0.1:47653/mcp/v1/workspaces/ws/agents/{agent}".into(),
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: AgentKind::WRITABLE.into_iter().collect(),
        };
        let claude: JsonValue = serde_json::from_str(
            &merge_claude_mcp(
                &dir.path().join(".mcp.json"),
                std::slice::from_ref(&connection),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(claude["mcpServers"]["agentkib"]["type"], "http");
        assert!(
            claude["mcpServers"]["agentkib"]["url"]
                .as_str()
                .unwrap()
                .ends_with("/claude-code")
        );

        let openclaw: JsonValue = serde_json::from_str(
            &merge_openclaw(
                &dir.path().join("openclaw.json"),
                std::slice::from_ref(&connection),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            openclaw["mcp"]["servers"]["agentkib"]["transport"],
            "streamable-http"
        );
        assert!(
            openclaw["mcp"]["servers"]["agentkib"]["url"]
                .as_str()
                .unwrap()
                .ends_with("/open-claw")
        );

        let codex = merge_codex_config(
            &dir.path().join("config.toml"),
            std::slice::from_ref(&connection),
        )
        .unwrap();
        assert!(codex.contains("/agents/codex"));

        let hermes = merge_hermes(
            &dir.path().join("hermes.yaml"),
            dir.path(),
            std::slice::from_ref(&connection),
        )
        .unwrap();
        assert!(hermes.contains("/agents/hermes"));
    }

    #[test]
    fn opencode_stdio_connection_uses_command_array_and_environment() {
        let dir = tempdir().unwrap();
        let connection = ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "agentkib-mcp".into(),
                args: vec!["serve".into()],
            },
            env: BTreeMap::from([("MODE".into(), "local".into())]),
            allow_tools: Vec::new(),
            targets: vec![AgentKind::OpenCode],
        };

        let merged =
            merge_opencode_config(&dir.path().join("opencode.json"), &[connection], false).unwrap();
        let value: JsonValue = serde_json::from_str(&merged).unwrap();

        assert_eq!(value["mcp"]["agentkib"]["type"], "local");
        assert_eq!(
            value["mcp"]["agentkib"]["command"],
            serde_json::json!(["agentkib-mcp", "serve"])
        );
        assert_eq!(value["mcp"]["agentkib"]["environment"]["MODE"], "local");
    }

    #[test]
    fn mcp_merge_keeps_json_strict_and_accepts_explicit_jsonc() {
        let dir = tempdir().unwrap();
        let strict = dir.path().join("mcp.json");
        fs::write(&strict, r#"{"mcpServers": {},}"#).unwrap();
        let strict_error = merge_mcp_json(&strict, &[], AgentKind::Cursor).unwrap_err();
        assert!(strict_error.to_string().contains("Invalid JSON"));

        let jsonc = dir.path().join("opencode.jsonc");
        fs::write(&jsonc, "{ // supported comment\n mcp: {},\n}").unwrap();
        let merged = merge_opencode_config(&jsonc, &[], false).unwrap();
        let value: JsonValue = serde_json::from_str(&merged).unwrap();
        assert!(value["mcp"].is_object());
    }

    #[test]
    fn legacy_connections_are_migrated_to_v2_hub_config() {
        let dir = tempdir().unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.schema_version = 1;
        manifest.connections.push(ConnectionDefinition {
            name: "filesystem".into(),
            transport: ConnectionTransport::Stdio {
                command: "node".into(),
                args: vec!["server.js".into()],
            },
            env: BTreeMap::new(),
            allow_tools: vec!["read_file".into()],
            targets: vec![AgentKind::Codex],
        });
        manifest.connections.push(ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Http {
                url: "http://127.0.0.1:47653/mcp/v1/workspaces/ws/agents/{agent}".into(),
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: AgentKind::WRITABLE.into_iter().collect(),
        });
        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        let mcp = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".agentkib/mcp.json"))
            .unwrap();
        assert!(mcp.after.contains("filesystem"));
        let persisted = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".agentkib/manifest.yaml"))
            .unwrap();
        let persisted: Manifest = serde_yaml::from_str(&persisted.after).unwrap();
        assert_eq!(persisted.schema_version, 2);
        assert!(persisted.connections.is_empty());
    }

    #[test]
    fn codex_duplicate_unmanaged_mcp_is_reported_without_rewriting() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        fs::write(
            &config,
            "theme = \"dark\"\n\n[mcp_servers.agentkib]\ncommand = \"custom\"\nplatform_only = true\n",
        )
        .unwrap();
        let connection = ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "/new".into(),
                args: vec![],
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::Codex],
        };

        let error = merge_codex_config(&config, &[connection]).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unmanaged MCP with the same name")
        );
        assert!(
            fs::read_to_string(config)
                .unwrap()
                .contains("platform_only = true")
        );
    }

    #[test]
    fn copies_complete_skill_directory_to_claude() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("shared/reviewer");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join("SKILL.md"), "# Reviewer").unwrap();
        fs::write(source.join("references/checklist.md"), "- Run tests").unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.skills.push(agentkib_core::SkillDefinition {
            name: "reviewer".into(),
            path: "shared/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        assert!(plan.changes.iter().any(|change| {
            change.target.ends_with(".claude/skills/reviewer/SKILL.md")
                && change.after == "# Reviewer"
        }));
        assert!(plan.changes.iter().any(|change| {
            change
                .target
                .ends_with(".claude/skills/reviewer/references/checklist.md")
                && change.after == "- Run tests"
        }));
    }

    #[test]
    fn rejects_skill_sources_without_skill_md_entrypoint() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("shared/directory-skill")).unwrap();
        fs::write(
            dir.path().join("shared/directory-skill/reviewer.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::write(dir.path().join("shared/reviewer.md"), "# Reviewer").unwrap();

        for path in ["shared/directory-skill", "shared/reviewer.md"] {
            let mut manifest = default_manifest(dir.path()).unwrap();
            manifest.skills.push(agentkib_core::SkillDefinition {
                name: "reviewer".into(),
                path: path.into(),
                targets: vec![AgentKind::ClaudeCode],
            });

            assert!(
                plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default())
                    .unwrap_err()
                    .to_string()
                    .contains("SKILL.md")
            );
        }
    }

    #[test]
    fn rejects_oversized_skill_assets_before_reading_them() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("shared/reviewer");
        fs::create_dir_all(&source).unwrap();
        fs::File::create(source.join("SKILL.md"))
            .unwrap()
            .set_len(MAX_SKILL_FILE_BYTES + 1)
            .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.skills.push(agentkib_core::SkillDefinition {
            name: "reviewer".into(),
            path: "shared/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });

        assert!(
            plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default())
                .unwrap_err()
                .to_string()
                .contains("8 MiB read limit")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_links_inside_skill_sources() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("shared/reviewer");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "# Reviewer").unwrap();
        fs::write(dir.path().join("shared/reference.md"), "Reference").unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("shared/reference.md"),
            source.join("reference.md"),
        )
        .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.skills.push(agentkib_core::SkillDefinition {
            name: "reviewer".into(),
            path: "shared/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });

        assert!(
            plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default())
                .unwrap_err()
                .to_string()
                .contains("symbolic links")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_link_ancestors_of_skill_sources() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("real-shared/reviewer")).unwrap();
        fs::write(
            dir.path().join("real-shared/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        std::os::unix::fs::symlink(dir.path().join("real-shared"), dir.path().join("shared"))
            .unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.skills.push(agentkib_core::SkillDefinition {
            name: "reviewer".into(),
            path: "shared/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });

        assert!(
            plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default())
                .unwrap_err()
                .to_string()
                .contains("symbolic links")
        );
    }

    #[test]
    fn handoff_export_is_project_scoped_and_ignored_by_git() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
        let plan = plan_handoff_export(dir.path(), "handoff.md", "# Handoff\n").unwrap();
        assert!(!plan.requires_home_approval);
        assert!(plan.changes.iter().any(|change| {
            change.target.ends_with(".agentkib/handoffs/handoff.md")
                && matches!(change.scope, ChangeScope::Project)
        }));
        assert!(plan.changes.iter().any(|change| {
            change.target.ends_with(".gitignore") && change.after.contains(".agentkib/handoffs/")
        }));
    }

    #[test]
    fn handoff_export_rejects_oversized_gitignore() {
        let dir = tempdir().unwrap();
        fs::File::create(dir.path().join(".gitignore"))
            .unwrap()
            .set_len(MAX_HANDOFF_GITIGNORE_BYTES + 1)
            .unwrap();

        let error = plan_handoff_export(dir.path(), "handoff.md", "# Handoff\n").unwrap_err();
        assert!(error.to_string().contains("exceeds the 1 MiB read limit"));
    }

    #[test]
    fn handoff_export_rejects_non_regular_gitignore() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".gitignore")).unwrap();

        let error = plan_handoff_export(dir.path(), "handoff.md", "# Handoff\n").unwrap_err();
        assert!(error.to_string().contains("must be a regular file"));
    }

    #[test]
    fn handoff_export_rejects_path_traversal_and_wrong_extensions() {
        let dir = tempdir().unwrap();
        assert!(plan_handoff_export(dir.path(), "../private.md", "text").is_err());
        assert!(plan_handoff_export(dir.path(), "handoff.txt", "text").is_err());
    }
}
