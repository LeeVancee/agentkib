use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use agentkib_core::{
    AgentInstallation, AgentKind, AssetKind, CatalogAsset, CatalogScope, DiscoveryCandidate,
    DiscoveryEvidence, hash_content,
};
use agentkib_platform::{command, path as platform_path};
use anyhow::{Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value as JsonValue;
use walkdir::{DirEntry, WalkDir};

pub trait WorkspaceDiscoveryProvider: Send {
    fn installation(&self) -> AgentInstallation;
    fn discover(&self) -> Result<Vec<DiscoveryCandidate>>;
    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>>;
}

pub struct DiscoverySnapshot {
    pub candidates: Vec<DiscoveryCandidate>,
    pub installations: Vec<AgentInstallation>,
    pub home_assets: Vec<CatalogAsset>,
    pub errors: Vec<String>,
}

pub fn discover(scan_roots: &[(PathBuf, usize)]) -> DiscoverySnapshot {
    let providers: Vec<Box<dyn WorkspaceDiscoveryProvider>> = vec![
        Box::new(CodexProvider::default()),
        Box::new(ClaudeProvider::default()),
        Box::new(CursorProvider::default()),
        Box::new(OpenCodeProvider::default()),
        Box::new(OpenClawProvider::default()),
        Box::new(HermesProvider::default()),
        Box::new(DeepSeekHarnessProvider::default()),
    ];
    let provider_results = parallel_map_bounded(providers, 4, |provider| {
        let installation = provider.installation();
        let label = installation.agent.as_str();
        let mut errors = Vec::new();
        let candidates = provider.discover().unwrap_or_else(|error| {
            errors.push(format!("{label} workspace discovery failed: {error}"));
            Vec::new()
        });
        let home_assets = provider.scan_home_assets().unwrap_or_else(|error| {
            errors.push(format!("{label} Home asset scan failed: {error}"));
            Vec::new()
        });
        (installation, candidates, home_assets, errors)
    });
    let scan_results = parallel_map_bounded(scan_roots.to_vec(), 4, |(root, depth)| {
        let result = discover_scan_root(&root, depth);
        (root, result)
    });

    let mut candidates = Vec::new();
    let mut installations = Vec::new();
    let mut home_assets = Vec::new();
    let mut errors = Vec::new();
    for (installation, discovered, assets, provider_errors) in provider_results {
        installations.push(installation);
        candidates.extend(discovered);
        home_assets.extend(assets);
        errors.extend(provider_errors);
    }
    for (root, result) in scan_results {
        match result {
            Ok((discovered, scan_errors)) => {
                candidates.extend(discovered);
                errors.extend(scan_errors.into_iter().map(|error| {
                    format!("Scan root {} partially failed: {error}", root.display())
                }));
            }
            Err(error) => errors.push(format!("Scan root {} failed: {error}", root.display())),
        }
    }
    DiscoverySnapshot {
        candidates: normalize_and_merge(candidates),
        installations,
        home_assets,
        errors,
    }
}

fn parallel_map_bounded<T, R, F>(items: Vec<T>, concurrency: usize, operation: F) -> Vec<R>
where
    T: Send,
    R: Send,
    F: Fn(T) -> R + Sync,
{
    let item_count = items.len();
    if item_count == 0 {
        return Vec::new();
    }
    let queue = Arc::new(Mutex::new(
        items.into_iter().enumerate().collect::<VecDeque<_>>(),
    ));
    let output = Arc::new(Mutex::new(Vec::with_capacity(item_count)));
    thread::scope(|scope| {
        for _ in 0..concurrency.max(1).min(item_count) {
            let queue = Arc::clone(&queue);
            let output = Arc::clone(&output);
            let operation = &operation;
            scope.spawn(move || {
                loop {
                    let item = queue.lock().expect("discovery queue lock").pop_front();
                    let Some((index, item)) = item else { break };
                    output
                        .lock()
                        .expect("discovery output lock")
                        .push((index, operation(item)));
                }
            });
        }
    });
    let mut output = Arc::try_unwrap(output)
        .ok()
        .expect("discovery output still shared")
        .into_inner()
        .expect("discovery output lock");
    output.sort_by_key(|(index, _)| *index);
    output.into_iter().map(|(_, value)| value).collect()
}

#[derive(Default)]
struct CodexProvider {
    home: Option<PathBuf>,
}

impl CodexProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".codex")))
        })
    }
}

impl WorkspaceDiscoveryProvider for CodexProvider {
    fn installation(&self) -> AgentInstallation {
        installation(
            AgentKind::Codex,
            self.home(),
            agent_is_installed(AgentKind::Codex),
        )
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(home) = self.home().filter(|path| path.is_dir()) else {
            return Ok(Vec::new());
        };
        let mut output = Vec::new();
        for entry in fs::read_dir(home)? {
            let path = entry?.path();
            if !path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("state_") && name.ends_with(".sqlite"))
            {
                continue;
            }
            let connection = open_read_only(&path)?;
            let columns = table_columns(&connection, "threads")?;
            if !columns.contains("cwd") {
                continue;
            }
            let timestamps: Vec<_> = ["recency_at", "updated_at", "created_at"]
                .into_iter()
                .filter(|column| columns.contains(*column))
                .collect();
            let timestamp_expression = match timestamps.as_slice() {
                [] => "NULL".to_string(),
                [only] => format!("MAX({only})"),
                values => format!("MAX(COALESCE({}))", values.join(", ")),
            };
            let sql = format!(
                "SELECT cwd, {timestamp_expression}, COUNT(*) \
                 FROM threads WHERE cwd IS NOT NULL AND cwd != '' GROUP BY cwd"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (path, updated, count) = row?;
                output.push(candidate(
                    PathBuf::from(path),
                    Some(AgentKind::Codex),
                    DiscoveryEvidence::SessionCwd,
                    updated.and_then(timestamp_from_integer),
                    count.max(0) as u64,
                    false,
                ));
            }
        }
        Ok(output)
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::Codex,
                    &home,
                    &["AGENTS.md", "config.toml", "skills", "agents", "hooks"],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

#[derive(Default)]
struct ClaudeProvider {
    home: Option<PathBuf>,
}

#[derive(Default)]
struct SessionActivity {
    session_ids: BTreeSet<String>,
    anonymous_sessions: u64,
    last_active_at: Option<DateTime<Utc>>,
}

impl SessionActivity {
    fn count(&self) -> u64 {
        self.session_ids.len() as u64 + self.anonymous_sessions
    }
}

impl ClaudeProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".claude")))
        })
    }
}

