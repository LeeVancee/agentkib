use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};

use agentkib_core::{
    AgentKind, ChangeScope, ChangeSet, FileChange, McpConfigDocument, McpMigrationCandidate,
    McpServerConfig, McpServerTransport, RiskLevel, encode_url_path_segment, hash_content,
};
use agentkib_platform::path::{canonicalize, starts_with as path_starts_with};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub fn scan_native_candidates(project: Option<&Path>) -> Result<Vec<McpMigrationCandidate>> {
    let grok_home = grok_home();
    scan_native_candidates_with_grok_home(project, grok_home.as_deref())
}

fn scan_native_candidates_with_grok_home(
    project: Option<&Path>,
    grok_home: Option<&Path>,
) -> Result<Vec<McpMigrationCandidate>> {
    let mut candidates = Vec::new();
    if let Some(project) = project {
        scan_codex(
            &project.join(".codex/config.toml"),
            "project",
            &mut candidates,
        )?;
        scan_toml_servers(
            &project.join(".grok/config.toml"),
            AgentKind::GrokBuild,
            "project",
            &mut candidates,
        )?;
        scan_json_servers(
            &project.join(".mcp.json"),
            AgentKind::ClaudeCode,
            "project",
            &["mcpServers"],
            &mut candidates,
        )?;
        scan_json_servers(
            &project.join(".cursor/mcp.json"),
            AgentKind::Cursor,
            "project",
            &["mcpServers"],
            &mut candidates,
        )?;
        for path in [
            project.join("opencode.json"),
            project.join("opencode.jsonc"),
            project.join(".opencode/opencode.json"),
            project.join(".opencode/opencode.jsonc"),
        ] {
            scan_opencode_servers(&path, "project", &mut candidates)?;
        }
    }
    if let Some(home) = dirs::home_dir() {
        scan_codex(&home.join(".codex/config.toml"), "home", &mut candidates)?;
        scan_json_servers(
            &home.join(".claude.json"),
            AgentKind::ClaudeCode,
            "home",
            &["mcpServers"],
            &mut candidates,
        )?;
        scan_json_servers(
            &home.join(".cursor/mcp.json"),
            AgentKind::Cursor,
            "home",
            &["mcpServers"],
            &mut candidates,
        )?;
        scan_json5_servers(
            &home.join(".openclaw/openclaw.json"),
            AgentKind::OpenClaw,
            "home",
            &["mcp", "servers"],
            &mut candidates,
        )?;
        scan_hermes(&home.join(".hermes/config.yaml"), "home", &mut candidates)?;
    }
    if let Some(config_home) = agentkib_platform::xdg::config_home()
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .map(|home| home.join("opencode"))
    {
        for name in ["opencode.json", "opencode.jsonc"] {
            scan_opencode_servers(&config_home.join(name), "home", &mut candidates)?;
        }
    }
    if let Some(home) = grok_home {
        scan_toml_servers(
            &home.join("config.toml"),
            AgentKind::GrokBuild,
            "home",
            &mut candidates,
        )?;
    }
    let mut seen = HashSet::new();
    candidates
        .retain(|candidate| candidate.name != "agentkib" && seen.insert(candidate.id.clone()));
    mark_layered_opencode_candidates_unsupported(&mut candidates);
    candidates.sort_by(|left, right| {
        left.agent
            .cmp(&right.agent)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(candidates)
}

pub fn has_agentkib_gateway(
    project: &Path,
    agent: AgentKind,
    workspace_id: &str,
    port: u16,
) -> Result<bool> {
    let endpoint = match agent {
        AgentKind::Codex => {
            let path = project.join(".codex/config.toml");
            if !path.is_file() {
                return Ok(false);
            }
            let value: toml::Value = toml::from_str(&std::fs::read_to_string(path)?)?;
            value
                .get("mcp_servers")
                .and_then(toml::Value::as_table)
                .and_then(|servers| servers.get("agentkib"))
                .and_then(|server| server.get("url"))
                .and_then(toml::Value::as_str)
                .map(str::to_owned)
        }
        AgentKind::ClaudeCode => {
            let path = project.join(".mcp.json");
            if !path.is_file() {
                return Ok(false);
            }
            let value: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
            value
                .pointer("/mcpServers/agentkib/url")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        _ => return Ok(false),
    };
    let Some(endpoint) = endpoint else {
        return Ok(false);
    };
    let slug = match agent {
        AgentKind::Codex => "codex",
        AgentKind::ClaudeCode => "claude-code",
        _ => unreachable!(),
    };
    let workspace_segment = encode_url_path_segment(workspace_id);
    let route = format!("/mcp/v1/workspaces/{workspace_segment}/agents/{slug}");
    Ok(endpoint == format!("http://127.0.0.1:{port}{route}")
        || endpoint == format!("http://localhost:{port}{route}"))
}

pub fn migration_server(candidate: &McpMigrationCandidate) -> Result<McpServerConfig> {
    if !candidate.supported {
        bail!("Unsupported native MCP candidate cannot be migrated automatically");
    }
    let mut server = match candidate.agent {
        AgentKind::Codex => codex_server(candidate)?,
        AgentKind::ClaudeCode => json_server(candidate, &["mcpServers"], false)?,
        AgentKind::Cursor => json_server(candidate, &["mcpServers"], false)?,
        AgentKind::OpenCode => opencode_server(candidate)?,
        AgentKind::OpenClaw => json_server(candidate, &["mcp", "servers"], true)?,
        AgentKind::Hermes => hermes_server(candidate)?,
        AgentKind::GrokBuild => toml_server(candidate, "Grok Build")?,
        AgentKind::DeepSeekHarness => {
            bail!("DeepSeek Harness Beta native MCP migration is not supported")
        }
    };
    server.targets = vec![candidate.agent];
    Ok(server)
}

pub fn plan_migration(
    project: &Path,
    candidate_ids: &[String],
    servers: &[McpServerConfig],
    gateway_url: &str,
) -> Result<ChangeSet> {
    let project = canonicalize(project)?;
    let candidates = scan_native_candidates(Some(&project))?;
    let selected: Vec<_> = candidates
        .iter()
        .filter(|candidate| candidate_ids.contains(&candidate.id))
        .collect();
    if selected.len() != candidate_ids.len() {
        bail!("One or more native MCP candidates changed; scan again");
    }
    if selected.iter().any(|candidate| !candidate.supported) {
        bail!("Unsupported native MCP candidates cannot be migrated automatically");
    }

    let target = project.join(".agentkib/mcp.json");
    let before = std::fs::read_to_string(&target).unwrap_or_default();
    let mut document = if before.trim().is_empty() {
        McpConfigDocument::default()
    } else {
        serde_json::from_str(&before)?
    };
    for server in servers {
        let mut public = server.clone();
        public.env.clear();
        public.headers.clear();
        public.oauth_credentials = None;
        public.local_config_path = None;
        if let Some(existing) = document
            .servers
            .iter_mut()
            .find(|value| value.id == public.id)
        {
            *existing = public;
        } else {
            document.servers.push(public);
        }
    }
    document
        .servers
        .sort_by(|left, right| left.name.cmp(&right.name));
    let mut changes = vec![file_change(
        &target,
        &before,
        format!("{}\n", serde_json::to_string_pretty(&document)?),
        ChangeScope::Project,
        RiskLevel::Medium,
        "json",
    )];

    let mut source_paths: Vec<_> = selected
        .iter()
        .map(|candidate| candidate.source_path.clone())
        .collect();
    source_paths.sort();
    source_paths.dedup();
    for source in source_paths {
        let source_candidates: Vec<_> = selected
            .iter()
            .filter(|candidate| candidate.source_path == source)
            .copied()
            .collect();
        let before = std::fs::read_to_string(&source)?;
        let after = remove_native_candidates(&before, &source_candidates, gateway_url)?;
        let in_project = path_starts_with(&source, &project);
        changes.push(file_change(
            &source,
            &before,
            after,
            if in_project {
                ChangeScope::Project
            } else {
                ChangeScope::AgentHome
            },
            if in_project {
                RiskLevel::Medium
            } else {
                RiskLevel::High
            },
            validator_for(&source),
        ));
    }
    let requires_home_approval = changes
        .iter()
        .any(|change| matches!(change.scope, ChangeScope::AgentHome));
    Ok(ChangeSet {
        id: Uuid::new_v4().to_string(),
        project_root: project,
        created_at: Utc::now(),
        changes,
        requires_home_approval,
    })
}

fn file_change(
    target: &Path,
    before: &str,
    after: String,
    scope: ChangeScope,
    risk: RiskLevel,
    validator: &str,
) -> FileChange {
    FileChange {
        target: target.to_path_buf(),
        scope,
        original_hash: target.exists().then(|| hash_content(before.as_bytes())),
        before: before.to_string(),
        after,
        risk,
        validator: validator.into(),
    }
}

fn validator_for(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("toml") => "toml",
        Some("yaml" | "yml") => "yaml",
        _ => "json",
    }
}

fn scan_codex(path: &Path, scope: &str, output: &mut Vec<McpMigrationCandidate>) -> Result<()> {
    scan_toml_servers(path, AgentKind::Codex, scope, output)
}

fn scan_toml_servers(
    path: &Path,
    agent: AgentKind,
    scope: &str,
    output: &mut Vec<McpMigrationCandidate>,
) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let value: toml::Value = toml::from_str(&std::fs::read_to_string(path)?)?;
    let Some(servers) = value.get("mcp_servers").and_then(toml::Value::as_table) else {
        return Ok(());
    };
    for (name, server) in servers {
        let endpoint = server
            .get("url")
            .or_else(|| server.get("command"))
            .and_then(toml::Value::as_str)
            .unwrap_or("unavailable");
        output.push(candidate(
            path,
            agent,
            scope,
            name,
            if server.get("url").is_some() {
                "http"
            } else {
                "stdio"
            },
            endpoint,
            server.get("env").is_some()
                || server.get("headers").is_some()
                || server.get("http_headers").is_some(),
        ));
    }
    Ok(())
}

fn scan_json_servers(
    path: &Path,
    agent: AgentKind,
    scope: &str,
    pointer: &[&str],
    output: &mut Vec<McpMigrationCandidate>,
) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    collect_json_servers(path, agent, scope, pointer_value(&value, pointer), output);
    Ok(())
}

