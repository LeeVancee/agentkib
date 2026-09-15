use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use agentkib_core::{
    AgentInstallation, AgentKind, AssetKind, CatalogAsset, CatalogScope, DiscoveryCandidate,
    DiscoveryDiagnosticStatus, DiscoveryEvidence, DiscoverySourceDiagnostic, hash_content,
    inspect_skill_entrypoint,
};
use agentkib_platform::{command, path as platform_path};
use anyhow::{Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value as JsonValue;
use walkdir::{DirEntry, WalkDir};

const MAX_GROK_SUMMARY_BYTES: u64 = 256 * 1024;

pub trait WorkspaceDiscoveryProvider: Send {
    fn installation(&self) -> AgentInstallation;
    fn discover(&self) -> Result<Vec<DiscoveryCandidate>>;
    fn discover_with_diagnostics(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        let installation = self.installation();
        let started_at = Utc::now();
        let candidates = self.discover()?;
        let finished_at = Utc::now();
        let status = if !installation.configured {
            if installation
                .home
                .as_ref()
                .is_some_and(|path| !path.exists())
            {
                DiscoveryDiagnosticStatus::Missing
            } else {
                DiscoveryDiagnosticStatus::NotConfigured
            }
        } else if candidates.is_empty() {
            DiscoveryDiagnosticStatus::Empty
        } else {
            DiscoveryDiagnosticStatus::Succeeded
        };
        Ok((
            candidates.clone(),
            vec![source_diagnostic(
                Some(installation.agent),
                source_name(installation.agent),
                installation.home,
                started_at,
                finished_at,
                Some(candidates.len()),
                status,
                Vec::new(),
            )],
        ))
    }
    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>>;
}

pub struct DiscoverySnapshot {
    pub candidates: Vec<DiscoveryCandidate>,
    pub installations: Vec<AgentInstallation>,
    pub home_assets: Vec<CatalogAsset>,
    pub errors: Vec<String>,
    pub source_diagnostics: Vec<DiscoverySourceDiagnostic>,
}

fn providers() -> Vec<Box<dyn WorkspaceDiscoveryProvider>> {
    vec![
        Box::new(CodexProvider::default()),
        Box::new(ClaudeProvider::default()),
        Box::new(CursorProvider::default()),
        Box::new(OpenCodeProvider::default()),
        Box::new(OpenClawProvider::default()),
        Box::new(HermesProvider::default()),
        Box::new(GrokBuildProvider::default()),
        Box::new(DeepSeekHarnessProvider::default()),
    ]
}

pub fn known_agent_homes() -> Vec<PathBuf> {
    let mut homes: BTreeMap<String, PathBuf> = BTreeMap::new();
    for provider in providers() {
        if let Some(home) = provider.installation().home {
            homes.entry(platform_path::identity(&home)).or_insert(home);
        }
    }
    if let Ok(home) = agentkib_skills::default_home_dir() {
        homes.entry(platform_path::identity(&home)).or_insert(home);
    }
    homes.into_values().collect()
}

pub fn discover(scan_roots: &[(PathBuf, usize)]) -> DiscoverySnapshot {
    let providers = providers();
    let provider_results = parallel_map_bounded(providers, 4, |provider| {
        let installation = provider.installation();
        let label = installation.agent.as_str();
        let mut errors = Vec::new();
        let (candidates, diagnostics) =
            provider
                .discover_with_diagnostics()
                .unwrap_or_else(|error| {
                    errors.push(format!("{label} workspace discovery failed: {error}"));
                    (
                        Vec::new(),
                        vec![source_diagnostic(
                            Some(installation.agent),
                            source_name(installation.agent),
                            installation.home.clone(),
                            Utc::now(),
                            Utc::now(),
                            None,
                            source_error_status(&error),
                            vec![diagnostic_reason(&error.to_string())],
                        )],
                    )
                });
        let home_assets = provider.scan_home_assets().unwrap_or_else(|error| {
            errors.push(format!("{label} Home asset scan failed: {error}"));
            Vec::new()
        });
        (installation, candidates, home_assets, errors, diagnostics)
    });
    let scan_results = parallel_map_bounded(scan_roots.to_vec(), 4, |(root, depth)| {
        let started_at = Utc::now();
        let result = discover_scan_root(&root, depth);
        let finished_at = Utc::now();
        (root, started_at, finished_at, result)
    });

    let mut candidates = Vec::new();
    let mut installations = Vec::new();
    let mut home_assets = Vec::new();
    let mut errors = Vec::new();
    let mut source_diagnostics = Vec::new();
    for (installation, discovered, assets, provider_errors, diagnostics) in provider_results {
        installations.push(installation);
        candidates.extend(discovered);
        home_assets.extend(assets);
        errors.extend(provider_errors);
        source_diagnostics.extend(diagnostics);
    }
    match agentkib_skills::default_home_dir()
        .and_then(|home| agentkib_skills::scan_library_assets(&home))
    {
        Ok(assets) => home_assets.extend(assets),
        Err(error) => errors.push(format!("AgentKib Skill library scan failed: {error}")),
    }
    for (root, started_at, finished_at, result) in scan_results {
        match result {
            Ok((discovered, scan_errors)) => {
                let status = if scan_errors.is_empty() {
                    if discovered.is_empty() {
                        DiscoveryDiagnosticStatus::Empty
                    } else {
                        DiscoveryDiagnosticStatus::Succeeded
                    }
                } else {
                    DiscoveryDiagnosticStatus::Partial
                };
                source_diagnostics.push(source_diagnostic(
                    None,
                    "scan-root",
                    Some(root.clone()),
                    started_at,
                    finished_at,
                    Some(discovered.len()),
                    status,
                    if scan_errors.is_empty() {
                        Vec::new()
                    } else {
                        vec!["scan-entry-failed".into()]
                    },
                ));
                candidates.extend(discovered);
                errors.extend(scan_errors.into_iter().map(|error| {
                    format!("Scan root {} partially failed: {error}", root.display())
                }));
            }
            Err(error) => {
                source_diagnostics.push(source_diagnostic(
                    None,
                    "scan-root",
                    Some(root.clone()),
                    started_at,
                    finished_at,
                    None,
                    if error
                        .to_string()
                        .to_ascii_lowercase()
                        .contains("permission")
                    {
                        DiscoveryDiagnosticStatus::PermissionDenied
                    } else {
                        DiscoveryDiagnosticStatus::Failed
                    },
                    vec![diagnostic_reason(&error.to_string())],
                ));
                errors.push(format!("Scan root {} failed: {error}", root.display()))
            }
        }
    }
    let mut candidates = normalize_and_merge(candidates);
    exclude_agent_home_candidates(&mut candidates, &installations);
    DiscoverySnapshot {
        candidates,
        installations,
        home_assets,
        errors,
        source_diagnostics,
    }
}

fn source_name(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Codex => "state-db",
        AgentKind::ClaudeCode => "history-and-index",
        AgentKind::Cursor => "workspace-storage",
        AgentKind::OpenCode => "sqlite-and-legacy",
        AgentKind::OpenClaw => "config-and-sessions",
        AgentKind::Hermes => "profiles-and-state",
        AgentKind::GrokBuild => "sessions-and-archives",
        AgentKind::DeepSeekHarness => "workspace-storage",
    }
}

