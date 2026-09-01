use std::collections::{BTreeSet, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use agentkib_platform::path::{canonicalize, equivalent, starts_with as path_starts_with};
use anyhow::{Context, Result, bail};

use crate::{AgentKind, ContextPreview, ContextSection, Manifest, canonical_project};

const MAX_CONTEXT_CHARS_PER_FILE: usize = 128 * 1024;
const MAX_CONTEXT_BYTES_PER_FILE: u64 = MAX_CONTEXT_CHARS_PER_FILE as u64 * 4;
const MAX_CONTEXT_CHARS_TOTAL: usize = 512 * 1024;
const GROK_MAX_CONTEXT_CHARS_PER_FILE: usize = 10_000;
const GROK_MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const DSH_MAX_CONTEXT_BYTES: usize = 64 * 1024;
const DSH_MAX_SOURCE_BYTES: u64 = 1024 * 1024;
const OPENCODE_MANAGED_INSTRUCTION: &str = ".opencode/agentkib-instructions.md";

pub fn resolve_context(
    project: &Path,
    cwd: &Path,
    agent: AgentKind,
    manifest: Option<&Manifest>,
    approved_memories: Vec<String>,
) -> Result<ContextPreview> {
    let root = canonical_project(project)?;
    let cwd = if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        root.join(cwd)
    };
    let cwd = canonicalize(&cwd)
        .with_context(|| format!("Working directory does not exist: {}", cwd.display()))?;
    if !path_starts_with(&cwd, &root) {
        bail!("Working directory must be inside the project");
    }

    let context_root = if agent == AgentKind::DeepSeekHarness {
        deepseek_project_root(&root, &cwd)
    } else {
        root.clone()
    };
    let dirs = directory_chain(&context_root, &cwd)?;
    let mut warnings = Vec::new();
    let sources = match agent {
        AgentKind::Codex => codex_sources(&dirs),
        AgentKind::ClaudeCode => claude_sources(&dirs),
        AgentKind::Cursor => cursor_sources(&dirs),
        AgentKind::OpenCode => opencode_sources(&dirs),
        AgentKind::OpenClaw => openclaw_sources(&dirs),
        AgentKind::Hermes => hermes_sources(&dirs),
        AgentKind::GrokBuild => Vec::new(),
        AgentKind::DeepSeekHarness => Vec::new(),
    };
    let mut sections = if agent == AgentKind::DeepSeekHarness {
        deepseek_harness_sections(&context_root, &dirs, &mut warnings)
    } else if agent == AgentKind::GrokBuild {
        grok_build_sections(&root, &dirs, &mut warnings)
    } else {
        let mut sections = Vec::new();
        let mut remaining_context_chars = MAX_CONTEXT_CHARS_TOTAL;
        for source in sources {
            if remaining_context_chars == 0 {
                push_context_budget_warning(&mut warnings);
                break;
            }
            match load_with_imports(
                &source,
                &root,
                &mut HashSet::new(),
                0,
                &mut remaining_context_chars,
                &mut warnings,
            ) {
                Ok(content) => sections.push(ContextSection {
                    scope: source
                        .parent()
                        .unwrap_or(&root)
                        .strip_prefix(&root)
                        .unwrap_or(Path::new("."))
                        .display()
                        .to_string(),
                    source,
                    content,
                    precedence: sections.len(),
                }),
                Err(error) => warnings.push(error.to_string()),
            }
        }
        sections
    };
    if sections.is_empty() {
        warnings.push("No project instruction file was found for this Agent".into());
    }

    if let Some(manifest) = manifest
        && let Some(override_text) = manifest.instructions.platform_overrides.get(&agent)
    {
        let already_generated = sections
            .iter()
            .any(|section| section.content.contains(override_text.trim()));
        if !override_text.trim().is_empty() && !already_generated {
            if !sections.is_empty() {
                warnings.push("The platform override is applied after native project instructions; check for semantic conflicts".into());
            }
            sections.push(ContextSection {
                source: root.join(".agentkib/manifest.yaml"),
                scope: "platform-override".into(),
                content: override_text.clone(),
                precedence: sections.len(),
            });
        }
    }
    let visible_skills = if agent == AgentKind::DeepSeekHarness {
        deepseek_harness_skills(&context_root)
    } else {
        manifest
            .map(|value| {
                value
                    .skills
                    .iter()
                    .filter(|skill| skill.targets.is_empty() || skill.targets.contains(&agent))
                    .map(|skill| skill.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    let visible_connections = if agent == AgentKind::DeepSeekHarness {
        Vec::new()
    } else {
        manifest
            .map(|value| {
                value
                    .connections
                    .iter()
                    .filter(|connection| {
                        connection.targets.is_empty() || connection.targets.contains(&agent)
                    })
                    .map(|connection| connection.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    };

    Ok(ContextPreview {
        agent,
        project: context_root,
        cwd,
        sections,
        visible_skills,
        visible_connections,
        approved_memories: if agent == AgentKind::DeepSeekHarness {
            Vec::new()
        } else {
            approved_memories
        },
        warnings,
    })
}

fn deepseek_project_root(workspace: &Path, cwd: &Path) -> PathBuf {
    let mut current = cwd;
    loop {
        if current.join(".git").exists() {
            return current.to_path_buf();
        }
        if equivalent(current, workspace) {
            return cwd.to_path_buf();
        }
        let Some(parent) = current
            .parent()
            .filter(|parent| path_starts_with(parent, workspace))
        else {
            return cwd.to_path_buf();
        };
        current = parent;
    }
}

fn deepseek_harness_home() -> Option<PathBuf> {
    env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".dsh")))
}

fn user_home() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

#[derive(Debug, Clone, Copy)]
struct GrokCompat {
    claude_agents: bool,
    claude_rules: bool,
    cursor_agents: bool,
    cursor_rules: bool,
}

impl Default for GrokCompat {
    fn default() -> Self {
        Self {
            claude_agents: true,
            claude_rules: true,
            cursor_agents: true,
            cursor_rules: true,
        }
    }
}

fn grok_home() -> Option<PathBuf> {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".grok")))
}

fn grok_compat(home: Option<&Path>, project: &Path) -> GrokCompat {
    let home_value = home
        .map(|home| home.join("config.toml"))
        .and_then(|path| read_utf8_file_with_limit(&path, GROK_MAX_CONFIG_BYTES).ok())
        .and_then(|content| toml::from_str::<toml::Value>(&content).ok());
    let project_value =
        read_utf8_file_with_limit(&project.join(".grok/config.toml"), GROK_MAX_CONFIG_BYTES)
            .ok()
            .and_then(|content| toml::from_str::<toml::Value>(&content).ok());
    resolve_grok_compat_values(home_value.as_ref(), project_value.as_ref(), |env_name| {
        env::var(env_name)
            .ok()
            .and_then(|value| parse_env_bool(&value))
    })
}

fn resolve_grok_compat_values(
    home_value: Option<&toml::Value>,
    project_value: Option<&toml::Value>,
    env_value: impl Fn(&str) -> Option<bool>,
) -> GrokCompat {
    let value_from = |value: &toml::Value, vendor: &str, surface: &str| {
        value
            .get("compat")
            .and_then(|value| value.get(vendor))
            .and_then(|value| value.get(surface))
            .and_then(toml::Value::as_bool)
    };
    let config_value = |vendor: &str, surface: &str| {
        project_value
            .and_then(|value| value_from(value, vendor, surface))
            .or_else(|| home_value.and_then(|value| value_from(value, vendor, surface)))
    };
    let resolved = |env_name: &str, vendor: &str, surface: &str| {
        env_value(env_name)
            .or_else(|| config_value(vendor, surface))
            .unwrap_or(true)
    };
    GrokCompat {
        claude_agents: resolved("GROK_CLAUDE_AGENTS_ENABLED", "claude", "agents"),
        claude_rules: resolved("GROK_CLAUDE_RULES_ENABLED", "claude", "rules"),
        cursor_agents: resolved("GROK_CURSOR_AGENTS_ENABLED", "cursor", "agents"),
        cursor_rules: resolved("GROK_CURSOR_RULES_ENABLED", "cursor", "rules"),
    }
}

fn parse_env_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn grok_build_sections(
    project: &Path,
    dirs: &[PathBuf],
    warnings: &mut Vec<String>,
) -> Vec<ContextSection> {
    let home = grok_home();
    let compat = grok_compat(home.as_deref(), project);
    grok_build_sections_with_roots(project, dirs, home, user_home(), compat, warnings)
}

fn grok_build_sections_with_roots(
    project: &Path,
    dirs: &[PathBuf],
    home: Option<PathBuf>,
    user_home: Option<PathBuf>,
    compat: GrokCompat,
    warnings: &mut Vec<String>,
) -> Vec<ContextSection> {
    const GENERIC_NAMES: &[&str] = &[
        "Agents.md",
        "Claude.md",
        "CLAUDE.md",
        "CLAUDE.local.md",
        "AGENT.md",
        "AGENTS.md",
    ];
    // The configured Home directory itself is trusted and may be a symlink (for
    // example to another volume). Canonicalize that root once, then keep applying
    // the normal containment checks to every file discovered beneath it.
    let home = home.and_then(|root| canonicalize(&root).ok());
    let user_home = user_home.and_then(|root| canonicalize(&root).ok());
    let mut sources = Vec::new();
    if let Some(home) = home.as_ref() {
        collect_grok_root(home, GENERIC_NAMES, &[("rules", false)], None, &mut sources);
    }
    if let Some(user) = user_home.as_ref() {
        if compat.claude_agents || compat.claude_rules {
            collect_grok_root(
                &user.join(".claude"),
                if compat.claude_agents {
                    GENERIC_NAMES
                } else {
                    &[]
                },
                if compat.claude_rules {
                    &[("rules", false)]
                } else {
                    &[]
                },
                None,
                &mut sources,
            );
        }
        if compat.cursor_agents || compat.cursor_rules {
            collect_grok_root(
                &user.join(".cursor"),
                if compat.cursor_agents {
                    GENERIC_NAMES
                } else {
                    &[]
                },
                if compat.cursor_rules {
                    &[("rules", true)]
                } else {
                    &[]
                },
                None,
                &mut sources,
            );
        }
    }
    let mut project_names = GENERIC_NAMES.to_vec();
    if compat.claude_agents {
        project_names.extend([".claude/CLAUDE.md", ".claude/CLAUDE.local.md"]);
    }
    let mut project_rules = vec![(".grok/rules", false)];
    if compat.claude_rules {
        project_rules.push((".claude/rules", false));
    }
    if compat.cursor_rules {
        project_rules.push((".cursor/rules", true));
    }
    for dir in dirs {
        collect_grok_root(
            dir,
            &project_names,
            &project_rules,
            Some(project),
            &mut sources,
        );
    }

    let mut seen = HashSet::new();
    let mut sections = Vec::new();
    let mut remaining = MAX_CONTEXT_CHARS_TOTAL;
    for source in sources {
        if remaining == 0 {
            push_context_budget_warning(warnings);
            break;
        }
        let Ok(canonical) = canonicalize(&source) else {
            continue;
        };
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let allowed = path_starts_with(&canonical, project)
            || home
                .as_ref()
                .is_some_and(|root| path_starts_with(&canonical, root))
            || user_home.as_ref().is_some_and(|user| {
                path_starts_with(&canonical, &user.join(".claude"))
                    || path_starts_with(&canonical, &user.join(".cursor"))
            });
        if !allowed {
            continue;
        }
        let Ok((content, truncated)) = read_grok_context_file(&canonical) else {
            warnings.push(format!("Could not read {}", source.display()));
            continue;
        };
        let content = if source
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name.eq_ignore_ascii_case("rules"))
        {
            grok_rule_body(&content)
        } else {
            content
        };
        if truncated {
            warnings.push(format!(
                "Grok Build instruction file exceeds {GROK_MAX_CONTEXT_CHARS_PER_FILE} characters and was truncated for preview: {}",
                source.display()
            ));
        }
        let mut output = String::new();
        append_context_text(&mut output, &content, &mut remaining, warnings);
        sections.push(ContextSection {
            scope: source
                .parent()
                .and_then(|parent| parent.strip_prefix(project).ok())
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "agent-home".into()),
            source,
            content: output,
            precedence: sections.len(),
        });
    }
    sections
}