impl WorkspaceDiscoveryProvider for ClaudeProvider {
    fn installation(&self) -> AgentInstallation {
        installation(
            AgentKind::ClaudeCode,
            self.home(),
            agent_is_installed(AgentKind::ClaudeCode),
        )
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(home) = self.home().filter(|path| path.is_dir()) else {
            return Ok(Vec::new());
        };
        let mut aggregate: BTreeMap<PathBuf, SessionActivity> = BTreeMap::new();
        let history = home.join("history.jsonl");
        if let Ok(content) = fs::read_to_string(history) {
            for line in content.lines() {
                let Ok(value) = serde_json::from_str::<JsonValue>(line) else {
                    continue;
                };
                let Some(path) = value.get("project").and_then(JsonValue::as_str) else {
                    continue;
                };
                let path = PathBuf::from(path);
                if platform_path::is_known_agent_probe_workspace(&path) {
                    continue;
                }
                let timestamp = value
                    .get("timestamp")
                    .and_then(JsonValue::as_i64)
                    .and_then(timestamp_from_integer);
                merge_activity(&mut aggregate, path, session_identifier(&value), timestamp);
            }
        }
        let projects = home.join("projects");
        if projects.is_dir() {
            for entry in WalkDir::new(projects)
                .max_depth(3)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| platform_path::is_safe_scan_entry(entry.path()))
            {
                let entry = entry?;
                if entry.file_name() != "sessions-index.json" || !entry.file_type().is_file() {
                    continue;
                }
                let value: JsonValue = serde_json::from_str(&fs::read_to_string(entry.path())?)?;
                for item in session_index_entries(&value) {
                    let Some(path) = item.get("projectPath").and_then(JsonValue::as_str) else {
                        continue;
                    };
                    let path = PathBuf::from(path);
                    if platform_path::is_known_agent_probe_workspace(&path) {
                        continue;
                    }
                    let timestamp = item
                        .get("modified")
                        .or_else(|| item.get("modifiedAt"))
                        .or_else(|| item.get("lastActivityAt"))
                        .and_then(parse_json_timestamp);
                    merge_activity(&mut aggregate, path, session_identifier(item), timestamp);
                }
            }
        }
        Ok(aggregate
            .into_iter()
            .map(|(path, activity)| {
                candidate(
                    path,
                    Some(AgentKind::ClaudeCode),
                    DiscoveryEvidence::SessionCwd,
                    activity.last_active_at,
                    activity.count(),
                    false,
                )
            })
            .collect())
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::ClaudeCode,
                    &home,
                    &[
                        "CLAUDE.md",
                        "settings.json",
                        "config.json",
                        "skills",
                        "agents",
                        "hooks",
                    ],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

#[derive(Default)]
struct CursorProvider {
    home: Option<PathBuf>,
    data_home: Option<PathBuf>,
}

impl CursorProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home
            .clone()
            .or_else(|| dirs::home_dir().map(|path| path.join(".cursor")))
    }

    fn data_home(&self) -> Option<PathBuf> {
        self.data_home.clone().or_else(|| {
            env::var_os("CURSOR_DATA_DIR")
                .map(PathBuf::from)
                .or_else(cursor_default_data_home)
        })
    }
}

impl WorkspaceDiscoveryProvider for CursorProvider {
    fn installation(&self) -> AgentInstallation {
        cursor_installation(
            self.home(),
            self.data_home(),
            agent_is_installed(AgentKind::Cursor),
        )
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(data_home) = self.data_home().filter(|path| path.is_dir()) else {
            return Ok(Vec::new());
        };
        let storage = data_home.join("User/workspaceStorage");
        if !storage.is_dir() {
            return Ok(Vec::new());
        }
        let mut output = Vec::new();
        for entry in WalkDir::new(storage)
            .min_depth(2)
            .max_depth(2)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| platform_path::is_safe_scan_entry(entry.path()))
        {
            let entry = entry?;
            if !entry.file_type().is_file() || entry.file_name() != "workspace.json" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<JsonValue>(&fs::read_to_string(entry.path())?)
            else {
                continue;
            };
            let Some(path) = cursor_workspace_path(&value) else {
                continue;
            };
            output.push(candidate(
                path,
                Some(AgentKind::Cursor),
                DiscoveryEvidence::ConfiguredWorkspace,
                modified_at(entry.path()).ok(),
                0,
                false,
            ));
        }
        Ok(output)
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::Cursor,
                    &home,
                    &["mcp.json", "rules", "commands", "hooks.json", "skills"],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

fn cursor_workspace_path(value: &JsonValue) -> Option<PathBuf> {
    let value = value
        .get("folder")
        .or_else(|| value.get("workspace"))?
        .as_str()?;
    file_uri_path(value)
}

fn file_uri_path(value: &str) -> Option<PathBuf> {
    platform_path::file_uri_to_path(value)
}

#[derive(Default)]
struct OpenCodeProvider {
    config_home: Option<PathBuf>,
    data_home: Option<PathBuf>,
}

impl OpenCodeProvider {
    fn config_home(&self) -> Option<PathBuf> {
        self.config_home.clone().or_else(|| {
            agentkib_platform::xdg::config_home()
                .or_else(|| dirs::home_dir().map(|path| path.join(".config")))
                .map(|path| path.join("opencode"))
        })
    }

