use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

use agentkib_core::{AgentKind, SkillScope, SkillTargetCapability, SkillWorkspace};
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

pub(crate) const SUPPORTED: [AgentKind; 8] = [
    AgentKind::Codex,
    AgentKind::ClaudeCode,
    AgentKind::Cursor,
    AgentKind::OpenCode,
    AgentKind::OpenClaw,
    AgentKind::Hermes,
    AgentKind::GrokBuild,
    AgentKind::Antigravity,
];

const OPENCLAW_SKILL_SCAN_DEPTH: usize = 6;

pub(crate) fn openclaw_root_reads_package(root: &Path, package: &Path) -> bool {
    platform_path::equivalent(root, package)
        || package
            .parent()
            .is_some_and(|parent| openclaw_extra_root_reads_children(root, parent))
}

fn openclaw_extra_root_reads_children(root: &Path, destination: &Path) -> bool {
    let Ok(resolved_root) = platform_path::canonicalize_allow_missing(root) else {
        return false;
    };
    let Ok(resolved_destination) = platform_path::canonicalize_allow_missing(destination) else {
        return false;
    };
    // Count native traversal through the configured entry when it contains a
    // linked child; use physical paths only to match a separately named alias.
    let (root, destination) = if platform_path::lexical_starts_with(destination, root) {
        (root.to_path_buf(), destination.to_path_buf())
    } else {
        (resolved_root, resolved_destination)
    };
    if !platform_path::lexical_starts_with(&destination, &root) {
        return false;
    }
    // Deployment creates a package immediately below destination. Leave one
    // level for it, and stop where native grouped discovery finds SKILL.md.
    let mut current = destination.as_path();
    for _ in 0..OPENCLAW_SKILL_SCAN_DEPTH {
        match fs::symlink_metadata(current.join("SKILL.md")) {
            Ok(_) => return false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
        if platform_path::equivalent(current, &root) {
            return true;
        }
        let Some(name) = current.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        if name.starts_with('.')
            || matches!(name, "node_modules" | "target" | "dist" | "__pycache__")
        {
            return false;
        }
        let Some(parent) = current.parent() else {
            return false;
        };
        current = parent;
    }
    false
}

/// Resolves native locations once for discovery and deployment. Tests inject
/// this value instead of changing process environment or inspecting real homes.
pub(crate) struct TargetEnvironment {
    pub home: PathBuf,
    pub values: BTreeMap<String, String>,
}

pub(crate) struct OpenClawSkillFilter {
    pub agent_id: String,
    pub names: Option<Vec<String>>,
}

impl TargetEnvironment {
    pub(crate) fn current() -> Result<Self> {
        Ok(Self {
            home: dirs::home_dir().context("User home directory is unavailable")?,
            values: env::vars().collect(),
        })
    }

    pub(crate) fn path(&self, key: &str, fallback: PathBuf) -> PathBuf {
        self.values
            .get(key)
            .map(|value| self.expand(value).unwrap_or_else(|| PathBuf::from(value)))
            .unwrap_or(fallback)
    }

    pub(crate) fn expand(&self, value: &str) -> Option<PathBuf> {
        let value = value.trim();
        let path = if value == "~" {
            self.home.clone()
        } else if let Some(value) = value.strip_prefix("~/") {
            self.home.join(value)
        } else {
            PathBuf::from(value)
        };
        path.is_absolute().then_some(path)
    }

    pub(crate) fn home_for(&self, agent: AgentKind) -> PathBuf {
        match agent {
            AgentKind::Codex => self.path("CODEX_HOME", self.home.join(".codex")),
            AgentKind::ClaudeCode => self.path("CLAUDE_CONFIG_DIR", self.home.join(".claude")),
            AgentKind::Cursor => self.home.join(".cursor"),
            AgentKind::OpenCode => self
                .path("XDG_CONFIG_HOME", self.home.join(".config"))
                .join("opencode"),
            AgentKind::OpenClaw => {
                let home = self.path("OPENCLAW_HOME", self.home.clone());
                let profile = self
                    .values
                    .get("OPENCLAW_PROFILE")
                    .map(|value| value.trim())
                    .filter(|value| {
                        !value.is_empty()
                            && !value.eq_ignore_ascii_case("default")
                            && value
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
                    });
                let default = home.join(profile.map_or_else(
                    || ".openclaw".into(),
                    |profile| format!(".openclaw-{profile}"),
                ));
                self.path("OPENCLAW_STATE_DIR", default)
            }
            AgentKind::Hermes => self.path("HERMES_HOME", self.home.join(".hermes")),
            AgentKind::GrokBuild => self.path("GROK_HOME", self.home.join(".grok")),
            AgentKind::Antigravity => self.home.join(".gemini/antigravity-cli"),
            AgentKind::DeepSeekHarness => self.path("DSH_HOME", self.home.join(".dsh")),
        }
    }

    pub(crate) fn opencode_flag(&self, key: &str) -> bool {
        self.values
            .get(key)
            .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
    }

    pub(crate) fn opencode_source_restriction(
        &self,
        path: &Path,
        project: Option<&Path>,
    ) -> Option<String> {
        let mut projects = Vec::new();
        if let Some(project) = project {
            for root in project.ancestors() {
                projects.push(root);
                if root.join(".git").exists() {
                    break;
                }
            }
        }
        // Readable explicit sources take precedence over disabled compatibility
        // entries and project directories, including their physical aliases.
        let sources = super::native_state::opencode_skill_sources(self, project);
        if sources
            .roots
            .iter()
            .any(|root| opencode_glob_root_contains(root, path))
        {
            return None;
        }
        let disabled_project_source = self.opencode_flag("OPENCODE_DISABLE_PROJECT_CONFIG")
            && projects.iter().any(|root| {
                ["skill", "skills"]
                    .iter()
                    .any(|name| opencode_root_contains(&root.join(".opencode").join(name), path))
            });
        let mut compatibility = vec![self.home.as_path()];
        compatibility.extend(projects);
        let mut restriction = None;
        for root in compatibility {
            for relative in [".claude/skills", ".agents/skills"] {
                if !opencode_root_contains(&root.join(relative), path) {
                    continue;
                }
                let flag = if self.opencode_flag("OPENCODE_DISABLE_EXTERNAL_SKILLS") {
                    Some("OPENCODE_DISABLE_EXTERNAL_SKILLS")
                } else if relative == ".claude/skills" {
                    [
                        "OPENCODE_DISABLE_CLAUDE_CODE",
                        "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
                    ]
                    .into_iter()
                    .find(|key| self.opencode_flag(key))
                } else {
                    None
                };
                let flag = flag?;
                restriction = Some(format!(
                    "OpenCode: {flag} disables this compatible Skill location"
                ));
            }
        }
        if restriction.is_some() {
            return restriction;
        }
        if disabled_project_source {
            return Some(
                "OpenCode: OPENCODE_DISABLE_PROJECT_CONFIG disables this project Skill location"
                    .into(),
            );
        }
        if opencode_root_contains(&self.home_for(AgentKind::ClaudeCode).join("skills"), path) {
            return Some(format!(
                "OpenCode: CLAUDE_CONFIG_DIR does not change its Claude-compatible Skill directory {}",
                self.home.join(".claude/skills").display()
            ));
        }
        None
    }

    pub(crate) fn hermes_homes(&self) -> Vec<PathBuf> {
        let mut homes = vec![self.home_for(AgentKind::Hermes)];
        let profiles = self.home_for(AgentKind::Hermes).join("profiles");
        if let Ok(entries) = fs::read_dir(&profiles) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir()
                    && [
                        "config.yaml",
                        ".env",
                        "SOUL.md",
                        "profile.yaml",
                        "auth.json",
                        "state.db",
                    ]
                    .iter()
                    .any(|file| path.join(file).is_file())
                {
                    homes.push(path);
                }
            }
        }
        homes.sort_by_key(|path| platform_path::identity(path));
        homes.dedup_by(|left, right| platform_path::equivalent(left, right));
        homes
    }

    pub(crate) fn configured_path(
        &self,
        value: &str,
        relative_to: Option<&Path>,
    ) -> Option<PathBuf> {
        let mut expanded = value.to_string();
        for _ in 0..32 {
            let Some(start) = expanded.find("${") else {
                break;
            };
            let end = start + expanded[start..].find('}')?;
            let replacement = self.values.get(&expanded[start + 2..end])?;
            expanded.replace_range(start..=end, replacement);
        }
        if expanded.contains("${") {
            return None;
        }
        self.expand(&expanded)
            .or_else(|| relative_to.map(|root| root.join(expanded)))
    }

    pub(crate) fn hermes_external_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        for home in self.hermes_homes() {
            if let Ok(config) = read_yaml(&home.join("config.yaml")) {
                if let Some(external) = config
                    .pointer("/skills/external_dirs")
                    .and_then(|value| value.as_array())
                {
                    dirs.extend(
                        external
                            .iter()
                            .filter_map(|value| value.as_str())
                            .filter_map(|value| self.configured_path(value, None)),
                    );
                }
                if let Some(create) = config
                    .pointer("/skills/create_dir")
                    .and_then(|value| value.as_str())
                    .and_then(|value| self.configured_path(value, Some(&home)))
                {
                    dirs.push(create);
                }
            }
        }
        dirs
    }

    pub(crate) fn hermes_project_conditions(&self, workspace: &Path) -> Vec<String> {
        let Some(git_root) = workspace
            .ancestors()
            .find(|root| root.join(".git").exists())
        else {
            return vec![
                "Hermes: project skills are not loaded because this project has no Git root".into(),
            ];
        };
        let mut conditions = Vec::new();
        if !platform_path::equivalent(git_root, workspace) {
            conditions.push(format!("Hermes: native project discovery reads the nearest Git root {}, not this nested project directory", git_root.display()));
        }
        for home in self.hermes_homes() {
            let label = format!("Hermes profile {}", home.display());
            match read_yaml(&home.join("config.yaml")) {
                Ok(config)
                    if config
                        .pointer("/skills/project_discovery")
                        .and_then(|value| value.as_bool())
                        == Some(false) =>
                {
                    conditions.push(format!(
                        "{label}: project discovery is disabled in config.yaml"
                    ))
                }
                Ok(config) => {
                    let trusted = config
                        .pointer("/skills/trusted_project_dirs")
                        .and_then(|value| value.as_array())
                        .is_some_and(|roots| {
                            roots
                                .iter()
                                .filter_map(|value| value.as_str())
                                .filter_map(|value| self.configured_path(value, None))
                                .any(|root| platform_path::equivalent(&root, git_root))
                        });
                    conditions.push(if trusted { format!("{label}: Git root is trusted; native content quarantine and session refresh still apply") } else { format!("{label}: Git root is not trusted; run hermes skills trust yourself before native loading") });
                }
                Err(_) => conditions.push(format!(
                    "{label}: project trust is unknown because config.yaml could not be read"
                )),
            }
        }
        conditions
    }

    pub(crate) fn hermes_project_root_matches(&self, workspace: &Path) -> bool {
        workspace
            .ancestors()
            .find(|root| root.join(".git").exists())
            .is_some_and(|root| platform_path::equivalent(root, workspace))
    }

    pub(crate) fn openclaw_workspaces(&self) -> (Vec<PathBuf>, Option<String>) {
        let home = self.home_for(AgentKind::OpenClaw);
        let config = self.path("OPENCLAW_CONFIG_PATH", home.join("openclaw.json"));
        let config = match read_json5(&config) {
            Ok(config) => config,
            Err(_) => {
                return (
                    Vec::new(),
                    Some("OpenClaw workspace configuration could not be read".into()),
                );
            }
        };
        self.openclaw_workspaces_from_config(&config)
    }

    pub(crate) fn openclaw_extra_dirs(&self) -> Result<Vec<PathBuf>> {
        let state = self.home_for(AgentKind::OpenClaw);
        let config = read_json5(&self.path("OPENCLAW_CONFIG_PATH", state.join("openclaw.json")))?;
        let Some(directories) = config.pointer("/skills/load/extraDirs") else {
            return Ok(Vec::new());
        };
        let values = self.openclaw_workspace_environment(&state, &config)?;
        directories
            .as_array()
            .context("OpenClaw skills.load.extraDirs must be an array")?
            .iter()
            .map(|directory| {
                directory
                    .as_str()
                    .and_then(|value| self.openclaw_configured_workspace(value, &values))
                    .context("OpenClaw skills.load.extraDirs contains an unresolved directory")
            })
            .collect()
    }

    pub(crate) fn personal_shared_agents(&self) -> Vec<AgentKind> {
        let shared = self.home.join(".agents/skills");
        // OpenClaw isolates home-scoped sources for non-default states. An
        // explicit extra root remains readable even when it aliases that source.
        let openclaw_reads_shared = self
            .openclaw_personal_roots(&self.openclaw_extra_dirs().unwrap_or_default())
            .iter()
            .any(|path| openclaw_extra_root_reads_children(path, &shared));
        let hermes_reads_shared = self
            .hermes_external_dirs()
            .iter()
            .any(|path| platform_path::equivalent(path, &shared));
        shared_agents()
            .into_iter()
            .filter(|agent| match agent {
                AgentKind::OpenClaw => openclaw_reads_shared,
                AgentKind::Hermes => hermes_reads_shared,
                _ => true,
            })
            .collect()
    }

    pub(crate) fn openclaw_personal_roots(&self, extra_dirs: &[PathBuf]) -> Vec<PathBuf> {
        let state = self.home_for(AgentKind::OpenClaw);
        let openclaw_home = self.path("OPENCLAW_HOME", self.home.clone());
        let mut roots = vec![state.join("skills")];
        if platform_path::equivalent(&state, &openclaw_home.join(".openclaw")) {
            roots.push(openclaw_home.join(".agents/skills"));
        }
        roots.extend_from_slice(extra_dirs);
        roots
    }

    fn openclaw_workspaces_from_config(
        &self,
        config: &serde_json::Value,
    ) -> (Vec<PathBuf>, Option<String>) {
        let home = self.home_for(AgentKind::OpenClaw);
        let values =
            match self.openclaw_workspace_environment(&home, config) {
                Ok(values) => values,
                Err(_) => return (
                    Vec::new(),
                    Some(
                        "OpenClaw workspace environment could not be read from its state directory"
                            .into(),
                    ),
                ),
            };
        let configured = if let Some(value) = config.pointer("/agents/defaults/workspace") {
            match value
                .as_str()
                .and_then(|value| self.openclaw_configured_workspace(value, &values))
            {
                Some(path) => path,
                None => {
                    return (
                        Vec::new(),
                        Some("OpenClaw agents.defaults.workspace could not be resolved to an absolute path; check its configured environment variables".into()),
                    );
                }
            }
        } else if let Some(value) = values
            .get("OPENCLAW_WORKSPACE_DIR")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            // Native OpenClaw uses this only as the default, and requires a
            // resolved path here rather than expanding config expressions.
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return (
                    Vec::new(),
                    Some("OPENCLAW_WORKSPACE_DIR is not an absolute directory path".into()),
                );
            }
            path
        } else {
            home.join("workspace")
        };
        if let Some(entries) = config.pointer("/agents/entries") {
            // The native roster reader and Doctor give entries precedence over
            // list, including an explicitly empty or malformed entries value.
            let Some(entries) = entries.as_object() else {
                return (
                    Vec::new(),
                    Some("OpenClaw agents.entries must be an object".into()),
                );
            };
            let mut ids = BTreeSet::new();
            let mut legacy_default = None;
            for (id, entry) in entries {
                let normalized = id.trim().to_ascii_lowercase();
                if normalized.len() > 64
                    || !normalized
                        .bytes()
                        .next()
                        .is_some_and(|byte| byte.is_ascii_alphanumeric())
                    || !normalized
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                    || !ids.insert(normalized)
                    || !entry.is_object()
                {
                    return (
                        Vec::new(),
                        Some(format!(
                            "OpenClaw agents.entries.{id} has an invalid or duplicate Agent ID or is not an object"
                        )),
                    );
                }
                if let Some(default) = entry.get("default") {
                    let Some(default) = default.as_bool() else {
                        return (
                            Vec::new(),
                            Some(format!(
                                "OpenClaw agents.entries.{id}.default must be a boolean"
                            )),
                        );
                    };
                    if default
                        && (legacy_default.replace(id).is_some()
                            || config
                                .pointer("/agents/ownership")
                                .and_then(|value| value.as_str())
                                == Some("explicit"))
                    {
                        return (Vec::new(), Some("OpenClaw agents.entries contains conflicting legacy default markers".into()));
                    }
                }
            }
            let mut roots = Vec::new();
            for (id, entry) in entries {
                let path = if let Some(value) = entry.get("workspace") {
                    let Some(path) = value
                        .as_str()
                        .and_then(|value| self.openclaw_configured_workspace(value, &values))
                    else {
                        return (
                            Vec::new(),
                            Some(format!(
                                "OpenClaw agents.entries.{id}.workspace could not be resolved to an absolute path; check its configured environment variables"
                            )),
                        );
                    };
                    path
                } else if entries.len() == 1 || legacy_default == Some(id) {
                    configured.clone()
                } else if config.pointer("/agents/defaults/workspace").is_some() {
                    // Native multi-agent defaults are a parent directory; only
                    // a sole/legacy-default Agent inherits that directory itself.
                    configured.join(id.trim().to_ascii_lowercase())
                } else {
                    home.join(format!("workspace-{}", id.trim().to_ascii_lowercase()))
                };
                roots.push(path);
            }
            return (roots, None);
        }
        let mut roots = vec![configured];
        if let Some(agents) = config.pointer("/agents/list") {
            let Some(agents) = agents.as_array() else {
                return (
                    Vec::new(),
                    Some("OpenClaw agents.list must be an array".into()),
                );
            };
            for (index, agent) in agents.iter().enumerate() {
                if !agent.is_object() {
                    return (
                        Vec::new(),
                        Some(format!("OpenClaw agents.list[{index}] must be an object")),
                    );
                }
                let Some(value) = agent.get("workspace") else {
                    continue;
                };
                let Some(path) = value
                    .as_str()
                    .and_then(|value| self.openclaw_configured_workspace(value, &values))
                else {
                    return (
                        Vec::new(),
                        Some(format!(
                            "OpenClaw agents.list[{index}].workspace could not be resolved to an absolute path; check its configured environment variables"
                        )),
                    );
                };
                roots.push(path);
            }
        }
        (roots, None)
    }

    pub(crate) fn openclaw_skill_filters(
        &self,
        config: &serde_json::Value,
        workspace: Option<&Path>,
    ) -> Result<Vec<OpenClawSkillFilter>> {
        let (roots, error) = self.openclaw_workspaces_from_config(config);
        anyhow::ensure!(error.is_none(), "{}", error.unwrap_or_default());
        let defaults = config.pointer("/agents/defaults/skills");
        let filter = |entry: Option<&serde_json::Value>| -> Result<Option<Vec<String>>> {
            let Some(value) = entry.and_then(|entry| entry.get("skills")).or(defaults) else {
                return Ok(None);
            };
            let values = value
                .as_array()
                .context("OpenClaw skills allowlist must be an array")?;
            values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(|value| value.trim().to_string())
                        .context("OpenClaw skills allowlist must contain names")
                })
                .collect::<Result<Vec<_>>>()
                .map(Some)
        };
        let matches = |root: &Path| {
            workspace.is_none_or(|workspace| platform_path::equivalent(root, workspace))
        };
        let mut output = Vec::new();
        if let Some(entries) = config
            .pointer("/agents/entries")
            .and_then(|value| value.as_object())
        {
            // Use the same ordered roster and resolver as deployment capabilities.
            for ((id, entry), root) in entries.iter().zip(&roots) {
                if matches(root) {
                    output.push(OpenClawSkillFilter {
                        agent_id: id.clone(),
                        names: filter(Some(entry))?,
                    });
                }
            }
        } else if let Some(entries) = config
            .pointer("/agents/list")
            .and_then(|value| value.as_array())
            .filter(|entries| !entries.is_empty())
        {
            let mut explicit_roots = roots.iter().skip(1);
            for (index, entry) in entries.iter().enumerate() {
                let root = if entry.get("workspace").is_some() {
                    explicit_roots.next()
                } else {
                    roots.first()
                }
                .context("OpenClaw Agent workspace could not be resolved")?;
                if matches(root) {
                    let id = entry
                        .get("id")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("legacy-{index}"));
                    output.push(OpenClawSkillFilter {
                        agent_id: id,
                        names: filter(Some(entry))?,
                    });
                }
            }
        } else if let Some(root) = roots.first()
            && matches(root)
        {
            output.push(OpenClawSkillFilter {
                agent_id: "default".into(),
                names: filter(None)?,
            });
        }
        Ok(output)
    }

    fn openclaw_workspace_environment(
        &self,
        state: &Path,
        config: &serde_json::Value,
    ) -> Result<BTreeMap<String, String>> {
        // Build a local, non-mutating view. Do not execute login shells or use
        // AgentKib's cwd as the cwd of an unrelated OpenClaw session.
        let mut values = self
            .values
            .iter()
            .map(|(key, value)| (environment_key(key), value.clone()))
            .collect::<BTreeMap<_, _>>();
        for (key, value) in read_dotenv(&state.join(".env"))? {
            values.entry(environment_key(&key)).or_insert(value);
        }
        if let Some(configured) = config
            .pointer("/env/vars")
            .and_then(|value| value.as_object())
        {
            for (key, value) in configured {
                if let Some(value) = value.as_str().filter(|value| !value.trim().is_empty()) {
                    let existing = values.entry(environment_key(key)).or_default();
                    if existing.trim().is_empty() {
                        *existing = value.to_string();
                    }
                }
            }
        }
        Ok(values)
    }

    fn openclaw_configured_workspace(
        &self,
        value: &str,
        values: &BTreeMap<String, String>,
    ) -> Option<PathBuf> {
        // Match OpenClaw's single config-substitution pass: escaped tokens
        // and expressions inside environment values remain literal paths.
        let mut expanded = String::with_capacity(value.len());
        let mut remaining = value;
        while let Some(start) = remaining.find('$') {
            expanded.push_str(&remaining[..start]);
            remaining = &remaining[start..];
            let token = remaining
                .strip_prefix("$${")
                .map(|body| (true, body))
                .or_else(|| remaining.strip_prefix("${").map(|body| (false, body)));
            if let Some((escaped, body)) = token
                && let Some((name, suffix)) = body.split_once('}')
                && name
                    .bytes()
                    .next()
                    .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            {
                if escaped {
                    expanded.push_str("${");
                    expanded.push_str(name);
                    expanded.push('}');
                } else {
                    let replacement = values.get(name).filter(|value| !value.is_empty())?;
                    expanded.push_str(replacement);
                }
                remaining = suffix;
            } else {
                expanded.push('$');
                remaining = &remaining[1..];
            }
        }
        expanded.push_str(remaining);
        self.expand(&expanded)
    }
}