fn diagnostic_reason(error: &str) -> String {
    if error.to_ascii_lowercase().contains("permission") {
        "permission-denied".into()
    } else if error.to_ascii_lowercase().contains("unsupported") {
        "unsupported-schema".into()
    } else {
        "source-read-failed".into()
    }
}

fn source_error_status(error: &anyhow::Error) -> DiscoveryDiagnosticStatus {
    let error = error.to_string().to_ascii_lowercase();
    if error.contains("permission") {
        DiscoveryDiagnosticStatus::PermissionDenied
    } else if error.contains("unsupported") {
        DiscoveryDiagnosticStatus::Unsupported
    } else {
        DiscoveryDiagnosticStatus::Failed
    }
}

#[allow(clippy::too_many_arguments)]
fn source_diagnostic(
    agent: Option<AgentKind>,
    source: impl Into<String>,
    path: Option<PathBuf>,
    started_at: DateTime<Utc>,
    finished_at: DateTime<Utc>,
    candidate_count: Option<usize>,
    status: DiscoveryDiagnosticStatus,
    reasons: Vec<String>,
) -> DiscoverySourceDiagnostic {
    DiscoverySourceDiagnostic {
        agent,
        source: source.into(),
        path,
        started_at,
        finished_at,
        candidate_count,
        // Inclusion happens after all provider results are normalized and
        // filtered against managed/excluded paths. Source providers cannot
        // know that count without making this helper infer downstream state.
        included_count: None,
        skipped_count: None,
        status,
        reasons,
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
        self.discover_sources().map(|(candidates, _)| candidates)
    }

    fn discover_with_diagnostics(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        self.discover_sources()
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
                        "tools",
                    ],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

impl OpenCodeProvider {
    fn discover_sources(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        let Some(data_home) = self.data_home().filter(|path| path.is_dir()) else {
            let now = Utc::now();
            let data_home = self.data_home();
            return Ok((
                Vec::new(),
                vec![
                    source_diagnostic(
                        Some(AgentKind::OpenCode),
                        "sqlite",
                        data_home.as_ref().map(|path| path.join("opencode.db")),
                        now,
                        now,
                        None,
                        DiscoveryDiagnosticStatus::Missing,
                        vec!["missing-directory".into()],
                    ),
                    source_diagnostic(
                        Some(AgentKind::OpenCode),
                        "legacy-json",
                        data_home.map(|path| path.join("storage/project")),
                        now,
                        now,
                        None,
                        DiscoveryDiagnosticStatus::Missing,
                        vec!["missing-directory".into()],
                    ),
                ],
            ));
        };
        // The current SQLite store and the legacy JSON store are independent
        // sources. A damaged/migrating SQLite file must not hide usable legacy
        // projects, and vice versa.
        let mut diagnostics = Vec::new();
        let database = data_home.join("opencode.db");
        let sqlite_started = Utc::now();
        let mut output = if !database.is_file() {
            diagnostics.push(source_diagnostic(
                Some(AgentKind::OpenCode),
                "sqlite",
                Some(database.clone()),
                sqlite_started,
                Utc::now(),
                None,
                DiscoveryDiagnosticStatus::Missing,
                vec!["missing-file".into()],
            ));
            Vec::new()
        } else {
            match discover_opencode_database(&database) {
                Ok(value) => {
                    let status = if value.is_empty() {
                        DiscoveryDiagnosticStatus::Empty
                    } else {
                        DiscoveryDiagnosticStatus::Succeeded
                    };
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::OpenCode),
                        "sqlite",
                        Some(database.clone()),
                        sqlite_started,
                        Utc::now(),
                        Some(value.len()),
                        status,
                        Vec::new(),
                    ));
                    value
                }
                Err(error) => {
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::OpenCode),
                        "sqlite",
                        Some(database.clone()),
                        sqlite_started,
                        Utc::now(),
                        None,
                        source_error_status(&error),
                        vec![diagnostic_reason(&error.to_string())],
                    ));
                    Vec::new()
                }
            }
        };
        let database_paths: BTreeSet<_> = output
            .iter()
            .map(|candidate| platform_path::identity(&candidate.path))
            .collect();
        let legacy_root = data_home.join("storage/project");
        let legacy_started = Utc::now();
        if !legacy_root.is_dir() {
            diagnostics.push(source_diagnostic(
                Some(AgentKind::OpenCode),
                "legacy-json",
                Some(legacy_root),
                legacy_started,
                Utc::now(),
                None,
                DiscoveryDiagnosticStatus::Missing,
                vec!["missing-directory".into()],
            ));
        } else {
            match discover_legacy_opencode_projects(&data_home) {
                Ok(legacy) => {
                    let legacy = legacy
                        .into_iter()
                        .filter(|candidate| {
                            !database_paths.contains(&platform_path::identity(&candidate.path))
                        })
                        .collect::<Vec<_>>();
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::OpenCode),
                        "legacy-json",
                        Some(legacy_root),
                        legacy_started,
                        Utc::now(),
                        Some(legacy.len()),
                        if legacy.is_empty() {
                            DiscoveryDiagnosticStatus::Empty
                        } else {
                            DiscoveryDiagnosticStatus::Succeeded
                        },
                        Vec::new(),
                    ));
                    output.extend(legacy);
                }
                Err(error) => {
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::OpenCode),
                        "legacy-json",
                        Some(legacy_root),
                        legacy_started,
                        Utc::now(),
                        None,
                        source_error_status(&error),
                        vec![diagnostic_reason(&error.to_string())],
                    ));
                }
            }
        }
        // Keep per-source failures even when no source yielded a candidate.
        Ok((output, diagnostics))
    }
}

fn discover_opencode_database(path: &Path) -> Result<Vec<DiscoveryCandidate>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let connection = open_read_only(path)?;
    let project_columns = table_columns(&connection, "project")?;
    if !project_columns.contains("worktree") {
        return Ok(Vec::new());
    }
    let mut output = Vec::new();
    let project_time = opencode_timestamp_expression(&project_columns);
    let project_sql = format!(
        "SELECT worktree, 0, {project_time} FROM project \
         WHERE worktree IS NOT NULL AND worktree != '' GROUP BY worktree"
    );
    append_opencode_database_candidates(&connection, &project_sql, &mut output)?;

    let session_columns = table_columns(&connection, "session")?;
    if session_columns.contains("directory") {
        let session_time = opencode_timestamp_expression(&session_columns);
        let session_sql = format!(
            "SELECT directory, COUNT(*), {session_time} FROM session \
             WHERE directory IS NOT NULL AND directory != '' GROUP BY directory"
        );
        append_opencode_database_candidates(&connection, &session_sql, &mut output)?;
    }

    let mut grouped = BTreeMap::<String, DiscoveryCandidate>::new();
    for candidate in output {
        let key = platform_path::identity(&candidate.path);
        grouped
            .entry(key)
            .and_modify(|existing| {
                existing.session_count = existing
                    .session_count
                    .saturating_add(candidate.session_count);
                existing.last_active_at = latest(existing.last_active_at, candidate.last_active_at);
            })
            .or_insert(candidate);
    }
    Ok(grouped.into_values().collect())
}

