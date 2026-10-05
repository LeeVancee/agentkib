use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use agentkib_core::{AgentKind, SkillInventory, SkillObservation, SkillScope, SkillWorkspace};
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result};

use super::targets::{
    TargetEnvironment, openclaw_root_reads_package, shared_agents, stable_id,
    targets_with_environment,
};

#[derive(Clone)]
struct ScanRoot {
    path: PathBuf,
    scope: SkillScope,
    workspace_id: Option<String>,
    agents: Vec<AgentKind>,
    conditions: Vec<String>,
    recursive_packages: bool,
    opencode_hidden: bool,
}

fn opencode_compatibility_roots(
    path: &Path,
    scope: SkillScope,
    workspace_id: Option<&str>,
) -> [ScanRoot; 2] {
    [".claude/skills", ".agents/skills"].map(|relative| ScanRoot {
        path: path.join(relative),
        scope,
        workspace_id: workspace_id.map(str::to_string),
        agents: vec![AgentKind::OpenCode],
        conditions: vec![
            "OpenCode compatible Skill source; observed read-only using native recursive discovery"
                .into(),
        ],
        recursive_packages: true,
        opencode_hidden: true,
    })
}

pub(crate) fn inventory(workspaces: &[SkillWorkspace]) -> Result<SkillInventory> {
    inventory_with_environment(workspaces, &TargetEnvironment::current()?)
}

pub(crate) fn inventory_with_environment(
    workspaces: &[SkillWorkspace],
    environment: &TargetEnvironment,
) -> Result<SkillInventory> {
    let mut roots = targets_with_environment(workspaces, environment)?
        .into_iter()
        .map(|target| ScanRoot {
            path: target.root,
            scope: target.scope,
            workspace_id: target.workspace_id,
            agents: target.visible_to,
            conditions: target.reason.into_iter().chain(target.conditions).collect(),
            recursive_packages: false,
            opencode_hidden: false,
        })
        .collect::<Vec<_>>();
    let mut personal = |path: PathBuf, agents: Vec<AgentKind>, condition: &str| {
        roots.push(ScanRoot {
            path,
            scope: SkillScope::Personal,
            workspace_id: None,
            agents,
            conditions: vec![condition.into()],
            recursive_packages: false,
            opencode_hidden: false,
        });
    };
    personal(
        environment.home.join(".agents/skills"),
        environment.personal_shared_agents(),
        "Shared directory; native compatibility, profile and deny settings may limit visibility",
    );
    personal(
        environment.home_for(AgentKind::Codex).join("skills"),
        vec![AgentKind::Codex, AgentKind::Cursor],
        "Codex legacy personal directory; native loading depends on the installed version",
    );
    personal(
        environment.home.join(".gemini/config/skills"),
        vec![AgentKind::Antigravity],
        "Antigravity IDE/2.0 personal skills; separate from the agy CLI target",
    );
    personal(
        environment.home.join(".gemini/antigravity/skills"),
        vec![AgentKind::Antigravity],
        "Antigravity IDE legacy directory",
    );
    personal(
        environment.home.join(".cc-switch/skills"),
        Vec::new(),
        "CC Switch central library; this location is observed only and may contain skills disabled for every Agent",
    );
    personal(
        environment
            .home_for(AgentKind::DeepSeekHarness)
            .join("skills"),
        vec![AgentKind::DeepSeekHarness],
        "DeepSeek Harness is observed read-only; deployment is not supported",
    );
    for path in environment.hermes_external_dirs() {
        personal(
            path,
            vec![AgentKind::Hermes],
            "Hermes configured external Skill directory; observed read-only",
        );
    }
    let openclaw_extra_dirs = environment.openclaw_extra_dirs();
    let openclaw_personal_roots =
        environment.openclaw_personal_roots(openclaw_extra_dirs.as_deref().unwrap_or_default());
    if let Ok(paths) = &openclaw_extra_dirs {
        for path in paths {
            personal(
                path.clone(),
                vec![AgentKind::OpenClaw],
                "OpenClaw configured extra Skill directory; observed read-only",
            );
        }
    }
    roots.extend(opencode_compatibility_roots(
        &environment.home,
        SkillScope::Personal,
        None,
    ));
    let personal_sources = super::native_state::opencode_skill_sources(environment, None);
    let personal_opencode_roots = personal_sources
        .roots
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut source_warnings = personal_sources.diagnostics.clone();
    for path in personal_sources.roots {
        roots.push(ScanRoot {
            path,
            scope: SkillScope::Personal,
            workspace_id: None,
            agents: vec![AgentKind::OpenCode],
            conditions: std::iter::once(
                "OpenCode native or configured Skill source; observed read-only".into(),
            )
            .chain(personal_sources.diagnostics.clone())
            .collect(),
            recursive_packages: true,
            opencode_hidden: false,
        });
    }
    for workspace in workspaces {
        let sources =
            super::native_state::opencode_skill_sources(environment, Some(&workspace.path));
        source_warnings.extend(
            sources
                .diagnostics
                .iter()
                .map(|reason| format!("{}: {reason}", workspace.path.display())),
        );
        let mut paths = sources.roots;
        // Keep disabled native installations inspectable too. These roots are
        // observations, not claims of native visibility or new write targets.
        for root in workspace.path.ancestors() {
            paths.extend([root.join(".opencode/skill"), root.join(".opencode/skills")]);
            roots.extend(opencode_compatibility_roots(
                root,
                SkillScope::Workspace,
                Some(&workspace.id),
            ));
            if root.join(".git").exists() {
                break;
            }
        }
        paths.sort();
        paths.dedup();
        for path in paths {
            if personal_opencode_roots.contains(&path) {
                continue;
            }
            roots.push(ScanRoot {
                path,
                scope: SkillScope::Workspace,
                workspace_id: Some(workspace.id.clone()),
                agents: vec![AgentKind::OpenCode],
                conditions: std::iter::once(
                    "OpenCode native or configured Skill source; observed read-only".into(),
                )
                .chain(sources.diagnostics.clone())
                .collect(),
                recursive_packages: true,
                opencode_hidden: false,
            });
        }
        for (relative, agents, condition) in [
            (
                ".agents/skills",
                shared_agents(),
                "Shared project location; native discovery is not guaranteed for every compatible Agent",
            ),
            (
                ".agent/skills",
                vec![AgentKind::Antigravity],
                "Antigravity legacy project location",
            ),
            (
                ".dsh/skills",
                vec![AgentKind::DeepSeekHarness],
                "DeepSeek Harness project skills are observed read-only",
            ),
        ] {
            roots.push(ScanRoot {
                path: workspace.path.join(relative),
                scope: SkillScope::Workspace,
                workspace_id: Some(workspace.id.clone()),
                agents,
                conditions: vec![condition.into()],
                recursive_packages: false,
                opencode_hidden: false,
            });
        }
    }
    // Canonical aliases are deliberately not collapsed here. Each entry is a
    // real usage location; deleting one link must not imply another disappeared.
    let mut grouped: BTreeMap<String, ScanRoot> = BTreeMap::new();
    for root in roots {
        if !root.path.is_absolute() {
            continue;
        }
        let key = format!(
            "{:?}:{}:{}",
            root.scope,
            root.workspace_id.as_deref().unwrap_or(""),
            root.path.display()
        );
        if let Some(existing) = grouped.get_mut(&key) {
            merge_agents(&mut existing.agents, root.agents);
            existing.recursive_packages |= root.recursive_packages;
            existing.opencode_hidden |= root.opencode_hidden;
            existing.conditions.extend(root.conditions);
            existing.conditions.sort();
            existing.conditions.dedup();
        } else {
            grouped.insert(key, root);
        }
    }
    let mut output = SkillInventory {
        observations: Vec::new(),
        warnings: source_warnings,
    };
    if let Err(error) = openclaw_extra_dirs {
        output.warnings.push(format!(
            "OpenClaw extra Skill directories could not be resolved: {error}"
        ));
    }
    let mut observations = BTreeMap::new();
    for root in grouped.into_values() {
        let mut remaining = 4096;
        scan(
            &root.path,
            &root,
            0,
            &mut BTreeSet::new(),
            &mut remaining,
            &mut observations,
            &mut output.warnings,
        );
    }
    output.observations = observations.into_values().collect();
    for observation in &mut output.observations {
        if observation.scope == SkillScope::Personal
            && !openclaw_personal_roots
                .iter()
                .any(|root| openclaw_root_reads_package(root, &observation.path))
        {
            observation
                .agents
                .retain(|agent| *agent != AgentKind::OpenClaw);
        }
        super::native_state::annotate(observation, workspaces, environment);
    }
    output
        .observations
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(output)
}