fn opencode_glob_root_contains(root: &Path, path: &Path) -> bool {
    let contains = |root: &Path, path: &Path| {
        platform_path::lexical_starts_with(path, root)
            && path
                .components()
                .skip(root.components().count())
                .all(|component| !component.as_os_str().to_string_lossy().starts_with('.'))
    };
    // Native/configured globs exclude hidden descendants. Do not resolve an
    // excluded entry through a link and accidentally restore its visibility.
    if platform_path::lexical_starts_with(path, root) {
        return contains(root, path);
    }
    match (
        platform_path::canonicalize_allow_missing(root),
        platform_path::canonicalize_allow_missing(path),
    ) {
        (Ok(root), Ok(path)) => contains(&root, &path),
        _ => false,
    }
}

fn opencode_root_contains(root: &Path, path: &Path) -> bool {
    // The entry spelling matters for linked packages; physical identity also
    // recognizes Home/config aliases, including not-yet-created destinations.
    platform_path::lexical_starts_with(path, root)
        || match (
            platform_path::canonicalize_allow_missing(root),
            platform_path::canonicalize_allow_missing(path),
        ) {
            (Ok(root), Ok(path)) => platform_path::lexical_starts_with(&path, &root),
            _ => false,
        }
}

pub(crate) fn read_json5(path: &Path) -> Result<serde_json::Value> {
    anyhow::ensure!(path.is_absolute(), "Configuration path must be absolute");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let mut text = String::new();
    fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_string(&mut text)?;
    anyhow::ensure!(text.len() <= 1024 * 1024, "Configuration exceeds 1 MiB");
    Ok(json5::from_str(&text)?)
}