fn collect_grok_root(
    root: &Path,
    names: &[&str],
    rule_dirs: &[(&str, bool)],
    git_root: Option<&Path>,
    output: &mut Vec<PathBuf>,
) {
    for name in names {
        let path = root.join(name);
        if grok_source_is_safe(root, &path, git_root) {
            output.push(path);
        }
    }
    for (relative, accepts_mdc) in rule_dirs {
        let rules = root.join(relative);
        let Ok(metadata) = fs::symlink_metadata(&rules) else {
            continue;
        };
        if !metadata.file_type().is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&rules) else {
            continue;
        };
        let mut files = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        extension.eq_ignore_ascii_case("md")
                            || (*accepts_mdc && extension.eq_ignore_ascii_case("mdc"))
                    })
                    && grok_source_is_safe(root, path, None)
            })
            .collect::<Vec<_>>();
        if let Some(git_root) = git_root {
            retain_not_git_ignored(git_root, &mut files);
        }
        files.sort();
        output.extend(files);
    }
}

fn grok_source_is_safe(root: &Path, path: &Path, git_root: Option<&Path>) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    let Ok(canonical) = canonicalize(path) else {
        return false;
    };
    path_starts_with(&canonical, root)
        && git_root.is_none_or(|git_root| !git_path_is_ignored(git_root, path))
}

