//! Read-only native restrictions. These are observations, never proof that a
//! running Agent has loaded the package or a request to change its settings.
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use agentkib_core::{AgentKind, SkillObservation, SkillScope, SkillWorkspace};
use agentkib_platform::path as platform_path;
use serde::{Deserialize, Deserializer, de};

use crate::targets::{TargetEnvironment, read_json5};

pub(crate) fn annotate(
    observation: &mut SkillObservation,
    workspaces: &[SkillWorkspace],
    environment: &TargetEnvironment,
) {
    let project = observation
        .workspace_id
        .as_ref()
        .and_then(|id| workspaces.iter().find(|workspace| &workspace.id == id));
    if let Some(reason) = environment.opencode_source_restriction(
        &observation.path,
        project.map(|project| project.path.as_path()),
    ) {
        let was_opencode_only =
            observation.agents.is_empty() || observation.agents == [AgentKind::OpenCode];
        observation
            .agents
            .retain(|agent| *agent != AgentKind::OpenCode);
        observation.diagnostics.push(reason);
        if was_opencode_only && observation.status == "observed" {
            observation.status = "native-restricted".into();
        }
    }
    let mut restricted = 0;
    let mut hermes_status = None;
    let mut opencode_unknown = false;
    let mut openclaw_unknown = false;
    for agent in observation.agents.clone() {
        match agent {
            AgentKind::Codex => {
                let path = environment.home_for(agent).join("config.toml");
                match read_toml(&path) {
                    Ok(config) => {
                        let disabled = config
                            .get("skills")
                            .and_then(|skills| skills.get("config"))
                            .and_then(|entries| entries.as_array())
                            .is_some_and(|entries| {
                                entries.iter().any(|entry| {
                                    entry.get("enabled").and_then(|value| value.as_bool())
                                        == Some(false)
                                        && entry
                                            .get("path")
                                            .and_then(|value| value.as_str())
                                            .and_then(|value| {
                                                environment.configured_path(value, None)
                                            })
                                            .is_some_and(|path| {
                                                platform_path::equivalent(&path, &observation.path)
                                                    || platform_path::equivalent(
                                                        &path,
                                                        &observation.path.join("SKILL.md"),
                                                    )
                                            })
                                })
                            });
                        if disabled {
                            restricted += 1;
                            observation.diagnostics.push(
                                "Codex: this Skill is disabled by skills.config in config.toml"
                                    .into(),
                            );
                        }
                    }
                    Err(_) => observation.diagnostics.push(
                        "Codex: native enablement is unknown because config.toml could not be read"
                            .into(),
                    ),
                }
            }
            AgentKind::OpenClaw => {
                let path = environment.path(
                    "OPENCLAW_CONFIG_PATH",
                    environment.home_for(agent).join("openclaw.json"),
                );
                match read_json5(&path).and_then(|config| {
                    let disabled = config
                        .pointer("/skills/entries")
                        .and_then(|entries| entries.get(&observation.name))
                        .and_then(|entry| entry.get("enabled"))
                        .and_then(|value| value.as_bool())
                        == Some(false);
                    let filters = environment.openclaw_skill_filters(
                        &config,
                        project.map(|project| project.path.as_path()),
                    )?;
                    Ok((disabled, filters))
                }) {
                    Ok((disabled, filters)) => {
                        if disabled {
                            restricted += 1;
                            observation.diagnostics.push("OpenClaw: this Skill name is disabled by skills.entries in openclaw.json; metadata skillKey aliases may differ".into());
                        } else if filters.is_empty() {
                            restricted += 1;
                            observation.diagnostics.push("OpenClaw: this project has no configured native Agent workspace; its Skill files are not discoverable in an OpenClaw session".into());
                        } else {
                            let mut allowed = 0;
                            for filter in filters {
                                let id = &filter.agent_id;
                                let readable = filter.names.as_ref().is_none_or(|names| {
                                    names.iter().any(|name| name == &observation.name)
                                });
                                allowed += usize::from(readable);
                                observation.diagnostics.push(format!("OpenClaw Agent {id}: {} by its effective skills allowlist (per-Agent settings replace defaults)", if readable { "allowed" } else { "excluded" }));
                            }
                            if allowed == 0 {
                                restricted += 1;
                            }
                        }
                    }
                    Err(_) => {
                        openclaw_unknown = true;
                        observation.diagnostics.push("OpenClaw: native enablement is unknown because workspace or skills configuration could not be resolved".into());
                    }
                }
            }
            AgentKind::OpenCode => {
                let sources = opencode_skill_sources(
                    environment,
                    project.map(|project| project.path.as_path()),
                );
                opencode_unknown |= !sources.diagnostics.is_empty();
                observation.diagnostics.extend(sources.diagnostics);
                match opencode_permissions(
                    environment,
                    project.map(|project| project.path.as_path()),
                ) {
                    Ok(permission) => {
                        if let Some(action @ (OpenCodeAction::Deny | OpenCodeAction::Ask)) =
                            permission.skill_action(&observation.name)
                        {
                            if action == OpenCodeAction::Deny {
                                restricted += 1;
                            }
                            let action = if action == OpenCodeAction::Deny {
                                "deny"
                            } else {
                                "ask"
                            };
                            observation.diagnostics.push(format!(
                                "OpenCode: permission.skill is {action} for this Skill"
                            ));
                        }
                    }
                    Err(_) => {
                        opencode_unknown = true;
                        observation.diagnostics.push("OpenCode: native enablement is unknown because a configuration file could not be read or a configured override is not supported by static inspection".into());
                    }
                }
            }
            AgentKind::Hermes if observation.scope == SkillScope::Workspace => {
                if let Some(project) = project {
                    let conditions = environment.hermes_project_conditions(&project.path);
                    if !environment.hermes_project_root_matches(&project.path) {
                        restricted += 1;
                        observation.diagnostics.extend(conditions);
                        continue;
                    }
                    if conditions
                        .iter()
                        .any(|condition| condition.contains("is unknown"))
                    {
                        hermes_status = Some("unverified");
                    } else if conditions
                        .iter()
                        .all(|condition| condition.contains("not trusted"))
                    {
                        hermes_status = Some("pending-trust");
                    }
                    if conditions
                        .iter()
                        .all(|condition| !condition.contains("Git root is trusted"))
                    {
                        restricted += 1;
                    }
                    observation.diagnostics.extend(conditions);
                }
            }
            AgentKind::GrokBuild => {
                let home = environment.home_for(agent);
                let mut paths = vec![home.join("config.toml")];
                if let Some(project) = project {
                    paths.push(project.path.join(".grok/config.toml"));
                }
                let mut disabled = false;
                for path in paths {
                    match read_toml(&path) {
                        Ok(config) => {
                            if let Some(skills) = config.get("skills") {
                                if let Some(names) = skills.get("disabled").and_then(|value| value.as_array()) {
                                    disabled |= names.iter().any(|value| value.as_str() == Some(&observation.name));
                                }
                                if let Some(paths) = skills.get("ignore").and_then(|value| value.as_array()) {
                                    disabled |= paths.iter().filter_map(|value| value.as_str()).filter_map(|value| environment.configured_path(value, project.map(|workspace| workspace.path.as_path()))).any(|path| platform_path::starts_with(&observation.path, &path));
                                }
                            }
                            for (name, relative) in [("claude", ".claude"), ("cursor", ".cursor")] {
                                let root = project.map(|workspace| workspace.path.join(relative)).unwrap_or_else(|| environment.home.join(relative));
                                if observation.path.starts_with(&root) && config.get("compat").and_then(|value| value.get(name)).and_then(|value| value.get("skills")).and_then(|value| value.as_bool()) == Some(false) {
                                    disabled = true;
                                    observation.diagnostics.push(format!("Grok: compat.{name}.skills is disabled"));
                                }
                            }
                        }
                        Err(_) => observation.diagnostics.push("Grok: native enablement is unknown because config.toml could not be read".into()),
                    }
                }
                for (key, relative) in [
                    ("GROK_CLAUDE_SKILLS_ENABLED", ".claude"),
                    ("GROK_CURSOR_SKILLS_ENABLED", ".cursor"),
                ] {
                    let root = project
                        .map(|workspace| workspace.path.join(relative))
                        .unwrap_or_else(|| environment.home.join(relative));
                    if observation.path.starts_with(&root)
                        && environment.values.get(key).is_some_and(|value| {
                            matches!(value.to_ascii_lowercase().as_str(), "false" | "0")
                        })
                    {
                        disabled = true;
                        observation
                            .diagnostics
                            .push(format!("Grok: {key} disables this compatible location"));
                    }
                }
                if disabled {
                    restricted += 1;
                    observation.diagnostics.push("Grok: native skills.disabled, skills.ignore or compatibility settings restrict this Skill".into());
                }
            }
            _ => {}
        }
    }
    if observation.status == "observed" && restricted > 0 && restricted == observation.agents.len()
    {
        observation.status = "native-restricted".into();
    }
    if observation.agents == [AgentKind::Hermes]
        && matches!(
            observation.status.as_str(),
            "observed" | "native-restricted"
        )
        && let Some(status) = hermes_status
    {
        observation.status = status.into();
    }
    if observation.status == "observed"
        && ((observation.agents == [AgentKind::OpenCode] && opencode_unknown)
            || (observation.agents == [AgentKind::OpenClaw] && openclaw_unknown))
    {
        observation.status = "unverified".into();
    }
    observation.diagnostics.sort();
    observation.diagnostics.dedup();
}