fn read_dotenv(path: &Path) -> Result<BTreeMap<String, String>> {
    anyhow::ensure!(path.is_absolute(), "Environment file path must be absolute");
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    let mut text = String::new();
    file.take(1024 * 1024 + 1).read_to_string(&mut text)?;
    anyhow::ensure!(text.len() <= 1024 * 1024, "Environment file exceeds 1 MiB");
    parse_dotenv(&text)
}

fn environment_key(key: &str) -> String {
    if cfg!(windows) {
        key.to_ascii_uppercase()
    } else {
        key.to_string()
    }
}

fn parse_dotenv(text: &str) -> Result<BTreeMap<String, String>> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut remaining = text.as_str();
    let mut values = BTreeMap::new();
    while !remaining.is_empty() {
        let (raw_line, following) = remaining.split_once('\n').unwrap_or((remaining, ""));
        let mut line = raw_line.trim_start();
        if let Some(rest) = line.strip_prefix("export")
            && rest.starts_with(char::is_whitespace)
        {
            line = rest.trim_start();
        }
        let key_end = line
            .find(|character: char| {
                !character.is_ascii_alphanumeric() && !matches!(character, '_' | '.' | '-')
            })
            .unwrap_or(line.len());
        let key = &line[..key_end];
        let assignment = line[key_end..].trim_start();
        let value = assignment.strip_prefix('=').or_else(|| {
            assignment
                .strip_prefix(':')
                .filter(|value| value.starts_with(char::is_whitespace))
        });
        let Some(value) = value.filter(|_| !key.is_empty()) else {
            remaining = following;
            continue;
        };
        let value = value.trim_start();
        let value_start = text.len() - remaining.len() + raw_line.len() - value.len();
        let mut parsed = value
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        remaining = following;
        if let Some(quote @ ('\'' | '"' | '`')) = value.chars().next() {
            // Quotes may span lines. Dotenv values are data: retain shell syntax
            // and ${VAR} literally, including inside quoted values.
            let quoted = &text[value_start + 1..];
            let mut escaped = false;
            let mut end = None;
            for (index, character) in quoted.char_indices() {
                if character == quote && !escaped {
                    end = Some(index);
                    break;
                }
                escaped = character == '\\' && !escaped;
            }
            let end = end.context("Environment file contains an unterminated quoted value")?;
            parsed = quoted[..end].to_string();
            if quote == '"' {
                parsed = parsed.replace("\\n", "\n").replace("\\r", "\r");
            }
            remaining = quoted[end + 1..]
                .split_once('\n')
                .map_or("", |(_, rest)| rest);
        }
        values.insert(key.to_string(), parsed);
    }
    Ok(values)
}

pub(crate) fn shared_agents() -> Vec<AgentKind> {
    vec![
        AgentKind::Codex,
        AgentKind::Cursor,
        AgentKind::OpenCode,
        AgentKind::OpenClaw,
        AgentKind::Hermes,
        AgentKind::GrokBuild,
        AgentKind::Antigravity,
        AgentKind::DeepSeekHarness,
    ]
}

pub(crate) fn visible_agents(agent: AgentKind, shared: bool) -> Vec<AgentKind> {
    if shared {
        return shared_agents();
    }
    match agent {
        AgentKind::ClaudeCode => vec![
            AgentKind::ClaudeCode,
            AgentKind::Cursor,
            AgentKind::OpenCode,
            AgentKind::GrokBuild,
        ],
        AgentKind::Cursor => vec![AgentKind::Cursor, AgentKind::GrokBuild],
        _ => vec![agent],
    }
}

pub(crate) fn stable_id(prefix: &str, value: &str) -> String {
    format!(
        "{prefix}-{}",
        &format!("{:x}", Sha256::digest(value.as_bytes()))[..24]
    )
}

pub fn skill_targets(workspaces: &[SkillWorkspace]) -> Result<Vec<SkillTargetCapability>> {
    targets_with_environment(workspaces, &TargetEnvironment::current()?)
}