fn merge_agents(existing: &mut Vec<AgentKind>, incoming: Vec<AgentKind>) {
    for agent in incoming {
        if !existing.contains(&agent) {
            existing.push(agent);
        }
    }
    existing.sort_by_key(|agent| agent.as_str());
}

fn observation(
    path: &Path,
    root: &ScanRoot,
    resolved: Option<PathBuf>,
    status: &str,
    diagnostic: Option<String>,
) -> SkillObservation {
    let linked = path
        .ancestors()
        .take_while(|ancestor| {
            root.path
                .parent()
                .is_some_and(|parent| ancestor.starts_with(parent))
        })
        .any(|ancestor| platform_path::is_reparse_or_symlink(ancestor).unwrap_or(false));
    let mut diagnostics = root.conditions.clone();
    diagnostics.extend(diagnostic);
    if linked && let Some(resolved) = &resolved {
        diagnostics.push(format!(
            "Symbolic link resolves to {}; external source remains read-only",
            resolved.display()
        ));
    }
    SkillObservation {
        id: stable_id(
            "observation",
            &format!(
                "{:?}:{}:{}",
                root.scope,
                root.workspace_id.as_deref().unwrap_or(""),
                if linked {
                    path.to_path_buf()
                } else {
                    resolved.clone().unwrap_or_else(|| path.to_path_buf())
                }
                .display()
            ),
        ),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_path_buf(),
        resolved_path: resolved,
        scope: root.scope,
        workspace_id: root.workspace_id.clone(),
        agents: root.agents.clone(),
        kind: if linked { "symlink" } else { "directory" }.into(),
        status: status.into(),
        owner: "external".into(),
        library_id: None,
        diagnostics,
    }
}

