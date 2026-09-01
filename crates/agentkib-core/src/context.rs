use std::collections::{BTreeSet, HashSet};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use agentkib_platform::path::{canonicalize, equivalent, starts_with as path_starts_with};
use anyhow::{Context, Result, bail};

use crate::{AgentKind, ContextPreview, ContextSection, Manifest, canonical_project};

const MAX_CONTEXT_CHARS_PER_FILE: usize = 128 * 1024;
const MAX_CONTEXT_BYTES_PER_FILE: u64 = MAX_CONTEXT_CHARS_PER_FILE as u64 * 4;
const MAX_CONTEXT_CHARS_TOTAL: usize = 512 * 1024;
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
        AgentKind::DeepSeekHarness => Vec::new(),
    };
    let mut sections = if agent == AgentKind::DeepSeekHarness {
        deepseek_harness_sections(&context_root, &dirs, &mut warnings)
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
    let registered = [
        root.join("opencode.json"),
        root.join("opencode.jsonc"),
        root.join(".opencode/opencode.json"),
        root.join(".opencode/opencode.jsonc"),
    ]
    .iter()
    .any(|config| opencode_registers_managed_instruction(config));
    if registered && managed.is_file() {
        result.push(managed);
    }
    result
}

fn opencode_registers_managed_instruction(path: &Path) -> bool {
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
                    value.trim_start_matches("./") == OPENCODE_MANAGED_INSTRUCTION
                })
            })
        })
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
            "{ // OpenCode accepts JSONC\n instructions: ['./.opencode/agentkib-instructions.md'],\n}",
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