fn opencode_timestamp_expression(columns: &BTreeSet<String>) -> &'static str {
    match (
        columns.contains("time_updated"),
        columns.contains("time_created"),
    ) {
        (true, true) => "MAX(COALESCE(time_updated, time_created))",
        (true, false) => "MAX(time_updated)",
        (false, true) => "MAX(time_created)",
        (false, false) => "NULL",
    }
}

fn append_opencode_database_candidates(
    connection: &Connection,
    sql: &str,
    output: &mut Vec<DiscoveryCandidate>,
) -> Result<()> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<i64>>(2)?,
        ))
    })?;
    for row in rows {
        let (directory, count, updated) = row?;
        output.push(candidate(
            PathBuf::from(directory),
            Some(AgentKind::OpenCode),
            DiscoveryEvidence::SessionCwd,
            updated.and_then(timestamp_from_integer),
            count.max(0) as u64,
            false,
        ));
    }
    Ok(())
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
        self.discover_sources().map(|(candidates, _)| candidates)
    }

    fn discover_with_diagnostics(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        self.discover_sources()
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

impl OpenClawProvider {
    fn discover_sources(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        let Some(home) = self.home().filter(|path| path.is_dir()) else {
            let now = Utc::now();
            let home = self.home();
            return Ok((
                Vec::new(),
                vec![
                    source_diagnostic(
                        Some(AgentKind::OpenClaw),
                        "config",
                        home.as_ref().map(|path| path.join("openclaw.json")),
                        now,
                        now,
                        None,
                        DiscoveryDiagnosticStatus::Missing,
                        vec!["missing-directory".into()],
                    ),
                    source_diagnostic(
                        Some(AgentKind::OpenClaw),
                        "sessions-jsonl",
                        home.map(|path| path.join("agents")),
                        now,
                        now,
                        None,
                        DiscoveryDiagnosticStatus::Missing,
                        vec!["missing-directory".into()],
                    ),
                ],
            ));
        };
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        let config = home.join("openclaw.json");
        let config_started = Utc::now();
        if config.is_file() {
            match fs::read_to_string(&config)
                .map_err(anyhow::Error::from)
                .and_then(|content| json5::from_str::<JsonValue>(&content).map_err(Into::into))
            {
                Ok(value) => {
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
                    let count = paths.len();
                    output.extend(paths.into_iter().map(|path| {
                        candidate(
                            path,
                            Some(AgentKind::OpenClaw),
                            DiscoveryEvidence::ConfiguredWorkspace,
                            None,
                            0,
                            true,
                        )
                    }));
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::OpenClaw),
                        "config",
                        Some(config),
                        config_started,
                        Utc::now(),
                        Some(count),
                        if count == 0 {
                            DiscoveryDiagnosticStatus::Empty
                        } else {
                            DiscoveryDiagnosticStatus::Succeeded
                        },
                        Vec::new(),
                    ));
                }
                Err(error) => {
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::OpenClaw),
                        "config",
                        Some(config),
                        config_started,
                        Utc::now(),
                        None,
                        source_error_status(&error),
                        vec![diagnostic_reason(&error.to_string())],
                    ));
                }
            }
        } else {
            diagnostics.push(source_diagnostic(
                Some(AgentKind::OpenClaw),
                "config",
                Some(config),
                config_started,
                Utc::now(),
                None,
                DiscoveryDiagnosticStatus::Missing,
                vec!["missing-file".into()],
            ));
        }

        let sessions_root = home.join("agents");
        let sessions_started = Utc::now();
        match discover_jsonl_cwds(&sessions_root, 3, AgentKind::OpenClaw) {
            Ok(discovery) => {
                let count = discovery.candidates.len();
                let reasons = discovery.reasons.into_iter().collect::<Vec<_>>();
                output.extend(discovery.candidates);
                diagnostics.push(source_diagnostic(
                    Some(AgentKind::OpenClaw),
                    "sessions-jsonl",
                    Some(sessions_root.clone()),
                    sessions_started,
                    Utc::now(),
                    Some(count),
                    if !reasons.is_empty() {
                        DiscoveryDiagnosticStatus::Partial
                    } else if count == 0 {
                        if sessions_root.is_dir() {
                            DiscoveryDiagnosticStatus::Empty
                        } else {
                            DiscoveryDiagnosticStatus::Missing
                        }
                    } else {
                        DiscoveryDiagnosticStatus::Succeeded
                    },
                    reasons,
                ));
            }
            Err(error) => {
                diagnostics.push(source_diagnostic(
                    Some(AgentKind::OpenClaw),
                    "sessions-jsonl",
                    Some(sessions_root),
                    sessions_started,
                    Utc::now(),
                    None,
                    source_error_status(&error),
                    vec![diagnostic_reason(&error.to_string())],
                ));
            }
        }
        Ok((output, diagnostics))
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
        self.discover_sources().map(|(candidates, _)| candidates)
    }

    fn discover_with_diagnostics(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        self.discover_sources()
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

impl HermesProvider {
    fn discover_sources(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        let homes = self.homes();
        if homes.is_empty() {
            let now = Utc::now();
            return Ok((
                Vec::new(),
                vec![source_diagnostic(
                    Some(AgentKind::Hermes),
                    "profiles",
                    None,
                    now,
                    now,
                    None,
                    DiscoveryDiagnosticStatus::NotConfigured,
                    Vec::new(),
                )],
            ));
        }
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        for home in homes {
            if !home.is_dir() {
                let finished_at = Utc::now();
                for (source, path) in [
                    ("config", home.join("config.yaml")),
                    ("state-db", home.join("state.db")),
                    ("sessions-jsonl", home.join("sessions")),
                ] {
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::Hermes),
                        source,
                        Some(path),
                        finished_at,
                        finished_at,
                        None,
                        DiscoveryDiagnosticStatus::Missing,
                        vec!["missing-directory".into()],
                    ));
                }
                continue;
            }
            let config = home.join("config.yaml");
            let config_started = Utc::now();
            if config.is_file() {
                match fs::read_to_string(&config)
                    .map_err(anyhow::Error::from)
                    .and_then(|content| {
                        serde_yaml::from_str::<serde_yaml::Value>(&content).map_err(Into::into)
                    }) {
                    Ok(value) => {
                        let path = value
                            .get("terminal")
                            .and_then(|value| value.get("cwd"))
                            .and_then(serde_yaml::Value::as_str)
                            .map(|path| resolve_config_path(&home, path));
                        if let Some(path) = path.clone() {
                            output.push(candidate(
                                path,
                                Some(AgentKind::Hermes),
                                DiscoveryEvidence::ConfiguredWorkspace,
                                None,
                                0,
                                true,
                            ));
                        }
                        diagnostics.push(source_diagnostic(
                            Some(AgentKind::Hermes),
                            "config",
                            Some(config),
                            config_started,
                            Utc::now(),
                            Some(usize::from(path.is_some())),
                            if path.is_some() {
                                DiscoveryDiagnosticStatus::Succeeded
                            } else {
                                DiscoveryDiagnosticStatus::Empty
                            },
                            Vec::new(),
                        ));
                    }
                    Err(error) => {
                        diagnostics.push(source_diagnostic(
                            Some(AgentKind::Hermes),
                            "config",
                            Some(config),
                            config_started,
                            Utc::now(),
                            None,
                            source_error_status(&error),
                            vec![diagnostic_reason(&error.to_string())],
                        ));
                    }
                }
            } else {
                diagnostics.push(source_diagnostic(
                    Some(AgentKind::Hermes),
                    "config",
                    Some(config),
                    config_started,
                    Utc::now(),
                    None,
                    DiscoveryDiagnosticStatus::Missing,
                    vec!["missing-file".into()],
                ));
            }

            let database = home.join("state.db");
            let db_started = Utc::now();
            if database.is_file() {
                match discover_hermes_database(&database) {
                    Ok(sessions) => {
                        let count = sessions.len();
                        output.extend(sessions);
                        diagnostics.push(source_diagnostic(
                            Some(AgentKind::Hermes),
                            "state-db",
                            Some(database),
                            db_started,
                            Utc::now(),
                            Some(count),
                            if count == 0 {
                                DiscoveryDiagnosticStatus::Empty
                            } else {
                                DiscoveryDiagnosticStatus::Succeeded
                            },
                            Vec::new(),
                        ));
                    }
                    Err(error) => {
                        diagnostics.push(source_diagnostic(
                            Some(AgentKind::Hermes),
                            "state-db",
                            Some(database),
                            db_started,
                            Utc::now(),
                            None,
                            source_error_status(&error),
                            vec![diagnostic_reason(&error.to_string())],
                        ));
                    }
                }
            } else {
                diagnostics.push(source_diagnostic(
                    Some(AgentKind::Hermes),
                    "state-db",
                    Some(database),
                    db_started,
                    Utc::now(),
                    None,
                    DiscoveryDiagnosticStatus::Missing,
                    vec!["missing-file".into()],
                ));
            }

            let sessions_root = home.join("sessions");
            let sessions_started = Utc::now();
            match discover_jsonl_cwds(&sessions_root, 3, AgentKind::Hermes) {
                Ok(discovery) => {
                    let count = discovery.candidates.len();
                    let reasons = discovery.reasons.into_iter().collect::<Vec<_>>();
                    output.extend(discovery.candidates);
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::Hermes),
                        "sessions-jsonl",
                        Some(sessions_root.clone()),
                        sessions_started,
                        Utc::now(),
                        Some(count),
                        if !reasons.is_empty() {
                            DiscoveryDiagnosticStatus::Partial
                        } else if count == 0 {
                            if sessions_root.is_dir() {
                                DiscoveryDiagnosticStatus::Empty
                            } else {
                                DiscoveryDiagnosticStatus::Missing
                            }
                        } else {
                            DiscoveryDiagnosticStatus::Succeeded
                        },
                        reasons,
                    ));
                }
                Err(error) => {
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::Hermes),
                        "sessions-jsonl",
                        Some(sessions_root),
                        sessions_started,
                        Utc::now(),
                        None,
                        source_error_status(&error),
                        vec![diagnostic_reason(&error.to_string())],
                    ));
                }
            }
        }
        Ok((output, diagnostics))
    }
}