pub(crate) fn targets_with_environment(
    workspaces: &[SkillWorkspace],
    environment: &TargetEnvironment,
) -> Result<Vec<SkillTargetCapability>> {
    let mut targets = Vec::new();
    for agent in SUPPORTED {
        let homes = if agent == AgentKind::Hermes {
            environment.hermes_homes()
        } else {
            vec![environment.home_for(agent)]
        };
        for home in homes {
            let root = if agent == AgentKind::Codex {
                environment.home.join(".agents/skills")
            } else {
                home.join("skills")
            };
            let scope_root = if agent == AgentKind::Codex {
                environment.home.join(".agents")
            } else {
                home.clone()
            };
            let mut target = capability(agent, SkillScope::Personal, None, root, scope_root);
            if agent == AgentKind::Hermes {
                target.profile = Some(
                    if platform_path::equivalent(&home, &environment.home_for(AgentKind::Hermes)) {
                        "default".into()
                    } else {
                        home.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    },
                );
                target.conditions.push("Select the same Hermes profile when starting a session; deployment does not restart running agents".into());
            }
            if agent == AgentKind::Antigravity {
                target.conditions.push("This target is Antigravity CLI (agy); Antigravity IDE uses a separate personal directory".into());
            }
            target.visible_to = if agent == AgentKind::Codex {
                environment.personal_shared_agents()
            } else {
                visible_agents(agent, false)
            };
            restrict_opencode_source(&mut target, environment, None);
            restrict_invalid_environment(&mut target, environment);
            targets.push(target);
        }
    }
    let personal_roots = targets
        .iter()
        .filter(|target| target.root.is_absolute())
        .map(|target| {
            platform_path::canonicalize_allow_missing(&target.root)
                .unwrap_or_else(|_| target.root.clone())
        })
        .collect::<Vec<_>>();
    let (openclaw_workspaces, openclaw_error) = environment.openclaw_workspaces();
    let mut workspace_ids = BTreeSet::new();
    for workspace in workspaces {
        if !workspace_ids.insert(&workspace.id) {
            continue;
        }
        for agent in SUPPORTED {
            let relative = match agent {
                AgentKind::Codex | AgentKind::Antigravity => ".agents/skills",
                AgentKind::ClaudeCode => ".claude/skills",
                AgentKind::Cursor => ".cursor/skills",
                AgentKind::OpenCode => ".opencode/skills",
                AgentKind::OpenClaw => "skills",
                AgentKind::Hermes => ".hermes/skills",
                AgentKind::GrokBuild => ".grok/skills",
                AgentKind::DeepSeekHarness => unreachable!(),
            };
            let mut target = capability(
                agent,
                SkillScope::Workspace,
                Some(workspace.id.clone()),
                workspace.path.join(relative),
                workspace.path.clone(),
            );
            target.visible_to = visible_agents(agent, relative == ".agents/skills");
            restrict_opencode_source(&mut target, environment, Some(&workspace.path));
            if !workspace.path.is_absolute() || !workspace.path.is_dir() {
                target.writable = false;
                target.reason = Some("Workspace is missing or is not an absolute directory".into());
            }
            if agent == AgentKind::OpenClaw
                && !openclaw_workspaces
                    .iter()
                    .any(|path| platform_path::equivalent(path, &workspace.path))
            {
                target.writable = false;
                target.reason = Some(openclaw_error.clone().unwrap_or_else(|| "This project is not an OpenClaw configured workspace; deployment cannot make it an active workspace".into()));
            }
            if agent == AgentKind::Hermes {
                target
                    .conditions
                    .extend(environment.hermes_project_conditions(&workspace.path));
            }
            restrict_invalid_environment(&mut target, environment);
            let physical_root = platform_path::canonicalize_allow_missing(&target.root)
                .unwrap_or_else(|_| target.root.clone());
            if personal_roots.iter().any(|personal| {
                platform_path::starts_with(&physical_root, personal)
                    || platform_path::starts_with(personal, &physical_root)
            }) {
                // A registered Home (including an alias) must not turn the
                // personal approval and receipt boundary into a project write.
                target.writable = false;
                target.reason = Some("This project location overlaps a personal Skill directory; manage it through the personal target instead".into());
            }
            targets.push(target);
        }
    }
    targets.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(targets)
}

fn restrict_opencode_source(
    target: &mut SkillTargetCapability,
    environment: &TargetEnvironment,
    project: Option<&Path>,
) {
    if !target.visible_to.contains(&AgentKind::OpenCode) {
        return;
    }
    if let Some(reason) = environment.opencode_source_restriction(&target.root, project) {
        target
            .visible_to
            .retain(|agent| *agent != AgentKind::OpenCode);
        target.conditions.push(reason);
    } else {
        target
            .conditions
            .extend(super::native_state::opencode_skill_sources(environment, project).diagnostics);
    }
}

fn restrict_invalid_environment(
    target: &mut SkillTargetCapability,
    environment: &TargetEnvironment,
) {
    let keys: &[&str] = match target.agent {
        AgentKind::Codex => &["CODEX_HOME"],
        AgentKind::ClaudeCode => &["CLAUDE_CONFIG_DIR"],
        AgentKind::OpenCode => &["XDG_CONFIG_HOME"],
        AgentKind::OpenClaw => &[
            "OPENCLAW_HOME",
            "OPENCLAW_STATE_DIR",
            "OPENCLAW_CONFIG_PATH",
        ],
        AgentKind::Hermes => &["HERMES_HOME"],
        AgentKind::GrokBuild => &["GROK_HOME"],
        _ => &[],
    };
    if let Some(key) = keys.iter().find(|key| {
        environment
            .values
            .get(**key)
            .is_some_and(|value| environment.expand(value).is_none())
    }) {
        target.writable = false;
        target.reason = Some(format!(
            "{key} is set but is not an absolute directory path; correct it before deployment"
        ));
    }
    if target.agent == AgentKind::OpenClaw
        && environment
            .values
            .get("OPENCLAW_PROFILE")
            .is_some_and(|value| {
                let value = value.trim();
                value.is_empty()
                    || !value
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            })
    {
        target.writable = false;
        target.reason = Some("OPENCLAW_PROFILE is invalid; correct it before deployment".into());
    }
}

pub(crate) fn read_yaml(path: &Path) -> Result<serde_json::Value> {
    anyhow::ensure!(path.is_absolute(), "Configuration path must be absolute");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let mut text = String::new();
    fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_string(&mut text)?;
    anyhow::ensure!(text.len() <= 1024 * 1024, "Configuration exceeds 1 MiB");
    Ok(serde_yaml::from_str(&text)?)
}