    fn data_home(&self) -> Option<PathBuf> {
        self.data_home.clone().or_else(|| {
            agentkib_platform::xdg::data_home()
                .or_else(|| dirs::home_dir().map(|path| path.join(".local/share")))
                .map(|path| path.join("opencode"))
        })
    }
}

impl WorkspaceDiscoveryProvider for OpenCodeProvider {
    fn installation(&self) -> AgentInstallation {
        let mut value = installation(
            AgentKind::OpenCode,
            self.config_home(),
            agent_is_installed(AgentKind::OpenCode),
        );
        value.configured = value.configured || self.data_home().is_some_and(|path| path.is_dir());
        value
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(data_home) = self.data_home().filter(|path| path.is_dir()) else {
            return Ok(Vec::new());
        };
        let mut output = discover_opencode_database(&data_home.join("opencode.db"))?;
        let database_paths: BTreeSet<_> = output
            .iter()
            .map(|candidate| platform_path::identity(&candidate.path))
            .collect();
        output.extend(
            discover_legacy_opencode_projects(&data_home)?
                .into_iter()
                .filter(|candidate| {
                    !database_paths.contains(&platform_path::identity(&candidate.path))
                }),
        );
        Ok(output)
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .config_home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::OpenCode,
                    &home,
                    &[
                        "AGENTS.md",
                        "opencode.json",
                        "opencode.jsonc",
                        "skills",
                        "agents",
                        "commands",
                        "plugins",
                    ],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

fn discover_opencode_database(path: &Path) -> Result<Vec<DiscoveryCandidate>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let connection = open_read_only(path)?;
    if !table_has_column(&connection, "project", "worktree")? {
        return Ok(Vec::new());
    }
    let has_sessions = table_has_column(&connection, "session", "project_id")?
        && table_has_column(&connection, "session", "directory")?;
    let sql = if has_sessions {
        "SELECT p.worktree, COUNT(s.id), MAX(COALESCE(s.time_updated, s.time_created)) \
         FROM project p LEFT JOIN session s ON s.project_id = p.id \
         WHERE p.worktree IS NOT NULL AND p.worktree != '' GROUP BY p.id, p.worktree"
    } else {
        "SELECT worktree, 0, MAX(COALESCE(time_updated, time_created)) \
         FROM project WHERE worktree IS NOT NULL AND worktree != '' GROUP BY id, worktree"
    };
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<i64>>(2)?,
        ))
    })?;
    let mut output = Vec::new();
    for row in rows {
        let (worktree, count, updated) = row?;
        output.push(candidate(
            PathBuf::from(worktree),
            Some(AgentKind::OpenCode),
            DiscoveryEvidence::SessionCwd,
            updated.and_then(timestamp_from_integer),
            count.max(0) as u64,
            false,
        ));
    }
    Ok(output)
}

fn discover_legacy_opencode_projects(data_home: &Path) -> Result<Vec<DiscoveryCandidate>> {
    let projects = data_home.join("storage/project");
    if !projects.is_dir() {
        return Ok(Vec::new());
    }
    let sessions = data_home.join("storage/session");
    let mut output = Vec::new();
    for entry in fs::read_dir(projects)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<JsonValue>(&fs::read_to_string(&path)?) else {
            continue;
        };
        let Some(worktree) = value.get("worktree").and_then(JsonValue::as_str) else {
            continue;
        };
        let project_id = value.get("id").and_then(JsonValue::as_str);
        let session_count = project_id
            .map(|id| sessions.join(id))
            .filter(|path| path.is_dir())
            .and_then(|path| fs::read_dir(path).ok())
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                    })
                    .count() as u64
            })
            .unwrap_or(0);
        let updated = value
            .pointer("/time/updated")
            .or_else(|| value.pointer("/time/created"))
            .and_then(parse_json_timestamp)
            .or_else(|| modified_at(&path).ok());
        output.push(candidate(
            PathBuf::from(worktree),
            Some(AgentKind::OpenCode),
            DiscoveryEvidence::SessionCwd,
            updated,
            session_count,
            false,
        ));
    }
    Ok(output)
}

#[derive(Default)]
struct OpenClawProvider {
    home: Option<PathBuf>,
}

impl OpenClawProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("OPENCLAW_STATE_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".openclaw")))
        })
    }
}

impl WorkspaceDiscoveryProvider for OpenClawProvider {
    fn installation(&self) -> AgentInstallation {
        installation(
            AgentKind::OpenClaw,
            self.home(),
            agent_is_installed(AgentKind::OpenClaw),
        )
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(home) = self.home().filter(|path| path.is_dir()) else {
            return Ok(Vec::new());
        };
        let config = home.join("openclaw.json");
        if !config.is_file() {
            return Ok(Vec::new());
        }
        let value: JsonValue = json5::from_str(&fs::read_to_string(config)?)?;
        let mut paths = Vec::new();
        if let Some(path) = value
            .pointer("/agents/defaults/workspace")
            .and_then(JsonValue::as_str)
        {
            paths.push(resolve_config_path(&home, path));
        }
        for key in ["list", "entries"] {
            for item in value
                .pointer(&format!("/agents/{key}"))
                .and_then(JsonValue::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(path) = item.get("workspace").and_then(JsonValue::as_str) {
                    paths.push(resolve_config_path(&home, path));
                }
            }
        }
        Ok(paths
            .into_iter()
            .map(|path| {
                candidate(
                    path,
                    Some(AgentKind::OpenClaw),
                    DiscoveryEvidence::ConfiguredWorkspace,
                    None,
                    0,
                    true,
                )
            })
            .collect())
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::OpenClaw,
                    &home,
                    &[
                        "openclaw.json",
                        "skills",
                        "agents",
                        "hooks",
                        "SOUL.md",
                        "MEMORY.md",
                    ],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

#[derive(Default)]
struct HermesProvider {
    home: Option<PathBuf>,
}

impl HermesProvider {
    fn homes(&self) -> Vec<PathBuf> {
        let base = self.home.clone().or_else(|| {
            env::var_os("HERMES_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".hermes")))
        });
        let Some(base) = base else { return Vec::new() };
        let mut homes = vec![base.clone()];
        let profiles = base.join("profiles");
        if let Ok(entries) = fs::read_dir(profiles) {
            homes.extend(
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir() && platform_path::is_safe_scan_entry(path)),
            );
        }
        homes
    }
}

impl WorkspaceDiscoveryProvider for HermesProvider {
    fn installation(&self) -> AgentInstallation {
        let home = self.homes().into_iter().next();
        installation(
            AgentKind::Hermes,
            home,
            agent_is_installed(AgentKind::Hermes),
        )
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let mut output = Vec::new();
        for home in self.homes().into_iter().filter(|path| path.is_dir()) {
            let config = home.join("config.yaml");
            if let Ok(content) = fs::read_to_string(config)
                && let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content)
                && let Some(path) = value
                    .get("terminal")
                    .and_then(|value| value.get("cwd"))
                    .and_then(serde_yaml::Value::as_str)
            {
                output.push(candidate(
                    resolve_config_path(&home, path),
                    Some(AgentKind::Hermes),
                    DiscoveryEvidence::ConfiguredWorkspace,
                    None,
                    0,
                    true,
                ));
            }
            let database = home.join("state.db");
            if database.is_file() {
                let connection = open_read_only(&database)?;
                if table_has_column(&connection, "sessions", "cwd")? {
                    let mut statement = connection.prepare("SELECT cwd, COUNT(*), MAX(started_at) FROM sessions WHERE cwd IS NOT NULL AND cwd != '' GROUP BY cwd")?;
                    let rows = statement.query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<f64>>(2)?,
                        ))
                    })?;
                    for row in rows {
                        let (path, count, timestamp) = row?;
                        output.push(candidate(
                            PathBuf::from(path),
                            Some(AgentKind::Hermes),
                            DiscoveryEvidence::SessionCwd,
                            timestamp.and_then(timestamp_from_float),
                            count.max(0) as u64,
                            false,
                        ));
                    }
                }
            }
        }
        Ok(output)
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        let mut assets = Vec::new();
        for home in self.homes().into_iter().filter(|path| path.is_dir()) {
            assets.extend(scan_known_home(
                AgentKind::Hermes,
                &home,
                &[
                    "config.yaml",
                    "SOUL.md",
                    "MEMORY.md",
                    "skills",
                    "profiles",
                    "hooks",
                ],
            )?);
        }
        Ok(assets)
    }
}