fn scan_json5_servers(
    path: &Path,
    agent: AgentKind,
    scope: &str,
    pointer: &[&str],
    output: &mut Vec<McpMigrationCandidate>,
) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let value: Value = json5::from_str(&std::fs::read_to_string(path)?)?;
    collect_json_servers(path, agent, scope, pointer_value(&value, pointer), output);
    Ok(())
}

fn scan_opencode_servers(
    path: &Path,
    scope: &str,
    output: &mut Vec<McpMigrationCandidate>,
) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let content = std::fs::read_to_string(path)?;
    let value = parse_opencode_config(path, &content)?;
    collect_json_servers(path, AgentKind::OpenCode, scope, value.get("mcp"), output);
    Ok(())
}

fn parse_opencode_config(path: &Path, content: &str) -> Result<Value> {
    if path.extension().and_then(|value| value.to_str()) == Some("jsonc") {
        Ok(json5::from_str(content)?)
    } else {
        Ok(serde_json::from_str(content)?)
    }
}

fn collect_json_servers(
    path: &Path,
    agent: AgentKind,
    scope: &str,
    servers: Option<&Value>,
    output: &mut Vec<McpMigrationCandidate>,
) {
    let Some(servers) = servers.and_then(Value::as_object) else {
        return;
    };
    for (name, server) in servers {
        let endpoint = server
            .get("url")
            .or_else(|| server.get("command"))
            .and_then(|value| {
                value.as_str().or_else(|| {
                    value
                        .as_array()
                        .and_then(|values| values.first())
                        .and_then(Value::as_str)
                })
            })
            .unwrap_or("unavailable");
        let transport = server
            .get("transport")
            .or_else(|| server.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                if server.get("url").is_some() {
                    "http"
                } else {
                    "stdio"
                }
            });
        let has_secret_values = ["env", "environment", "headers"]
            .into_iter()
            .any(|key| secret_container_has_values(server.get(key)))
            || server
                .get("oauth")
                .filter(|value| value.is_object())
                .is_some_and(|value| secret_container_has_values(Some(value)));
        let mut migration_candidate = candidate(
            path,
            agent,
            scope,
            name,
            transport,
            endpoint,
            has_secret_values,
        );
        let has_unsupported_opencode_fields =
            agent == AgentKind::OpenCode && !opencode_server_can_be_migrated(server);
        if has_unsupported_opencode_fields {
            migration_candidate.supported = false;
            if !migration_candidate
                .warnings
                .iter()
                .any(|warning| warning == "Unsupported native MCP fields or transport")
            {
                migration_candidate
                    .warnings
                    .push("Unsupported native MCP fields or transport".into());
            }
        }
        output.push(migration_candidate);
    }
}