// Permission objects are ordered rules. serde_json::Value's default map sorts
// keys, which changes OpenCode's last-matching-rule precedence.
struct OrderedPermissions<T>(Vec<(String, T)>);

impl<T> Default for OrderedPermissions<T> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for OrderedPermissions<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: Deserialize<'de>> de::Visitor<'de> for Visitor<T> {
            type Value = OrderedPermissions<T>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an ordered permission object")
            }

            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries: Vec<(String, T)> = Vec::new();
                let mut positions = HashMap::<String, usize>::new();
                while let Some((key, value)) = map.next_entry::<String, T>()? {
                    if let Some(&index) = positions.get(&key) {
                        entries[index].1 = value;
                    } else {
                        positions.insert(key.clone(), entries.len());
                        entries.push((key, value));
                    }
                }
                let mut ordered = OrderedPermissions(entries);
                ordered.order_native_keys();
                Ok(ordered)
            }
        }

        deserializer.deserialize_map(Visitor(std::marker::PhantomData))
    }
}

impl<T> OrderedPermissions<T> {
    fn order_native_keys(&mut self) {
        // Object.entries enumerates canonical array-index keys first, then
        // other keys in insertion order. 2^32 - 1 is not an array index.
        self.0.sort_by_cached_key(|(key, _)| {
            let index = key
                .parse::<u32>()
                .ok()
                .filter(|index| *index != u32::MAX && index.to_string() == key.as_str());
            match index {
                Some(index) => (false, index),
                None => (true, 0),
            }
        });
    }