#[derive(Default)]
struct DeepSeekHarnessProvider {
    home: Option<PathBuf>,
}

impl DeepSeekHarnessProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("DSH_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".dsh")))
        })
    }

    fn workspace_file(&self) -> Option<PathBuf> {
        self.home().map(|home| home.join("storages/workspace.json"))
    }
}

impl WorkspaceDiscoveryProvider for DeepSeekHarnessProvider {
    fn installation(&self) -> AgentInstallation {
        let home = self.home();
        let mut value = installation(
            AgentKind::DeepSeekHarness,
            home.clone(),
            agent_is_installed(AgentKind::DeepSeekHarness),
        );
        if let Some(path) = self.workspace_file().filter(|path| path.is_file())
            && let Err(error) = parse_deepseek_workspaces(&path)
        {
            value.warnings.push(error.to_string());
        }
        value
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(path) = self.workspace_file().filter(|path| path.is_file()) else {
            return Ok(Vec::new());
        };
        parse_deepseek_workspaces(&path)
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::DeepSeekHarness,
                    &home,
                    &[
                        "AGENTS.md",
                        "settings.yaml",
                        "cordis.patch.yml",
                        "profiles",
                        "skills",
                        ".agent-presets",
                    ],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

fn parse_deepseek_workspaces(path: &Path) -> Result<Vec<DiscoveryCandidate>> {
    let value: JsonValue = serde_json::from_str(&fs::read_to_string(path)?)?;
    let unit = value
        .get("unit")
        .and_then(JsonValue::as_object)
        .context("DeepSeek Harness workspace storage has no unit header")?;
    if unit.get("name").and_then(JsonValue::as_str) != Some("workspace")
        || unit.get("version").and_then(JsonValue::as_u64) != Some(2)
    {
        anyhow::bail!("DeepSeek Harness workspace storage version is not supported");
    }
    let records = value
        .pointer("/tables/workspaces")
        .and_then(JsonValue::as_object)
        .context("DeepSeek Harness workspace storage has no workspaces table")?;
    let mut output = Vec::new();
    for record in records.values() {
        let Some(workspace_path) = record.get("path").and_then(JsonValue::as_str) else {
            continue;
        };
        let session_count = record
            .get("sessionIds")
            .and_then(JsonValue::as_array)
            .map_or(0, |values| values.len() as u64);
        let mut value = candidate(
            PathBuf::from(workspace_path),
            Some(AgentKind::DeepSeekHarness),
            DiscoveryEvidence::ConfiguredWorkspace,
            record.get("updatedAt").and_then(parse_json_timestamp),
            session_count,
            true,
        );
        value.display_name = record
            .get("title")
            .and_then(JsonValue::as_str)
            .filter(|title| !title.trim().is_empty())
            .map(str::to_owned);
        output.push(value);
    }
    Ok(output)
}

fn discover_scan_root(
    root: &Path,
    max_depth: usize,
) -> Result<(Vec<DiscoveryCandidate>, Vec<String>)> {
    if platform_path::is_reparse_or_symlink(root)? {
        anyhow::bail!("scan root must not be a symbolic link or reparse point");
    }
    let root = platform_path::canonicalize(root)?;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(max_depth.clamp(1, 8))
        .follow_links(false)
        .same_file_system(true)
        .into_iter()
        .filter_entry(allowed_scan_entry)
    {
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                errors.push(error.to_string());
                continue;
            }
        };
        if entry.file_type().is_dir() && has_project_marker(entry.path()) {
            output.push(candidate(
                entry.path().to_path_buf(),
                None,
                DiscoveryEvidence::ScanMarker,
                modified_at(entry.path()).ok(),
                0,
                true,
            ));
        }
    }
    Ok((output, errors))
}

fn allowed_scan_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".cache"
                | ".next"
                | ".turbo"
                | ".venv"
                | "venv"
                | "vendor"
                | "coverage"
                | "Pods"
                | "DerivedData"
                | "Library"
        )
    ) && platform_path::is_safe_scan_entry(entry.path())
}