fn scan(
    path: &Path,
    root: &ScanRoot,
    depth: usize,
    ancestors: &mut BTreeSet<String>,
    remaining: &mut usize,
    observations: &mut BTreeMap<String, SkillObservation>,
    warnings: &mut Vec<String>,
) {
    if *remaining == 0 {
        return;
    }
    *remaining -= 1;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            warnings.push(format!("Could not inspect {}: {error}", path.display()));
            return;
        }
    };
    if !metadata.is_dir() && !metadata.file_type().is_symlink() {
        return;
    }
    let resolved = match platform_path::canonicalize(path) {
        Ok(resolved) => resolved,
        Err(error) => {
            let item = observation(
                path,
                root,
                None,
                "broken-link",
                Some(format!(
                    "Cannot resolve location (missing target or symlink loop): {error}"
                )),
            );
            observations.insert(item.id.clone(), item);
            return;
        }
    };
    let key = platform_path::identity(&resolved);
    if !ancestors.insert(key.clone()) {
        let item = observation(
            path,
            root,
            Some(resolved),
            "link-loop",
            Some("Symbolic link points to an ancestor; traversal stopped".into()),
        );
        observations.insert(item.id.clone(), item);
        return;
    }
    let entrypoint = resolved.join("SKILL.md");
    let has_entrypoint = fs::symlink_metadata(&entrypoint).is_ok();
    if has_entrypoint {
        let mut item = observation(path, root, Some(resolved.clone()), "observed", None);
        match agentkib_core::inspect_skill_entrypoint(&entrypoint) {
            Ok(package) => {
                item.name = package.name;
                // Native nameless packages use the installation entry's name,
                // including when that entry links to a differently named directory.
                // Keep malformed metadata inspectable under the existing fallback.
                if path.file_name() != resolved.file_name()
                    && let Some(name) = path.file_name().and_then(|name| name.to_str())
                    && let Ok(content) = super::read_skill_entrypoint(&entrypoint)
                    && let Ok(frontmatter) = super::skill_frontmatter_yaml(&content)
                    && let Ok(serde_yaml::Value::Mapping(fields)) =
                        serde_yaml::from_str(frontmatter)
                    && !fields.contains_key(serde_yaml::Value::String("name".into()))
                {
                    item.name = name.to_string();
                }
            }
            Err(error) => {
                item.status = "invalid".into();
                item.diagnostics.push(error.to_string());
            }
        }
        if let Some(existing) = observations.get_mut(&item.id) {
            merge_agents(&mut existing.agents, item.agents);
            existing.diagnostics.extend(item.diagnostics);
            if existing.path != item.path {
                existing
                    .diagnostics
                    .push(format!("Also observed through {}", item.path.display()));
            }
        } else {
            observations.insert(item.id.clone(), item);
        }
    }
    if !has_entrypoint || root.recursive_packages {
        // Only OpenCode uses recursive package globbing here. Do not attribute
        // a nested SKILL.md to other agents merged into the same scan root.
        let nested_root = has_entrypoint.then(|| ScanRoot {
            agents: vec![AgentKind::OpenCode],
            ..root.clone()
        });
        let child_root = nested_root.as_ref().unwrap_or(root);
        match fs::read_dir(path) {
            Ok(entries) => {
                for entry in entries {
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(error) => {
                            warnings.push(format!(
                                "Could not inspect an entry in {}: {error}",
                                path.display()
                            ));
                            continue;
                        }
                    };
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if (name.starts_with('.') && !child_root.opencode_hidden)
                        || matches!(
                            name.as_ref(),
                            "node_modules" | "target" | "dist" | "__pycache__"
                        )
                    {
                        continue;
                    }
                    // OpenCode's compatible glob includes hidden descendants.
                    // Other readers merged at this root must not inherit that rule.
                    let hidden_root = name.starts_with('.').then(|| ScanRoot {
                        agents: vec![AgentKind::OpenCode],
                        ..child_root.clone()
                    });
                    let entry_root = hidden_root.as_ref().unwrap_or(child_root);
                    if depth >= 8 {
                        match entry.file_type() {
                            Ok(kind) if kind.is_dir() || kind.is_symlink() => {
                                warnings.push(format!(
                                    "Skill scan depth limit reached at {}",
                                    path.display()
                                ));
                                break;
                            }
                            Ok(_) => {}
                            Err(error) => warnings.push(format!(
                                "Could not inspect {}: {error}",
                                entry.path().display()
                            )),
                        }
                        continue;
                    }
                    scan(
                        &entry.path(),
                        entry_root,
                        depth + 1,
                        ancestors,
                        remaining,
                        observations,
                        warnings,
                    );
                    if *remaining == 0 {
                        warnings.push(format!(
                            "Skill scan entry limit reached at {}",
                            root.path.display()
                        ));
                        break;
                    }
                }
            }
            Err(error) => warnings.push(format!("Could not scan {}: {error}", path.display())),
        }
    }
    ancestors.remove(&key);
}