    fn merge(&mut self, next: Self, merge_value: impl Fn(&mut T, T)) {
        let mut positions = self
            .0
            .iter()
            .enumerate()
            .map(|(index, (key, _))| (key.clone(), index))
            .collect::<HashMap<_, _>>();
        for (key, value) in next.0 {
            if let Some(&index) = positions.get(&key) {
                merge_value(&mut self.0[index].1, value);
            } else {
                positions.insert(key.clone(), self.0.len());
                self.0.push((key, value));
            }
        }
        self.order_native_keys();
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum OpenCodeAction {
    Allow,
    Ask,
    Deny,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OpenCodeRule {
    Action(OpenCodeAction),
    Patterns(OrderedPermissions<OpenCodeAction>),
}

#[derive(Default)]
struct OpenCodePermissions(OrderedPermissions<OpenCodeRule>);

impl<'de> Deserialize<'de> for OpenCodePermissions {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Input {
            Action(OpenCodeAction),
            Rules(OrderedPermissions<OpenCodeRule>),
        }
        Ok(Self(match Input::deserialize(deserializer)? {
            Input::Action(action) => {
                OrderedPermissions(vec![("*".into(), OpenCodeRule::Action(action))])
            }
            Input::Rules(rules) => rules,
        }))
    }
}

impl OpenCodePermissions {
    fn merge(&mut self, next: Self) {
        // OpenCode deep-merges config objects before evaluating permissions.
        // Replaced keys keep their insertion position; new keys append before
        // applying JavaScript's array-index enumeration order.
        self.0
            .merge(next.0, |existing, next| match (existing, next) {
                (OpenCodeRule::Patterns(existing), OpenCodeRule::Patterns(next)) => {
                    existing.merge(next, |existing, next| *existing = next);
                }
                (existing, next) => *existing = next,
            });
    }

    fn skill_action(&self, name: &str) -> Option<OpenCodeAction> {
        let mut action = None;
        for (tool, rule) in &self.0.0 {
            if !opencode_pattern_matches(tool, "skill") {
                continue;
            }
            match rule {
                OpenCodeRule::Action(value) => action = Some(*value),
                OpenCodeRule::Patterns(patterns) => {
                    for (pattern, value) in &patterns.0 {
                        if opencode_pattern_matches(pattern, name) {
                            action = Some(*value);
                        }
                    }
                }
            }
        }
        action
    }
}

fn opencode_pattern_matches(pattern: &str, name: &str) -> bool {
    let pattern = pattern.chars().collect::<Vec<_>>();
    let name = name.chars().collect::<Vec<_>>();
    let (mut pattern_index, mut name_index) = (0, 0);
    let mut star = None;
    let mut retry = 0;
    while name_index < name.len() {
        if pattern.get(pattern_index) == Some(&'*') {
            star = Some(pattern_index);
            pattern_index += 1;
            retry = name_index;
        } else if pattern.get(pattern_index).is_some_and(|character| {
            *character == '?'
                || *character == name[name_index]
                || (cfg!(windows) && character.eq_ignore_ascii_case(&name[name_index]))
        }) {
            pattern_index += 1;
            name_index += 1;
        } else if let Some(star) = star {
            retry += 1;
            name_index = retry;
            pattern_index = star + 1;
        } else {
            return false;
        }
    }
    while pattern.get(pattern_index) == Some(&'*') {
        pattern_index += 1;
    }
    // OpenCode also makes a final space-plus-star optional, for all permissions.
    pattern_index == pattern.len() || pattern[pattern_index..] == [' ', '*']
}

#[derive(Deserialize)]
struct OpenCodeConfig {
    #[serde(default)]
    permission: OpenCodePermissions,
    tools: Option<serde_json::Value>,
    agent: Option<serde_json::Value>,
    mode: Option<serde_json::Value>,
    remote_config: Option<serde_json::Value>,
}

fn parse_opencode_permissions(text: &str) -> anyhow::Result<OpenCodePermissions> {
    anyhow::ensure!(text.len() <= 1024 * 1024, "Configuration exceeds 1 MiB");
    // Native substitution can read arbitrary files or depend on a session's env.
    // Do not execute it, or mistake unresolved expressions for literal rules.
    anyhow::ensure!(
        !text.contains("{env:") && !text.contains("{file:"),
        "Configuration substitution is not statically verified"
    );
    let config: OpenCodeConfig = json5::from_str(text)?;
    anyhow::ensure!(
        config.remote_config.is_none(),
        "Remote configuration is not statically verified"
    );
    anyhow::ensure!(
        config
            .tools
            .as_ref()
            .and_then(|tools| tools.get("skill"))
            .is_none(),
        "Legacy tool permissions are not statically verified"
    );
    for agents in [config.agent, config.mode].into_iter().flatten() {
        anyhow::ensure!(
            !agents.as_object().is_some_and(|agents| agents
                .values()
                .any(|agent| agent.get("permission").is_some() || agent.get("tools").is_some())),
            "Agent-specific permissions require a selected native Agent"
        );
    }
    Ok(config.permission)
}

fn read_opencode_config(path: &Path) -> anyhow::Result<Option<String>> {
    anyhow::ensure!(path.is_absolute(), "Configuration path must be absolute");
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut text = String::new();
    file.take(1024 * 1024 + 1).read_to_string(&mut text)?;
    anyhow::ensure!(text.len() <= 1024 * 1024, "Configuration exceeds 1 MiB");
    Ok(Some(text))
}

fn opencode_absolute_path(value: &Path, project: Option<&Path>) -> Option<PathBuf> {
    let path = if value.is_absolute() {
        value.to_path_buf()
    } else {
        project?.join(value)
    };
    if !path.is_absolute() {
        return None;
    }
    // Node's path.join/resolve normalizes parent components before filesystem
    // access. Resolve aliases later, retaining native lexical path semantics.
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized)
}

struct OpenCodeConfigLayers {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    diagnostics: Vec<String>,
}

// Both permissions and Skill sources use the same native layer order. Keeping
// directories separate also exposes read-only roots that are not write targets.
fn opencode_config_layers(
    environment: &TargetEnvironment,
    project: Option<&Path>,
) -> OpenCodeConfigLayers {
    let home = environment.home_for(AgentKind::OpenCode);
    let mut diagnostics = Vec::new();
    if home.join("config").exists() {
        diagnostics.push("OpenCode: legacy TOML configuration requires native migration".into());
    }
    let mut paths = vec![
        home.join("config.json"),
        home.join("opencode.json"),
        home.join("opencode.jsonc"),
    ];
    let mut resolve = |key: &str| -> Option<PathBuf> {
        let value = environment
            .values
            .get(key)
            .filter(|value| !value.is_empty())?;
        let path = opencode_absolute_path(Path::new(value), project);
        if path.is_none() {
            diagnostics.push(format!("OpenCode: {key} needs a known session directory"));
        }
        path
    };
    if let Some(path) = resolve("OPENCODE_CONFIG") {
        paths.push(path);
    }
    let config_directory = resolve("OPENCODE_CONFIG_DIR");
    let mut ancestors = Vec::new();
    if !environment.opencode_flag("OPENCODE_DISABLE_PROJECT_CONFIG")
        && let Some(project) = project
    {
        for root in project.ancestors() {
            ancestors.push(root);
            if root.join(".git").exists() {
                break;
            }
        }
        for root in ancestors.iter().rev() {
            paths.extend([root.join("opencode.json"), root.join("opencode.jsonc")]);
        }
    }
    // Native deduplicates raw directory strings. An explicit spelling such as
    // /config/opencode/../opencode must retain its final override position even
    // when filesystem access resolves it to an earlier directory.
    let mut directories = vec![home];
    directories.extend(ancestors.iter().map(|root| root.join(".opencode")));
    directories.push(environment.home.join(".opencode"));
    let mut directories = directories
        .into_iter()
        .map(|path| (path.display().to_string(), path))
        .collect::<Vec<_>>();
    let configured_key = environment
        .values
        .get("OPENCODE_CONFIG_DIR")
        .filter(|value| !value.is_empty());
    if let (Some(path), Some(key)) = (config_directory, configured_key) {
        directories.push((key.clone(), path));
    }
    let mut seen = BTreeSet::new();
    directories.retain(|(key, _)| seen.insert(key.clone()));
    for (key, directory) in &directories {
        if key.ends_with(".opencode") || configured_key == Some(key) {
            paths.extend([
                directory.join("opencode.json"),
                directory.join("opencode.jsonc"),
            ]);
        }
    }
    let directories = directories.into_iter().map(|(_, path)| path).collect();
    OpenCodeConfigLayers {
        files: paths,
        directories,
        diagnostics,
    }
}

pub(crate) struct OpenCodeSkillSources {
    pub roots: Vec<PathBuf>,
    pub diagnostics: Vec<String>,
}

pub(crate) fn opencode_skill_sources(
    environment: &TargetEnvironment,
    project: Option<&Path>,
) -> OpenCodeSkillSources {
    let layers = opencode_config_layers(environment, project);
    let mut result = OpenCodeSkillSources {
        roots: layers
            .directories
            .iter()
            .flat_map(|directory| [directory.join("skill"), directory.join("skills")])
            .collect(),
        diagnostics: layers.diagnostics,
    };
    let mut configured = Vec::new();
    let mut merge = |text: &str, label: &str| {
        let parsed = (|| -> anyhow::Result<Option<Vec<String>>> {
            anyhow::ensure!(text.len() <= 1024 * 1024, "Configuration exceeds 1 MiB");
            anyhow::ensure!(
                !text.contains("{env:") && !text.contains("{file:"),
                "Configuration substitution is not statically verified"
            );
            let config: serde_json::Value = json5::from_str(text)?;
            anyhow::ensure!(config.is_object(), "Configuration must be an object");
            anyhow::ensure!(
                config.get("remote_config").is_none(),
                "Remote configuration is not inspected"
            );
            let Some(skills) = config.get("skills") else {
                return Ok(None);
            };
            anyhow::ensure!(skills.is_object(), "skills must be an object");
            if skills
                .get("urls")
                .is_some_and(|urls| urls.as_array().is_none_or(|urls| !urls.is_empty()))
            {
                result.diagnostics.push(format!(
                    "OpenCode: remote Skill sources in {label} are not inspected"
                ));
            }
            skills
                .get("paths")
                .map(|paths| {
                    serde_json::from_value::<Vec<String>>(paths.clone()).map_err(Into::into)
                })
                .transpose()
        })();
        match parsed {
            // Native deep merge replaces arrays rather than concatenating paths.
            Ok(Some(paths)) => configured = paths,
            Ok(None) => {}
            Err(_) => result.diagnostics.push(format!("OpenCode: Skill sources are unverified because configuration {label} could not be inspected")),
        }
    };
    for path in layers.files {
        match read_opencode_config(&path) {
            Ok(Some(text)) => merge(&text, &path.display().to_string()),
            Ok(None) => {}
            Err(_) => merge("", &path.display().to_string()),
        }
    }
    if let Some(text) = environment
        .values
        .get("OPENCODE_CONFIG_CONTENT")
        .filter(|value| !value.is_empty())
    {
        merge(text, "OPENCODE_CONFIG_CONTENT");
    }
    for value in configured {
        // Relative paths are relative to the native session directory, including
        // when they originate in a personal config file. Do not guess our cwd.
        let path = if let Some(suffix) = value.strip_prefix("~/") {
            opencode_absolute_path(&environment.home.join(suffix), None)
        } else {
            opencode_absolute_path(Path::new(&value), project)
        };
        if let Some(path) = path.filter(|path| path.is_absolute()) {
            result.roots.push(path);
        } else {
            result
                .diagnostics
                .push("OpenCode: relative skills.paths require a known session directory".into());
        }
    }
    result.roots.sort();
    result.roots.dedup();
    result.diagnostics.sort();
    result.diagnostics.dedup();
    result
}

fn opencode_permissions(
    environment: &TargetEnvironment,
    project: Option<&Path>,
) -> anyhow::Result<OpenCodePermissions> {
    let layers = opencode_config_layers(environment, project);
    anyhow::ensure!(
        layers.diagnostics.is_empty(),
        "Native configuration layers are not statically verified"
    );
    let mut permission = OpenCodePermissions::default();
    for path in layers.files {
        if let Some(text) = read_opencode_config(&path)? {
            permission.merge(parse_opencode_permissions(&text)?);
        }
    }
    if let Some(content) = environment
        .values
        .get("OPENCODE_CONFIG_CONTENT")
        .filter(|value| !value.is_empty())
    {
        permission.merge(parse_opencode_permissions(content)?);
    }
    if let Some(content) = environment
        .values
        .get("OPENCODE_PERMISSION")
        .filter(|value| !value.is_empty())
    {
        anyhow::ensure!(
            content.len() <= 1024 * 1024,
            "Permission configuration exceeds 1 MiB"
        );
        permission.merge(serde_json::from_str::<OpenCodePermissions>(content)?);
    }
    Ok(permission)
}

fn read_toml(path: &Path) -> anyhow::Result<toml::Value> {
    anyhow::ensure!(path.is_absolute(), "Configuration path must be absolute");
    if !path.exists() {
        return Ok(toml::Value::Table(Default::default()));
    }
    let mut text = String::new();
    fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_string(&mut text)?;
    anyhow::ensure!(text.len() <= 1024 * 1024, "Configuration exceeds 1 MiB");
    Ok(toml::from_str(&text)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn opencode_sources_follow_permission_layers_and_replace_path_arrays() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("repo");
        let nested = project.join("packages/app");
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        let custom = temp.path().join("custom.json");
        let explicit = temp.path().join("explicit");
        let mut environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let mut previous = None;
        for (file, key, value, label) in [
            (
                home.join(".config/opencode/config.json"),
                None,
                None,
                "global",
            ),
            (
                custom.clone(),
                Some("OPENCODE_CONFIG"),
                Some(custom.clone()),
                "custom",
            ),
            (project.join("opencode.jsonc"), None, None, "project"),
            (nested.join("opencode.json"), None, None, "nested"),
            (
                nested.join(".opencode/opencode.json"),
                None,
                None,
                "nested-native",
            ),
            (
                project.join(".opencode/opencode.jsonc"),
                None,
                None,
                "project-native",
            ),
            (
                home.join(".opencode/opencode.json"),
                None,
                None,
                "home-native",
            ),
            (
                explicit.join("opencode.json"),
                Some("OPENCODE_CONFIG_DIR"),
                Some(explicit.clone()),
                "explicit",
            ),
        ] {
            let path = format!("resources/{label}");
            write_config(
                &file,
                &serde_json::json!({"skills":{"paths":[path]}}).to_string(),
            );
            if let (Some(key), Some(value)) = (key, value) {
                environment
                    .values
                    .insert(key.into(), value.display().to_string());
            }
            let sources = opencode_skill_sources(&environment, Some(&nested));
            assert!(sources.diagnostics.is_empty(), "{:?}", sources.diagnostics);
            assert!(sources.roots.contains(&nested.join(&path)));
            if let Some(previous) = previous {
                assert!(!sources.roots.contains(&previous));
            }
            previous = Some(nested.join(path));
        }
        environment.values.insert(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"skills":{"paths":["~/shared", "local"]}}"#.into(),
        );
        let sources = opencode_skill_sources(&environment, Some(&nested));
        assert!(sources.roots.contains(&home.join("shared")));
        assert!(sources.roots.contains(&nested.join("local")));
        assert!(!sources.roots.contains(&previous.unwrap()));
        environment
            .values
            .insert("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "true".into());
        let sources = opencode_skill_sources(&environment, Some(&nested));
        assert!(!sources.roots.contains(&project.join(".opencode/skills")));
        assert!(!sources.roots.contains(&nested.join(".opencode/skills")));
        assert!(sources.roots.contains(&home.join(".opencode/skills")));
        assert!(sources.roots.contains(&explicit.join("skill")));
        assert!(sources.roots.contains(&nested.join("local")));
        environment.values.insert(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"skills":{"paths":[]}}"#.into(),
        );
        assert!(
            !opencode_skill_sources(&environment, Some(&nested))
                .roots
                .contains(&nested.join("local"))
        );
    }