fn normalize_and_merge(candidates: Vec<DiscoveryCandidate>) -> Vec<DiscoveryCandidate> {
    let mut grouped: BTreeMap<(String, Option<AgentKind>, DiscoveryEvidence), DiscoveryCandidate> =
        BTreeMap::new();
    for mut candidate in candidates {
        let Some(path) = normalize_workspace(&candidate.path, candidate.explicit_workspace) else {
            continue;
        };
        candidate.repository_group_id = repository_group_id(&path);
        candidate.path = path.clone();
        let key = (
            platform_path::identity(&path),
            candidate.source_agent,
            candidate.evidence,
        );
        grouped
            .entry(key)
            .and_modify(|existing| {
                if existing.display_name.is_none() {
                    existing.display_name = candidate.display_name.clone();
                }
                existing.session_count = existing
                    .session_count
                    .saturating_add(candidate.session_count);
                existing.last_active_at = latest(existing.last_active_at, candidate.last_active_at);
            })
            .or_insert(candidate);
    }
    grouped.into_values().collect()
}

fn normalize_workspace(path: &Path, explicit: bool) -> Option<PathBuf> {
    let canonical = platform_path::canonicalize(path).ok()?;
    if !canonical.is_dir() {
        return None;
    }
    let home = dirs::home_dir();
    let mut current = Some(canonical.as_path());
    while let Some(path) = current {
        if has_project_marker(path) && home.as_deref() != Some(path) {
            return platform_path::canonicalize(path).ok();
        }
        current = path.parent();
    }
    explicit.then_some(canonical)
}

fn has_project_marker(path: &Path) -> bool {
    [
        ".agentkib",
        ".git",
        "AGENTS.md",
        "CLAUDE.md",
        ".codex",
        ".claude",
        ".cursor",
        ".dsh",
    ]
    .into_iter()
    .any(|name| path.join(name).exists())
}

fn repository_group_id(path: &Path) -> Option<String> {
    let marker = path.join(".git");
    let git_dir = if marker.is_dir() {
        platform_path::canonicalize(&marker).ok()?
    } else {
        let content = fs::read_to_string(marker).ok()?;
        let relative = content.trim().strip_prefix("gitdir:")?.trim();
        platform_path::canonicalize(&path.join(relative)).ok()?
    };
    let common = fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|value| git_dir.join(value.trim()))
        .and_then(|value| platform_path::canonicalize(&value).ok())
        .unwrap_or(git_dir);
    Some(hash_content(platform_path::identity(&common).as_bytes()))
}

fn scan_known_home(agent: AgentKind, home: &Path, names: &[&str]) -> Result<Vec<CatalogAsset>> {
    let allowed: BTreeSet<_> = names.iter().copied().collect();
    let mut output = Vec::new();
    for name in names {
        let path = home.join(name);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file() {
            if !is_private_home_file(&path) {
                output.push(home_asset(agent, &path, home_asset_kind(&path))?);
            }
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&path)
            .max_depth(4)
            .follow_links(false)
            .same_file_system(true)
            .into_iter()
            .filter_entry(allowed_home_entry)
        {
            let entry = entry?;
            if !entry.file_type().is_file() || is_private_home_file(entry.path()) {
                continue;
            }
            if *name == "skills"
                && entry.path().file_name().and_then(|value| value.to_str()) != Some("SKILL.md")
            {
                continue;
            }
            let kind = home_asset_kind(entry.path());
            output.push(home_asset(agent, entry.path(), kind)?);
        }
    }
    output.retain(|asset| {
        asset
            .path
            .strip_prefix(home)
            .ok()
            .and_then(|path| path.components().next())
            .and_then(|part| part.as_os_str().to_str())
            .is_some_and(|name| allowed.contains(name))
    });
    Ok(output)
}

fn allowed_home_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".cache"
                | "__pycache__"
                | ".venv"
                | "venv"
        )
    ) && platform_path::is_safe_scan_entry(entry.path())
}

fn is_private_home_file(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    text.contains("credential")
        || text.contains("telemetry")
        || text.ends_with(".env")
        || text.contains("session")
        || text.ends_with("state.db")
        || path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| {
                let name = name.to_ascii_lowercase();
                name.contains("token")
                    || name.contains("secret")
                    || name.ends_with(".pem")
                    || name.ends_with(".key")
            })
}

fn home_asset_kind(path: &Path) -> AssetKind {
    let text = path.to_string_lossy().to_ascii_lowercase();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if name.eq_ignore_ascii_case("SKILL.md") || text.contains("/skills/") {
        AssetKind::Skill
    } else if name.eq_ignore_ascii_case("MEMORY.md") || text.contains("/memory/") {
        AssetKind::Memory
    } else if name.eq_ignore_ascii_case("hooks.json") || text.contains("/hooks/") {
        AssetKind::Hook
    } else if text.contains("/agents/")
        || text.contains("/profiles/")
        || text.contains("/.agent-presets/")
    {
        AssetKind::Agent
    } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
        AssetKind::Instruction
    } else {
        AssetKind::Configuration
    }
}

fn home_asset(agent: AgentKind, path: &Path, kind: AssetKind) -> Result<CatalogAsset> {
    let metadata = fs::metadata(path)?;
    let name = if matches!(kind, AssetKind::Skill)
        && path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md")
    {
        path.parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .unwrap_or("skill")
    } else {
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("asset")
    };
    Ok(CatalogAsset {
        id: String::new(),
        scope: CatalogScope::AgentHome,
        workspace_id: None,
        agent: Some(agent),
        kind,
        name: name.to_string(),
        path: path.to_path_buf(),
        summary: format!("{} Home asset (read-only)", agent.as_str()),
        summary_key: Some("assets.summary.homeAsset".into()),
        summary_params: [("agent".into(), agent.as_str().into())]
            .into_iter()
            .collect(),
        size: metadata.len(),
        modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
    })
}

fn installation(agent: AgentKind, home: Option<PathBuf>, installed: bool) -> AgentInstallation {
    let configured = home.as_ref().is_some_and(|path| path.is_dir());
    AgentInstallation {
        agent,
        installed,
        configured,
        version: None,
        home,
        warnings: Vec::new(),
    }
}

fn cursor_installation(
    home: Option<PathBuf>,
    data_home: Option<PathBuf>,
    installed: bool,
) -> AgentInstallation {
    let mut value = installation(AgentKind::Cursor, home, installed);
    value.configured = value.configured || data_home.is_some_and(|path| path.is_dir());
    value
}