fn git_path_is_ignored(git_root: &Path, path: &Path) -> bool {
    Command::new("git")
        .current_dir(git_root)
        .args(["check-ignore", "--quiet", "--no-index", "--"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn retain_not_git_ignored(git_root: &Path, paths: &mut Vec<PathBuf>) {
    let Some(ignored) = git_ignored_paths(git_root, paths) else {
        paths.retain(|path| !git_path_is_ignored(git_root, path));
        return;
    };
    paths.retain(|path| !ignored.contains(path));
}

fn git_ignored_paths(git_root: &Path, paths: &[PathBuf]) -> Option<HashSet<PathBuf>> {
    if paths.is_empty() {
        return Some(HashSet::new());
    }
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.to_str()?.as_bytes());
        input.push(0);
    }

    let mut child = Command::new("git")
        .current_dir(git_root)
        .args(["check-ignore", "--no-index", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    // Drain stdout while paths are still being written so large ignored sets cannot fill the pipe.
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output().ok()?;
    writer.join().ok()?.ok()?;
    if !output.status.success() && output.status.code() != Some(1) {
        return None;
    }

    let output = String::from_utf8(output.stdout).ok()?;
    Some(
        output
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .collect(),
    )
}

fn read_grok_context_file(path: &Path) -> Result<(String, bool)> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        bail!("Grok Build instruction source must be a regular file");
    }
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take((GROK_MAX_CONTEXT_CHARS_PER_FILE * 4 + 4) as u64)
        .read_to_end(&mut bytes)?;
    let raw = match String::from_utf8(bytes) {
        Ok(value) => value,
        Err(error) if error.utf8_error().error_len().is_none() => {
            let valid_up_to = error.utf8_error().valid_up_to();
            let mut bytes = error.into_bytes();
            bytes.truncate(valid_up_to);
            String::from_utf8(bytes).expect("the validated UTF-8 prefix must remain valid")
        }
        Err(error) => return Err(error.into()),
    };
    let truncated = raw.chars().count() > GROK_MAX_CONTEXT_CHARS_PER_FILE;
    let content = if truncated {
        raw.chars().take(GROK_MAX_CONTEXT_CHARS_PER_FILE).collect()
    } else {
        raw
    };
    Ok((content, truncated))
}

fn grok_rule_body(content: &str) -> String {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return content.to_string();
    }
    let remaining = lines.collect::<Vec<_>>();
    let Some(end) = remaining.iter().position(|line| line.trim() == "---") else {
        return content.to_string();
    };
    remaining[end + 1..].join("\n")
}

fn deepseek_harness_sections(
    root: &Path,
    dirs: &[PathBuf],
    warnings: &mut Vec<String>,
) -> Vec<ContextSection> {
    let mut sections = Vec::new();
    let mut remaining = DSH_MAX_CONTEXT_BYTES;
    if let Some(home) = deepseek_harness_home() {
        let global = home.join("AGENTS.md");
        push_deepseek_section(
            &mut sections,
            global,
            "agent-home".into(),
            &mut remaining,
            warnings,
        );
        if deepseek_custom_loading_rules(&home) {
            warnings.push(
                "DeepSeek Harness custom instruction or Skill loading rules were detected; this preview uses the public default rules"
                    .into(),
            );
        }
    }
    for dir in dirs {
        let scope = dir
            .strip_prefix(root)
            .unwrap_or(Path::new("."))
            .display()
            .to_string();
        let mut seen = HashSet::new();
        for name in [
            "AGENTS.md",
            "CLAUDE.md",
            "AGENTS.local.md",
            "CLAUDE.local.md",
        ] {
            let path = dir.join(name);
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            if metadata.len() > DSH_MAX_SOURCE_BYTES {
                warnings.push(format!(
                    "DeepSeek Harness instruction file exceeds 1 MiB and was skipped: {}",
                    path.display()
                ));
                continue;
            }
            let Ok(content) = read_utf8_file_with_limit(&path, DSH_MAX_SOURCE_BYTES) else {
                warnings.push(format!("Could not read {}", path.display()));
                continue;
            };
            let normalized = content.trim().to_string();
            if !seen.insert(normalized) {
                continue;
            }
            if name == "CLAUDE.md" && content.lines().any(|line| line.trim() == "@AGENTS.md") {
                warnings.push(
                    "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import"
                        .into(),
                );
            }
            push_deepseek_content(
                &mut sections,
                path,
                scope.clone(),
                content,
                &mut remaining,
                warnings,
            );
        }
    }
    sections
}