fn discover_hermes_database(path: &Path) -> Result<Vec<DiscoveryCandidate>> {
    let connection = open_read_only(path)?;
    let columns = table_columns(&connection, "sessions")?;
    let cwd_column = ["cwd", "directory", "project_dir"]
        .into_iter()
        .find(|column| columns.contains(*column));
    let Some(cwd_column) = cwd_column else {
        return Ok(Vec::new());
    };
    let timestamp_column = ["started_at", "created_at", "updated_at"]
        .into_iter()
        .find(|column| columns.contains(*column));
    let timestamp_expression = timestamp_column
        .map(|column| format!("CAST(MAX({column}) AS TEXT)"))
        .unwrap_or_else(|| "NULL".into());
    let sql = format!(
        "SELECT {cwd_column}, COUNT(*), {timestamp_expression} FROM sessions \
         WHERE {cwd_column} IS NOT NULL AND {cwd_column} != '' GROUP BY {cwd_column}"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut output = Vec::new();
    for row in rows {
        let (path, count, timestamp) = row?;
        output.push(candidate(
            PathBuf::from(path),
            Some(AgentKind::Hermes),
            DiscoveryEvidence::SessionCwd,
            timestamp.as_deref().and_then(|value| {
                serde_json::from_str::<JsonValue>(value)
                    .ok()
                    .and_then(|value| parse_json_timestamp(&value))
                    .or_else(|| value.parse::<i64>().ok().and_then(timestamp_from_integer))
                    .or_else(|| {
                        value.parse::<f64>().ok().and_then(|value| {
                            (value.is_finite() && value > 0.0 && value < i64::MAX as f64)
                                .then(|| timestamp_from_integer(value as i64))
                                .flatten()
                        })
                    })
                    .or_else(|| {
                        DateTime::parse_from_rfc3339(value)
                            .ok()
                            .map(|value| value.with_timezone(&Utc))
                    })
            }),
            count.max(0) as u64,
            false,
        ));
    }
    Ok(output)
}

#[derive(Default)]
struct GrokBuildProvider {
    home: Option<PathBuf>,
}

impl GrokBuildProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("GROK_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".grok")))
        })
    }
}

impl WorkspaceDiscoveryProvider for GrokBuildProvider {
    fn installation(&self) -> AgentInstallation {
        installation(
            AgentKind::GrokBuild,
            self.home(),
            agent_is_installed(AgentKind::GrokBuild),
        )
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        self.discover_sources().map(|(candidates, _)| candidates)
    }