fn cursor_default_data_home() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        agentkib_platform::xdg::config_home().map(|path| path.join("Cursor"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        dirs::config_dir().map(|path| path.join("Cursor"))
    }
}

fn agent_is_installed(agent: AgentKind) -> bool {
    let command = match agent {
        AgentKind::Codex => "codex",
        AgentKind::ClaudeCode => "claude",
        AgentKind::Cursor => "cursor",
        AgentKind::OpenCode => "opencode",
        AgentKind::OpenClaw => "openclaw",
        AgentKind::Hermes => "hermes",
        AgentKind::DeepSeekHarness => "dsh",
    };
    command_is_available(command) || app_bundle_is_available(agent)
}

fn command_is_available(command: &str) -> bool {
    command::resolve(command).is_some()
}

#[cfg(all(test, unix))]
fn command_is_available_in(command: &str, directories: &BTreeSet<PathBuf>) -> bool {
    command::resolve_in(command, directories.iter().map(PathBuf::as_path)).is_some()
}

#[cfg(target_os = "macos")]
fn app_bundle_is_available(agent: AgentKind) -> bool {
    let bundle = match agent {
        AgentKind::Codex => "Codex.app",
        AgentKind::Cursor => "Cursor.app",
        AgentKind::OpenCode => "OpenCode.app",
        AgentKind::ClaudeCode
        | AgentKind::OpenClaw
        | AgentKind::Hermes
        | AgentKind::DeepSeekHarness => return false,
    };
    let mut candidates = vec![PathBuf::from("/Applications").join(bundle)];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Applications").join(bundle));
    }
    candidates
        .into_iter()
        .any(|path| path.join("Contents/Info.plist").is_file())
}

#[cfg(target_os = "windows")]
fn app_bundle_is_available(agent: AgentKind) -> bool {
    if agent == AgentKind::Cursor {
        return command::cursor_app_is_available();
    }
    if agent != AgentKind::OpenCode {
        return false;
    }
    dirs::data_local_dir().is_some_and(|local| {
        [
            local.join("Programs/OpenCode/OpenCode.exe"),
            local.join("OpenCode/OpenCode.exe"),
        ]
        .into_iter()
        .any(|path| path.is_file())
    })
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn app_bundle_is_available(agent: AgentKind) -> bool {
    match agent {
        AgentKind::Cursor => command::cursor_app_is_available(),
        AgentKind::OpenCode => {
            let search = command::search_directories();
            command::desktop_application_executables(
                &["ai.opencode.desktop", "opencode-desktop"],
                &search,
            )
            .into_iter()
            .any(|path| command::is_executable(&path))
        }
        _ => false,
    }
}

fn candidate(
    path: PathBuf,
    source_agent: Option<AgentKind>,
    evidence: DiscoveryEvidence,
    last_active_at: Option<DateTime<Utc>>,
    session_count: u64,
    explicit_workspace: bool,
) -> DiscoveryCandidate {
    DiscoveryCandidate {
        path,
        display_name: None,
        source_agent,
        evidence,
        last_active_at,
        session_count,
        explicit_workspace,
        repository_group_id: None,
    }
}

fn open_read_only(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    Ok(connection)
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(table_columns(connection, table)?.contains(column))
}

fn table_columns(connection: &Connection, table: &str) -> Result<BTreeSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut output = BTreeSet::new();
    for value in columns {
        output.insert(value?);
    }
    Ok(output)
}

fn timestamp_from_integer(value: i64) -> Option<DateTime<Utc>> {
    if value <= 0 {
        return None;
    }
    if value > 10_000_000_000 {
        Utc.timestamp_millis_opt(value).single()
    } else {
        Utc.timestamp_opt(value, 0).single()
    }
}

fn timestamp_from_float(value: f64) -> Option<DateTime<Utc>> {
    timestamp_from_integer(value as i64)
}

fn parse_json_timestamp(value: &JsonValue) -> Option<DateTime<Utc>> {
    value.as_i64().and_then(timestamp_from_integer).or_else(|| {
        value.as_str().and_then(|value| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|value| value.with_timezone(&Utc))
        })
    })
}

fn merge_activity(
    values: &mut BTreeMap<PathBuf, SessionActivity>,
    path: PathBuf,
    session_id: Option<String>,
    timestamp: Option<DateTime<Utc>>,
) {
    let activity = values.entry(path).or_default();
    if let Some(session_id) = session_id {
        activity.session_ids.insert(session_id);
    } else {
        activity.anonymous_sessions = activity.anonymous_sessions.saturating_add(1);
    }
    activity.last_active_at = latest(activity.last_active_at, timestamp);
}

fn session_identifier(value: &JsonValue) -> Option<String> {
    ["sessionId", "session_id", "id"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(JsonValue::as_str))
        .map(str::to_owned)
}

fn session_index_entries(value: &JsonValue) -> Vec<&JsonValue> {
    value
        .get("entries")
        .and_then(JsonValue::as_array)
        .or_else(|| value.as_array())
        .into_iter()
        .flatten()
        .collect()
}

fn latest(left: Option<DateTime<Utc>>, right: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(relative) = value.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(relative))
            .unwrap_or_else(|| PathBuf::from(value));
    }
    PathBuf::from(value)
}

fn resolve_config_path(home: &Path, value: &str) -> PathBuf {
    let expanded = expand_home(value);
    if expanded.is_absolute() {
        expanded
    } else {
        home.join(expanded)
    }
}