pub(crate) fn resolve_observation(
    id: &str,
    workspaces: &[SkillWorkspace],
) -> Result<SkillObservation> {
    inventory(workspaces)?
        .observations
        .into_iter()
        .find(|observation| observation.id == id)
        .context("Skill observation no longer exists; refresh the inventory")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn linked_nameless_packages_use_the_entry_name_without_restricting_inventory() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let source = temp.path().join("real-package");
        let entry = home.join(".claude/skills/installed-alias");
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::create_dir_all(&source).unwrap();
        std::os::unix::fs::symlink(&source, &entry).unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        for (content, expected) in [
            ("---\ndescription: Fixture\n---\nBody", "installed-alias"),
            (
                "---\nname: explicit\ndescription: Fixture\n---\nBody",
                "explicit",
            ),
            ("---\nname: null\n---\nBody", "real-package"),
            ("---\nname: [broken\n---\nBody", "real-package"),
            ("Plain instructions without metadata", "real-package"),
        ] {
            fs::write(source.join("SKILL.md"), content).unwrap();
            let result = inventory_with_environment(&[], &environment).unwrap();
            let item = result
                .observations
                .iter()
                .find(|item| item.path == entry)
                .unwrap();
            assert_eq!(item.name, expected);
            assert_eq!(item.status, "observed");
            assert_eq!(
                fs::read_to_string(source.join("SKILL.md")).unwrap(),
                content
            );
        }
    }

    #[test]
    fn opencode_compatible_roots_keep_extra_discovery_exclusive_to_opencode() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.clone(),
        }];
        for base in [&home, &project] {
            for relative in [".claude/skills", ".agents/skills"] {
                let root = base.join(relative);
                for package in ["outer", "outer/nested", ".hidden/leaf", "group/.hidden"] {
                    write_fixture(&root.join(package));
                }
            }
        }
        let native_hidden = project.join(".opencode/skills/.hidden");
        write_fixture(&native_hidden);
        let result = inventory_with_environment(&workspaces, &environment).unwrap();
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        for base in [&home, &project] {
            for (relative, ordinary_reader) in [
                (".claude/skills", AgentKind::ClaudeCode),
                (".agents/skills", AgentKind::Codex),
            ] {
                for package in ["outer", "outer/nested", ".hidden/leaf", "group/.hidden"] {
                    let path = base.join(relative).join(package);
                    let matching = result
                        .observations
                        .iter()
                        .filter(|item| item.path == path)
                        .collect::<Vec<_>>();
                    assert_eq!(matching.len(), 1, "{}", path.display());
                    let item = matching[0];
                    assert_eq!(item.status, "observed");
                    if package == "outer" {
                        assert!(item.agents.contains(&ordinary_reader));
                        assert!(item.agents.contains(&AgentKind::OpenCode));
                    } else {
                        assert_eq!(item.agents, [AgentKind::OpenCode], "{}", path.display());
                    }
                }
            }
        }
        assert!(
            !result
                .observations
                .iter()
                .any(|item| item.path == native_hidden)
        );
    }

    #[test]
    fn opencode_compatible_ancestor_roots_are_read_only_workspace_sources() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let repo = temp.path().join("repo");
        let middle = repo.join("packages");
        let project = middle.join("app");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&project).unwrap();
        let mut paths = Vec::new();
        for base in [&repo, &middle] {
            for relative in [".claude/skills", ".agents/skills"] {
                let path = base.join(relative).join("inherited");
                write_fixture(&path);
                paths.push(path);
            }
        }
        let outside = temp.path().join(".agents/skills/outside");
        write_fixture(&outside);
        let environment = TargetEnvironment {
            home,
            // Native project configuration and compatible Skill discovery are independent.
            values: BTreeMap::from([("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into())]),
        };
        let workspaces = [SkillWorkspace {
            id: "nested".into(),
            name: "Nested".into(),
            path: project.clone(),
        }];
        let result = inventory_with_environment(&workspaces, &environment).unwrap();
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        for path in &paths {
            let item = result
                .observations
                .iter()
                .find(|item| &item.path == path)
                .unwrap();
            assert_eq!(item.agents, [AgentKind::OpenCode]);
            assert_eq!(item.workspace_id.as_deref(), Some("nested"));
            assert_eq!(item.scope, SkillScope::Workspace);
            assert_eq!(item.owner, "external");
            assert_eq!(item.status, "observed");
            assert_eq!(fs::read_dir(path).unwrap().count(), 1);
        }
        assert!(!result.observations.iter().any(|item| item.path == outside));
        let targets = targets_with_environment(&workspaces, &environment).unwrap();
        assert!(
            targets
                .iter()
                .filter(|target| target.scope == SkillScope::Workspace)
                .all(|target| target.scope_root == project)
        );
        for path in [&repo, &middle, &project] {
            assert!(!path.join(".agentkib").exists());
        }
    }

    #[test]
    fn opencode_compatible_extra_discovery_obeys_flags_and_native_exceptions() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let repo = temp.path().join("repo");
        let project = repo.join("nested");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&project).unwrap();
        for base in [&home, &repo] {
            for relative in [".claude/skills", ".agents/skills"] {
                for package in ["outer", "outer/nested", ".hidden"] {
                    write_fixture(&base.join(relative).join(package));
                }
            }
        }
        let workspaces = [SkillWorkspace {
            id: "nested".into(),
            name: "Nested".into(),
            path: project,
        }];
        for flag in [
            "OPENCODE_DISABLE_EXTERNAL_SKILLS",
            "OPENCODE_DISABLE_CLAUDE_CODE",
            "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
        ] {
            for explicit in [false, true] {
                let mut environment = TargetEnvironment {
                    home: home.clone(),
                    values: BTreeMap::from([(flag.into(), "1".into())]),
                };
                if explicit {
                    environment.values.insert(
                        "OPENCODE_CONFIG_DIR".into(),
                        repo.join(".claude").display().to_string(),
                    );
                }
                let result = inventory_with_environment(&workspaces, &environment).unwrap();
                for base in [&home, &repo] {
                    for relative in [".claude/skills", ".agents/skills"] {
                        for package in ["outer/nested", ".hidden"] {
                            let path = base.join(relative).join(package);
                            let item = result
                                .observations
                                .iter()
                                .find(|item| item.path == path)
                                .unwrap();
                            let compatible = relative == ".agents/skills"
                                && flag != "OPENCODE_DISABLE_EXTERNAL_SKILLS";
                            let native = explicit
                                && base == &repo
                                && relative == ".claude/skills"
                                && package == "outer/nested";
                            let readable = compatible || native;
                            assert_eq!(
                                item.agents.contains(&AgentKind::OpenCode),
                                readable,
                                "{flag}, explicit={explicit}: {}",
                                path.display()
                            );
                            assert_eq!(
                                item.status,
                                if readable {
                                    "observed"
                                } else {
                                    "native-restricted"
                                }
                            );
                            assert_eq!(
                                item.diagnostics.iter().any(|reason| reason.contains(flag)),
                                !readable
                            );
                        }
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn opencode_compatible_hidden_links_keep_locations_and_cycle_diagnostics() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let root = home.join(".claude/skills");
        let outside = temp.path().join("external");
        write_fixture(&root.join("outer"));
        write_fixture(&outside);
        for path in [root.join(".alias"), root.join("outer/.alias")] {
            std::os::unix::fs::symlink(&outside, path).unwrap();
        }
        std::os::unix::fs::symlink(&root, root.join("outer/.loop")).unwrap();
        std::os::unix::fs::symlink(temp.path().join("missing"), root.join(".broken")).unwrap();
        let result = inventory_with_environment(
            &[],
            &TargetEnvironment {
                home,
                values: BTreeMap::new(),
            },
        )
        .unwrap();
        for path in [root.join(".alias"), root.join("outer/.alias")] {
            let item = result
                .observations
                .iter()
                .find(|item| item.path == path)
                .unwrap();
            assert_eq!(item.agents, [AgentKind::OpenCode]);
            assert_eq!(item.kind, "symlink");
            assert!(platform_path::equivalent(
                item.resolved_path.as_deref().unwrap(),
                &outside
            ));
        }
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.path == root.join("outer/.loop") && item.status == "link-loop")
        );
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.path == root.join(".broken") && item.status == "broken-link")
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }

    #[test]
    fn opencode_compatible_hidden_discovery_keeps_depth_and_entry_limits() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let root = home.join(".claude/skills");
        let leaf = root.join(".hidden/a/b/c/d/e/f/g");
        write_fixture(&leaf);
        write_fixture(&leaf.join("beyond"));
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let result = inventory_with_environment(&[], &environment).unwrap();
        assert!(result.observations.iter().any(|item| item.path == leaf));
        assert!(
            !result
                .observations
                .iter()
                .any(|item| item.path == leaf.join("beyond"))
        );
        assert!(
            result.warnings.iter().any(|warning| warning
                .strip_prefix("Skill scan depth limit reached at ")
                .is_some_and(|path| platform_path::equivalent(Path::new(path), &leaf))),
            "{:?}",
            result.warnings
        );

        // Use a small explicit budget to exercise the same production traversal
        // without creating thousands of fixture directories.
        let root = opencode_compatibility_roots(&home, SkillScope::Personal, None)[0].clone();
        let mut remaining = 2;
        let mut observations = BTreeMap::new();
        let mut warnings = Vec::new();
        scan(
            &root.path,
            &root,
            0,
            &mut BTreeSet::new(),
            &mut remaining,
            &mut observations,
            &mut warnings,
        );
        assert_eq!(remaining, 0);
        assert!(observations.is_empty());
        assert!(
            warnings
                .iter()
                .any(|warning| warning.contains("entry limit"))
        );
    }

    #[test]
    fn observes_all_opencode_native_and_configured_sources_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let custom = temp.path().join("custom");
        let extra = temp.path().join("extra");
        fs::create_dir_all(project.join(".git")).unwrap();
        let paths = [
            home.join(".config/opencode/skills/default"),
            home.join(".config/opencode/skill/singular"),
            home.join(".opencode/skills/home"),
            project.join(".opencode/skills/project"),
            custom.join("skills/custom"),
            extra.join("extra"),
        ];
        for path in &paths {
            write_fixture(path);
        }
        let config = home.join(".config/opencode/opencode.json");
        fs::write(
            &config,
            serde_json::json!({"skills":{"paths":[extra]}}).to_string(),
        )
        .unwrap();
        let original_config = fs::read(&config).unwrap();
        let original_packages = paths
            .iter()
            .map(|path| fs::read(path.join("SKILL.md")).unwrap())
            .collect::<Vec<_>>();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([("OPENCODE_CONFIG_DIR".into(), custom.display().to_string())]),
        };
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.clone(),
        }];
        let inventory = inventory_with_environment(&workspaces, &environment).unwrap();
        assert!(inventory.warnings.is_empty(), "{:?}", inventory.warnings);
        assert_eq!(inventory.observations.len(), paths.len());
        for (path, original) in paths.iter().zip(original_packages) {
            let item = inventory
                .observations
                .iter()
                .find(|item| &item.path == path)
                .unwrap();
            assert_eq!(item.agents, [AgentKind::OpenCode]);
            assert_eq!(item.owner, "external");
            assert_eq!(item.status, "observed");
            assert_eq!(fs::read(path.join("SKILL.md")).unwrap(), original);
            assert!(!path.join(".agentkib").exists());
        }
        assert_eq!(fs::read(config).unwrap(), original_config);
        assert!(!home.join(".agentkib").exists());
        assert!(!project.join(".agentkib").exists());
    }

    #[test]
    fn disabled_opencode_project_sources_stay_inspectable_and_explicit_sources_restore_visibility()
    {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let paths = [
            project.join(".opencode/skills/plural"),
            project.join(".opencode/skill/singular"),
        ];
        for path in &paths {
            write_fixture(path);
        }
        let workspaces = [SkillWorkspace {
            id: "project".into(),
            name: "Project".into(),
            path: project.clone(),
        }];
        let mut environment = TargetEnvironment {
            home,
            values: BTreeMap::from([("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into())]),
        };
        for readable in [false, true] {
            if readable {
                environment.values.insert(
                    "OPENCODE_CONFIG_DIR".into(),
                    project.join(".opencode").display().to_string(),
                );
            }
            let inventory = inventory_with_environment(&workspaces, &environment).unwrap();
            for path in &paths {
                let item = inventory
                    .observations
                    .iter()
                    .find(|item| &item.path == path)
                    .unwrap();
                assert_eq!(item.agents.contains(&AgentKind::OpenCode), readable);
                assert_eq!(
                    item.status,
                    if readable {
                        "observed"
                    } else {
                        "native-restricted"
                    }
                );
                assert_eq!(
                    item.diagnostics
                        .iter()
                        .any(|reason| reason.contains("OPENCODE_DISABLE_PROJECT_CONFIG")),
                    !readable
                );
            }
            let target = targets_with_environment(&workspaces, &environment)
                .unwrap()
                .into_iter()
                .find(|target| {
                    target.agent == AgentKind::OpenCode && target.scope == SkillScope::Workspace
                })
                .unwrap();
            assert_eq!(target.visible_to.contains(&AgentKind::OpenCode), readable);
        }
    }

    #[test]
    fn unreadable_opencode_sources_warn_and_keep_existing_installations_unverified() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let package = home.join(".config/opencode/skills/example");
        write_fixture(&package);
        let config = home.join(".config/opencode/opencode.json");
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        for text in [
            "{broken",
            r#"{"skills":{"paths":"bad"}}"#,
            r#"{"skills":{"paths":["relative"]}}"#,
            r#"{"skills":{"paths":["{file:private}"]}}"#,
        ] {
            fs::write(&config, text).unwrap();
            let result = inventory_with_environment(&[], &environment).unwrap();
            assert!(!result.warnings.is_empty(), "{text}");
            let item = result
                .observations
                .iter()
                .find(|item| item.path == package)
                .unwrap();
            assert_eq!(item.status, "unverified", "{text}: {:?}", item.diagnostics);
            assert_eq!(fs::read_to_string(&config).unwrap(), text);
        }
        fs::remove_file(&config).unwrap();
        fs::create_dir(&config).unwrap();
        let result = inventory_with_environment(&[], &environment).unwrap();
        assert!(!result.warnings.is_empty());
        assert_eq!(result.observations[0].status, "unverified");
    }

    #[test]
    fn opencode_scan_depth_warns_only_when_an_unvisited_directory_remains() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let extra = temp.path().join("extra");
        let leaf = extra.join("a/b/c/d/e/f/g/h");
        write_fixture(&leaf);
        fs::create_dir_all(home.join(".config/opencode")).unwrap();
        fs::write(
            home.join(".config/opencode/opencode.json"),
            serde_json::json!({"skills":{"paths":[extra]}}).to_string(),
        )
        .unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        let complete = inventory_with_environment(&[], &environment).unwrap();
        assert!(complete.warnings.is_empty(), "{:?}", complete.warnings);
        assert!(complete.observations.iter().any(|item| item.path == leaf));
        write_fixture(&leaf.join("beyond"));
        let incomplete = inventory_with_environment(&[], &environment).unwrap();
        assert!(
            incomplete.warnings.iter().any(|warning| warning
                .strip_prefix("Skill scan depth limit reached at ")
                .is_some_and(|path| platform_path::equivalent(Path::new(path), &leaf))),
            "{:?}",
            incomplete.warnings
        );
        assert!(
            !incomplete
                .observations
                .iter()
                .any(|item| item.path == leaf.join("beyond"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn configured_opencode_roots_recurse_packages_and_diagnose_links_within_the_scan_budget() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let extra = temp.path().join("extra");
        write_fixture(&extra);
        write_fixture(&extra.join("nested"));
        std::os::unix::fs::symlink(&extra, extra.join("loop")).unwrap();
        std::os::unix::fs::symlink(temp.path().join("missing"), extra.join("broken")).unwrap();
        fs::create_dir_all(home.join(".config/opencode")).unwrap();
        fs::write(
            home.join(".config/opencode/opencode.json"),
            serde_json::json!({"skills":{"paths":[extra]}}).to_string(),
        )
        .unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::new(),
        };
        let result = inventory_with_environment(&[], &environment).unwrap();
        for path in [&extra, &extra.join("nested")] {
            let item = result
                .observations
                .iter()
                .find(|item| &item.path == path)
                .unwrap();
            assert_eq!(item.agents, [AgentKind::OpenCode]);
        }
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.status == "link-loop")
        );
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.status == "broken-link")
        );
    }

    #[test]
    fn opencode_compatibility_flags_keep_observations_and_other_native_readers() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let paths = [
            home.join(".claude/skills/example"),
            project.join(".claude/skills/example"),
            home.join(".agents/skills/example"),
            project.join(".agents/skills/example"),
            home.join(".config/opencode/skills/example"),
            project.join(".opencode/skills/example"),
        ];
        for path in &paths {
            write_fixture(path);
        }
        let originals = paths
            .iter()
            .map(|path| fs::read(path.join("SKILL.md")).unwrap())
            .collect::<Vec<_>>();
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
            let environment = TargetEnvironment {
                home: home.clone(),
                values: BTreeMap::from([(key.into(), "1".into())]),
            };
            let result =
                inventory_with_environment(std::slice::from_ref(&workspace), &environment).unwrap();
            for (index, path) in paths.iter().enumerate() {
                let item = result
                    .observations
                    .iter()
                    .find(|item| &item.path == path)
                    .unwrap();
                let disabled =
                    index < 2 || (index < 4 && key == "OPENCODE_DISABLE_EXTERNAL_SKILLS");
                assert_eq!(
                    item.agents.contains(&AgentKind::OpenCode),
                    !disabled,
                    "{key}: {item:?}"
                );
                assert_eq!(
                    item.diagnostics.iter().any(|reason| reason.contains(key)),
                    disabled
                );
                assert_eq!(item.status, "observed");
                if index < 2 {
                    assert!(item.agents.contains(&AgentKind::ClaudeCode));
                    assert!(item.agents.contains(&AgentKind::Cursor));
                }
                if (2..4).contains(&index) {
                    assert!(item.agents.contains(&AgentKind::Codex));
                }
                assert_eq!(fs::read(path.join("SKILL.md")).unwrap(), originals[index]);
                assert!(!path.parent().unwrap().join(".agentkib").exists());
            }
        }
    }

    #[test]
    fn opencode_default_claude_source_survives_claude_home_override_and_disable() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let custom = temp.path().join("custom-claude");
        let original_skill = home.join(".claude/skills/example");
        let custom_skill = custom.join("skills/example");
        write_fixture(&original_skill);
        write_fixture(&custom_skill);
        let mut environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([("CLAUDE_CONFIG_DIR".into(), custom.display().to_string())]),
        };
        for disabled in [false, true] {
            if disabled {
                environment
                    .values
                    .insert("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS".into(), "true".into());
            }
            let result = inventory_with_environment(&[], &environment).unwrap();
            let original = result
                .observations
                .iter()
                .find(|item| item.path == original_skill)
                .unwrap();
            assert_eq!(original.agents.contains(&AgentKind::OpenCode), !disabled);
            assert_eq!(
                original.status,
                if disabled {
                    "native-restricted"
                } else {
                    "observed"
                }
            );
            assert_eq!(
                original
                    .diagnostics
                    .iter()
                    .any(|reason| reason.contains("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS")),
                disabled
            );
            let overridden = result
                .observations
                .iter()
                .find(|item| item.path == custom_skill)
                .unwrap();
            assert!(!overridden.agents.contains(&AgentKind::OpenCode));
            assert!(overridden.agents.contains(&AgentKind::ClaudeCode));
            assert!(
                overridden
                    .diagnostics
                    .iter()
                    .any(|reason| reason.contains("CLAUDE_CONFIG_DIR does not"))
            );
            assert_eq!(overridden.status, "observed");
        }
    }

    #[cfg(unix)]
    #[test]
    fn opencode_native_directory_alias_retains_visibility_after_compatibility_is_disabled() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let skill = home.join(".claude/skills/example");
        write_fixture(&skill);
        fs::create_dir_all(home.join(".config")).unwrap();
        symlink(home.join(".claude"), home.join(".config/opencode")).unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::from([("OPENCODE_DISABLE_CLAUDE_CODE".into(), "1".into())]),
        };
        let result = inventory_with_environment(&[], &environment).unwrap();
        let observed = result
            .observations
            .iter()
            .find(|item| item.path == skill)
            .unwrap();
        assert!(observed.agents.contains(&AgentKind::OpenCode));
        assert!(
            !observed
                .diagnostics
                .iter()
                .any(|reason| reason.contains("OPENCODE_DISABLE_CLAUDE_CODE"))
        );
        assert_eq!(observed.status, "observed");
    }

    #[test]
    fn openclaw_state_isolation_keeps_inventory_and_native_diagnostics_consistent() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let shared = home.join(".agents/skills/example");
        let project_skill = project.join(".agents/skills/example");
        write_fixture(&shared);
        write_fixture(&project_skill);
        let workspace = SkillWorkspace {
            id: "repo".into(),
            name: "Repo".into(),
            path: project.clone(),
        };
        for (values, default_state) in [
            (BTreeMap::new(), true),
            (
                BTreeMap::from([("OPENCLAW_PROFILE".into(), "work".into())]),
                false,
            ),
            (
                BTreeMap::from([(
                    "OPENCLAW_STATE_DIR".into(),
                    temp.path().join("custom-state").display().to_string(),
                )]),
                false,
            ),
        ] {
            let environment = TargetEnvironment {
                home: home.clone(),
                values,
            };
            let state = environment.home_for(AgentKind::OpenClaw);
            let managed = state.join("skills/example");
            write_fixture(&managed);
            for extra_directory in [None, Some("~/.agents/skills"), Some("~/.agents")] {
                let config = serde_json::json!({
                    "agents":{"defaults":{"workspace":project}},
                    "skills":{"load":{"extraDirs":extra_directory.into_iter().collect::<Vec<_>>()}}
                });
                let config_path = state.join("openclaw.json");
                fs::write(&config_path, config.to_string()).unwrap();
                let config_before = fs::read(&config_path).unwrap();
                let result =
                    inventory_with_environment(std::slice::from_ref(&workspace), &environment)
                        .unwrap();
                let expected = default_state || extra_directory.is_some();
                let targets = targets_with_environment(&[], &environment).unwrap();
                let target = targets
                    .iter()
                    .find(|target| target.agent == AgentKind::Codex)
                    .unwrap();
                assert_eq!(target.visible_to.contains(&AgentKind::OpenClaw), expected);
                let item = result
                    .observations
                    .iter()
                    .find(|item| item.path == shared)
                    .unwrap();
                assert_eq!(item.agents.contains(&AgentKind::OpenClaw), expected);
                assert!(item.agents.contains(&AgentKind::Codex));
                assert_eq!(
                    item.diagnostics
                        .iter()
                        .any(|message| message.contains("OpenClaw Agent default: allowed")),
                    expected
                );
                if !expected {
                    assert!(
                        !item
                            .diagnostics
                            .iter()
                            .any(|message| message.starts_with("OpenClaw"))
                    );
                }
                for path in [&project_skill, &managed] {
                    let item = result
                        .observations
                        .iter()
                        .find(|item| &item.path == path)
                        .unwrap();
                    assert!(item.agents.contains(&AgentKind::OpenClaw));
                    assert!(
                        item.diagnostics
                            .iter()
                            .any(|message| message.contains("OpenClaw Agent default: allowed"))
                    );
                }
                assert_eq!(fs::read(&config_path).unwrap(), config_before);
            }
        }
    }

    #[test]
    fn openclaw_extra_ancestor_visibility_respects_package_boundaries_and_depth() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = home.join(".openclaw-work");
        let shared = home.join(".agents/skills/example");
        let extra = temp.path().join("extra");
        let within_depth = extra.join("a/b/c/d/e/example");
        let beyond_depth = extra.join("a/b/c/d/f/g/example");
        for skill in [&shared, &within_depth, &beyond_depth] {
            write_fixture(skill);
        }
        fs::create_dir_all(&state).unwrap();
        fs::write(
            state.join("openclaw.json"),
            serde_json::json!({"skills":{"load":{"extraDirs":["~/.agents", extra]}}}).to_string(),
        )
        .unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([("OPENCLAW_PROFILE".into(), "work".into())]),
        };
        let boundary = home.join(".agents/SKILL.md");
        for blocked in [false, true] {
            if blocked {
                fs::write(&boundary, "invalid boundary still stops grouped discovery").unwrap();
            }
            let targets = targets_with_environment(&[], &environment).unwrap();
            let target = targets
                .iter()
                .find(|target| target.agent == AgentKind::Codex)
                .unwrap();
            assert_eq!(target.visible_to.contains(&AgentKind::OpenClaw), !blocked);
            let result = inventory_with_environment(&[], &environment).unwrap();
            for (path, expected) in [
                (&shared, !blocked),
                (&within_depth, true),
                (&beyond_depth, false),
            ] {
                let item = result
                    .observations
                    .iter()
                    .find(|item| &item.path == path)
                    .unwrap();
                assert_eq!(
                    item.agents.contains(&AgentKind::OpenClaw),
                    expected,
                    "{}",
                    path.display()
                );
                assert_eq!(
                    item.diagnostics
                        .iter()
                        .any(|message| message.contains("OpenClaw Agent default: allowed")),
                    expected
                );
            }
        }
    }

    #[test]
    fn openclaw_extra_dirs_remain_read_only_observed_sources_with_native_restrictions() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let state = home.join(".openclaw-work");
        let external = temp.path().join("external/example");
        write_fixture(&external);
        fs::create_dir_all(&state).unwrap();
        let config_path = state.join("openclaw.json");
        fs::write(&config_path, serde_json::json!({"skills":{"load":{"extraDirs":[external.parent().unwrap()]},"entries":{"example":{"enabled":false}}}}).to_string()).unwrap();
        let environment = TargetEnvironment {
            home,
            values: BTreeMap::from([("OPENCLAW_PROFILE".into(), "work".into())]),
        };
        let result = inventory_with_environment(&[], &environment).unwrap();
        let item = result
            .observations
            .iter()
            .find(|item| item.path == external)
            .unwrap();
        assert_eq!(item.agents, [AgentKind::OpenClaw]);
        assert_eq!(item.status, "native-restricted");
        assert!(
            item.diagnostics
                .iter()
                .any(|message| message.contains("disabled by skills.entries"))
        );
        assert!(!external.parent().unwrap().join(".agentkib").exists());
        fs::write(
            &config_path,
            r#"{"skills":{"load":{"extraDirs":["${MISSING_ROOT}"]}}}"#,
        )
        .unwrap();
        let result = inventory_with_environment(&[], &environment).unwrap();
        assert!(result.warnings.iter().any(|message| {
            message.contains("OpenClaw extra Skill directories could not be resolved")
        }));
        assert!(!result.observations.iter().any(|item| item.path == external));
    }

    #[cfg(unix)]
    #[test]
    fn observes_external_links_without_losing_locations_or_following_loops() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let root = home.join(".claude/skills");
        fs::create_dir_all(&root).unwrap();
        let source = home.join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: example\ndescription: Example\n---\nBody",
        )
        .unwrap();
        symlink(&source, root.join("one")).unwrap();
        symlink(&source, root.join("two")).unwrap();
        symlink(home.join("missing"), root.join("broken")).unwrap();
        symlink(&root, root.join("loop")).unwrap();
        let result = inventory_with_environment(
            &[],
            &TargetEnvironment {
                home,
                values: BTreeMap::new(),
            },
        )
        .unwrap();
        assert_eq!(
            result
                .observations
                .iter()
                .filter(|value| value.name == "example")
                .count(),
            2
        );
        assert!(
            result
                .observations
                .iter()
                .any(|value| value.status == "broken-link")
        );
        assert!(
            result
                .observations
                .iter()
                .any(|value| value.status == "link-loop")
        );
    }
    fn write_fixture(root: &Path) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("SKILL.md"),
            "---\nname: example\ndescription: Example\n---\nBody",
        )
        .unwrap();
    }

    #[test]
    fn reads_native_restrictions_and_hermes_project_trust_without_mutations() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let project = home.join("repo");
        fs::create_dir_all(project.join(".git")).unwrap();
        write_fixture(&project.join(".hermes/skills/example"));
        write_fixture(&home.join(".openclaw/skills/example"));
        write_fixture(&home.join(".grok/skills/example"));
        fs::write(
            home.join(".openclaw/openclaw.json"),
            "{skills:{entries:{example:{enabled:false}}}}",
        )
        .unwrap();
        fs::write(
            home.join(".grok/config.toml"),
            "[skills]\ndisabled = ['example']\n",
        )
        .unwrap();
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::new(),
        };
        let workspaces = [SkillWorkspace {
            id: "repo".into(),
            name: "Repo".into(),
            path: project.clone(),
        }];
        let result = inventory_with_environment(&workspaces, &environment).unwrap();
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.agents == [AgentKind::Hermes] && item.status == "pending-trust")
        );
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.agents == [AgentKind::OpenClaw]
                    && item.status == "native-restricted")
        );
        assert!(result.observations.iter().any(
            |item| item.agents == [AgentKind::GrokBuild] && item.status == "native-restricted"
        ));
        assert!(!home.join(".hermes").exists());
        fs::create_dir(home.join(".hermes")).unwrap();
        let config = home.join(".hermes/config.yaml");
        fs::write(
            &config,
            serde_yaml::to_string(
                &serde_json::json!({"skills":{"trusted_project_dirs":[project]}}),
            )
            .unwrap(),
        )
        .unwrap();
        let result = inventory_with_environment(&workspaces, &environment).unwrap();
        assert!(result.observations.iter().any(|item| {
            item.agents == [AgentKind::Hermes]
                && item.status == "observed"
                && item
                    .diagnostics
                    .iter()
                    .any(|text| text.contains("Git root is trusted"))
        }));
        fs::write(&config, "skills:\n  project_discovery: false\n").unwrap();
        let result = inventory_with_environment(&workspaces, &environment).unwrap();
        assert!(
            result.observations.iter().any(
                |item| item.agents == [AgentKind::Hermes] && item.status == "native-restricted"
            )
        );
        fs::write(&config, "skills: [broken").unwrap();
        let result = inventory_with_environment(&workspaces, &environment).unwrap();
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.agents == [AgentKind::Hermes] && item.status == "unverified")
        );
    }

    #[test]
    fn shared_visibility_respects_hermes_configuration_and_keeps_read_only_libraries() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let shared = home.join(".agents/skills");
        write_fixture(&shared.join("example"));
        write_fixture(&home.join(".cc-switch/skills/example"));
        write_fixture(&home.join("custom-dsh/skills/example"));
        let environment = TargetEnvironment {
            home: home.clone(),
            values: BTreeMap::from([(
                "DSH_HOME".into(),
                home.join("custom-dsh").display().to_string(),
            )]),
        };
        let result = inventory_with_environment(&[], &environment).unwrap();
        let item = result
            .observations
            .iter()
            .find(|item| item.path == shared.join("example"))
            .unwrap();
        assert!(item.agents.contains(&AgentKind::DeepSeekHarness));
        assert!(!item.agents.contains(&AgentKind::Hermes));
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.path == home.join(".cc-switch/skills/example")
                    && item.agents.is_empty())
        );
        assert!(
            result
                .observations
                .iter()
                .any(|item| item.agents == [AgentKind::DeepSeekHarness])
        );
        fs::create_dir(home.join(".hermes")).unwrap();
        fs::write(
            home.join(".hermes/config.yaml"),
            "skills:\n  external_dirs: [~/.agents/skills]\n",
        )
        .unwrap();
        let result = inventory_with_environment(&[], &environment).unwrap();
        assert!(
            result
                .observations
                .iter()
                .find(|item| item.path == shared.join("example"))
                .unwrap()
                .agents
                .contains(&AgentKind::Hermes)
        );
    }
}