    fn discover_with_diagnostics(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        self.discover_sources()
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::GrokBuild,
                    &home,
                    &[
                        "config.toml",
                        "managed_config.toml",
                        "requirements.toml",
                        "AGENTS.md",
                        "rules",
                        "skills",
                        "plugins",
                        "agents",
                        "hooks",
                        "workflows",
                    ],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

impl GrokBuildProvider {
    fn discover_sources(
        &self,
    ) -> Result<(Vec<DiscoveryCandidate>, Vec<DiscoverySourceDiagnostic>)> {
        let Some(home) = self.home().filter(|path| path.is_dir()) else {
            let now = Utc::now();
            let home = self.home();
            return Ok((
                Vec::new(),
                vec![
                    source_diagnostic(
                        Some(AgentKind::GrokBuild),
                        "sessions",
                        home.as_ref().map(|path| path.join("sessions")),
                        now,
                        now,
                        None,
                        DiscoveryDiagnosticStatus::Missing,
                        vec!["missing-directory".into()],
                    ),
                    source_diagnostic(
                        Some(AgentKind::GrokBuild),
                        "archived-sessions",
                        home.map(|path| path.join("archived_sessions")),
                        now,
                        now,
                        None,
                        DiscoveryDiagnosticStatus::Missing,
                        vec!["missing-directory".into()],
                    ),
                ],
            ));
        };
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        for (source, root) in [
            ("sessions", home.join("sessions")),
            ("archived-sessions", home.join("archived_sessions")),
        ] {
            let started_at = Utc::now();
            if !root.is_dir() {
                diagnostics.push(source_diagnostic(
                    Some(AgentKind::GrokBuild),
                    source,
                    Some(root),
                    started_at,
                    Utc::now(),
                    None,
                    DiscoveryDiagnosticStatus::Missing,
                    vec!["missing-directory".into()],
                ));
                continue;
            }
            match discover_grok_root(&root) {
                Ok(discovery) => {
                    let count = discovery.candidates.len();
                    let reasons = discovery.reasons.into_iter().collect::<Vec<_>>();
                    output.extend(discovery.candidates);
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::GrokBuild),
                        source,
                        Some(root),
                        started_at,
                        Utc::now(),
                        Some(count),
                        if !reasons.is_empty() {
                            DiscoveryDiagnosticStatus::Partial
                        } else if count == 0 {
                            DiscoveryDiagnosticStatus::Empty
                        } else {
                            DiscoveryDiagnosticStatus::Succeeded
                        },
                        reasons,
                    ));
                }
                Err(error) => {
                    diagnostics.push(source_diagnostic(
                        Some(AgentKind::GrokBuild),
                        source,
                        Some(root),
                        started_at,
                        Utc::now(),
                        None,
                        source_error_status(&error),
                        vec![diagnostic_reason(&error.to_string())],
                    ));
                }
            }
        }
        Ok((output, diagnostics))
    }
}

struct GrokDiscovery {
    candidates: Vec<DiscoveryCandidate>,
    reasons: BTreeSet<String>,
}

fn discover_grok_root(root: &Path) -> Result<GrokDiscovery> {
    let mut output = Vec::new();
    let mut reasons = BTreeSet::new();
    for entry in WalkDir::new(root)
        .min_depth(3)
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            platform_path::is_safe_scan_entry(entry.path())
                && !platform_path::is_reparse_or_symlink(entry.path()).unwrap_or(true)
        })
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                reasons.insert("scan-entry-failed".into());
                continue;
            }
        };
        if !entry.file_type().is_file() || entry.file_name() != "summary.json" {
            continue;
        }
        let value = match read_bounded_json(entry.path(), MAX_GROK_SUMMARY_BYTES) {
            Ok(value) => value,
            Err(_) => {
                reasons.insert("source-read-failed".into());
                continue;
            }
        };
        let Some(cwd) = value.pointer("/info/cwd").and_then(JsonValue::as_str) else {
            continue;
        };
        if cwd.trim().is_empty() {
            continue;
        }
        let timestamp = value
            .get("updated_at")
            .or_else(|| value.get("updatedAt"))
            .or_else(|| value.get("created_at"))
            .or_else(|| value.get("createdAt"))
            .and_then(parse_json_timestamp);
        output.push(candidate(
            PathBuf::from(cwd),
            Some(AgentKind::GrokBuild),
            DiscoveryEvidence::SessionCwd,
            timestamp,
            1,
            false,
        ));
    }
    Ok(GrokDiscovery {
        candidates: output,
        reasons,
    })
}

fn read_bounded_json(path: &Path, limit: u64) -> Result<JsonValue> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > limit {
        anyhow::bail!("JSON file is not a bounded regular file");
    }
    let mut content = String::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_string(&mut content)?;
    if content.len() as u64 > limit {
        anyhow::bail!("JSON file exceeds the read limit");
    }
    Ok(serde_json::from_str(&content)?)
}

/// Extract only the small session header needed for workspace discovery. The
/// body is never retained, and symlinked files are rejected by the bounded
/// regular-file check.
struct JsonlCwdDiscovery {
    candidates: Vec<DiscoveryCandidate>,
    reasons: BTreeSet<String>,
}

fn discover_jsonl_cwds(
    root: &Path,
    max_depth: usize,
    agent: AgentKind,
) -> Result<JsonlCwdDiscovery> {
    if !root.is_dir() {
        return Ok(JsonlCwdDiscovery {
            candidates: Vec::new(),
            reasons: BTreeSet::new(),
        });
    }
    let mut output = Vec::new();
    let mut reasons = BTreeSet::new();
    for entry in WalkDir::new(root)
        .max_depth(max_depth.max(1))
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| platform_path::is_safe_scan_entry(entry.path()))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                reasons.insert("scan-entry-failed".into());
                continue;
            }
        };
        let path = entry.path();
        if !entry.file_type().is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        if platform_path::is_reparse_or_symlink(path).unwrap_or(true) {
            reasons.insert("source-read-failed".into());
            continue;
        }
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => {
                reasons.insert("source-read-failed".into());
                continue;
            }
        };
        if !metadata.file_type().is_file() {
            reasons.insert("source-read-failed".into());
            continue;
        }
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(_) => {
                reasons.insert("source-read-failed".into());
                continue;
            }
        };
        let mut cwd = None;
        let mut updated_at = None;
        const HEADER_BYTES: usize = 256 * 1024;
        let mut bytes = Vec::new();
        if file
            .take((HEADER_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .is_err()
        {
            reasons.insert("source-read-failed".into());
            continue;
        }
        let byte_limited = bytes.len() > HEADER_BYTES;
        if byte_limited {
            bytes.truncate(HEADER_BYTES);
            // Never parse the partial record at the byte boundary as a header.
            let end = bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |i| i + 1);
            bytes.truncate(end);
        }
        let mut lines = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty());
        for line in lines.by_ref().take(32) {
            let value = match serde_json::from_slice::<JsonValue>(line) {
                Ok(value) => value,
                Err(_) => {
                    reasons.insert("unsupported-schema".into());
                    continue;
                }
            };
            if updated_at.is_none() {
                updated_at = value
                    .get("timestamp")
                    .or_else(|| value.get("updated_at"))
                    .or_else(|| value.get("updatedAt"))
                    .and_then(parse_json_timestamp);
            }
            if cwd.is_none() {
                cwd = value
                    .get("cwd")
                    .or_else(|| value.get("directory"))
                    .or_else(|| value.get("project_dir"))
                    .or_else(|| value.pointer("/session/cwd"))
                    .and_then(JsonValue::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(PathBuf::from);
            }
            if cwd.is_some() && updated_at.is_some() {
                break;
            }
        }
        if (cwd.is_none() || updated_at.is_none()) && (byte_limited || lines.next().is_some()) {
            reasons.insert("scan-budget-exceeded".into());
        }
        if let Some(cwd) = cwd {
            output.push(candidate(
                cwd,
                Some(agent),
                DiscoveryEvidence::SessionCwd,
                updated_at,
                1,
                false,
            ));
        }
    }
    Ok(JsonlCwdDiscovery {
        candidates: output,
        reasons,
    })
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
        let session_root = matches!(candidate.evidence, DiscoveryEvidence::SessionCwd)
            && matches!(
                candidate.source_agent,
                Some(AgentKind::OpenClaw | AgentKind::Hermes | AgentKind::GrokBuild)
            );
        let Some(path) = (if session_root {
            platform_path::session_workspace_root(&candidate.path, dirs::home_dir().as_deref())
        } else {
            normalize_workspace(&candidate.path, candidate.explicit_workspace)
        }) else {
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
                merge_session_cwds(&mut existing.session_cwds, candidate.session_cwds.as_ref());
            })
            .or_insert(candidate);
    }
    grouped.into_values().collect()
}