    #[test]
    fn opencode_source_directory_deduplication_preserves_first_layer_position() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("repo");
        fs::create_dir_all(project.join(".git")).unwrap();
        write_config(
            &project.join(".opencode/opencode.json"),
            r#"{"skills":{"paths":["project-source"]}}"#,
        );
        write_config(
            &home.join(".opencode/opencode.json"),
            r#"{"skills":{"paths":["home-source"]}}"#,
        );
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::from([(
                "OPENCODE_CONFIG_DIR".into(),
                project.join(".opencode").display().to_string(),
            )]),
        };
        let sources = opencode_skill_sources(&environment, Some(&project));
        assert!(sources.roots.contains(&project.join("home-source")));
        assert!(!sources.roots.contains(&project.join("project-source")));
    }

    #[test]
    fn opencode_explicit_directory_spelling_keeps_its_override_position() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        // The first case must use the same raw spelling as the native default.
        // A joined ".config/opencode" retains mixed separators on Windows and
        // is intentionally a distinct override key despite resolving identically.
        let global = home.join(".config").join("opencode");
        write_config(
            &global.join("opencode.json"),
            r#"{"skills":{"paths":["global-source"]},"permission":{"skill":"allow"}}"#,
        );
        write_config(
            &home.join(".opencode/opencode.json"),
            r#"{"skills":{"paths":["home-source"]},"permission":{"skill":"deny"}}"#,
        );
        let spellings = [
            (
                global.display().to_string(),
                "home-source",
                OpenCodeAction::Deny,
            ),
            (
                global.join("../opencode").display().to_string(),
                "global-source",
                OpenCodeAction::Allow,
            ),
            (
                format!("{}/", global.display()),
                "global-source",
                OpenCodeAction::Allow,
            ),
        ];
        let alternate_separators = cfg!(windows).then(|| {
            (
                global.display().to_string().replace('\\', "/"),
                "global-source",
                OpenCodeAction::Allow,
            )
        });
        for (spelling, expected, action) in spellings.into_iter().chain(alternate_separators) {
            let environment = TargetEnvironment {
                home: home.clone(),
                values: BTreeMap::from([("OPENCODE_CONFIG_DIR".into(), spelling.clone())]),
            };
            let sources = opencode_skill_sources(&environment, Some(&project));
            assert!(sources.diagnostics.is_empty());
            assert!(
                sources.roots.contains(&project.join(expected)),
                "{spelling}"
            );
            assert_eq!(
                opencode_permissions(&environment, Some(&project))
                    .unwrap()
                    .skill_action("example"),
                Some(action),
                "{spelling}"
            );
        }
    }

    #[test]
    fn opencode_relative_configuration_uses_the_session_directory_without_shell_expansion() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("repo");
        fs::create_dir_all(project.join(".git")).unwrap();
        write_config(
            &project.join("~/config/opencode.json"),
            r#"{"skills":{"paths":["~/shared","nested/../relative"]}}"#,
        );
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([("OPENCODE_CONFIG_DIR".into(), "~/config".into())]),
        };
        let sources = opencode_skill_sources(&environment, Some(&project));
        assert!(sources.diagnostics.is_empty());
        assert!(sources.roots.contains(&project.join("~/config/skills")));
        assert!(sources.roots.contains(&home.join("shared")));
        assert!(sources.roots.contains(&project.join("relative")));
        assert!(
            !opencode_skill_sources(&environment, None)
                .diagnostics
                .is_empty()
        );
    }

    fn inspect_opencode(
        name: &str,
        global_json: Option<&str>,
        global_jsonc: Option<&str>,
        project_json: Option<&str>,
        project_jsonc: Option<&str>,
    ) -> SkillObservation {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let config = home.join(".config/opencode");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&project).unwrap();
        for (path, content) in [
            (config.join("opencode.json"), global_json),
            (config.join("opencode.jsonc"), global_jsonc),
            (project.join("opencode.json"), project_json),
            (project.join("opencode.jsonc"), project_jsonc),
        ] {
            if let Some(content) = content {
                fs::write(path, content).unwrap();
            }
        }
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.clone(),
        }];
        let mut observation = SkillObservation {
            id: "skill".into(),
            name: name.into(),
            path: project.join(".opencode/skills").join(name),
            resolved_path: None,
            scope: SkillScope::Workspace,
            workspace_id: Some("project".into()),
            agents: vec![AgentKind::OpenCode],
            kind: "directory".into(),
            status: "observed".into(),
            owner: "external".into(),
            library_id: None,
            diagnostics: Vec::new(),
        };
        annotate(&mut observation, &workspaces, &environment);
        observation
    }

    #[test]
    fn opencode_uses_the_last_matching_rule_in_source_order() {
        for (rules, restricted) in [
            (r#"{"*":"allow","internal-*":"deny"}"#, true),
            (r#"{"internal-foo":"allow","*":"deny"}"#, true),
            (r#"{"*":"deny","internal-*":"allow"}"#, false),
            (r#"{"internal-*":"deny","internal-foo":"allow"}"#, false),
            (r#"{"internal-foo":"allow","internal-*":"deny"}"#, true),
            (r#"{"*":"allow","internal-???":"deny"}"#, true),
            (r#"{"*":"allow","internal-??":"deny"}"#, false),
            // Repeated keys replace their value, retaining their first insertion position.
            (r#"{"*":"deny","internal-*":"deny","*":"allow"}"#, true),
        ] {
            let config = format!(r#"{{"permission":{{"skill":{rules}}}}}"#);
            let observed = inspect_opencode("internal-foo", Some(&config), None, None, None);
            assert_eq!(
                observed.status,
                if restricted {
                    "native-restricted"
                } else {
                    "observed"
                },
                "{rules}: {:?}",
                observed.diagnostics
            );
        }
    }

    #[test]
    fn opencode_array_index_rules_follow_native_object_enumeration() {
        let rules: OrderedPermissions<OpenCodeAction> = json5::from_str(
            r#"{"*":"allow","10":"deny","2":"deny","0":"deny",
                "4294967294":"deny","00":"deny","01":"deny","-0":"deny",
                "+1":"deny","1.0":"deny","1e0":"deny","4294967295":"deny"}"#,
        )
        .unwrap();
        assert_eq!(
            rules
                .0
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            [
                "0",
                "2",
                "10",
                "4294967294",
                "*",
                "00",
                "01",
                "-0",
                "+1",
                "1.0",
                "1e0",
                "4294967295"
            ]
        );
        for (name, array_index) in [
            ("0", true),
            ("123", true),
            ("4294967294", true),
            ("00", false),
            ("01", false),
            ("4294967295", false),
            ("4294967296", false),
        ] {
            for (fallback, specific) in [("allow", "deny"), ("deny", "allow")] {
                let config = format!(
                    r#"{{"permission":{{"skill":{{"*":"{fallback}","{name}":"{specific}"}}}}}}"#
                );
                let observed = inspect_opencode(name, Some(&config), None, None, None);
                let action = if array_index { fallback } else { specific };
                assert_eq!(
                    observed.status,
                    if action == "deny" {
                        "native-restricted"
                    } else {
                        "observed"
                    },
                    "{config}"
                );
            }
        }
    }

    #[test]
    fn opencode_merging_keeps_array_indices_before_existing_string_rules() {
        for (name, global, project, expected) in [
            (
                "123",
                r#"{"*":"deny"}"#,
                r#"{"123":"allow"}"#,
                "native-restricted",
            ),
            (
                "123",
                r#"{"*":"allow","123":"deny"}"#,
                r#"{"123":"deny"}"#,
                "observed",
            ),
            ("01", r#"{"*":"deny"}"#, r#"{"01":"allow"}"#, "observed"),
            (
                "01",
                r#"{"01":"deny","*":"deny"}"#,
                r#"{"01":"allow"}"#,
                "native-restricted",
            ),
        ] {
            let global = format!(r#"{{"permission":{{"skill":{global}}}}}"#);
            let project = format!(r#"{{"permission":{{"skill":{project}}}}}"#);
            let observed = inspect_opencode(name, Some(&global), None, Some(&project), None);
            assert_eq!(observed.status, expected, "{global} + {project}");
        }
    }

    #[test]
    fn opencode_trailing_space_and_star_are_optional() {
        for (pattern, name, expected) in [
            ("internal *", "internal", true),
            ("internal *", "internal ", true),
            ("internal *", "internal details", true),
            ("internal *", "internal-extra", false),
            ("internal* *", "internal-extra", true),
            ("internal * *", "internal", false),
            ("internal * *", "internal details", true),
            ("internal  *", "internal", false),
            ("internal **", "internal", false),
        ] {
            assert_eq!(
                opencode_pattern_matches(pattern, name),
                expected,
                "{pattern}: {name}"
            );
        }
        let observed = inspect_opencode(
            "internal",
            Some(r#"{"permission":{"skill":{"*":"allow","internal *":"deny"}}}"#),
            None,
            None,
            None,
        );
        assert_eq!(observed.status, "native-restricted");
        let observed = inspect_opencode(
            "internal",
            Some(r#"{"permission":{"*":"allow","skill *":"deny"}}"#),
            None,
            None,
            None,
        );
        assert_eq!(observed.status, "native-restricted");
    }

    #[test]
    fn opencode_patterns_match_wildcards_and_literal_characters() {
        for (pattern, name, matches) in [
            ("internal-*", "internal-foo", true),
            ("internal-*", "internal-", true),
            ("internal-?", "internal-a", true),
            ("internal-?", "internal-ab", false),
            ("internal-?", "internal-", false),
            ("*review*foo", "review-a-foo", true),
            ("*review*foo", "review-a-bar", false),
            ("[ab]", "a", false),
            ("[ab]", "[ab]", true),
            ("a.b", "axb", false),
            ("a.b", "a.b", true),
            ("**", "", true),
        ] {
            assert_eq!(
                opencode_pattern_matches(pattern, name),
                matches,
                "{pattern}: {name}"
            );
        }
    }

    #[test]
    fn opencode_merges_global_and_project_patterns_before_matching() {
        for (global, project, expected) in [
            // Unrelated project rules cannot discard a global restriction.
            (
                r#"{"*":"allow","internal-*":"deny"}"#,
                r#"{"other-*":"allow"}"#,
                "native-restricted",
            ),
            (
                r#"{"*":"allow","internal-*":"deny"}"#,
                r#"{"internal-foo":"allow"}"#,
                "observed",
            ),
            // Overwriting a key does not move it after later global rules.
            (
                r#"{"*":"deny","internal-*":"deny"}"#,
                r#"{"*":"allow"}"#,
                "native-restricted",
            ),
            (
                r#"{"internal-*":"deny","*":"deny"}"#,
                r#"{"internal-*":"allow"}"#,
                "native-restricted",
            ),
            (r#"{"*":"deny"}"#, r#""allow""#, "observed"),
            (
                r#""allow""#,
                r#"{"internal-*":"deny"}"#,
                "native-restricted",
            ),
        ] {
            let global = format!(r#"{{"permission":{{"skill":{global}}}}}"#);
            let project = format!(r#"{{"permission":{{"skill":{project}}}}}"#);
            let observed =
                inspect_opencode("internal-foo", Some(&global), None, Some(&project), None);
            assert_eq!(observed.status, expected, "{global} + {project}");
        }
    }

    #[test]
    fn opencode_jsonc_and_project_overrides_keep_permission_order() {
        let global = r#"{"permission":{"skill":{"*":"allow","internal-*":"deny"}}}"#;
        let global_jsonc = r#"{
            // JSONC overrides a shared key without sorting or dropping the other patterns.
            "permission": {"skill": {"internal-*": "ask",}},
        }"#;
        let observed =
            inspect_opencode("internal-foo", Some(global), Some(global_jsonc), None, None);
        assert_eq!(observed.status, "observed");
        assert!(
            observed
                .diagnostics
                .iter()
                .any(|message| message.contains("permission.skill is ask"))
        );
        let observed = inspect_opencode(
            "internal-foo",
            Some(global),
            Some(global_jsonc),
            Some(r#"{"permission":{"skill":{"internal-foo":"allow"}}}"#),
            Some(r#"{"permission":{"skill":{"internal-foo":"deny",}}}"#),
        );
        assert_eq!(observed.status, "native-restricted");
    }

    #[test]
    fn opencode_tool_defaults_obey_the_same_order_and_merge_rules() {
        let observed = inspect_opencode(
            "internal-foo",
            Some(r#"{"permission":"deny"}"#),
            None,
            Some(r#"{"permission":{"skill":{"internal-*":"allow"}}}"#),
            None,
        );
        assert_eq!(observed.status, "observed");
        let observed = inspect_opencode(
            "external-foo",
            Some(r#"{"permission":"deny"}"#),
            None,
            Some(r#"{"permission":{"skill":{"internal-*":"allow"}}}"#),
            None,
        );
        assert_eq!(observed.status, "native-restricted");
        let observed = inspect_opencode(
            "internal-foo",
            Some(r#"{"permission":{"skill":"allow","*":"deny"}}"#),
            None,
            None,
            None,
        );
        assert_eq!(observed.status, "native-restricted");
    }

    #[test]
    fn malformed_opencode_configuration_does_not_reuse_a_partial_permission_result() {
        for malformed in [
            "{",
            r#"{"permission":null}"#,
            r#"{"permission":{"skill":{"*":42}}}"#,
            r#"{"permission":{"skill":"approve"}}"#,
            r#"{"permission":{"skill":["allow"]}}"#,
        ] {
            for known in ["allow", "deny"] {
                let global = format!(r#"{{"permission":{{"skill":"{known}"}}}}"#);
                let observed =
                    inspect_opencode("internal-foo", Some(&global), None, Some(malformed), None);
                assert_eq!(observed.status, "unverified", "{malformed}");
                assert!(
                    observed
                        .diagnostics
                        .iter()
                        .any(|message| { message.contains("native enablement is unknown") })
                );
                assert!(
                    !observed
                        .diagnostics
                        .iter()
                        .any(|message| { message.contains("permission.skill is") })
                );
            }
        }
    }

    #[test]
    fn arbitrary_project_skill_directory_is_not_reported_as_openclaw_discoverable() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join("skills/example")).unwrap();
        fs::create_dir_all(home.join(".openclaw")).unwrap();
        fs::write(
            project.join("skills/example/SKILL.md"),
            "---\nname: example\ndescription: Fixture\n---\nBody",
        )
        .unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.clone(),
        }];
        let inspect = || {
            crate::inventory::inventory_with_environment(&workspaces, &environment)
                .unwrap()
                .observations
                .into_iter()
                .find(|item| item.path == project.join("skills/example"))
                .unwrap()
        };
        assert_eq!(inspect().status, "native-restricted");
        fs::write(
            home.join(".openclaw/openclaw.json"),
            serde_json::json!({"agents": {"defaults": {"workspace": project}}}).to_string(),
        )
        .unwrap();
        assert_eq!(inspect().status, "observed");
    }

    fn inspect_native(
        environment: &TargetEnvironment,
        project: &Path,
        agent: AgentKind,
    ) -> SkillObservation {
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.to_path_buf(),
        }];
        let mut observation = SkillObservation {
            id: "skill".into(),
            name: "reviewer".into(),
            path: project.join("skills/reviewer"),
            resolved_path: None,
            scope: SkillScope::Workspace,
            workspace_id: Some("project".into()),
            agents: vec![agent],
            kind: "directory".into(),
            status: "observed".into(),
            owner: "external".into(),
            library_id: None,
            diagnostics: Vec::new(),
        };
        annotate(&mut observation, &workspaces, environment);
        observation
    }

    #[test]
    fn opencode_disabled_compatibility_is_diagnosed_per_agent_before_permission_checks() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS".into(), "1".into())]),
        };
        // A source that native skips must not acquire an unrelated permission
        // parsing warning from a configuration it will never use for this Skill.
        write_config(&home.join(".config/opencode/opencode.json"), "invalid");
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.clone(),
        }];
        for agents in [
            vec![AgentKind::OpenCode],
            vec![AgentKind::OpenCode, AgentKind::ClaudeCode],
        ] {
            let mut observation = SkillObservation {
                id: "skill".into(),
                name: "reviewer".into(),
                path: project.join(".claude/skills/reviewer"),
                resolved_path: None,
                scope: SkillScope::Workspace,
                workspace_id: Some("project".into()),
                agents: agents.clone(),
                kind: "directory".into(),
                status: "observed".into(),
                owner: "external".into(),
                library_id: None,
                diagnostics: Vec::new(),
            };
            annotate(&mut observation, &workspaces, &environment);
            assert!(!observation.agents.contains(&AgentKind::OpenCode));
            assert_eq!(
                observation.agents.contains(&AgentKind::ClaudeCode),
                agents.len() == 2
            );
            assert_eq!(
                observation.status,
                if agents.len() == 1 {
                    "native-restricted"
                } else {
                    "observed"
                }
            );
            assert!(
                observation
                    .diagnostics
                    .iter()
                    .any(|reason| reason.contains("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"))
            );
            assert!(
                !observation
                    .diagnostics
                    .iter()
                    .any(|reason| reason.contains("configuration file could not be read"))
            );
        }
    }

    fn write_config(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn opencode_resolves_native_configuration_layers_and_environment_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("repo");
        fs::create_dir_all(project.join(".git")).unwrap();
        let mut environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let global = home.join(".config/opencode");
        let custom = temp.path().join("custom.json");
        let config_dir = temp.path().join("config-dir");
        let allow = r#"{"permission":{"skill":"allow"}}"#;
        let deny = r#"{"permission":{"skill":"deny"}}"#;
        for (path, content, key, value, expected) in [
            (
                global.join("config.json"),
                deny,
                None,
                None,
                "native-restricted",
            ),
            (
                custom.clone(),
                allow,
                Some("OPENCODE_CONFIG"),
                Some(custom.clone()),
                "observed",
            ),
            (
                project.join("opencode.json"),
                deny,
                None,
                None,
                "native-restricted",
            ),
            (
                project.join(".opencode/opencode.jsonc"),
                allow,
                None,
                None,
                "observed",
            ),
            (
                home.join(".opencode/opencode.json"),
                deny,
                None,
                None,
                "native-restricted",
            ),
            (
                config_dir.join("opencode.json"),
                allow,
                Some("OPENCODE_CONFIG_DIR"),
                Some(config_dir),
                "observed",
            ),
        ] {
            write_config(&path, content);
            if let (Some(key), Some(value)) = (key, value) {
                environment
                    .values
                    .insert(key.into(), value.display().to_string());
            }
            assert_eq!(
                inspect_native(&environment, &project, AgentKind::OpenCode).status,
                expected,
                "{}",
                path.display()
            );
        }
        environment
            .values
            .insert("OPENCODE_CONFIG_CONTENT".into(), deny.into());
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::OpenCode).status,
            "native-restricted"
        );
        environment
            .values
            .insert("OPENCODE_PERMISSION".into(), r#"{"skill":"allow"}"#.into());
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::OpenCode).status,
            "observed"
        );
    }

    #[test]
    fn opencode_project_disable_skips_project_chain_but_keeps_home_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        let nested = project.join("packages/client");
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        let home = temp.path().join("home");
        let mut environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let allow = r#"{"permission":{"skill":"allow"}}"#;
        let deny = r#"{"permission":{"skill":"deny"}}"#;
        write_config(&project.join("opencode.json"), deny);
        write_config(&nested.join("opencode.json"), allow);
        assert_eq!(
            inspect_native(&environment, &nested, AgentKind::OpenCode).status,
            "observed"
        );
        write_config(&nested.join(".opencode/opencode.json"), allow);
        write_config(&project.join(".opencode/opencode.json"), deny);
        assert_eq!(
            inspect_native(&environment, &nested, AgentKind::OpenCode).status,
            "native-restricted"
        );
        environment
            .values
            .insert("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "true".into());
        assert_eq!(
            inspect_native(&environment, &nested, AgentKind::OpenCode).status,
            "observed"
        );
        write_config(&home.join(".opencode/opencode.jsonc"), deny);
        assert_eq!(
            inspect_native(&environment, &nested, AgentKind::OpenCode).status,
            "native-restricted"
        );
    }

    #[test]
    fn opencode_unknown_explicit_configuration_does_not_claim_an_allow_or_deny() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        fs::create_dir_all(project.join(".git")).unwrap();
        let mut environment = TargetEnvironment {
            home: temp.path().join("home"),
            values: BTreeMap::new(),
        };
        write_config(
            &environment
                .home_for(AgentKind::OpenCode)
                .join("config.json"),
            r#"{"permission":{"skill":"deny"}}"#,
        );
        for content in [
            "{",
            r#"{"permission":{"skill":"{env:SKILL_PERMISSION}"}}"#,
            r#"{"agent":{"build":{"permission":{"skill":"deny"}}}}"#,
            r#"{"remote_config":{"url":"https://example.invalid/config"}}"#,
            r#"{"tools":{"skill":false}}"#,
        ] {
            environment
                .values
                .insert("OPENCODE_CONFIG_CONTENT".into(), content.into());
            assert_eq!(
                inspect_native(&environment, &project, AgentKind::OpenCode).status,
                "unverified",
                "{content}"
            );
        }
        environment.values.insert(
            "OPENCODE_CONFIG_CONTENT".into(),
            "x".repeat(1024 * 1024 + 1),
        );
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::OpenCode).status,
            "unverified"
        );
        environment.values.remove("OPENCODE_CONFIG_CONTENT");
        environment
            .values
            .insert("OPENCODE_PERMISSION".into(), "{".into());
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::OpenCode).status,
            "unverified"
        );
    }

    #[test]
    fn openclaw_agent_allowlists_inherit_replace_and_combine_only_matching_workspaces() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        let other = temp.path().join("other");
        let environment = TargetEnvironment {
            home: temp.path().join("home"),
            values: BTreeMap::new(),
        };
        let config_path = environment
            .home_for(AgentKind::OpenClaw)
            .join("openclaw.json");
        for (defaults, entries, expected) in [
            (
                serde_json::json!({}),
                serde_json::json!({"writer":{"workspace":project}}),
                "observed",
            ),
            (
                serde_json::json!({"skills":[]}),
                serde_json::json!({"writer":{"workspace":project}}),
                "native-restricted",
            ),
            (
                serde_json::json!({"skills":["reviewer"]}),
                serde_json::json!({"writer":{"workspace":project,"skills":[]}}),
                "native-restricted",
            ),
            (
                serde_json::json!({"skills":[]}),
                serde_json::json!({"writer":{"workspace":project,"skills":["reviewer"]}}),
                "observed",
            ),
            (
                serde_json::json!({"skills":[]}),
                serde_json::json!({"reader":{"workspace":project},"writer":{"workspace":project,"skills":["reviewer"]}}),
                "observed",
            ),
            (
                serde_json::json!({"skills":[]}),
                serde_json::json!({"reader":{"workspace":project},"writer":{"workspace":other,"skills":["reviewer"]}}),
                "native-restricted",
            ),
            (
                serde_json::json!({"skills":"reviewer"}),
                serde_json::json!({"writer":{"workspace":project}}),
                "unverified",
            ),
        ] {
            let config = serde_json::json!({"agents":{"defaults":defaults,"entries":entries}});
            write_config(&config_path, &config.to_string());
            let observed = inspect_native(&environment, &project, AgentKind::OpenClaw);
            assert_eq!(
                observed.status, expected,
                "{config}: {:?}",
                observed.diagnostics
            );
            if config.pointer("/agents/entries/reader").is_some() && expected == "observed" {
                assert!(
                    observed
                        .diagnostics
                        .iter()
                        .any(|line| line.contains("Agent reader: excluded"))
                );
                assert!(
                    observed
                        .diagnostics
                        .iter()
                        .any(|line| line.contains("Agent writer: allowed"))
                );
            }
        }
        let config = serde_json::json!({"agents":{"defaults":{"skills":[],"workspace":project},"list":[{"id":"writer","workspace":project,"skills":["reviewer"]}]}});
        write_config(&config_path, &config.to_string());
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::OpenClaw).status,
            "observed"
        );
        let config = serde_json::json!({"agents":{"defaults":{"skills":["reviewer"],"workspace":project},"list":[{"id":"writer","workspace":project,"skills":[]}]}});
        write_config(&config_path, &config.to_string());
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::OpenClaw).status,
            "native-restricted"
        );
    }

    #[test]
    fn hermes_nested_workspace_remains_restricted_when_the_git_root_is_trusted() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        let nested = project.join("nested");
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir(&nested).unwrap();
        let environment = TargetEnvironment {
            home: temp.path().join("home"),
            values: BTreeMap::new(),
        };
        write_config(
            &environment.home_for(AgentKind::Hermes).join("config.yaml"),
            &format!(
                "skills:\n  trusted_project_dirs:\n    - {}\n",
                project.display()
            ),
        );
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::Hermes).status,
            "observed"
        );
        let observed = inspect_native(&environment, &nested, AgentKind::Hermes);
        assert_eq!(observed.status, "native-restricted");
        assert!(
            observed
                .diagnostics
                .iter()
                .any(|line| line.contains("nearest Git root"))
        );
    }

    #[test]
    fn opencode_config_directory_deduplication_retains_its_first_native_position() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        fs::create_dir_all(project.join(".git")).unwrap();
        let mut environment = TargetEnvironment {
            home: temp.path().join("home"),
            values: BTreeMap::new(),
        };
        let global = environment.home_for(AgentKind::OpenCode);
        write_config(
            &global.join("opencode.json"),
            r#"{"permission":{"skill":"deny"}}"#,
        );
        write_config(
            &project.join(".opencode/opencode.json"),
            r#"{"permission":{"skill":"allow"}}"#,
        );
        environment
            .values
            .insert("OPENCODE_CONFIG_DIR".into(), global.display().to_string());
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::OpenCode).status,
            "observed"
        );
        environment.values.insert(
            "OPENCODE_CONFIG_DIR".into(),
            project.join(".opencode").display().to_string(),
        );
        write_config(
            &environment.home.join(".opencode/opencode.json"),
            r#"{"permission":{"skill":"deny"}}"#,
        );
        assert_eq!(
            inspect_native(&environment, &project, AgentKind::OpenCode).status,
            "native-restricted"
        );
    }
}