fn modified_at(path: &Path) -> Result<DateTime<Utc>> {
    Ok(DateTime::<Utc>::from(
        fs::metadata(path)?
            .modified()
            .unwrap_or(SystemTime::UNIX_EPOCH),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn bounded_parallel_map_preserves_input_order() {
        let values = parallel_map_bounded(vec![3, 1, 2], 2, |value| value * 10);
        assert_eq!(values, vec![30, 10, 20]);
    }

    #[test]
    fn residual_home_is_configured_but_not_installed() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("cursor-home");
        let data_home = dir.path().join("Cursor");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&data_home).unwrap();

        let value = cursor_installation(Some(home.clone()), Some(data_home), false);

        assert!(!value.installed);
        assert!(value.configured);
        assert_eq!(value.home, Some(home));
    }

    #[test]
    fn opencode_residual_configuration_is_not_installation_evidence() {
        let dir = tempdir().unwrap();
        let config_home = dir.path().join("config/opencode");
        fs::create_dir_all(&config_home).unwrap();

        let value = installation(AgentKind::OpenCode, Some(config_home.clone()), false);

        assert!(!value.installed);
        assert!(value.configured);
        assert_eq!(value.home, Some(config_home));
    }

    #[test]
    fn opencode_discovers_sqlite_projects_without_exposing_session_titles() {
        let dir = tempdir().unwrap();
        let data_home = dir.path().join("data/opencode");
        fs::create_dir_all(&data_home).unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let connection = Connection::open(data_home.join("opencode.db")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, time_created INTEGER, time_updated INTEGER);\
                 CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO project VALUES (?1, ?2, 1000, 2000)",
                rusqlite::params!["project-private-id", workspace.display().to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES (?1, ?2, ?3, ?4, 2000, 3000)",
                rusqlite::params![
                    "session-private-id",
                    "project-private-id",
                    workspace.display().to_string(),
                    "private session title"
                ],
            )
            .unwrap();
        drop(connection);

        let candidates = OpenCodeProvider {
            config_home: None,
            data_home: Some(data_home),
        }
        .discover()
        .unwrap();

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, workspace);
        assert_eq!(candidates[0].session_count, 1);
        let debug = format!("{candidates:?}");
        assert!(!debug.contains("private session title"));
        assert!(!debug.contains("session-private-id"));
    }

    #[test]
    fn opencode_discovers_legacy_project_json_without_exposing_metadata() {
        let dir = tempdir().unwrap();
        let data_home = dir.path().join("data/opencode");
        let project_store = data_home.join("storage/project");
        let session_store = data_home.join("storage/session/project-private-id");
        fs::create_dir_all(&project_store).unwrap();
        fs::create_dir_all(&session_store).unwrap();
        let workspace = dir.path().join("legacy-workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(
            project_store.join("project-private-id.json"),
            serde_json::json!({
                "id": "project-private-id",
                "worktree": workspace,
                "name": "private project title",
                "time": { "updated": 3_000 }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            session_store.join("session-private-id.json"),
            r#"{"title":"private session title","messages":["secret"]}"#,
        )
        .unwrap();

        let candidates = discover_legacy_opencode_projects(&data_home).unwrap();

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].session_count, 1);
        let debug = format!("{candidates:?}");
        assert!(!debug.contains("private project title"));
        assert!(!debug.contains("private session title"));
    }

    #[cfg(unix)]
    #[test]
    fn executable_file_is_valid_installation_evidence() {
        let dir = tempdir().unwrap();
        let executable = dir.path().join("cursor");
        fs::write(&executable, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let directories = [dir.path().to_path_buf()].into_iter().collect();

        assert!(command_is_available_in("cursor", &directories));
    }

    #[test]
    fn normalizes_nested_directory_to_project_marker() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("packages/api/src")).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let result = normalize_workspace(&dir.path().join("packages/api/src"), false).unwrap();
        assert_eq!(result, platform_path::canonicalize(dir.path()).unwrap());
    }

    #[test]
    fn ignores_existing_unmarked_session_directory() {
        let dir = tempdir().unwrap();
        assert!(normalize_workspace(dir.path(), false).is_none());
        assert_eq!(
            normalize_workspace(dir.path(), true).unwrap(),
            platform_path::canonicalize(dir.path()).unwrap()
        );
    }

    #[test]
    fn scan_root_skips_dependency_directories() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("app/.git")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/fake/.git")).unwrap();
        let (discovered, errors) = discover_scan_root(dir.path(), 5).unwrap();
        assert!(errors.is_empty());
        assert_eq!(discovered.len(), 1);
        assert_eq!(
            discovered[0].path,
            platform_path::canonicalize(&dir.path().join("app")).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_root_rejects_symbolic_link_roots() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let actual = dir.path().join("actual");
        fs::create_dir(&actual).unwrap();
        let link = dir.path().join("linked");
        symlink(&actual, &link).unwrap();

        assert!(
            discover_scan_root(&link, 5)
                .unwrap_err()
                .to_string()
                .contains("symbolic link")
        );
    }

    #[cfg(unix)]
    #[test]
    fn home_catalog_does_not_follow_symbolic_links() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let external = dir.path().join("external-skills");
        fs::create_dir_all(external.join("private")).unwrap();
        fs::write(external.join("private/SKILL.md"), "private body").unwrap();
        symlink(&external, dir.path().join("skills")).unwrap();

        let assets = scan_known_home(AgentKind::Codex, dir.path(), &["skills"]).unwrap();
        assert!(assets.is_empty());
    }

    #[test]
    fn worktrees_share_repository_group_without_merging_paths() {
        let dir = tempdir().unwrap();
        let main = dir.path().join("main");
        let worktree = dir.path().join("worktree");
        fs::create_dir_all(main.join(".git/worktrees/feature")).unwrap();
        fs::create_dir(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            "gitdir: ../main/.git/worktrees/feature\n",
        )
        .unwrap();
        fs::write(main.join(".git/worktrees/feature/commondir"), "../..\n").unwrap();

        assert_ne!(
            main.canonicalize().unwrap(),
            worktree.canonicalize().unwrap()
        );
        assert_eq!(repository_group_id(&main), repository_group_id(&worktree));
    }

    #[test]
    fn codex_reads_legacy_thread_timestamp_columns() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let agent_home = dir.path().join("codex");
        fs::create_dir(&agent_home).unwrap();
        let database = Connection::open(agent_home.join("state_test.sqlite")).unwrap();
        database
            .execute_batch("CREATE TABLE threads(cwd TEXT, updated_at INTEGER);")
            .unwrap();
        database
            .execute(
                "INSERT INTO threads(cwd, updated_at) VALUES (?1, 1700000000)",
                [workspace.display().to_string()],
            )
            .unwrap();
        drop(database);

        let candidates = CodexProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].session_count, 1);
    }

    #[test]
    fn claude_counts_sessions_without_retaining_prompt_data() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let agent_home = dir.path().join("claude");
        fs::create_dir_all(agent_home.join("projects/p1")).unwrap();
        fs::write(
            agent_home.join("history.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({
                    "project": workspace.to_string_lossy(),
                    "sessionId": "private-session",
                    "display": "private prompt"
                })
            ),
        )
        .unwrap();
        fs::write(
            agent_home.join("projects/p1/sessions-index.json"),
            serde_json::to_vec(&serde_json::json!({
                "entries": [{
                    "projectPath": workspace.to_string_lossy(),
                    "sessionId": "private-session",
                    "messageCount": 42
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let candidates = ClaudeProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].session_count, 1);
        assert!(!format!("{candidates:?}").contains("private-session"));
        assert!(!format!("{candidates:?}").contains("private prompt"));
    }

    #[test]
    fn claude_excludes_codexbar_probe_workspace() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let probe = dir.path().join("ClaudeProbe");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        fs::create_dir_all(&probe).unwrap();
        fs::write(probe.join(".codexbar-session-id"), "probe-session").unwrap();
        let agent_home = dir.path().join("claude");
        fs::create_dir_all(&agent_home).unwrap();
        let records = [
            serde_json::json!({"project":workspace,"sessionId":"user-session"}),
            serde_json::json!({"project":probe,"sessionId":"probe-session-1"}),
            serde_json::json!({"project":probe,"sessionId":"probe-session-2"}),
        ];
        fs::write(
            agent_home.join("history.jsonl"),
            records
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let candidates = ClaudeProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            platform_path::identity(&candidates[0].path),
            platform_path::identity(&workspace)
        );
    }

    #[test]
    fn openclaw_supports_json5_and_multiple_workspaces() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let agent_home = dir.path().join("openclaw");
        fs::create_dir(&agent_home).unwrap();
        fs::write(
            agent_home.join("openclaw.json"),
            format!(
                "{{ agents: {{ defaults: {{ workspace: '{}' }}, list: [{{ workspace: '{}' }}], }}, }}",
                first.display(),
                second.display()
            ),
        )
        .unwrap();

        let candidates = OpenClawProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().all(|value| value.explicit_workspace));
    }

    #[test]
    fn hermes_discovers_default_and_profile_workspaces() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let agent_home = dir.path().join("hermes");
        fs::create_dir_all(agent_home.join("profiles/work")).unwrap();
        fs::write(
            agent_home.join("config.yaml"),
            format!("terminal:\n  cwd: {}\n", first.display()),
        )
        .unwrap();
        fs::write(
            agent_home.join("profiles/work/config.yaml"),
            format!("terminal:\n  cwd: {}\n", second.display()),
        )
        .unwrap();

        let candidates = HermesProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 2);
    }

    #[test]
    fn cursor_discovers_workspace_metadata_without_reading_chat_content() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project with space");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let cursor_home = dir.path().join("cursor-home");
        fs::create_dir(&cursor_home).unwrap();
        let data_home = dir.path().join("Cursor");
        let storage = data_home.join("User/workspaceStorage/hash");
        fs::create_dir_all(&storage).unwrap();
        let uri_path = workspace
            .display()
            .to_string()
            .replace('\\', "/")
            .replace(' ', "%20");
        let uri = if cfg!(windows) {
            format!("file:///{uri_path}")
        } else {
            format!("file://{uri_path}")
        };
        fs::write(
            storage.join("workspace.json"),
            serde_json::to_vec(&serde_json::json!({
                "folder": uri,
                "prompt": "must not be retained"
            }))
            .unwrap(),
        )
        .unwrap();

        let candidates = CursorProvider {
            home: Some(cursor_home),
            data_home: Some(data_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, workspace);
        assert!(!format!("{candidates:?}").contains("must not be retained"));
    }

    #[test]
    fn deepseek_harness_reads_workspace_v2_without_retaining_session_ids() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("harness-project");
        fs::create_dir(&workspace).unwrap();
        let storage = dir.path().join("workspace.json");
        fs::write(
            &storage,
            serde_json::to_vec(&serde_json::json!({
                "unit": { "name": "workspace", "version": 2 },
                "global": null,
                "tables": { "workspaces": { "private-workspace-id": {
                    "path": workspace,
                    "title": "Harness Project",
                    "sessionIds": ["private-session-1", "private-session-2"],
                    "updatedAt": "2026-08-14T00:00:00Z"
                } } }
            }))
            .unwrap(),
        )
        .unwrap();

        let candidates = parse_deepseek_workspaces(&storage).unwrap();

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].session_count, 2);
        assert_eq!(
            candidates[0].display_name.as_deref(),
            Some("Harness Project")
        );
        assert!(candidates[0].explicit_workspace);
        assert!(!format!("{candidates:?}").contains("private-session"));
    }

    #[test]
    fn deepseek_harness_rejects_unknown_workspace_storage_version() {
        let dir = tempdir().unwrap();
        let storage = dir.path().join("workspace.json");
        fs::write(
            &storage,
            r#"{"unit":{"name":"workspace","version":3},"tables":{"workspaces":{}}}"#,
        )
        .unwrap();

        assert!(
            parse_deepseek_workspaces(&storage)
                .unwrap_err()
                .to_string()
                .contains("version is not supported")
        );
    }

    #[test]
    fn home_catalog_excludes_private_files_and_classifies_memory() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("MEMORY.md"), "private memory body").unwrap();
        fs::write(dir.path().join("credentials.json"), "secret").unwrap();
        fs::create_dir_all(dir.path().join("skills/example/.git")).unwrap();
        fs::write(dir.path().join("skills/example/SKILL.md"), "skill body").unwrap();
        fs::write(
            dir.path().join("skills/example/script.py"),
            "print('noise')",
        )
        .unwrap();
        fs::write(dir.path().join("skills/example/.git/index"), "noise").unwrap();
        let assets = scan_known_home(
            AgentKind::Hermes,
            dir.path(),
            &["MEMORY.md", "credentials.json", "skills"],
        )
        .unwrap();
        assert_eq!(assets.len(), 2);
        assert!(assets.iter().any(|value| value.kind == AssetKind::Memory));
        assert!(assets.iter().any(|value| value.name == "example"));
    }
}