fn merge_session_cwds(target: &mut Option<Vec<PathBuf>>, incoming: Option<&Vec<PathBuf>>) {
    let Some(incoming) = incoming else {
        return;
    };
    let target = target.get_or_insert_with(Vec::new);
    for path in incoming {
        let identity = platform_path::identity(path);
        if !target
            .iter()
            .any(|existing| platform_path::identity(existing) == identity)
        {
            target.push(path.clone());
        }
    }
    target.sort_by_key(|path| platform_path::identity(path));
}

fn exclude_agent_home_candidates(
    candidates: &mut Vec<DiscoveryCandidate>,
    installations: &[AgentInstallation],
) {
    let agent_homes: BTreeSet<_> = installations
        .iter()
        .filter_map(|installation| installation.home.as_deref())
        .map(platform_path::identity)
        .collect();
    let mut managed_homes = agent_homes;
    if let Ok(home) = agentkib_skills::default_home_dir() {
        managed_homes.insert(platform_path::identity(&home));
    }
    candidates
        .retain(|candidate| !managed_homes.contains(&platform_path::identity(&candidate.path)));
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
        ".opencode",
        "opencode.json",
        "opencode.jsonc",
        ".grok",
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
    let home = platform_path::canonicalize(home)?;
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
            .strip_prefix(&home)
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
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if name.eq_ignore_ascii_case("SKILL.md") || has_path_component(path, "skills") {
        AssetKind::Skill
    } else if name.eq_ignore_ascii_case("MEMORY.md") || has_path_component(path, "memory") {
        AssetKind::Memory
    } else if name.eq_ignore_ascii_case("hooks.json") || has_path_component(path, "hooks") {
        AssetKind::Hook
    } else if has_path_component(path, "agents")
        || has_path_component(path, "profiles")
        || has_path_component(path, ".agent-presets")
    {
        AssetKind::Agent
    } else if has_path_component(path, "workflows") {
        AssetKind::Configuration
    } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
        AssetKind::Instruction
    } else {
        AssetKind::Configuration
    }
}

fn has_path_component(path: &Path, expected: &str) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|component| component.eq_ignore_ascii_case(expected))
    })
}