fn capability(
    agent: AgentKind,
    scope: SkillScope,
    workspace_id: Option<String>,
    root: PathBuf,
    scope_root: PathBuf,
) -> SkillTargetCapability {
    let identity_root =
        platform_path::canonicalize_allow_missing(&root).unwrap_or_else(|_| root.clone());
    let id = stable_id(
        "target",
        &format!(
            "{}:{scope:?}:{}:{}",
            agent.as_str(),
            workspace_id.as_deref().unwrap_or("personal"),
            platform_path::identity(&identity_root)
        ),
    );
    SkillTargetCapability { id, agent, scope, workspace_id, profile: None, root, scope_root, visible_to: vec![agent], writable: true, reason: None, conditions: vec!["Files are deployed by copy. Native discovery, existing deny settings and active-session refresh are not changed or guaranteed".into()] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn explicit_opencode_skill_paths_restore_disabled_sources_through_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(project.join(".opencode/skills")).unwrap();
        fs::create_dir_all(home.join(".claude/skills")).unwrap();
        let alias = temp.path().join("native-alias");
        std::os::unix::fs::symlink(project.join(".opencode/skills"), &alias).unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([
                ("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into()),
                ("OPENCODE_DISABLE_EXTERNAL_SKILLS".into(), "1".into()),
                (
                    "OPENCODE_CONFIG_CONTENT".into(),
                    serde_json::json!({"skills":{"paths":[alias, home.join(".claude/skills")]}})
                        .to_string(),
                ),
            ]),
        };
        assert!(
            environment
                .opencode_source_restriction(&project.join(".opencode/skills"), Some(&project))
                .is_none()
        );
        assert!(
            environment
                .opencode_source_restriction(&home.join(".claude/skills/example"), None)
                .is_none()
        );
        assert!(
            environment
                .opencode_source_restriction(&project.join(".opencode/skill"), Some(&project))
                .unwrap()
                .contains("OPENCODE_DISABLE_PROJECT_CONFIG")
        );
        let environment = TargetEnvironment {
            values: BTreeMap::from([
                ("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into()),
                (
                    "OPENCODE_CONFIG_CONTENT".into(),
                    serde_json::json!({"skills":{"paths":[project]}}).to_string(),
                ),
            ]),
            ..environment
        };
        assert!(
            environment
                .opencode_source_restriction(&project.join(".opencode/skills"), Some(&project))
                .unwrap()
                .contains("OPENCODE_DISABLE_PROJECT_CONFIG")
        );
    }

    #[test]
    fn opencode_compatibility_flags_filter_targets_without_disabling_native_directories() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        let workspace = SkillWorkspace {
            id: "repo".into(),
            name: "Repo".into(),
            path: project,
        };
        for key in [
            "OPENCODE_DISABLE_CLAUDE_CODE",
            "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
            "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        ] {
            for value in ["1", "true", "TRUE", "0", "false", ""] {
                let disabled = matches!(value, "1" | "true" | "TRUE");
                let environment = TargetEnvironment {
                    home: home.clone(),
                    values: BTreeMap::from([(key.into(), value.into())]),
                };
                for target in
                    targets_with_environment(std::slice::from_ref(&workspace), &environment)
                        .unwrap()
                {
                    if target.agent == AgentKind::ClaudeCode {
                        assert_eq!(
                            target.visible_to.contains(&AgentKind::OpenCode),
                            !disabled,
                            "{key}={value}: {target:?}"
                        );
                        assert!(target.visible_to.contains(&AgentKind::ClaudeCode));
                        assert!(target.visible_to.contains(&AgentKind::Cursor));
                        assert_eq!(
                            target.conditions.iter().any(|reason| reason.contains(key)),
                            disabled
                        );
                    }
                    if target.agent == AgentKind::Codex {
                        assert_eq!(
                            target.visible_to.contains(&AgentKind::OpenCode),
                            !(disabled && key == "OPENCODE_DISABLE_EXTERNAL_SKILLS")
                        );
                    }
                    if target.agent == AgentKind::OpenCode {
                        assert_eq!(target.visible_to, [AgentKind::OpenCode]);
                        assert!(!target.conditions.iter().any(|reason| reason.contains(key)));
                    }
                }
            }
        }
    }

    #[test]
    fn opencode_claude_compatibility_stays_at_home_when_claude_home_is_overridden() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let workspace = SkillWorkspace {
            id: "repo".into(),
            name: "Repo".into(),
            path: project,
        };
        for (override_home, expected) in [
            (home.join(".claude"), true),
            (temp.path().join("custom-claude"), false),
            (home.join(".config/opencode"), true),
        ] {
            let environment = TargetEnvironment {
                home: home.clone(),
                values: BTreeMap::from([(
                    "CLAUDE_CONFIG_DIR".into(),
                    override_home.display().to_string(),
                )]),
            };
            let targets =
                targets_with_environment(std::slice::from_ref(&workspace), &environment).unwrap();
            for target in targets
                .iter()
                .filter(|target| target.agent == AgentKind::ClaudeCode)
            {
                assert_eq!(
                    target.visible_to.contains(&AgentKind::OpenCode),
                    expected || target.scope == SkillScope::Workspace
                );
                assert!(target.visible_to.contains(&AgentKind::ClaudeCode));
                assert_eq!(
                    target
                        .conditions
                        .iter()
                        .any(|reason| reason.contains("CLAUDE_CONFIG_DIR does not")),
                    !expected && target.scope == SkillScope::Personal
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn opencode_source_visibility_resolves_home_and_native_directory_aliases() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let alias = temp.path().join("home-alias");
        fs::create_dir_all(home.join(".claude")).unwrap();
        symlink(&home, &alias).unwrap();
        let mut environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([(
                "CLAUDE_CONFIG_DIR".into(),
                alias.join(".claude").display().to_string(),
            )]),
        };
        let claude_root = alias.join(".claude/skills");
        // No skills directory exists yet: aliases still describe the same target.
        assert!(
            environment
                .opencode_source_restriction(&claude_root, None)
                .is_none()
        );
        environment
            .values
            .insert("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS".into(), "1".into());
        assert!(
            environment
                .opencode_source_restriction(&claude_root, None)
                .is_some()
        );
        fs::create_dir_all(home.join(".config")).unwrap();
        symlink(home.join(".claude"), home.join(".config/opencode")).unwrap();
        assert!(
            environment
                .opencode_source_restriction(&claude_root, None)
                .is_none()
        );
        let target = targets_with_environment(&[], &environment)
            .unwrap()
            .into_iter()
            .find(|target| target.agent == AgentKind::ClaudeCode)
            .unwrap();
        assert!(target.visible_to.contains(&AgentKind::OpenCode));
    }

    #[test]
    fn opencode_explicit_config_directory_remains_readable_with_compatibility_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let mut environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([
                ("OPENCODE_DISABLE_EXTERNAL_SKILLS".into(), "1".into()),
                (
                    "OPENCODE_CONFIG_DIR".into(),
                    home.join(".claude").display().to_string(),
                ),
            ]),
        };
        assert!(
            environment
                .opencode_source_restriction(&home.join(".claude/skills"), None)
                .is_none()
        );
        environment
            .values
            .insert("OPENCODE_CONFIG_DIR".into(), ".claude".into());
        assert!(
            environment
                .opencode_source_restriction(&project.join(".claude/skills"), Some(&project))
                .is_none()
        );
        assert!(
            environment
                .opencode_source_restriction(&home.join(".claude/skills"), Some(&project))
                .is_some()
        );
    }

    #[test]
    fn openclaw_personal_shared_visibility_uses_the_effective_state() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        let workspace = SkillWorkspace {
            id: "repo".into(),
            name: "Repo".into(),
            path: project,
        };
        for (values, expected) in [
            (BTreeMap::new(), true),
            (
                BTreeMap::from([("OPENCLAW_PROFILE".into(), "DEFAULT".into())]),
                true,
            ),
            (
                BTreeMap::from([(
                    "OPENCLAW_STATE_DIR".into(),
                    home.join(".openclaw").display().to_string(),
                )]),
                true,
            ),
            (
                BTreeMap::from([(
                    "OPENCLAW_STATE_DIR".into(),
                    temp.path().join("state").display().to_string(),
                )]),
                false,
            ),
            (
                BTreeMap::from([("OPENCLAW_PROFILE".into(), "work".into())]),
                false,
            ),
            (
                BTreeMap::from([
                    ("OPENCLAW_PROFILE".into(), "work".into()),
                    (
                        "OPENCLAW_STATE_DIR".into(),
                        home.join(".openclaw").display().to_string(),
                    ),
                ]),
                true,
            ),
            (
                BTreeMap::from([(
                    "OPENCLAW_HOME".into(),
                    temp.path().join("other-home").display().to_string(),
                )]),
                false,
            ),
        ] {
            let environment = TargetEnvironment {
                home: home.clone(),
                values,
            };
            let targets =
                targets_with_environment(std::slice::from_ref(&workspace), &environment).unwrap();
            for target in targets
                .iter()
                .filter(|target| target.agent == AgentKind::Codex)
            {
                assert_eq!(
                    target.visible_to.contains(&AgentKind::OpenClaw),
                    target.scope == SkillScope::Workspace || expected,
                    "{:?}: {target:?}",
                    environment.values
                );
                assert!(target.visible_to.contains(&AgentKind::Cursor));
            }
            let managed = targets
                .iter()
                .find(|target| {
                    target.agent == AgentKind::OpenClaw && target.scope == SkillScope::Personal
                })
                .unwrap();
            assert_eq!(
                managed.root,
                environment.home_for(AgentKind::OpenClaw).join("skills")
            );
            assert_eq!(managed.visible_to, [AgentKind::OpenClaw]);
        }
    }

    #[test]
    fn openclaw_explicit_extra_dirs_restore_shared_visibility_using_native_environment() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = home.join(".openclaw-work");
        let config = temp.path().join("config.json");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join(".env"), "SKILL_ROOT=~/.agents/skills\n").unwrap();
        fs::write(
            &config,
            r#"{"skills":{"load":{"extraDirs":["${SKILL_ROOT}"]}}}"#,
        )
        .unwrap();
        let mut environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([
                ("OPENCLAW_PROFILE".into(), "work".into()),
                ("OPENCLAW_CONFIG_PATH".into(), config.display().to_string()),
            ]),
        };
        assert_eq!(
            environment.openclaw_extra_dirs().unwrap(),
            [home.join(".agents/skills")]
        );
        assert!(
            environment
                .personal_shared_agents()
                .contains(&AgentKind::OpenClaw)
        );
        environment.values.insert(
            "SKILL_ROOT".into(),
            temp.path().join("other-skills").display().to_string(),
        );
        assert!(
            !environment
                .personal_shared_agents()
                .contains(&AgentKind::OpenClaw)
        );
        environment.values.remove("SKILL_ROOT");
        fs::remove_file(state.join(".env")).unwrap();
        fs::write(&config, r#"{"env":{"vars":{"SKILL_ROOT":"~/.agents/skills"}},"skills":{"load":{"extraDirs":["${SKILL_ROOT}"]}}}"#).unwrap();
        assert!(
            environment
                .personal_shared_agents()
                .contains(&AgentKind::OpenClaw)
        );
        fs::write(
            &config,
            r#"{"skills":{"load":{"extraDirs":["${UNSET_ROOT}"]}}}"#,
        )
        .unwrap();
        assert!(environment.openclaw_extra_dirs().is_err());
        assert!(
            !environment
                .personal_shared_agents()
                .contains(&AgentKind::OpenClaw)
        );
    }

    #[cfg(unix)]
    #[test]
    fn openclaw_extra_dirs_match_shared_sources_through_physical_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = home.join(".openclaw-work");
        let shared = home.join(".agents/skills");
        let alias = temp.path().join("shared-alias");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&shared).unwrap();
        std::os::unix::fs::symlink(&shared, &alias).unwrap();
        fs::write(
            state.join("openclaw.json"),
            serde_json::json!({"skills":{"load":{"extraDirs":[alias]}}}).to_string(),
        )
        .unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::from([("OPENCLAW_PROFILE".into(), "work".into())]),
        };
        assert!(
            environment
                .personal_shared_agents()
                .contains(&AgentKind::OpenClaw)
        );
        // Removing the extra source must not hide the same physical package
        // when the selected state's managed root also points to it.
        fs::write(state.join("openclaw.json"), "{}").unwrap();
        assert!(
            !environment
                .personal_shared_agents()
                .contains(&AgentKind::OpenClaw)
        );
        std::os::unix::fs::symlink(&shared, state.join("skills")).unwrap();
        assert!(
            environment
                .personal_shared_agents()
                .contains(&AgentKind::OpenClaw)
        );
        let grouped = temp.path().join("grouped");
        fs::create_dir(&grouped).unwrap();
        std::os::unix::fs::symlink(&shared, grouped.join("skills")).unwrap();
        assert!(openclaw_extra_root_reads_children(
            &grouped,
            &grouped.join("skills")
        ));
    }

    #[test]
    fn openclaw_extra_roots_stop_at_package_boundaries_and_six_levels() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("extra");
        let parent_at_five = root.join("a/b/c/d/e");
        fs::create_dir_all(&parent_at_five).unwrap();
        assert!(openclaw_extra_root_reads_children(&root, &parent_at_five));
        assert!(!openclaw_extra_root_reads_children(
            &root,
            &parent_at_five.join("f")
        ));
        assert!(openclaw_root_reads_package(
            &root,
            &parent_at_five.join("skill")
        ));
        assert!(!openclaw_root_reads_package(
            &root,
            &parent_at_five.join("f/skill")
        ));
        for boundary in [&root, &root.join("a/b"), &parent_at_five] {
            fs::write(
                boundary.join("SKILL.md"),
                "invalid skill still ends discovery",
            )
            .unwrap();
            assert!(!openclaw_extra_root_reads_children(&root, &parent_at_five));
            fs::remove_file(boundary.join("SKILL.md")).unwrap();
        }
    }

    #[test]
    fn openclaw_default_profile_uses_the_default_state_and_configuration() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(
            home.join(".openclaw/openclaw.json"),
            serde_json::json!({"agents":{"defaults":{"workspace":project}}}).to_string(),
        )
        .unwrap();
        let workspaces = [SkillWorkspace {
            id: "repo".into(),
            name: "Repo".into(),
            path: project.clone(),
        }];
        for profile in ["default", "DEFAULT", " Default "] {
            let environment = TargetEnvironment {
                home: home.clone(),
                values: BTreeMap::from([("OPENCLAW_PROFILE".into(), profile.into())]),
            };
            assert_eq!(
                environment.home_for(AgentKind::OpenClaw),
                home.join(".openclaw")
            );
            let targets = targets_with_environment(&workspaces, &environment).unwrap();
            for target in targets
                .iter()
                .filter(|target| target.agent == AgentKind::OpenClaw)
            {
                assert!(target.writable, "{profile}: {target:?}");
                assert_eq!(
                    target.root,
                    if target.scope == SkillScope::Personal {
                        home.join(".openclaw/skills")
                    } else {
                        project.join("skills")
                    }
                );
            }
        }
        assert!(!home.join(".openclaw-default").exists());
    }

    #[test]
    fn openclaw_entries_resolve_explicit_and_inherited_multi_agent_workspaces() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        let base = temp.path().join("base");
        let expected = [
            base.join("reader"),
            temp.path().join("writer"),
            home.join("research"),
        ];
        for path in std::iter::once(&base).chain(expected.iter()) {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(
            home.join(".openclaw/openclaw.json"),
            serde_json::json!({
                "env": {"vars": {"WORK_ROOT": temp.path()}},
                "agents": {
                    "ownership": "explicit",
                    "defaults": {"workspace": "${WORK_ROOT}/base"},
                    "entries": {
                        "Reader": {},
                        "writer": {"workspace": "${WORK_ROOT}/writer"},
                        "research": {"workspace": "~/research"}
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        let (roots, error) = environment.openclaw_workspaces();
        assert!(error.is_none(), "{error:?}");
        assert_eq!(
            roots.into_iter().collect::<BTreeSet<_>>(),
            expected.iter().cloned().collect::<BTreeSet<_>>()
        );
        let workspaces = std::iter::once(&base)
            .chain(expected.iter())
            .enumerate()
            .map(|(index, path)| SkillWorkspace {
                id: index.to_string(),
                name: index.to_string(),
                path: path.clone(),
            })
            .collect::<Vec<_>>();
        let targets = targets_with_environment(&workspaces, &environment).unwrap();
        for target in targets.iter().filter(|target| {
            target.agent == AgentKind::OpenClaw && target.scope == SkillScope::Workspace
        }) {
            assert_eq!(target.writable, target.scope_root != base, "{target:?}");
            assert!(!target.root.exists());
        }
    }

    #[test]
    fn openclaw_entries_inherit_sole_and_legacy_default_workspaces() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = home.join(".openclaw");
        fs::create_dir_all(&state).unwrap();
        let default = temp.path().join("default");
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        for (config, expected) in [
            (
                serde_json::json!({"agents":{"defaults":{"workspace":default},"entries":{"writer":{}}}}),
                vec![default.clone()],
            ),
            (
                serde_json::json!({"agents":{"entries":{"writer":{}}}}),
                vec![state.join("workspace")],
            ),
            (
                serde_json::json!({"agents":{"ownership":"explicit","entries":{"reader":{},"writer":{}}}}),
                vec![
                    state.join("workspace-reader"),
                    state.join("workspace-writer"),
                ],
            ),
            (
                serde_json::json!({"agents":{"defaults":{"workspace":default},"entries":{"reader":{},"writer":{"default":true}}}}),
                vec![default.join("reader"), default.clone()],
            ),
        ] {
            fs::write(state.join("openclaw.json"), config.to_string()).unwrap();
            let (roots, error) = environment.openclaw_workspaces();
            assert!(error.is_none(), "{config}: {error:?}");
            assert_eq!(
                roots.into_iter().collect::<BTreeSet<_>>(),
                expected.into_iter().collect::<BTreeSet<_>>(),
                "{config}"
            );
        }
    }

    #[test]
    fn openclaw_entries_take_precedence_over_legacy_list_including_empty_rosters() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = home.join(".openclaw");
        fs::create_dir_all(&state).unwrap();
        let current = temp.path().join("current");
        let legacy = temp.path().join("legacy");
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        for legacy_workspace in [legacy.display().to_string(), "${MISSING}".into()] {
            let config = serde_json::json!({"agents":{
                "entries":{"writer":{"workspace":current}},
                "list":[{"id":"writer","workspace":legacy_workspace}]
            }});
            fs::write(state.join("openclaw.json"), config.to_string()).unwrap();
            assert_eq!(
                environment.openclaw_workspaces(),
                (vec![current.clone()], None)
            );
        }
        fs::write(
            state.join("openclaw.json"),
            serde_json::json!({"agents":{
                "defaults":{"workspace":current}, "entries":{},
                "list":[{"id":"writer","workspace":legacy}]
            }})
            .to_string(),
        )
        .unwrap();
        assert_eq!(environment.openclaw_workspaces(), (Vec::new(), None));

        // A pre-migration installation with only list keeps its existing paths.
        fs::write(
            state.join("openclaw.json"),
            serde_json::json!({"agents":{
                "defaults":{"workspace":current},
                "list":[{"id":"writer","workspace":legacy}]
            }})
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            environment.openclaw_workspaces(),
            (vec![current, legacy], None)
        );
    }

    #[test]
    fn invalid_openclaw_entries_do_not_enable_default_or_legacy_workspaces() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = home.join(".openclaw");
        fs::create_dir_all(&state).unwrap();
        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::from([(
                "OPENCLAW_WORKSPACE_DIR".into(),
                project.display().to_string(),
            )]),
        };
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.clone(),
        }];
        for entries in [
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!(false),
            serde_json::json!({"writer":null}),
            serde_json::json!({"writer":[]}),
            serde_json::json!({"":{}}),
            serde_json::json!({"../writer":{}}),
            serde_json::json!({"Writer":{},"writer":{}}),
            serde_json::json!({"writer":{"workspace":"relative/path"}}),
            serde_json::json!({"writer":{"workspace":""}}),
            serde_json::json!({"writer":{"workspace":"${MISSING}/project"}}),
            serde_json::json!({"writer":{"workspace":null}}),
            serde_json::json!({"writer":{"workspace":7}}),
            serde_json::json!({"writer":{"default":"true"}}),
            serde_json::json!({"reader":{"default":true},"writer":{"default":true}}),
        ] {
            let config = serde_json::json!({"agents":{
                "defaults":{"workspace":project}, "entries":entries,
                "list":[{"id":"legacy","workspace":project}]
            }});
            fs::write(state.join("openclaw.json"), config.to_string()).unwrap();
            let (roots, error) = environment.openclaw_workspaces();
            assert!(roots.is_empty(), "{entries}: {roots:?}");
            assert!(
                error.is_some_and(|error| error.contains("agents.entries")),
                "{entries}"
            );
            let targets = targets_with_environment(&workspaces, &environment).unwrap();
            let target = targets
                .iter()
                .find(|target| {
                    target.agent == AgentKind::OpenClaw && target.scope == SkillScope::Workspace
                })
                .unwrap();
            assert!(!target.writable, "{entries}: {target:?}");
        }
        assert!(!project.join("skills").exists());
    }

    #[test]
    fn openclaw_workspace_variables_use_process_then_state_dotenv_then_config() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = temp.path().join("custom-state");
        fs::create_dir_all(&state).unwrap();
        let configured = temp.path().join("configured");
        let dotenv = temp.path().join("dotenv");
        let process = temp.path().join("process");
        let agent = temp.path().join("agent");
        for path in [&configured, &dotenv, &process, &agent] {
            fs::create_dir_all(path).unwrap();
        }
        let config = serde_json::json!({"env":{"vars":{"WORK_ROOT":configured,"AGENT_ROOT":agent}},"agents":{"defaults":{"workspace":"${WORK_ROOT}"},"list":[{"id":"other","workspace":"${AGENT_ROOT}"}]}}).to_string();
        fs::write(state.join("openclaw.json"), &config).unwrap();
        let mut environment = TargetEnvironment {
            home,
            values: BTreeMap::from([("OPENCLAW_STATE_DIR".into(), state.display().to_string())]),
        };
        assert_eq!(
            environment.openclaw_workspaces(),
            (vec![configured, agent.clone()], None)
        );
        let dotenv_content = format!(
            "export WORK_ROOT='{}' # retained as a path\n",
            dotenv.display()
        );
        fs::write(state.join(".env"), &dotenv_content).unwrap();
        assert_eq!(
            environment.openclaw_workspaces(),
            (vec![dotenv, agent.clone()], None)
        );
        environment
            .values
            .insert("WORK_ROOT".into(), process.display().to_string());
        assert_eq!(
            environment.openclaw_workspaces(),
            (vec![process, agent], None)
        );
        assert_eq!(
            fs::read_to_string(state.join("openclaw.json")).unwrap(),
            config
        );
        assert_eq!(
            fs::read_to_string(state.join(".env")).unwrap(),
            dotenv_content
        );
        assert!(!state.join("skills").exists());
    }

    #[test]
    fn openclaw_dotenv_workspace_defaults_and_literal_values_are_not_executed_or_expanded() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = home.join(".openclaw");
        fs::create_dir_all(&state).unwrap();
        let project = temp.path().join("project");
        fs::write(
            state.join(".env"),
            format!("OPENCLAW_WORKSPACE_DIR={}\n", project.display()),
        )
        .unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        assert_eq!(environment.openclaw_workspaces(), (vec![project], None));
        fs::write(
            state.join(".env"),
            "WORK_ROOT='${MISSING}/$(touch should-not-run)'\n",
        )
        .unwrap();
        fs::write(
            state.join("openclaw.json"),
            r#"{"agents":{"defaults":{"workspace":"${WORK_ROOT}"}}}"#,
        )
        .unwrap();
        let (roots, error) = environment.openclaw_workspaces();
        assert!(roots.is_empty());
        assert!(error.is_some());
        assert!(!state.join("should-not-run").exists());
        fs::write(state.join(".env"), "WORK_ROOT='unterminated").unwrap();
        assert!(
            environment
                .openclaw_workspaces()
                .1
                .unwrap()
                .contains("environment could not be read")
        );
    }

    #[test]
    fn dotenv_parser_preserves_literal_values_and_supported_quotes() {
        let parsed = parse_dotenv("# comment\r\nexport ROOT = '/path with #/空格'\r\nPLAIN= /path # comment\nDOUBLE=\"line\\nsecond\\r\"\nSINGLE='${ROOT}/$(command)'\nMULTI=`one\ntwo`\nEMPTY=\nREPEAT=first\nREPEAT=last\n").unwrap();
        assert_eq!(parsed["ROOT"], "/path with #/空格");
        assert_eq!(parsed["PLAIN"], "/path");
        assert_eq!(parsed["DOUBLE"], "line\nsecond\r");
        assert_eq!(parsed["SINGLE"], "${ROOT}/$(command)");
        assert_eq!(parsed["MULTI"], "one\ntwo");
        assert_eq!(parsed["EMPTY"], "");
        assert_eq!(parsed["REPEAT"], "last");
    }

    #[test]
    fn all_eight_agents_resolve_the_documented_personal_and_project_locations() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        fs::write(
            home.join(".openclaw/openclaw.json"),
            serde_json::json!({"agents": {"defaults": {"workspace": project}}}).to_string(),
        )
        .unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let targets = targets_with_environment(
            &[SkillWorkspace {
                id: "repo".into(),
                name: "Repo".into(),
                path: project.clone(),
            }],
            &environment,
        )
        .unwrap();
        assert_eq!(targets.len(), 16);
        for (agent, personal, local) in [
            (AgentKind::Codex, ".agents/skills", ".agents/skills"),
            (AgentKind::ClaudeCode, ".claude/skills", ".claude/skills"),
            (AgentKind::Cursor, ".cursor/skills", ".cursor/skills"),
            (
                AgentKind::OpenCode,
                ".config/opencode/skills",
                ".opencode/skills",
            ),
            (AgentKind::OpenClaw, ".openclaw/skills", "skills"),
            (AgentKind::Hermes, ".hermes/skills", ".hermes/skills"),
            (AgentKind::GrokBuild, ".grok/skills", ".grok/skills"),
            (
                AgentKind::Antigravity,
                ".gemini/antigravity-cli/skills",
                ".agents/skills",
            ),
        ] {
            for (scope, expected) in [
                (SkillScope::Personal, home.join(personal)),
                (SkillScope::Workspace, project.join(local)),
            ] {
                let target = targets
                    .iter()
                    .find(|target| target.agent == agent && target.scope == scope)
                    .unwrap();
                assert_eq!(target.root, expected, "{agent:?} {scope:?}");
                assert!(target.writable, "{agent:?} {scope:?}: {:?}", target.reason);
                assert!(target.visible_to.contains(&agent));
            }
        }
    }

    #[test]
    fn valid_home_overrides_resolve_without_changing_codex_shared_destination() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let environment = TargetEnvironment {
            home: home.clone(),
            values: [
                "CODEX_HOME",
                "CLAUDE_CONFIG_DIR",
                "XDG_CONFIG_HOME",
                "OPENCLAW_STATE_DIR",
                "HERMES_HOME",
                "GROK_HOME",
            ]
            .into_iter()
            .map(|key| (key.to_string(), temp.path().join(key).display().to_string()))
            .collect(),
        };
        let targets = targets_with_environment(&[], &environment).unwrap();
        for (agent, expected) in [
            (AgentKind::Codex, home.join(".agents/skills")),
            (
                AgentKind::ClaudeCode,
                temp.path().join("CLAUDE_CONFIG_DIR/skills"),
            ),
            (
                AgentKind::OpenCode,
                temp.path().join("XDG_CONFIG_HOME/opencode/skills"),
            ),
            (
                AgentKind::OpenClaw,
                temp.path().join("OPENCLAW_STATE_DIR/skills"),
            ),
            (AgentKind::Hermes, temp.path().join("HERMES_HOME/skills")),
            (AgentKind::GrokBuild, temp.path().join("GROK_HOME/skills")),
        ] {
            let target = targets.iter().find(|target| target.agent == agent).unwrap();
            assert_eq!(target.root, expected);
            assert!(target.writable, "{agent:?}: {:?}", target.reason);
        }
    }

    #[test]
    fn targets_respect_overrides_profiles_and_workspace_conditions() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let project = home.join("repo");
        fs::create_dir(&project).unwrap();
        let profile = home.join(".hermes/profiles/research");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("config.yaml"), "{}").unwrap();
        let env = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([(
                "GROK_HOME".into(),
                home.join("custom-grok").display().to_string(),
            )]),
        };
        let targets = targets_with_environment(
            &[SkillWorkspace {
                id: "repo".into(),
                name: "Repo".into(),
                path: project,
            }],
            &env,
        )
        .unwrap();
        assert!(
            targets
                .iter()
                .any(|target| target.root == home.join("custom-grok/skills"))
        );
        assert!(
            targets
                .iter()
                .any(|target| target.profile.as_deref() == Some("research"))
        );
        assert!(
            targets
                .iter()
                .any(|target| target.agent == AgentKind::OpenClaw
                    && target.scope == SkillScope::Workspace
                    && !target.writable)
        );
        assert!(
            targets
                .iter()
                .filter(|target| target.scope == SkillScope::Personal)
                .all(|target| target.root.starts_with(&home))
        );
    }
    #[test]
    fn invalid_overrides_are_not_silently_replaced_with_writable_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let environment = TargetEnvironment {
            home: temp.path().to_path_buf(),
            values: BTreeMap::from([
                ("GROK_HOME".into(), "relative-home".into()),
                ("OPENCLAW_PROFILE".into(), "../unsafe".into()),
            ]),
        };
        let targets = targets_with_environment(&[], &environment).unwrap();
        assert!(
            targets
                .iter()
                .filter(|target| matches!(target.agent, AgentKind::GrokBuild | AgentKind::OpenClaw))
                .all(|target| !target.writable && target.reason.is_some())
        );
        assert!(
            !targets
                .iter()
                .any(|target| target.agent == AgentKind::DeepSeekHarness)
        );
        assert_eq!(targets.len(), 8);
    }

    #[test]
    fn openclaw_explicit_workspace_takes_precedence_over_the_environment_default() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let configured = temp.path().join("configured");
        let fallback = temp.path().join("fallback");
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        fs::create_dir_all(&configured).unwrap();
        fs::create_dir_all(&fallback).unwrap();
        let config = home.join(".openclaw/openclaw.json");
        fs::write(
            &config,
            serde_json::json!({"agents":{"defaults":{"workspace":configured}}}).to_string(),
        )
        .unwrap();
        let workspaces = [&configured, &fallback]
            .into_iter()
            .enumerate()
            .map(|(index, path)| SkillWorkspace {
                id: index.to_string(),
                name: index.to_string(),
                path: path.clone(),
            })
            .collect::<Vec<_>>();
        // An ignored invalid environment default must not block the explicit
        // configuration through the general environment validation either.
        for value in [fallback.display().to_string(), "relative-workspace".into()] {
            let environment = TargetEnvironment {
                home: home.clone(),
                values: BTreeMap::from([("OPENCLAW_WORKSPACE_DIR".into(), value)]),
            };
            let targets = targets_with_environment(&workspaces, &environment).unwrap();
            for target in targets.iter().filter(|target| {
                target.agent == AgentKind::OpenClaw && target.scope == SkillScope::Workspace
            }) {
                assert_eq!(
                    target.writable,
                    target.scope_root == configured,
                    "{target:?}"
                );
            }
        }
        fs::write(&config, "{}").unwrap();
        let mut environment = TargetEnvironment {
            home,
            values: BTreeMap::from([(
                "OPENCLAW_WORKSPACE_DIR".into(),
                fallback.display().to_string(),
            )]),
        };
        assert_eq!(environment.openclaw_workspaces(), (vec![fallback], None));
        environment
            .values
            .insert("OPENCLAW_WORKSPACE_DIR".into(), "relative-workspace".into());
        let (roots, error) = environment.openclaw_workspaces();
        assert!(roots.is_empty());
        assert!(error.unwrap().contains("OPENCLAW_WORKSPACE_DIR"));
    }

    #[test]
    fn openclaw_resolves_environment_variables_in_default_and_agent_workspaces() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        fs::write(
            home.join(".openclaw/openclaw.json"),
            r#"{"agents":{"defaults":{"workspace":"${WORK_ROOT}/default"},"list":[{"id":"one","workspace":"${WORK_ROOT}/${AGENT_NAME}"},{"id":"two","workspace":"~/second"}]}}"#,
        )
        .unwrap();
        let expected = [
            temp.path().join("default"),
            temp.path().join("first"),
            home.join("second"),
        ];
        let workspaces = expected
            .iter()
            .enumerate()
            .map(|(index, path)| {
                fs::create_dir_all(path).unwrap();
                SkillWorkspace {
                    id: index.to_string(),
                    name: index.to_string(),
                    path: path.clone(),
                }
            })
            .collect::<Vec<_>>();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::from([
                ("WORK_ROOT".into(), temp.path().display().to_string()),
                ("AGENT_NAME".into(), "first".into()),
            ]),
        };
        assert_eq!(environment.openclaw_workspaces(), (expected.to_vec(), None));
        let targets = targets_with_environment(&workspaces, &environment).unwrap();
        let targets = targets
            .iter()
            .filter(|target| {
                target.agent == AgentKind::OpenClaw && target.scope == SkillScope::Workspace
            })
            .collect::<Vec<_>>();
        assert_eq!(targets.len(), expected.len());
        assert!(targets.iter().all(|target| target.writable));
    }

    #[test]
    fn openclaw_workspace_substitution_preserves_native_literals_without_recursion() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([
                ("ROOT".into(), temp.path().display().to_string()),
                ("LITERAL".into(), "must-not-replace".into()),
                ("NESTED".into(), "${LITERAL}".into()),
                ("lower".into(), "must-not-replace".into()),
                ("BAD-NAME".into(), "must-not-replace".into()),
                ("_PROFILE2".into(), "profile".into()),
            ]),
        };
        for (suffix, expected_suffix) in [
            ("$${LITERAL}", "${LITERAL}"),
            ("$${MISSING}", "${MISSING}"),
            ("${NESTED}", "${LITERAL}"),
            ("${lower}", "${lower}"),
            ("${BAD-NAME}", "${BAD-NAME}"),
            ("${UNCLOSED", "${UNCLOSED"),
            ("$$${LITERAL}", "$${LITERAL}"),
            ("中文-${_PROFILE2}-$${LITERAL}", "中文-profile-${LITERAL}"),
        ] {
            let expected = temp.path().join(expected_suffix);
            fs::create_dir_all(&expected).unwrap();
            let workspace = SkillWorkspace {
                id: "literal".into(),
                name: "Literal workspace".into(),
                path: expected.clone(),
            };
            let path = format!("${{ROOT}}/{suffix}");
            for agent_specific in [false, true] {
                let config = if agent_specific {
                    serde_json::json!({"agents":{"list":[{"id":"one","workspace":path}]}})
                } else {
                    serde_json::json!({"agents":{"defaults":{"workspace":path}}})
                };
                fs::write(home.join(".openclaw/openclaw.json"), config.to_string()).unwrap();
                let (roots, error) = environment.openclaw_workspaces();
                assert!(error.is_none(), "{path}: {error:?}");
                assert!(roots.contains(&expected), "{path}: {roots:?}");
                let targets =
                    targets_with_environment(std::slice::from_ref(&workspace), &environment)
                        .unwrap();
                let target = targets
                    .iter()
                    .find(|target| {
                        target.agent == AgentKind::OpenClaw && target.scope == SkillScope::Workspace
                    })
                    .unwrap();
                assert!(target.writable, "{path}: {target:?}");
                assert!(!expected.join("skills").exists());
            }
        }
        // The pre-existing path helper used by other agents retains its behavior.
        assert_eq!(
            environment.configured_path("${ROOT}/${NESTED}", None),
            Some(temp.path().join("must-not-replace"))
        );
    }

    #[test]
    fn unresolved_openclaw_configuration_never_enables_a_fallback_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        fs::create_dir_all(&project).unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([
                (
                    "OPENCLAW_WORKSPACE_DIR".into(),
                    project.display().to_string(),
                ),
                ("WORK_ROOT".into(), project.display().to_string()),
                ("EMPTY".into(), String::new()),
                ("RELATIVE".into(), "relative-root".into()),
            ]),
        };
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.clone(),
        }];
        for path in [
            "${MISSING}/project",
            "${WORK_ROOT}/${EMPTY}",
            "${RELATIVE}/project",
        ] {
            for agent_specific in [false, true] {
                let config = if agent_specific {
                    serde_json::json!({"agents":{"defaults":{"workspace":project},"list":[{"id":"one","workspace":path}]}})
                } else {
                    serde_json::json!({"agents":{"defaults":{"workspace":path}}})
                };
                fs::write(home.join(".openclaw/openclaw.json"), config.to_string()).unwrap();
                let (roots, error) = environment.openclaw_workspaces();
                assert!(roots.is_empty());
                assert!(error.unwrap().contains(if agent_specific {
                    "agents.list[0].workspace"
                } else {
                    "agents.defaults.workspace"
                }));
                let targets = targets_with_environment(&workspaces, &environment).unwrap();
                let target = targets
                    .iter()
                    .find(|target| {
                        target.agent == AgentKind::OpenClaw && target.scope == SkillScope::Workspace
                    })
                    .unwrap();
                assert!(!target.writable, "{path}: {target:?}");
                assert!(target.reason.is_some());
                assert!(!project.join("skills").exists());
            }
        }
    }

    #[test]
    fn hermes_profiles_and_external_paths_use_the_effective_home() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let custom = home.join("hermes-custom");
        fs::create_dir_all(custom.join("profiles/research")).unwrap();
        fs::write(custom.join("profiles/research/config.yaml"), "{}").unwrap();
        fs::write(
            custom.join("config.yaml"),
            "skills:\n  create_dir: brain\n  external_dirs: ['${SKILL_FIXTURE}/skills']\n",
        )
        .unwrap();
        let environment = TargetEnvironment {
            home: home.to_path_buf(),
            values: BTreeMap::from([
                ("HERMES_HOME".into(), custom.display().to_string()),
                (
                    "SKILL_FIXTURE".into(),
                    home.join("external").display().to_string(),
                ),
            ]),
        };
        assert!(
            environment
                .hermes_homes()
                .contains(&custom.join("profiles/research"))
        );
        let dirs = environment.hermes_external_dirs();
        assert!(dirs.contains(&custom.join("brain")));
        assert!(dirs.contains(&home.join("external/skills")));
        assert!(
            !environment
                .hermes_homes()
                .iter()
                .any(|path| path.starts_with(home.join(".hermes")))
        );
    }
    #[test]
    fn registering_home_does_not_expose_personal_skill_roots_as_project_writes() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let ordinary = home.join("repo");
        fs::create_dir_all(&ordinary).unwrap();
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        fs::write(
            home.join(".openclaw/openclaw.json"),
            serde_json::json!({"agents":{"defaults":{"workspace":ordinary}}}).to_string(),
        )
        .unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let workspaces = [
            SkillWorkspace {
                id: "home".into(),
                name: "Home".into(),
                path: home.clone(),
            },
            SkillWorkspace {
                id: "ordinary".into(),
                name: "Ordinary".into(),
                path: ordinary,
            },
        ];
        let targets = targets_with_environment(&workspaces, &environment).unwrap();
        for agent in [
            AgentKind::Codex,
            AgentKind::ClaudeCode,
            AgentKind::Cursor,
            AgentKind::Hermes,
            AgentKind::GrokBuild,
            AgentKind::Antigravity,
        ] {
            let target = targets
                .iter()
                .find(|target| {
                    target.agent == agent && target.workspace_id.as_deref() == Some("home")
                })
                .unwrap();
            assert!(!target.writable, "{agent:?} must use personal approval");
            assert!(
                target
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("personal target"))
            );
        }
        assert_eq!(
            targets
                .iter()
                .filter(|target| target.workspace_id.as_deref() == Some("home"))
                .count(),
            SUPPORTED.len()
        );
        assert!(
            targets
                .iter()
                .filter(|target| target.workspace_id.as_deref() == Some("ordinary"))
                .all(|target| target.writable)
        );
        assert!(
            targets
                .iter()
                .filter(|target| target.scope == SkillScope::Personal)
                .all(|target| target.writable)
        );
        assert!(!home.join(".agents/skills").exists());
    }

    #[cfg(unix)]
    #[test]
    fn missing_skill_roots_below_a_home_alias_still_require_personal_management() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let alias = temp.path().join("home-alias");
        fs::create_dir(&home).unwrap();
        std::os::unix::fs::symlink(&home, &alias).unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let targets = targets_with_environment(
            &[SkillWorkspace {
                id: "alias".into(),
                name: "Alias".into(),
                path: alias,
            }],
            &environment,
        )
        .unwrap();
        for agent in [
            AgentKind::Codex,
            AgentKind::ClaudeCode,
            AgentKind::Cursor,
            AgentKind::Hermes,
            AgentKind::GrokBuild,
            AgentKind::Antigravity,
        ] {
            let target = targets
                .iter()
                .find(|target| target.agent == agent && target.scope == SkillScope::Workspace)
                .unwrap();
            assert!(!target.writable, "{agent:?}");
            assert!(
                target
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("personal target"))
            );
        }
        assert!(!home.join(".agents").exists());
    }

    #[test]
    fn project_roots_cannot_contain_a_nested_personal_skill_directory() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("repo");
        fs::create_dir_all(&project).unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::from([(
                "CLAUDE_CONFIG_DIR".into(),
                project.join(".claude/skills/nested").display().to_string(),
            )]),
        };
        let targets = targets_with_environment(
            &[SkillWorkspace {
                id: "repo".into(),
                name: "Repo".into(),
                path: project,
            }],
            &environment,
        )
        .unwrap();
        let target = targets
            .iter()
            .find(|target| {
                target.agent == AgentKind::ClaudeCode && target.scope == SkillScope::Workspace
            })
            .unwrap();
        assert!(!target.writable);
        assert!(
            target
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("personal target"))
        );
    }
}