fn push_deepseek_section(
    sections: &mut Vec<ContextSection>,
    path: PathBuf,
    scope: String,
    remaining: &mut usize,
    warnings: &mut Vec<String>,
) {
    let Ok(metadata) = fs::metadata(&path) else {
        return;
    };
    if !metadata.is_file() {
        return;
    }
    if metadata.len() > DSH_MAX_SOURCE_BYTES {
        warnings.push(format!(
            "DeepSeek Harness instruction file exceeds 1 MiB and was skipped: {}",
            path.display()
        ));
        return;
    }
    match read_utf8_file_with_limit(&path, DSH_MAX_SOURCE_BYTES) {
        Ok(content) => push_deepseek_content(sections, path, scope, content, remaining, warnings),
        Err(error) => warnings.push(format!("Could not read {}: {error}", path.display())),
    }
}

fn read_utf8_file_with_limit(path: &Path, limit: u64) -> Result<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!("file exceeds the {limit}-byte read limit");
    }
    Ok(String::from_utf8(bytes)?)
}

fn push_deepseek_content(
    sections: &mut Vec<ContextSection>,
    path: PathBuf,
    scope: String,
    content: String,
    remaining: &mut usize,
    warnings: &mut Vec<String>,
) {
    if *remaining == 0 {
        warnings.push("DeepSeek Harness instruction budget of 64 KiB was exhausted".into());
        return;
    }
    let take = content.len().min(*remaining);
    let mut boundary = take;
    while boundary > 0 && !content.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let truncated = boundary < content.len();
    sections.push(ContextSection {
        source: path.clone(),
        scope,
        content: content[..boundary].to_string(),
        precedence: sections.len(),
    });
    *remaining = remaining.saturating_sub(boundary);
    if truncated {
        warnings.push(format!(
            "DeepSeek Harness instruction budget of 64 KiB truncated {}",
            path.display()
        ));
    }
}

fn deepseek_custom_loading_rules(home: &Path) -> bool {
    let mut candidates = vec![home.join("cordis.patch.yml")];
    let profiles = home.join("profiles");
    if let Ok(entries) = fs::read_dir(profiles) {
        candidates.extend(
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("cordis.patch.yml")),
        );
    }
    candidates.into_iter().any(|path| {
        read_context_file(&path).is_ok_and(|(content, _)| {
            content.contains("agent-instructions") || content.contains("skill-filesystem")
        })
    })
}

fn deepseek_harness_skills(root: &Path) -> Vec<String> {
    let mut names = BTreeSet::new();
    let mut roots = vec![root.join(".dsh/skills"), root.join(".agents/skills")];
    if let Some(home) = deepseek_harness_home() {
        roots.push(home.join("skills"));
    }
    if let Some(home) = user_home() {
        roots.push(home.join(".agents/skills"));
    }
    for skill_root in roots {
        let Ok(entries) = fs::read_dir(skill_root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let is_skill = path.is_dir() && path.join("SKILL.md").is_file()
                || path.extension().is_some_and(|extension| extension == "md");
            if is_skill && let Some(name) = path.file_stem().and_then(|value| value.to_str()) {
                names.insert(name.to_string());
            }
        }
    }
    names.into_iter().collect()
}

fn directory_chain(root: &Path, cwd: &Path) -> Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    let mut current = cwd;
    loop {
        dirs.push(current.to_path_buf());
        if equivalent(current, root) {
            break;
        }
        current = current
            .parent()
            .context("Working directory must be inside the project")?;
    }
    dirs.reverse();
    Ok(dirs)
}

fn codex_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    dirs.iter()
        .filter_map(|dir| first_existing(dir, &["AGENTS.override.md", "AGENTS.md"]))
        .collect()
}

fn claude_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for dir in dirs {
        for path in [
            dir.join("CLAUDE.md"),
            dir.join("CLAUDE.local.md"),
            dir.join(".claude/CLAUDE.md"),
        ] {
            if path.is_file() {
                result.push(path);
            }
        }
    }
    if let Some(root) = dirs.first() {
        let rules = root.join(".claude/rules");
        if let Ok(entries) = fs::read_dir(rules) {
            let mut files: Vec<_> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
                .collect();
            files.sort();
            result.extend(files);
        }
    }
    result
}

fn cursor_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for dir in dirs {
        let agents = dir.join("AGENTS.md");
        if agents.is_file() {
            result.push(agents);
        }
        let rules = dir.join(".cursor/rules");
        let Ok(entries) = fs::read_dir(rules) else {
            continue;
        };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "mdc"))
            .collect();
        files.sort();
        result.extend(files.into_iter().filter(|path| cursor_rule_is_always(path)));
    }
    result
}

fn opencode_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut result = dirs
        .iter()
        .filter_map(|dir| first_existing(dir, &["AGENTS.md", "CLAUDE.md"]))
        .collect::<Vec<_>>();
    let Some(root) = dirs.first() else {
        return result;
    };
    let managed = root.join(OPENCODE_MANAGED_INSTRUCTION);
    if opencode_managed_instruction_is_registered(root) && managed.is_file() {
        result.push(managed);
    }
    result
}