fn home_asset(agent: AgentKind, path: &Path, kind: AssetKind) -> Result<CatalogAsset> {
    let metadata = fs::metadata(path)?;
    let skill = (kind == AssetKind::Skill
        && path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md"))
    .then(|| inspect_skill_entrypoint(path))
    .transpose()?;
    let name = skill
        .as_ref()
        .map(|skill| skill.name.clone())
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("asset")
                .to_string()
        });
    let asset_path = skill
        .as_ref()
        .map(|skill| skill.root.clone())
        .unwrap_or_else(|| path.to_path_buf());
    Ok(CatalogAsset {
        id: String::new(),
        scope: CatalogScope::AgentHome,
        workspace_id: None,
        agent: Some(agent),
        kind,
        name,
        path: asset_path,
        summary: format!("{} Home asset (read-only)", agent.as_str()),
        summary_key: Some("assets.summary.homeAsset".into()),
        summary_params: [("agent".into(), agent.as_str().into())]
            .into_iter()
            .collect(),
        size: skill.as_ref().map_or(metadata.len(), |skill| skill.size),
        modified_at: skill
            .as_ref()
            .and_then(|skill| skill.modified_at)
            .or_else(|| metadata.modified().ok().map(DateTime::<Utc>::from)),
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
        support: Some(agentkib_core::AgentSupportCapabilities::for_agent(agent)),
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
        AgentKind::GrokBuild => "grok",
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
        | AgentKind::GrokBuild
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
    let session_cwds = matches!(
        (source_agent, evidence),
        (
            Some(AgentKind::OpenClaw | AgentKind::Hermes | AgentKind::GrokBuild),
            DiscoveryEvidence::SessionCwd
        )
    )
    .then(|| vec![path.clone()]);
    DiscoveryCandidate {
        path,
        display_name: None,
        source_agent,
        evidence,
        last_active_at,
        session_count,
        explicit_workspace,
        repository_group_id: None,
        session_cwds,
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
    fn jsonl_discovery_reads_large_transcript_headers_with_a_bounded_prefix() {
        for agent in [AgentKind::OpenClaw, AgentKind::Hermes] {
            let dir = tempdir().unwrap();
            let header =
                serde_json::json!({"cwd":"/workspace", "timestamp":"2026-09-01T12:00:00Z"});
            fs::write(
                dir.path().join("large.jsonl"),
                format!("{header}\n{}", "x".repeat(300 * 1024)),
            )
            .unwrap();
            let result = discover_jsonl_cwds(dir.path(), 1, agent).unwrap();
            assert_eq!(result.candidates.len(), 1);
            assert_eq!(result.candidates[0].path, PathBuf::from("/workspace"));
            assert!(result.reasons.is_empty());
        }
    }

    #[test]
    fn jsonl_discovery_does_not_parse_records_beyond_byte_or_line_budget() {
        for prefix in [" ".repeat(256 * 1024), "{}\n".repeat(32)] {
            let dir = tempdir().unwrap();
            fs::write(
                dir.path().join("limited.jsonl"),
                format!("{prefix}{{\"cwd\":\"/hidden\"}}\n"),
            )
            .unwrap();
            let result = discover_jsonl_cwds(dir.path(), 1, AgentKind::OpenClaw).unwrap();
            assert!(result.candidates.is_empty());
            assert!(result.reasons.contains("scan-budget-exceeded"));
        }
    }

    #[test]
    fn hermes_database_preserves_real_integer_and_rfc3339_timestamps() {
        for (kind, value, expected) in [
            ("REAL", "1788860000.5", 1788860000),
            ("INTEGER", "1788860000", 1788860000),
            ("INTEGER", "1788860000000", 1788860000),
            ("TEXT", "2026-09-08T10:53:20Z", 1788864800),
        ] {
            let dir = tempdir().unwrap();
            let path = dir.path().join("state.db");
            let db = Connection::open(&path).unwrap();
            db.execute_batch(&format!(
                "CREATE TABLE sessions(cwd TEXT, started_at {kind});"
            ))
            .unwrap();
            db.execute("INSERT INTO sessions VALUES('/workspace', ?1)", [value])
                .unwrap();
            drop(db);
            let candidates = discover_hermes_database(&path).unwrap();
            assert_eq!(candidates.len(), 1);
            assert_eq!(
                candidates[0].last_active_at.unwrap().timestamp(),
                expected,
                "{kind}: {value}"
            );
        }
    }

    #[test]
    fn failed_sources_keep_diagnostics_without_candidates() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("opencode.db"), "not sqlite").unwrap();
        fs::write(dir.path().join("openclaw.json"), "{broken").unwrap();
        fs::write(dir.path().join("state.db"), "not sqlite").unwrap();
        let providers: Vec<(Box<dyn WorkspaceDiscoveryProvider>, &str, &str)> = vec![
            (
                Box::new(OpenCodeProvider {
                    config_home: Some(dir.path().to_path_buf()),
                    data_home: Some(dir.path().to_path_buf()),
                }),
                "sqlite",
                "opencode.db",
            ),
            (
                Box::new(OpenClawProvider {
                    home: Some(dir.path().to_path_buf()),
                }),
                "config",
                "openclaw.json",
            ),
            (
                Box::new(HermesProvider {
                    home: Some(dir.path().to_path_buf()),
                }),
                "state-db",
                "state.db",
            ),
        ];
        for (provider, source, file) in providers {
            let (candidates, diagnostics) = provider.discover_with_diagnostics().unwrap();
            assert!(candidates.is_empty());
            let failure = diagnostics.iter().find(|d| d.source == source).unwrap();
            assert_eq!(
                failure.path.as_deref(),
                Some(dir.path().join(file).as_path())
            );
            assert_eq!(failure.status, DiscoveryDiagnosticStatus::Failed);
            assert!(!failure.reasons.is_empty());
            assert!(diagnostics.len() > 1);
        }
    }

    #[test]
    fn source_failure_keeps_other_source_candidates_and_missing_sources_stay_missing() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("openclaw");
        let provider = OpenClawProvider {
            home: Some(home.clone()),
        };
        let (candidates, diagnostics) = provider.discover_with_diagnostics().unwrap();
        assert!(candidates.is_empty());
        assert!(
            diagnostics
                .iter()
                .all(|d| d.status == DiscoveryDiagnosticStatus::Missing)
        );

        let sessions = home.join("agents/default/sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(home.join("openclaw.json"), "{broken").unwrap();
        fs::write(
            sessions.join("session.jsonl"),
            "{\"cwd\":\"/workspace\",\"timestamp\":\"2026-09-01T12:00:00Z\"}\n",
        )
        .unwrap();
        let (candidates, diagnostics) = provider.discover_with_diagnostics().unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(
            diagnostics
                .iter()
                .any(|d| d.source == "config" && d.status == DiscoveryDiagnosticStatus::Failed)
        );
        assert!(
            diagnostics.iter().any(|d| d.source == "sessions-jsonl"
                && d.status == DiscoveryDiagnosticStatus::Succeeded)
        );
    }

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
        fs::create_dir_all(workspace.join(".opencode")).unwrap();
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
        let normalized = normalize_and_merge(candidates.clone());
        assert_eq!(normalized.len(), 1);
        assert_eq!(
            normalized[0].path,
            platform_path::canonicalize(&workspace).unwrap()
        );
        let debug = format!("{candidates:?}");
        assert!(!debug.contains("private session title"));
        assert!(!debug.contains("session-private-id"));
    }

    #[test]
    fn opencode_discovers_distinct_session_directories_and_tolerates_missing_timestamps() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("opencode.db");
        let project = dir.path().join("project");
        let package = project.join("packages/api");
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(package.join(".opencode")).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE project (worktree TEXT);\
                 CREATE TABLE session (directory TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO project VALUES (?1)",
                [project.display().to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES (?1)",
                [package.display().to_string()],
            )
            .unwrap();
        drop(connection);

        let candidates = discover_opencode_database(&database).unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.last_active_at.is_none())
        );
        assert_eq!(
            candidates
                .iter()
                .find(|candidate| candidate.path == package)
                .unwrap()
                .session_count,
            1
        );
        let normalized = normalize_and_merge(candidates);
        assert_eq!(normalized.len(), 2);
    }

    #[test]
    fn opencode_home_catalog_includes_custom_tools() {
        let dir = tempdir().unwrap();
        let config_home = dir.path().join("config/opencode");
        fs::create_dir_all(config_home.join("tools")).unwrap();
        fs::write(config_home.join("tools/custom.ts"), "export default {}").unwrap();

        let assets = OpenCodeProvider {
            config_home: Some(config_home.clone()),
            data_home: None,
        }
        .scan_home_assets()
        .unwrap();

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].agent, Some(AgentKind::OpenCode));
        assert_eq!(assets[0].kind, AssetKind::Configuration);
        assert_eq!(
            assets[0].path,
            platform_path::canonicalize(&config_home.join("tools/custom.ts")).unwrap()
        );
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
        fs::write(workspace.join("opencode.jsonc"), "{}").unwrap();
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
        let normalized = normalize_and_merge(candidates.clone());
        assert_eq!(normalized.len(), 1);
        assert_eq!(
            normalized[0].path,
            platform_path::canonicalize(&workspace).unwrap()
        );
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
    fn session_cwd_normalization_preserves_all_original_nested_paths() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("packages/api");
        let second = dir.path().join("packages/web");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();

        let candidates = normalize_and_merge(vec![
            candidate(
                first.clone(),
                Some(AgentKind::OpenClaw),
                DiscoveryEvidence::SessionCwd,
                None,
                1,
                false,
            ),
            candidate(
                second.clone(),
                Some(AgentKind::OpenClaw),
                DiscoveryEvidence::SessionCwd,
                None,
                2,
                false,
            ),
        ]);

        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].path,
            platform_path::canonicalize(dir.path()).unwrap()
        );
        let mut session_cwds = candidates[0].session_cwds.clone().unwrap();
        session_cwds.sort();
        assert_eq!(session_cwds, vec![first, second]);
        assert_eq!(candidates[0].session_count, 3);
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
    fn grok_build_discovers_only_bounded_session_summary_metadata() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let home = dir.path().join("grok");
        let first = home.join("sessions/encoded/session-1");
        let second = home.join("sessions/encoded/session-2");
        let corrupt = home.join("sessions/encoded/session-3");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::create_dir_all(&corrupt).unwrap();
        fs::write(
            first.join("summary.json"),
            serde_json::json!({
                "info": { "cwd": workspace },
                "title": "must-not-be-retained",
                "updated_at": "2026-08-31T12:00:00Z"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            second.join("summary.json"),
            serde_json::json!({
                "info": { "cwd": workspace },
                "created_at": "2026-08-30T12:00:00Z"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(corrupt.join("summary.json"), "{broken").unwrap();

        let candidates = GrokBuildProvider { home: Some(home) }.discover().unwrap();
        let candidates = normalize_and_merge(candidates);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source_agent, Some(AgentKind::GrokBuild));
        assert_eq!(candidates[0].session_count, 2);
        assert_eq!(candidates[0].display_name, None);
        assert!(
            !serde_json::to_string(&candidates[0])
                .unwrap()
                .contains("session-1")
        );
        assert!(
            !serde_json::to_string(&candidates[0])
                .unwrap()
                .contains("must-not-be-retained")
        );
    }

    #[test]
    fn grok_build_skips_oversized_summaries_and_private_home_directories() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("grok");
        let session = home.join("sessions/encoded/session-1");
        fs::create_dir_all(&session).unwrap();
        fs::File::create(session.join("summary.json"))
            .unwrap()
            .set_len(MAX_GROK_SUMMARY_BYTES + 1)
            .unwrap();
        fs::create_dir_all(home.join("skills/reviewer")).unwrap();
        fs::write(home.join("skills/reviewer/SKILL.md"), "# Reviewer").unwrap();
        fs::create_dir_all(home.join("workflows")).unwrap();
        fs::write(home.join("workflows/review.md"), "# Review workflow").unwrap();
        fs::create_dir_all(home.join("agents")).unwrap();
        fs::write(home.join("agents/reviewer.md"), "# Reviewer agent").unwrap();
        fs::create_dir_all(home.join("memory")).unwrap();
        fs::write(home.join("memory/private.md"), "private").unwrap();

        let provider = GrokBuildProvider { home: Some(home) };
        assert!(provider.discover().unwrap().is_empty());
        let assets = provider.scan_home_assets().unwrap();
        assert!(assets.iter().any(|asset| asset.name == "reviewer"));
        assert!(
            assets
                .iter()
                .any(|asset| asset.path.ends_with("workflows/review.md"))
        );
        assert!(assets.iter().any(|asset| {
            asset.path.ends_with("workflows/review.md") && asset.kind == AssetKind::Configuration
        }));
        assert!(assets.iter().any(|asset| {
            asset.path.ends_with("agents/reviewer.md") && asset.kind == AssetKind::Agent
        }));
        assert!(
            assets
                .iter()
                .all(|asset| !asset.path.to_string_lossy().contains("memory"))
        );
        assert!(
            assets
                .iter()
                .all(|asset| !asset.path.to_string_lossy().contains("sessions"))
        );
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
    fn openclaw_discovers_session_cwd_without_configuration() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("session-workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let sessions = dir.path().join("openclaw/agents/default/sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("session-1.jsonl"),
            format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "session",
                    "id": "private-session-id",
                    "cwd": workspace,
                    "timestamp": "2026-09-01T12:00:00Z"
                }),
                serde_json::json!({
                    "type": "message",
                    "message": {"role": "user", "content": "private prompt"}
                })
            ),
        )
        .unwrap();

        let candidates = OpenClawProvider {
            home: Some(dir.path().join("openclaw")),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, workspace);
        assert_eq!(candidates[0].session_count, 1);
        assert!(!format!("{candidates:?}").contains("private-session-id"));
        assert!(!format!("{candidates:?}").contains("private prompt"));
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
    fn hermes_merges_profile_jsonl_cwds_with_database_sources() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("jsonl-workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let home = dir.path().join("hermes");
        let sessions = home.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("session.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session",
                    "cwd": workspace,
                    "timestamp": "2026-09-01T12:00:00Z"
                })
            ),
        )
        .unwrap();

        let candidates = HermesProvider { home: Some(home) }.discover().unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, workspace);
        assert_eq!(candidates[0].session_count, 1);
    }

    #[test]
    fn grok_build_discovers_archived_session_summaries() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let home = dir.path().join("grok");
        let session = home.join("archived_sessions/encoded/session-archived");
        fs::create_dir_all(&session).unwrap();
        fs::write(
            session.join("summary.json"),
            serde_json::json!({
                "info": {"cwd": workspace},
                "created_at": "2026-09-01T12:00:00Z"
            })
            .to_string(),
        )
        .unwrap();

        let candidates = GrokBuildProvider { home: Some(home) }.discover().unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, workspace);
        assert_eq!(candidates[0].session_count, 1);
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
        let skill_entrypoint = "---\nname: logical-skill\n---\nskill body";
        fs::write(dir.path().join("skills/example/SKILL.md"), skill_entrypoint).unwrap();
        fs::create_dir_all(dir.path().join("skills/example/references")).unwrap();
        fs::create_dir_all(dir.path().join("skills/example/scripts")).unwrap();
        fs::write(
            dir.path().join("skills/example/references/guide.md"),
            "guide",
        )
        .unwrap();
        fs::write(
            dir.path().join("skills/example/scripts/script.py"),
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
        let skill = assets
            .iter()
            .find(|value| value.kind == AssetKind::Skill)
            .unwrap();
        assert_eq!(skill.name, "logical-skill");
        assert_eq!(
            skill.path,
            platform_path::canonicalize(&dir.path().join("skills/example")).unwrap()
        );
        assert_eq!(
            skill.size,
            (skill_entrypoint.len() + 5 + "print('noise')".len()) as u64
        );
        assert!(skill.modified_at.is_some());
    }

    #[test]
    fn exact_agent_home_candidates_are_excluded_without_hiding_projects_below_them() {
        let dir = tempdir().unwrap();
        let home = dir.path().join(".codex");
        let project = home.join("projects/app");
        fs::create_dir_all(&project).unwrap();
        let mut candidates = vec![
            candidate(
                home.clone(),
                Some(AgentKind::Codex),
                DiscoveryEvidence::SessionCwd,
                None,
                1,
                true,
            ),
            candidate(
                project.clone(),
                Some(AgentKind::Codex),
                DiscoveryEvidence::SessionCwd,
                None,
                1,
                true,
            ),
        ];
        let installations = vec![AgentInstallation {
            agent: AgentKind::Codex,
            installed: true,
            configured: true,
            version: None,
            home: Some(home.clone()),
            warnings: Vec::new(),
            support: Some(agentkib_core::AgentSupportCapabilities::for_agent(
                AgentKind::Codex,
            )),
        }];

        exclude_agent_home_candidates(&mut candidates, &installations);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, project);
    }
}