fn opencode_server_can_be_migrated(server: &Value) -> bool {
    let Some(server) = server.as_object() else {
        return false;
    };
    let enabled_is_valid = server.get("enabled").is_none_or(|value| value.is_boolean());
    if !enabled_is_valid {
        return false;
    }
    match server.get("type").and_then(Value::as_str) {
        Some("local") => {
            let allowed = ["type", "command", "environment", "enabled"];
            server.keys().all(|key| allowed.contains(&key.as_str()))
                && server
                    .get("command")
                    .and_then(Value::as_array)
                    .is_some_and(|command| {
                        !command.is_empty() && command.iter().all(Value::is_string)
                    })
                && string_map_is_valid(server.get("environment"))
        }
        Some("remote") => {
            let allowed = ["type", "url", "enabled", "headers", "oauth"];
            server.keys().all(|key| allowed.contains(&key.as_str()))
                && server.get("url").is_some_and(Value::is_string)
                && string_map_is_valid(server.get("headers"))
                && server
                    .get("oauth")
                    .is_none_or(|value| value.as_bool() == Some(false))
        }
        _ => false,
    }
}

fn string_map_is_valid(value: Option<&Value>) -> bool {
    value.is_none_or(|value| {
        value
            .as_object()
            .is_some_and(|values| values.values().all(Value::is_string))
    })
}

fn mark_layered_opencode_candidates_unsupported(candidates: &mut [McpMigrationCandidate]) {
    let layered_names = candidates
        .iter()
        .filter(|candidate| candidate.agent == AgentKind::OpenCode)
        .filter(|candidate| {
            candidates.iter().any(|other| {
                other.agent == AgentKind::OpenCode
                    && other.name == candidate.name
                    && other.source_path != candidate.source_path
            })
        })
        .map(|candidate| candidate.name.clone())
        .collect::<HashSet<_>>();
    for candidate in candidates.iter_mut().filter(|candidate| {
        candidate.agent == AgentKind::OpenCode && layered_names.contains(&candidate.name)
    }) {
        candidate.supported = false;
        let warning =
            "Layered OpenCode MCP entries with the same name cannot be migrated automatically";
        if !candidate.warnings.iter().any(|value| value == warning) {
            candidate.warnings.push(warning.into());
        }
    }
}

fn secret_container_has_values(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Object(values)) => !values.is_empty(),
        Some(Value::Array(values)) => !values.is_empty(),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Bool(_) | Value::Number(_)) => true,
        Some(Value::Null) | None => false,
    }
}