pub fn opencode_managed_instruction_is_registered(project: &Path) -> bool {
    [
        project.join("opencode.json"),
        project.join("opencode.jsonc"),
        project.join(".opencode/opencode.json"),
        project.join(".opencode/opencode.jsonc"),
    ]
    .iter()
    .any(|config| opencode_config_registers_managed_instruction(config))
}

fn opencode_config_registers_managed_instruction(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > DSH_MAX_SOURCE_BYTES {
        return false;
    }
    let Ok(content) = read_utf8_file_with_limit(path, DSH_MAX_SOURCE_BYTES) else {
        return false;
    };
    let value = if path.extension().and_then(|value| value.to_str()) == Some("jsonc") {
        json5::from_str::<serde_json::Value>(&content).ok()
    } else {
        serde_json::from_str::<serde_json::Value>(&content).ok()
    };
    value
        .and_then(|value| value.get("instructions")?.as_array().cloned())
        .is_some_and(|instructions| {
            instructions.iter().any(|instruction| {
                instruction.as_str().is_some_and(|value| {
                    opencode_instruction_pattern_matches(
                        value.trim_start_matches("./"),
                        OPENCODE_MANAGED_INSTRUCTION,
                    )
                })
            })
        })
}

fn opencode_instruction_pattern_matches(pattern: &str, target: &str) -> bool {
    fn segment_matches(pattern: &[u8], target: &[u8]) -> bool {
        let (mut pattern_index, mut target_index) = (0, 0);
        let mut star = None;
        let mut star_target_index = 0;
        while target_index < target.len() {
            if pattern_index < pattern.len()
                && (pattern[pattern_index] == b'?'
                    || pattern[pattern_index] == target[target_index])
            {
                pattern_index += 1;
                target_index += 1;
            } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
                star = Some(pattern_index);
                star_target_index = target_index;
                pattern_index += 1;
            } else if let Some(star_index) = star {
                star_target_index += 1;
                target_index = star_target_index;
                pattern_index = star_index + 1;
            } else {
                return false;
            }
        }
        while pattern.get(pattern_index) == Some(&b'*') {
            pattern_index += 1;
        }
        pattern_index == pattern.len()
    }

    fn path_matches(pattern: &[&str], target: &[&str]) -> bool {
        let (mut pattern_index, mut target_index) = (0, 0);
        let mut globstar = None;
        let mut globstar_target_index = 0;
        while target_index < target.len() {
            if pattern_index < pattern.len()
                && pattern[pattern_index] != "**"
                && segment_matches(
                    pattern[pattern_index].as_bytes(),
                    target[target_index].as_bytes(),
                )
            {
                pattern_index += 1;
                target_index += 1;
            } else if pattern.get(pattern_index) == Some(&"**") {
                globstar = Some(pattern_index);
                globstar_target_index = target_index;
                pattern_index += 1;
            } else if let Some(globstar_index) = globstar {
                globstar_target_index += 1;
                target_index = globstar_target_index;
                pattern_index = globstar_index + 1;
            } else {
                return false;
            }
        }
        while pattern.get(pattern_index) == Some(&"**") {
            pattern_index += 1;
        }
        pattern_index == pattern.len()
    }

    let pattern = pattern.split('/').collect::<Vec<_>>();
    let target = target.split('/').collect::<Vec<_>>();
    path_matches(&pattern, &target)
}

fn cursor_rule_is_always(path: &Path) -> bool {
    read_context_file(path).is_ok_and(|(content, _)| {
        let mut lines = content.lines();
        if lines.next().map(str::trim) != Some("---") {
            return false;
        }
        lines.take_while(|line| line.trim() != "---").any(|line| {
            line.split_once(':').is_some_and(|(key, value)| {
                key.trim() == "alwaysApply" && value.trim().eq_ignore_ascii_case("true")
            })
        })
    })
}

fn openclaw_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let Some(root) = dirs.first() else {
        return Vec::new();
    };
    let mut result = [
        "AGENTS.md",
        "SOUL.md",
        "IDENTITY.md",
        "USER.md",
        "TOOLS.md",
        "MEMORY.md",
    ]
    .into_iter()
    .map(|name| root.join(name))
    .filter(|path| path.is_file())
    .collect::<Vec<_>>();
    result.extend(
        dirs.iter()
            .skip(1)
            .map(|dir| dir.join("AGENTS.md"))
            .filter(|path| path.is_file()),
    );
    result
}

fn hermes_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    dirs.iter()
        .filter_map(|dir| {
            first_existing(
                dir,
                &[
                    ".hermes.md",
                    "HERMES.md",
                    "AGENTS.md",
                    "CLAUDE.md",
                    ".cursorrules",
                ],
            )
        })
        .collect()
}

fn first_existing(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn load_with_imports(
    path: &Path,
    project: &Path,
    visited: &mut HashSet<PathBuf>,
    depth: usize,
    remaining_context_chars: &mut usize,
    warnings: &mut Vec<String>,
) -> Result<String> {
    if depth > 5 {
        bail!("Instruction import depth exceeds 5: {}", path.display());
    }
    let canonical = canonicalize(path)?;
    if !path_starts_with(&canonical, project) {
        bail!(
            "Refusing to import instructions outside the project: {}",
            path.display()
        );
    }
    if !visited.insert(canonical.clone()) {
        bail!("Circular instruction import detected: {}", path.display());
    }
    let (content, truncated) = read_context_file(&canonical)
        .with_context(|| format!("Could not read {}", path.display()))?;
    if truncated {
        warnings.push(format!(
            "Instruction file exceeds {} characters and was truncated for preview: {}",
            MAX_CONTEXT_CHARS_PER_FILE,
            path.display()
        ));
    }
    let mut output = String::new();
    for line in content.lines() {
        if *remaining_context_chars == 0 {
            push_context_budget_warning(warnings);
            break;
        }
        let trimmed = line.trim();
        if let Some(import_path) = trimmed
            .strip_prefix('@')
            .filter(|value| !value.contains(' '))
        {
            let imported = canonical
                .parent()
                .unwrap_or(Path::new("."))
                .join(import_path);
            if imported.is_file() {
                output.push_str(&load_with_imports(
                    &imported,
                    project,
                    visited,
                    depth + 1,
                    remaining_context_chars,
                    warnings,
                )?);
                append_context_text(&mut output, "\n", remaining_context_chars, warnings);
                continue;
            }
            warnings.push(format!(
                "Imported file is missing: {} (source: {})",
                imported.display(),
                canonical.display()
            ));
        }
        append_context_text(&mut output, line, remaining_context_chars, warnings);
        append_context_text(&mut output, "\n", remaining_context_chars, warnings);
    }
    visited.remove(&canonical);
    Ok(output)
}

fn append_context_text(
    output: &mut String,
    value: &str,
    remaining_context_chars: &mut usize,
    warnings: &mut Vec<String>,
) {
    let mut chars = value.chars();
    let chunk = chars
        .by_ref()
        .take(*remaining_context_chars)
        .collect::<String>();
    let used = chunk.chars().count();
    output.push_str(&chunk);
    *remaining_context_chars = remaining_context_chars.saturating_sub(used);
    if chars.next().is_some() {
        push_context_budget_warning(warnings);
    }
}

fn push_context_budget_warning(warnings: &mut Vec<String>) {
    let warning = format!(
        "Resolved project instructions exceed {} characters and were truncated for preview",
        MAX_CONTEXT_CHARS_TOTAL
    );
    if !warnings.contains(&warning) {
        warnings.push(warning);
    }
}

fn read_context_file(path: &Path) -> Result<(String, bool)> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(MAX_CONTEXT_BYTES_PER_FILE + 1)
        .read_to_end(&mut bytes)?;
    let exceeded_byte_limit = bytes.len() as u64 > MAX_CONTEXT_BYTES_PER_FILE;
    if exceeded_byte_limit {
        bytes.truncate(MAX_CONTEXT_BYTES_PER_FILE as usize);
    }

    let raw = match String::from_utf8(bytes) {
        Ok(value) => value,
        Err(error) if exceeded_byte_limit && error.utf8_error().error_len().is_none() => {
            let valid_up_to = error.utf8_error().valid_up_to();
            let mut bytes = error.into_bytes();
            bytes.truncate(valid_up_to);
            String::from_utf8(bytes).expect("the validated UTF-8 prefix must remain valid")
        }
        Err(error) => return Err(error.into()),
    };
    let exceeded_character_limit = raw.chars().count() > MAX_CONTEXT_CHARS_PER_FILE;
    let content = if exceeded_character_limit {
        raw.chars().take(MAX_CONTEXT_CHARS_PER_FILE).collect()
    } else {
        raw
    };
    Ok((content, exceeded_byte_limit || exceeded_character_limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn grok_build_context_matches_home_compat_and_project_precedence() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let nested = project.join("src/module");
        let grok_home = dir.path().join("grok-home");
        let user_home = dir.path().join("user-home");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(grok_home.join("rules")).unwrap();
        fs::create_dir_all(user_home.join(".claude/rules")).unwrap();
        fs::create_dir_all(user_home.join(".cursor/rules")).unwrap();
        fs::create_dir_all(project.join(".grok/rules")).unwrap();
        fs::create_dir_all(project.join(".cursor/rules")).unwrap();
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&project)
            .status()
            .unwrap();
        fs::write(grok_home.join("AGENTS.md"), "global-named").unwrap();
        fs::write(grok_home.join("rules/global.md"), "global-rule").unwrap();
        fs::write(
            user_home.join(".claude/AGENTS.md"),
            "claude-compatible-home",
        )
        .unwrap();
        fs::write(
            user_home.join(".cursor/rules/global.mdc"),
            "---\ndescription: Global Cursor rule\n---\ncursor-compatible-home",
        )
        .unwrap();
        fs::write(project.join("Agents.md"), "project-named").unwrap();
        fs::write(
            project.join(".grok/rules/project.md"),
            "---\ndescription: Project rule\n---\nproject-rule",
        )
        .unwrap();
        fs::write(
            project.join(".cursor/rules/project.mdc"),
            "---\ndescription: Project Cursor rule\n---\ncursor-compatible-project",
        )
        .unwrap();
        fs::write(project.join(".grok/rules/ignored.md"), "ignored-rule").unwrap();
        fs::write(
            project.join(".grok/rules/ignored-too.md"),
            "ignored-rule-too",
        )
        .unwrap();
        fs::write(project.join(".grok/rules/kept.md"), "kept-rule").unwrap();
        fs::write(project.join(".gitignore"), ".grok/rules/ignored*.md\n").unwrap();
        fs::write(nested.join("AGENTS.md"), "nested-named").unwrap();

        let dirs = directory_chain(&project, &nested).unwrap();
        let mut warnings = Vec::new();
        let sections = grok_build_sections_with_roots(
            &project,
            &dirs,
            Some(grok_home),
            Some(user_home),
            GrokCompat::default(),
            &mut warnings,
        );
        let contents = sections
            .iter()
            .map(|section| section.content.trim())
            .collect::<Vec<_>>();

        assert_eq!(
            contents,
            [
                "global-named",
                "global-rule",
                "claude-compatible-home",
                "cursor-compatible-home",
                "project-named",
                "kept-rule",
                "project-rule",
                "cursor-compatible-project",
                "nested-named",
            ]
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn grok_build_compat_uses_env_then_project_then_home_then_defaults() {
        let home: toml::Value = toml::from_str(
            "[compat.claude]\nagents = false\nrules = false\n\n[compat.cursor]\nagents = false\n",
        )
        .unwrap();
        let project: toml::Value = toml::from_str("[compat.claude]\nagents = true\n").unwrap();
        let compat = resolve_grok_compat_values(Some(&home), Some(&project), |name| {
            (name == "GROK_CURSOR_AGENTS_ENABLED").then_some(true)
        });

        assert!(compat.claude_agents);
        assert!(!compat.claude_rules);
        assert!(compat.cursor_agents);
        assert!(compat.cursor_rules);
    }

    #[test]
    fn grok_build_context_caps_each_instruction_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "x".repeat(10_050)).unwrap();
        let mut warnings = Vec::new();
        let sections = grok_build_sections_with_roots(
            dir.path(),
            &[dir.path().to_path_buf()],
            None,
            None,
            GrokCompat {
                claude_agents: false,
                claude_rules: false,
                cursor_agents: false,
                cursor_rules: false,
            },
            &mut warnings,
        );

        assert_eq!(sections[0].content.chars().count(), 10_000);
        assert!(warnings.iter().any(|warning| warning.contains("10000")));
    }

    #[cfg(unix)]
    #[test]
    fn grok_build_context_accepts_a_symlinked_home_root() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let actual_home = dir.path().join("actual-grok-home");
        let linked_home = dir.path().join("linked-grok-home");
        fs::create_dir(&project).unwrap();
        fs::create_dir_all(actual_home.join("rules")).unwrap();
        fs::write(actual_home.join("AGENTS.md"), "global instructions").unwrap();
        fs::write(actual_home.join("rules/global.md"), "global rule").unwrap();
        symlink(&actual_home, &linked_home).unwrap();

        let mut warnings = Vec::new();
        let sections = grok_build_sections_with_roots(
            &project,
            std::slice::from_ref(&project),
            Some(linked_home),
            None,
            GrokCompat::default(),
            &mut warnings,
        );

        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].content, "global instructions");
        assert_eq!(sections[1].content, "global rule");
        assert!(warnings.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn grok_build_context_rejects_rules_symlinked_outside_the_root() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        fs::create_dir_all(project.join(".grok/rules")).unwrap();
        let outside = dir.path().join("outside.md");
        fs::write(&outside, "private").unwrap();
        symlink(&outside, project.join(".grok/rules/private.md")).unwrap();
        let mut warnings = Vec::new();
        let sections = grok_build_sections_with_roots(
            &project,
            std::slice::from_ref(&project),
            None,
            None,
            GrokCompat::default(),
            &mut warnings,
        );

        assert!(sections.is_empty());
    }

    #[test]
    fn codex_context_inherits_root_and_nested_rules_in_order() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("src/module");
        fs::create_dir_all(&nested).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "root").unwrap();
        fs::write(dir.path().join("src/AGENTS.md"), "src").unwrap();
        let preview = resolve_context(dir.path(), &nested, AgentKind::Codex, None, vec![]).unwrap();
        assert_eq!(preview.sections.len(), 2);
        assert_eq!(preview.sections[0].content.trim(), "root");
        assert_eq!(preview.sections[1].content.trim(), "src");
    }

    #[test]
    fn missing_import_is_reported() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "@missing.md").unwrap();
        let preview =
            resolve_context(dir.path(), dir.path(), AgentKind::ClaudeCode, None, vec![]).unwrap();
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("Imported file is missing"))
        );
    }

    #[test]
    fn oversized_instruction_is_read_within_the_preview_bound() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("AGENTS.md");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_CONTEXT_BYTES_PER_FILE + 1).unwrap();

        let (content, truncated) = read_context_file(&path).unwrap();

        assert_eq!(content.chars().count(), MAX_CONTEXT_CHARS_PER_FILE);
        assert!(truncated);
    }

    #[test]
    fn deepseek_source_read_keeps_the_one_mib_hard_limit() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("AGENTS.md");
        fs::File::create(&path)
            .unwrap()
            .set_len(DSH_MAX_SOURCE_BYTES + 1)
            .unwrap();

        let error = read_utf8_file_with_limit(&path, DSH_MAX_SOURCE_BYTES).unwrap_err();

        assert!(error.to_string().contains("read limit"));
    }

    #[test]
    fn bounded_instruction_read_keeps_complete_utf8_characters() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("AGENTS.md"),
            "中".repeat(MAX_CONTEXT_BYTES_PER_FILE as usize / 3 + 2),
        )
        .unwrap();

        let (content, truncated) = read_context_file(&dir.path().join("AGENTS.md")).unwrap();

        assert_eq!(content.chars().count(), MAX_CONTEXT_CHARS_PER_FILE);
        assert!(content.ends_with('中'));
        assert!(truncated);
    }

    #[test]
    fn repeated_imports_share_a_total_context_budget() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "@part.md\n".repeat(8)).unwrap();
        fs::write(
            dir.path().join("part.md"),
            "x".repeat(MAX_CONTEXT_CHARS_PER_FILE),
        )
        .unwrap();

        let preview =
            resolve_context(dir.path(), dir.path(), AgentKind::ClaudeCode, None, vec![]).unwrap();

        assert!(preview.sections[0].content.chars().count() <= MAX_CONTEXT_CHARS_TOTAL);
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("Resolved project instructions exceed"))
        );
    }

    #[test]
    fn cursor_rule_detection_does_not_read_an_oversized_file_in_full() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("always.mdc");
        fs::write(&path, "---\nalwaysApply: true\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_CONTEXT_BYTES_PER_FILE + 1)
            .unwrap();

        assert!(cursor_rule_is_always(&path));
    }

    #[test]
    fn cursor_context_uses_agents_and_only_always_rules() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("src");
        fs::create_dir(&nested).unwrap();
        fs::create_dir_all(dir.path().join(".cursor/rules")).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "shared").unwrap();
        fs::write(nested.join("AGENTS.md"), "nested").unwrap();
        fs::write(
            dir.path().join(".cursor/rules/always.mdc"),
            "---\nalwaysApply: true\n---\ncursor override",
        )
        .unwrap();
        fs::write(
            dir.path().join(".cursor/rules/manual.mdc"),
            "---\nalwaysApply: false\n---\nmanual rule",
        )
        .unwrap();

        let preview =
            resolve_context(dir.path(), &nested, AgentKind::Cursor, None, vec![]).unwrap();
        assert_eq!(preview.sections.len(), 3);
        assert_eq!(preview.sections[0].content.trim(), "shared");
        assert!(preview.sections[1].content.contains("cursor override"));
        assert_eq!(preview.sections[2].content.trim(), "nested");
    }

    #[test]
    fn opencode_prefers_agents_and_falls_back_to_claude_per_directory() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("src");
        fs::create_dir(&nested).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "root agents").unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "ignored root fallback").unwrap();
        fs::write(nested.join("CLAUDE.md"), "nested fallback").unwrap();

        let preview =
            resolve_context(dir.path(), &nested, AgentKind::OpenCode, None, vec![]).unwrap();

        assert_eq!(preview.sections.len(), 2);
        assert_eq!(preview.sections[0].content.trim(), "root agents");
        assert_eq!(preview.sections[1].content.trim(), "nested fallback");
    }

    #[test]
    fn opencode_includes_only_registered_managed_instructions() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".opencode")).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "shared").unwrap();
        fs::write(
            dir.path().join(OPENCODE_MANAGED_INSTRUCTION),
            "OpenCode override",
        )
        .unwrap();

        let unregistered =
            resolve_context(dir.path(), dir.path(), AgentKind::OpenCode, None, vec![]).unwrap();
        assert_eq!(unregistered.sections.len(), 1);

        fs::write(
            dir.path().join(".opencode/opencode.jsonc"),
            "{ // OpenCode accepts JSONC\n instructions: ['.opencode/*.md'],\n}",
        )
        .unwrap();
        let registered =
            resolve_context(dir.path(), dir.path(), AgentKind::OpenCode, None, vec![]).unwrap();

        assert_eq!(registered.sections.len(), 2);
        assert!(equivalent(
            &registered.sections[1].source,
            &dir.path().join(OPENCODE_MANAGED_INSTRUCTION)
        ));
        assert_eq!(registered.sections[1].content.trim(), "OpenCode override");
    }

    #[test]
    fn opencode_registration_matches_component_and_recursive_globs() {
        assert!(opencode_instruction_pattern_matches(
            ".opencode/*.md",
            OPENCODE_MANAGED_INSTRUCTION
        ));
        assert!(opencode_instruction_pattern_matches(
            "**/agentkib-*.md",
            OPENCODE_MANAGED_INSTRUCTION
        ));
        assert!(!opencode_instruction_pattern_matches(
            "docs/*.md",
            OPENCODE_MANAGED_INSTRUCTION
        ));
    }

    #[test]
    fn openclaw_context_inherits_nested_agents_rules() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("src");
        fs::create_dir(&nested).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "shared").unwrap();
        fs::write(dir.path().join("TOOLS.md"), "tools").unwrap();
        fs::write(nested.join("AGENTS.md"), "nested").unwrap();

        let preview =
            resolve_context(dir.path(), &nested, AgentKind::OpenClaw, None, vec![]).unwrap();
        assert_eq!(preview.sections.len(), 3);
        assert_eq!(preview.sections[0].content.trim(), "shared");
        assert_eq!(preview.sections[1].content.trim(), "tools");
        assert_eq!(preview.sections[2].content.trim(), "nested");
    }

    #[test]
    fn import_cannot_escape_project() {
        let parent = tempdir().unwrap();
        let project = parent.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::write(parent.path().join("outside.md"), "secret").unwrap();
        fs::write(project.join("CLAUDE.md"), "@../outside.md").unwrap();
        let preview =
            resolve_context(&project, &project, AgentKind::ClaudeCode, None, vec![]).unwrap();
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("outside the project"))
        );
        assert!(preview.sections.is_empty());
    }

    #[test]
    fn deepseek_harness_loads_overlays_in_order_and_keeps_claude_import_literal() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("src");
        fs::create_dir(&nested).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "root rules").unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "@AGENTS.md\nclaude rules").unwrap();
        fs::write(nested.join("AGENTS.md"), "nested rules").unwrap();
        fs::write(nested.join("AGENTS.local.md"), "local override").unwrap();

        let preview = resolve_context(
            dir.path(),
            &nested,
            AgentKind::DeepSeekHarness,
            None,
            vec!["must not be shared".into()],
        )
        .unwrap();
        let project = canonicalize(dir.path()).unwrap();
        let project_sections: Vec<_> = preview
            .sections
            .iter()
            .filter(|section| section.source.starts_with(&project))
            .collect();

        assert_eq!(project_sections.len(), 4);
        assert_eq!(project_sections[0].source, project.join("AGENTS.md"));
        assert_eq!(project_sections[1].source, project.join("CLAUDE.md"));
        assert_eq!(project_sections[2].source, project.join("src/AGENTS.md"));
        assert_eq!(
            project_sections[3].source,
            project.join("src/AGENTS.local.md")
        );
        assert!(project_sections[1].content.contains("@AGENTS.md"));
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("literal text"))
        );
        assert!(preview.approved_memories.is_empty());
        assert!(preview.visible_connections.is_empty());
    }
}