fn scan_hermes(path: &Path, scope: &str, output: &mut Vec<McpMigrationCandidate>) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let yaml: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(path)?)?;
    let json = serde_json::to_value(yaml)?;
    collect_json_servers(
        path,
        AgentKind::Hermes,
        scope,
        json.get("mcp_servers"),
        output,
    );
    Ok(())
}

fn pointer_value<'a>(mut value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    for segment in path {
        value = value.get(*segment)?;
    }
    Some(value)
}

fn candidate(
    path: &Path,
    agent: AgentKind,
    scope: &str,
    name: &str,
    transport: &str,
    endpoint: &str,
    has_secret_values: bool,
) -> McpMigrationCandidate {
    let source_path = canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let digest = Sha256::digest(format!("{}:{name}", source_path.display()));
    let supported = matches!(transport, "stdio" | "http" | "streamable-http" | "sse")
        || (agent == AgentKind::OpenCode && matches!(transport, "local" | "remote"));
    McpMigrationCandidate {
        id: hex::encode(&digest[..12]),
        agent,
        scope: scope.into(),
        name: name.into(),
        source_path,
        transport: transport.into(),
        endpoint: endpoint.into(),
        has_secret_values,
        supported,
        warnings: if has_secret_values {
            vec!["Secret values must be re-entered into mcp.local.json".into()]
        } else if !supported {
            vec!["Unsupported native MCP fields or transport".into()]
        } else {
            Vec::new()
        },
    }
}

fn codex_server(candidate: &McpMigrationCandidate) -> Result<McpServerConfig> {
    toml_server(candidate, "Codex")
}

fn toml_server(candidate: &McpMigrationCandidate, label: &str) -> Result<McpServerConfig> {
    let value: toml::Value = toml::from_str(&std::fs::read_to_string(&candidate.source_path)?)?;
    let server = value
        .get("mcp_servers")
        .and_then(toml::Value::as_table)
        .and_then(|servers| servers.get(&candidate.name))
        .with_context(|| format!("{label} MCP candidate no longer exists"))?;
    let url = server.get("url").and_then(toml::Value::as_str);
    let mut output = base_server(
        candidate,
        if let Some(url) = url {
            McpServerTransport::StreamableHttp { url: url.into() }
        } else {
            McpServerTransport::Stdio {
                command: server
                    .get("command")
                    .and_then(toml::Value::as_str)
                    .with_context(|| format!("{label} MCP command is missing"))?
                    .into(),
                args: toml_strings(server.get("args")),
                cwd: server
                    .get("cwd")
                    .and_then(toml::Value::as_str)
                    .map(PathBuf::from),
            }
        },
    );
    output.allow_tools = toml_strings(server.get("enabled_tools"));
    Ok(output)
}

fn toml_strings(value: Option<&toml::Value>) -> Vec<String> {
    value
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(toml::Value::as_str)
        .map(str::to_string)
        .collect()
}

fn json_server(
    candidate: &McpMigrationCandidate,
    pointer: &[&str],
    json5: bool,
) -> Result<McpServerConfig> {
    let content = std::fs::read_to_string(&candidate.source_path)?;
    let value: Value = if json5 {
        json5::from_str(&content)?
    } else {
        serde_json::from_str(&content)?
    };
    let server = pointer_value(&value, pointer)
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(&candidate.name))
        .context("Native MCP candidate no longer exists")?;
    let url = server.get("url").and_then(Value::as_str);
    Ok(base_server(
        candidate,
        if let Some(url) = url {
            match server
                .get("transport")
                .or_else(|| server.get("type"))
                .and_then(Value::as_str)
            {
                Some("sse") => McpServerTransport::Sse { url: url.into() },
                _ => McpServerTransport::StreamableHttp { url: url.into() },
            }
        } else {
            McpServerTransport::Stdio {
                command: server
                    .get("command")
                    .and_then(Value::as_str)
                    .context("Native MCP command is missing")?
                    .into(),
                args: json_strings(server.get("args")),
                cwd: server.get("cwd").and_then(Value::as_str).map(PathBuf::from),
            }
        },
    ))
}

fn hermes_server(candidate: &McpMigrationCandidate) -> Result<McpServerConfig> {
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&candidate.source_path)?)?;
    let json = serde_json::to_value(yaml)?;
    let server = json
        .get("mcp_servers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(&candidate.name))
        .context("Hermes MCP candidate no longer exists")?;
    let url = server.get("url").and_then(Value::as_str);
    Ok(base_server(
        candidate,
        if let Some(url) = url {
            McpServerTransport::StreamableHttp { url: url.into() }
        } else {
            McpServerTransport::Stdio {
                command: server
                    .get("command")
                    .and_then(Value::as_str)
                    .context("Hermes MCP command is missing")?
                    .into(),
                args: json_strings(server.get("args")),
                cwd: server.get("cwd").and_then(Value::as_str).map(PathBuf::from),
            }
        },
    ))
}

fn opencode_server(candidate: &McpMigrationCandidate) -> Result<McpServerConfig> {
    let content = std::fs::read_to_string(&candidate.source_path)?;
    let value = parse_opencode_config(&candidate.source_path, &content)?;
    let server = value
        .get("mcp")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(&candidate.name))
        .context("OpenCode MCP candidate no longer exists")?;
    let transport = if let Some(url) = server.get("url").and_then(Value::as_str) {
        McpServerTransport::StreamableHttp { url: url.into() }
    } else {
        let command = server
            .get("command")
            .and_then(Value::as_array)
            .context("OpenCode MCP command must be an array")?;
        let executable = command
            .first()
            .and_then(Value::as_str)
            .context("OpenCode MCP command is missing")?;
        McpServerTransport::Stdio {
            command: executable.into(),
            args: command
                .iter()
                .skip(1)
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            cwd: None,
        }
    };
    let mut config = base_server(candidate, transport);
    config.enabled = server
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(config)
}

fn json_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn base_server(
    candidate: &McpMigrationCandidate,
    transport: McpServerTransport,
) -> McpServerConfig {
    McpServerConfig {
        id: safe_id(&candidate.name),
        name: candidate.name.clone(),
        enabled: true,
        transport,
        env: Default::default(),
        headers: Default::default(),
        oauth_credentials: None,
        local_config_path: None,
        targets: vec![candidate.agent],
        allow_tools: Vec::new(),
        lan_allow_tools: Vec::new(),
        supports_parallel_tool_calls: false,
        package: None,
    }
}

fn safe_id(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    value.trim_matches('-').to_string()
}

fn remove_native_candidates(
    content: &str,
    candidates: &[&McpMigrationCandidate],
    gateway_url: &str,
) -> Result<String> {
    let agent = candidates
        .first()
        .context("Native MCP migration has no candidates")?
        .agent;
    let names: Vec<_> = candidates
        .iter()
        .map(|candidate| candidate.name.as_str())
        .collect();
    match agent {
        AgentKind::Codex | AgentKind::GrokBuild => {
            let mut value: toml::Value = toml::from_str(content)?;
            let servers = value
                .get_mut("mcp_servers")
                .and_then(toml::Value::as_table_mut)
                .context("TOML mcp_servers table is missing")?;
            for name in names {
                servers.remove(name);
            }
            // Keep the gateway in AgentKib's managed block so later adapter updates can
            // change the port without treating this migration entry as user-owned.
            servers.remove("agentkib");
            let mut output = toml::to_string_pretty(&value)?;
            if !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str("\n# agentkib:managed:start\n[mcp_servers.agentkib]\nurl = ");
            output.push_str(&toml_string(&agent_gateway_url(gateway_url, agent)));
            output.push_str("\n# agentkib:managed:end\n");
            Ok(output)
        }
        AgentKind::ClaudeCode | AgentKind::Cursor => {
            let mut value: Value = serde_json::from_str(content)?;
            remove_json_names(&mut value, &["mcpServers"], &names)?;
            upsert_json_gateway(&mut value, &["mcpServers"], agent, gateway_url)?;
            Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
        }
        AgentKind::OpenCode => {
            let source = &candidates
                .first()
                .context("OpenCode MCP migration has no candidates")?
                .source_path;
            let mut value = parse_opencode_config(source, content)?;
            remove_json_names(&mut value, &["mcp"], &names)?;
            upsert_json_gateway(&mut value, &["mcp"], agent, gateway_url)?;
            Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
        }
        AgentKind::OpenClaw => {
            let mut value: Value = json5::from_str(content)?;
            remove_json_names(&mut value, &["mcp", "servers"], &names)?;
            upsert_json_gateway(&mut value, &["mcp", "servers"], agent, gateway_url)?;
            Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
        }
        AgentKind::Hermes => {
            let yaml: serde_yaml::Value = serde_yaml::from_str(content)?;
            let mut value = serde_json::to_value(yaml)?;
            remove_json_names(&mut value, &["mcp_servers"], &names)?;
            upsert_json_gateway(&mut value, &["mcp_servers"], agent, gateway_url)?;
            Ok(serde_yaml::to_string(&value)?)
        }
        AgentKind::DeepSeekHarness => {
            bail!("DeepSeek Harness Beta native MCP migration is not supported")
        }
    }
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn agent_gateway_url(template: &str, agent: AgentKind) -> String {
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
    template.replace("{agent}", slug)
}

fn upsert_json_gateway(
    value: &mut Value,
    pointer: &[&str],
    agent: AgentKind,
    gateway_url: &str,
) -> Result<()> {
    let mut current = value;
    for segment in pointer {
        current = current
            .get_mut(*segment)
            .with_context(|| format!("Native MCP object `{segment}` is missing"))?;
    }
    let servers = current
        .as_object_mut()
        .context("Native MCP servers value is not an object")?;
    let mut gateway = serde_json::Map::new();
    gateway.insert("url".into(), agent_gateway_url(gateway_url, agent).into());
    match agent {
        AgentKind::ClaudeCode => {
            gateway.insert("type".into(), "http".into());
        }
        AgentKind::OpenClaw => {
            gateway.insert("transport".into(), "streamable-http".into());
        }
        AgentKind::OpenCode => {
            gateway.insert("type".into(), "remote".into());
            gateway.insert("enabled".into(), true.into());
        }
        AgentKind::Codex
        | AgentKind::Cursor
        | AgentKind::Hermes
        | AgentKind::GrokBuild
        | AgentKind::DeepSeekHarness => {}
    }
    servers.insert("agentkib".into(), Value::Object(gateway));
    Ok(())
}

fn grok_home() -> Option<PathBuf> {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
        .and_then(canonical_grok_home)
}

fn canonical_grok_home(home: PathBuf) -> Option<PathBuf> {
    canonicalize(&home).ok().filter(|home| home.is_dir())
}

fn remove_json_names(value: &mut Value, pointer: &[&str], names: &[&str]) -> Result<()> {
    let mut current = value;
    for segment in pointer {
        current = current
            .get_mut(*segment)
            .with_context(|| format!("Native MCP object `{segment}` is missing"))?;
    }
    let servers = current
        .as_object_mut()
        .context("Native MCP servers value is not an object")?;
    for name in names {
        servers.remove(*name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn scan_reports_secret_presence_without_returning_values() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".codex")).unwrap();
        std::fs::write(
            dir.path().join(".codex/config.toml"),
            "[mcp_servers.private]\ncommand = \"server\"\nenv = { API_TOKEN = \"do-not-return\" }\n",
        )
        .unwrap();
        let candidates = scan_native_candidates(Some(dir.path())).unwrap();
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.name == "private")
            .unwrap();
        assert!(candidate.has_secret_values);
        assert!(
            !serde_json::to_string(candidate)
                .unwrap()
                .contains("do-not-return")
        );
    }

    #[test]
    fn gateway_detection_is_scoped_to_workspace_and_agent() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".codex")).unwrap();
        std::fs::write(
            dir.path().join(".codex/config.toml"),
            "[mcp_servers.agentkib]\nurl = \"http://127.0.0.1:47653/mcp/v1/workspaces/ws/agents/codex\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"agentkib":{"type":"http","url":"http://localhost:47653/mcp/v1/workspaces/ws/agents/claude-code"}}}"#,
        )
        .unwrap();

        assert!(has_agentkib_gateway(dir.path(), AgentKind::Codex, "ws", 47653).unwrap());
        assert!(has_agentkib_gateway(dir.path(), AgentKind::ClaudeCode, "ws", 47653).unwrap());
        assert!(!has_agentkib_gateway(dir.path(), AgentKind::Codex, "ws", 47654).unwrap());
        assert!(!has_agentkib_gateway(dir.path(), AgentKind::Codex, "other", 47653).unwrap());
        assert!(!has_agentkib_gateway(dir.path(), AgentKind::Cursor, "ws", 47653).unwrap());
    }

    #[test]
    fn gateway_detection_encodes_workspace_id_path_segments() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".codex")).unwrap();
        std::fs::write(
            dir.path().join(".codex/config.toml"),
            "[mcp_servers.agentkib]\nurl = \"http://127.0.0.1:47653/mcp/v1/workspaces/team%2Fproject%3Ftag%23one%20two/agents/codex\"\n",
        )
        .unwrap();

        assert!(
            has_agentkib_gateway(
                dir.path(),
                AgentKind::Codex,
                "team/project?tag#one two",
                47653,
            )
            .unwrap()
        );
    }

    #[test]
    fn scan_rejects_opencode_transports_in_other_agent_configs() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{
                "local-shape":{"type":"local","command":["node","server.js"]},
                "remote-shape":{"type":"remote","url":"https://example.com/mcp"}
            }}"#,
        )
        .unwrap();

        let candidates = scan_native_candidates(Some(dir.path())).unwrap();
        for name in ["local-shape", "remote-shape"] {
            let candidate = candidates
                .iter()
                .find(|candidate| candidate.name == name)
                .unwrap();
            assert_eq!(candidate.agent, AgentKind::ClaudeCode);
            assert!(!candidate.supported);
            assert_eq!(
                candidate.warnings,
                ["Unsupported native MCP fields or transport"]
            );
        }
    }

    #[test]
    fn opencode_scan_rejects_lossy_fields_and_ignores_empty_secret_containers() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".opencode")).unwrap();
        std::fs::write(
            dir.path().join(".opencode/opencode.json"),
            r#"{"mcp":{
                "empty-secrets":{"type":"local","command":["node"],"environment":{}},
                "empty-headers":{"type":"remote","url":"https://example.com/empty","headers":{}},
                "empty-value":{"type":"local","command":["node"],"environment":{"MODE":""}},
                "oauth-disabled":{"type":"remote","url":"https://example.com/no-oauth","oauth":false},
                "oauth-custom":{"type":"remote","url":"https://example.com/oauth","oauth":{"clientId":"client","clientSecret":"secret","scope":"tools:read"}},
                "timed":{"type":"remote","url":"https://example.com/timed","timeout":30000},
                "relative-cwd":{"type":"local","command":["node"],"cwd":"services/api"},
                "invalid-command":{"type":"local","command":["node",42]}
            }}"#,
        )
        .unwrap();

        let candidates = scan_native_candidates(Some(dir.path())).unwrap();
        let empty = candidates
            .iter()
            .find(|candidate| candidate.name == "empty-secrets")
            .unwrap();
        assert!(!empty.has_secret_values);
        assert!(empty.supported);

        let empty_headers = candidates
            .iter()
            .find(|candidate| candidate.name == "empty-headers")
            .unwrap();
        assert!(!empty_headers.has_secret_values);
        assert!(empty_headers.supported);

        let empty_value = candidates
            .iter()
            .find(|candidate| candidate.name == "empty-value")
            .unwrap();
        assert!(empty_value.has_secret_values);
        assert!(empty_value.supported);

        let oauth_disabled = candidates
            .iter()
            .find(|candidate| candidate.name == "oauth-disabled")
            .unwrap();
        assert!(!oauth_disabled.has_secret_values);
        assert!(oauth_disabled.supported);

        let oauth_custom = candidates
            .iter()
            .find(|candidate| candidate.name == "oauth-custom")
            .unwrap();
        assert!(oauth_custom.has_secret_values);
        assert!(!oauth_custom.supported);

        let timed = candidates
            .iter()
            .find(|candidate| candidate.name == "timed")
            .unwrap();
        assert!(!timed.supported);
        assert_eq!(
            timed.warnings,
            ["Unsupported native MCP fields or transport"]
        );
        for name in ["relative-cwd", "invalid-command"] {
            let candidate = candidates
                .iter()
                .find(|candidate| candidate.name == name)
                .unwrap();
            assert!(!candidate.supported);
            assert!(migration_server(candidate).is_err());
        }
    }

    #[test]
    fn opencode_layered_servers_with_the_same_name_are_not_auto_migrated() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".opencode")).unwrap();
        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{"mcp":{"shared":{"type":"local","command":["node"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join(".opencode/opencode.json"),
            r#"{"mcp":{"shared":{"type":"local","command":["bun"]}}}"#,
        )
        .unwrap();

        let candidates = scan_native_candidates(Some(dir.path())).unwrap();
        let layered = candidates
            .iter()
            .filter(|candidate| {
                candidate.agent == AgentKind::OpenCode && candidate.name == "shared"
            })
            .collect::<Vec<_>>();

        assert_eq!(layered.len(), 2);
        assert!(layered.iter().all(|candidate| !candidate.supported));
        assert!(layered.iter().all(|candidate| {
            candidate
                .warnings
                .iter()
                .any(|warning| warning.contains("Layered OpenCode MCP"))
        }));
    }

    #[test]
    fn migration_plan_adds_hub_config_and_removes_only_selected_native_server() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{
  "unknown": { "keep": true },
  "mcpServers": {
    "selected": { "command": "node", "args": ["server.js"] },
    "other": { "url": "https://example.com/mcp", "future": 42 }
  }
}"#,
        )
        .unwrap();
        let candidates = scan_native_candidates(Some(dir.path())).unwrap();
        let selected = candidates
            .iter()
            .find(|candidate| candidate.name == "selected")
            .unwrap();
        let server = migration_server(selected).unwrap();
        let plan = plan_migration(
            dir.path(),
            std::slice::from_ref(&selected.id),
            &[server],
            "http://127.0.0.1:47653/mcp/v1/workspaces/ws/agents/{agent}",
        )
        .unwrap();
        assert_eq!(plan.changes.len(), 2);
        let hub = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".agentkib/mcp.json"))
            .unwrap();
        assert!(hub.after.contains("server.js"));
        let native = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".mcp.json"))
            .unwrap();
        let value: Value = serde_json::from_str(&native.after).unwrap();
        assert_eq!(value.pointer("/unknown/keep"), Some(&Value::Bool(true)));
        assert!(value.pointer("/mcpServers/selected").is_none());
        assert_eq!(
            value.pointer("/mcpServers/agentkib/type"),
            Some(&Value::from("http"))
        );
        assert_eq!(
            value.pointer("/mcpServers/agentkib/url"),
            Some(&Value::from(
                "http://127.0.0.1:47653/mcp/v1/workspaces/ws/agents/claude-code"
            ))
        );
        assert_eq!(
            value.pointer("/mcpServers/other/future"),
            Some(&Value::from(42))
        );
    }

    #[test]
    fn opencode_jsonc_scan_and_migration_use_native_shapes_without_leaking_secrets() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::create_dir(dir.path().join(".opencode")).unwrap();
        std::fs::write(
            dir.path().join(".opencode/opencode.jsonc"),
            r#"{
  // keep unknown fields
  "theme": "dark",
  "mcp": {
    "selected": {
      "type": "local",
      "enabled": false,
      "command": ["node", "server.js"],
      "environment": { "API_TOKEN": "do-not-return" }
    },
    "other": { "type": "remote", "url": "https://example.com/mcp", "future": 42 }
  }
}"#,
        )
        .unwrap();
        let candidates = scan_native_candidates(Some(dir.path())).unwrap();
        let selected = candidates
            .iter()
            .find(|candidate| {
                candidate.agent == AgentKind::OpenCode && candidate.name == "selected"
            })
            .unwrap();
        assert_eq!(selected.endpoint, "node");
        assert!(selected.has_secret_values);
        assert!(
            !serde_json::to_string(selected)
                .unwrap()
                .contains("do-not-return")
        );
        let server = migration_server(selected).unwrap();
        assert!(matches!(
            server.transport,
            McpServerTransport::Stdio { ref command, ref args, .. }
                if command == "node" && args == &["server.js"]
        ));
        assert!(!server.enabled);
        let plan = plan_migration(
            dir.path(),
            std::slice::from_ref(&selected.id),
            &[server],
            "http://127.0.0.1/mcp/{agent}",
        )
        .unwrap();
        let hub = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".agentkib/mcp.json"))
            .unwrap();
        let document: McpConfigDocument = serde_json::from_str(&hub.after).unwrap();
        assert!(
            !document
                .servers
                .iter()
                .find(|server| server.name == "selected")
                .unwrap()
                .enabled
        );
        let native = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".opencode/opencode.jsonc"))
            .unwrap();
        let value: Value = serde_json::from_str(&native.after).unwrap();
        assert_eq!(value["theme"], "dark");
        assert!(value.pointer("/mcp/selected").is_none());
        assert_eq!(value["mcp"]["other"]["future"], 42);
        assert_eq!(value["mcp"]["agentkib"]["type"], "remote");
        assert_eq!(value["mcp"]["agentkib"]["enabled"], true);
        assert_eq!(
            value["mcp"]["agentkib"]["url"],
            "http://127.0.0.1/mcp/opencode"
        );
    }

    #[test]
    fn opencode_json_stays_strict_across_scan_and_migration() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".opencode")).unwrap();
        let path = dir.path().join(".opencode/opencode.json");
        let content = r#"{"mcp":{"selected":{"type":"remote","url":"https://example.com"}},}"#;
        std::fs::write(&path, content).unwrap();

        assert!(scan_native_candidates(Some(dir.path())).is_err());
        let candidate = candidate(
            &path,
            AgentKind::OpenCode,
            "project",
            "selected",
            "remote",
            "https://example.com",
            false,
        );
        assert!(migration_server(&candidate).is_err());
        assert!(
            remove_native_candidates(content, &[&candidate], "http://127.0.0.1/mcp/{agent}")
                .is_err()
        );
    }

    #[test]
    fn grok_build_migration_preserves_unrelated_toml_and_redacts_secrets() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::create_dir(dir.path().join(".grok")).unwrap();
        std::fs::write(
            dir.path().join(".grok/config.toml"),
            r#"model = "grok-code"

[mcp_servers.selected]
command = "node"
args = ["server.js"]
cwd = "services/reviewer"
enabled_tools = ["search", "read_file"]
env = { API_TOKEN = "do-not-return" }

[mcp_servers.other]
url = "https://example.com/mcp"
future = 42
"#,
        )
        .unwrap();
        let candidates = scan_native_candidates(Some(dir.path())).unwrap();
        let selected = candidates
            .iter()
            .find(|candidate| {
                candidate.agent == AgentKind::GrokBuild && candidate.name == "selected"
            })
            .unwrap();
        assert!(selected.has_secret_values);
        assert!(
            !serde_json::to_string(selected)
                .unwrap()
                .contains("do-not-return")
        );
        let server = migration_server(selected).unwrap();
        assert!(matches!(
            &server.transport,
            McpServerTransport::Stdio { cwd: Some(cwd), .. }
                if cwd == Path::new("services/reviewer")
        ));
        assert_eq!(server.allow_tools, ["search", "read_file"]);
        let plan = plan_migration(
            dir.path(),
            std::slice::from_ref(&selected.id),
            &[server],
            "http://127.0.0.1/workspaces/ws/agents/{agent}",
        )
        .unwrap();
        let native = plan
            .changes
            .iter()
            .find(|change| change.target.ends_with(".grok/config.toml"))
            .unwrap();
        let managed_prefix = native
            .after
            .split("# agentkib:managed:start")
            .next()
            .unwrap();
        let value: toml::Value = toml::from_str(managed_prefix).unwrap();
        assert_eq!(
            value.get("model").and_then(toml::Value::as_str),
            Some("grok-code")
        );
        assert!(
            value
                .get("mcp_servers")
                .and_then(|value| value.get("selected"))
                .is_none()
        );
        assert_eq!(
            value
                .get("mcp_servers")
                .and_then(|value| value.get("other"))
                .and_then(|value| value.get("future"))
                .and_then(toml::Value::as_integer),
            Some(42)
        );
        assert!(native.after.contains("/agents/grok-build"));
    }

    #[test]
    fn grok_home_matching_project_config_is_scanned_once() {
        let dir = tempdir().unwrap();
        let grok_home = dir.path().join(".grok");
        std::fs::create_dir(&grok_home).unwrap();
        std::fs::write(
            grok_home.join("config.toml"),
            "[mcp_servers.local]\ncommand = \"server\"\n",
        )
        .unwrap();

        let candidates =
            scan_native_candidates_with_grok_home(Some(dir.path()), Some(&grok_home)).unwrap();
        let matching: Vec<_> = candidates
            .iter()
            .filter(|candidate| {
                candidate.agent == AgentKind::GrokBuild && candidate.name == "local"
            })
            .collect();

        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].scope, "project");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_grok_home_is_resolved_for_mcp_scans() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let actual_home = dir.path().join("actual-grok-home");
        let linked_home = dir.path().join("linked-grok-home");
        std::fs::create_dir(&actual_home).unwrap();
        std::fs::write(
            actual_home.join("config.toml"),
            "[mcp_servers.home]\ncommand = \"server\"\n",
        )
        .unwrap();
        symlink(&actual_home, &linked_home).unwrap();

        let home = canonical_grok_home(linked_home).unwrap();
        let candidates = scan_native_candidates_with_grok_home(None, Some(&home)).unwrap();
        let matching: Vec<_> = candidates
            .iter()
            .filter(|candidate| candidate.agent == AgentKind::GrokBuild && candidate.name == "home")
            .collect();

        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].scope, "home");
    }
}
