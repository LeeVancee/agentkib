use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use agentkib_platform::path::{equivalent, is_safe_scan_entry};
use anyhow::Result;
use chrono::Utc;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::manifest::manifest_entry_exists;
use crate::{
    AgentKind, AssetKind, ContextDoctorReport, ContextDoctorSummary, DoctorAgentRow,
    DoctorAssetStatus, DoctorEvidence, DoctorIssue, DoctorSeverity, DoctorStatus, Manifest,
    hash_content, load_manifest, manifest_path, resolve_context, scan_workspace,
};

const MAX_MANAGED_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MANAGED_SKILL_FILES: usize = 512;
const MAX_MANAGED_SKILL_BYTES: u64 = 32 * 1024 * 1024;
const MANAGED_MARKDOWN_START: &str = "<!-- agentkib:managed:start -->";

pub fn diagnose_workspace(
    project: &Path,
    workspace_id: &str,
    installed_agents: &BTreeSet<AgentKind>,
    visible_connections: &BTreeMap<AgentKind, Vec<String>>,
) -> Result<ContextDoctorReport> {
    diagnose_workspace_with_mcp_error(
        project,
        workspace_id,
        installed_agents,
        visible_connections,
        None,
    )
}

pub fn diagnose_workspace_with_mcp_error(
    project: &Path,
    workspace_id: &str,
    installed_agents: &BTreeSet<AgentKind>,
    visible_connections: &BTreeMap<AgentKind, Vec<String>>,
    mcp_load_error: Option<&str>,
) -> Result<ContextDoctorReport> {
    let scan = scan_workspace(project)?;
    let project = scan.root.as_path();
    let manifest_result = if manifest_entry_exists(project) {
        Some(load_manifest(project))
    } else {
        None
    };
    let manifest = manifest_result
        .as_ref()
        .and_then(|value| value.as_ref().ok());
    let manifest_invalid = manifest_result.as_ref().is_some_and(Result::is_err);
    let mut issues = Vec::new();

    if let Some(error) = mcp_load_error {
        push_issue(
            &mut issues,
            "mcp.config-unavailable",
            DoctorSeverity::Error,
            None,
            Some(AssetKind::Configuration),
            false,
            None,
            error.to_string(),
            Some("Readable, valid MCP configuration".into()),
            Some("Unavailable".into()),
        );
    }

    if let Some(Err(error)) = manifest_result.as_ref() {
        push_issue(
            &mut issues,
            "manifest.invalid",
            DoctorSeverity::Error,
            None,
            Some(AssetKind::Configuration),
            false,
            Some(manifest_path(project)),
            error.to_string(),
            None,
            None,
        );
    }

    let manifest_error = manifest_result
        .as_ref()
        .and_then(|result| result.as_ref().err())
        .map(ToString::to_string);
    for warning in &scan.warnings {
        if manifest_error.as_deref() == Some(warning) {
            continue;
        }
        push_issue(
            &mut issues,
            "native.invalid",
            DoctorSeverity::Error,
            scan.agents
                .iter()
                .find(|item| item.warnings.contains(warning))
                .map(|item| item.agent),
            Some(AssetKind::Configuration),
            false,
            None,
            warning.clone(),
            None,
            None,
        );
    }

    if let Some(manifest) = manifest {
        diagnose_skill_sources(project, manifest, &mut issues);
        diagnose_managed_files(project, manifest, &mut issues);
    }

    let mut matrix = Vec::new();
    for agent in AgentKind::ALL {
        let detected = scan
            .agents
            .iter()
            .find(|item| item.agent == agent)
            .is_some_and(|item| item.detected);
        let native_configuration_valid = scan
            .agents
            .iter()
            .find(|item| item.agent == agent)
            .is_none_or(|item| item.warnings.is_empty());
        let installed = installed_agents.contains(&agent);
        let applicable = detected || installed;
        let writable = AgentKind::WRITABLE.contains(&agent);
        let enabled = writable
            && manifest.map_or(applicable, |value| {
                value.adapters.get(&agent).is_none_or(|state| state.enabled)
            });
        let diagnostically_active = applicable && (enabled || agent == AgentKind::DeepSeekHarness);
        let expected_instruction_fragments = manifest
            .map(|value| {
                let mut fragments = Vec::new();
                if !value.instructions.shared.trim().is_empty() {
                    fragments.push((
                        project.to_path_buf(),
                        value.instructions.shared.as_str(),
                        false,
                    ));
                }
                if let Some(platform_override) = value
                    .instructions
                    .platform_overrides
                    .get(&agent)
                    .filter(|content| !content.trim().is_empty())
                {
                    fragments.push((project.to_path_buf(), platform_override.as_str(), false));
                }
                for scoped in &value.instructions.scoped {
                    if !scoped.content.trim().is_empty() {
                        fragments.push((project.join(&scoped.path), scoped.content.as_str(), true));
                    }
                }
                fragments
            })
            .unwrap_or_default();
        let instruction_expected = expected_instruction_fragments.len();
        let mut instruction_actual = 0;
        let mut skill_expected = 0;
        let mut skill_actual = 0;
        let mut skill_repairable = true;
        let expected_mcp_names = manifest
            .filter(|_| writable)
            .map(|value| {
                value
                    .connections
                    .iter()
                    // `agentkib` is the native gateway, not a downstream server exposed by
                    // the effective MCP configuration that Doctor receives.
                    .filter(|connection| connection.name != "agentkib")
                    .filter(|connection| {
                        connection.targets.is_empty() || connection.targets.contains(&agent)
                    })
                    .map(|connection| connection.name.clone())
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();

        if let Some(manifest) = manifest {
            skill_expected = manifest
                .skills
                .iter()
                .filter(|skill| skill.targets.is_empty() || skill.targets.contains(&agent))
                .count();
            skill_actual = manifest
                .skills
                .iter()
                .filter(|skill| skill.targets.is_empty() || skill.targets.contains(&agent))
                .filter(|skill| generated_skill_is_current(project, manifest, agent, skill))
                .count();
            skill_repairable = manifest
                .skills
                .iter()
                .filter(|skill| skill.targets.is_empty() || skill.targets.contains(&agent))
                .filter(|skill| !generated_skill_is_current(project, manifest, agent, skill))
                .all(|skill| generated_skill_can_be_repaired(project, manifest, agent, skill));
        }

        if diagnostically_active {
            let mut context_cwds = vec![project.to_path_buf()];
            for (cwd, _, _) in &expected_instruction_fragments {
                if cwd.is_dir() && !context_cwds.contains(cwd) {
                    context_cwds.push(cwd.clone());
                }
            }
            let mut native_sections = Vec::new();
            let mut satisfied_fragments = BTreeSet::new();
            let mut indeterminate_fragments = BTreeSet::new();
            let mut seen_warnings = BTreeSet::new();
            let mut missing_instruction_reported = false;
            for cwd in context_cwds {
                match resolve_context(project, &cwd, agent, manifest, Vec::new()) {
                    Ok(preview) => {
                        let content_was_truncated = preview.warnings.iter().any(|warning| {
                            warning.contains("truncated for preview")
                                || warning.contains("instruction budget")
                        });
                        let current_sections = preview
                            .sections
                            .into_iter()
                            .filter(|section| section.scope != "platform-override")
                            .collect::<Vec<_>>();
                        let expected_here = expected_instruction_fragments
                            .iter()
                            .enumerate()
                            .filter(|(_, (expected_cwd, _, _))| expected_cwd == &cwd)
                            .collect::<Vec<_>>();
                        for (index, (_, expected, scoped)) in &expected_here {
                            if current_sections.iter().any(|section| {
                                contains_normalized(&section.content, expected)
                                    && (!scoped
                                        || section
                                            .source
                                            .parent()
                                            .is_some_and(|parent| equivalent(parent, &cwd)))
                            }) {
                                satisfied_fragments.insert(*index);
                            }
                        }
                        if content_was_truncated {
                            indeterminate_fragments
                                .extend(expected_here.iter().map(|(index, _)| *index));
                        }
                        for warning in preview.warnings {
                            let missing_instruction = warning.contains("No project instruction");
                            // The resolver exposes this advisory for the preview UI, but Doctor
                            // only reports conditions that can be proven from files and parsed
                            // context. A root without instructions is valid when only scoped
                            // instructions are configured.
                            if warning.contains("semantic conflicts")
                                || missing_instruction && expected_here.is_empty()
                                || !seen_warnings.insert(warning.clone())
                            {
                                continue;
                            }
                            missing_instruction_reported |= missing_instruction;
                            let repairable = missing_instruction
                                && enabled
                                && writable
                                && expected_here.iter().all(
                                    |(_, (expected_cwd, expected, scoped))| {
                                        instruction_fragment_can_be_repaired(
                                            project,
                                            expected_cwd,
                                            agent,
                                            manifest,
                                            expected,
                                            *scoped,
                                        )
                                    },
                                );
                            push_issue(
                                &mut issues,
                                if missing_instruction {
                                    "instruction.missing"
                                } else {
                                    "context.warning"
                                },
                                DoctorSeverity::Warning,
                                Some(agent),
                                Some(AssetKind::Instruction),
                                repairable,
                                Some(cwd.clone()),
                                warning,
                                None,
                                None,
                            );
                        }
                        for section in current_sections {
                            if native_sections
                                .iter()
                                .all(|existing: &crate::ContextSection| {
                                    existing.source != section.source
                                })
                            {
                                native_sections.push(section);
                            }
                        }
                    }
                    Err(error) => push_issue(
                        &mut issues,
                        "context.unavailable",
                        DoctorSeverity::Error,
                        Some(agent),
                        Some(AssetKind::Instruction),
                        false,
                        Some(cwd),
                        error.to_string(),
                        None,
                        None,
                    ),
                }
            }
            instruction_actual = if expected_instruction_fragments.is_empty() {
                native_sections.len()
            } else {
                satisfied_fragments.union(&indeterminate_fragments).count()
            };
            let native_section_refs = native_sections.iter().collect::<Vec<_>>();
            diagnose_exact_duplicates(agent, &native_section_refs, &mut issues);
            if instruction_actual < instruction_expected && !missing_instruction_reported {
                let missing_fragments = expected_instruction_fragments
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| {
                        !satisfied_fragments.contains(index)
                            && !indeterminate_fragments.contains(index)
                    })
                    .collect::<Vec<_>>();
                if !missing_fragments.is_empty() {
                    let evidence_path = missing_fragments
                        .first()
                        .map(|(_, (cwd, _, _))| cwd.clone());
                    let repairable = enabled
                        && writable
                        && missing_fragments
                            .iter()
                            .all(|(_, (cwd, expected, scoped))| {
                                instruction_fragment_can_be_repaired(
                                    project, cwd, agent, manifest, expected, *scoped,
                                )
                            });
                    push_issue(
                        &mut issues,
                        "instruction.expected-content-missing",
                        DoctorSeverity::Warning,
                        Some(agent),
                        Some(AssetKind::Instruction),
                        repairable,
                        evidence_path,
                        "Configured instructions are not present in native context sources".into(),
                        Some(instruction_expected.to_string()),
                        Some(instruction_actual.to_string()),
                    );
                }
            }
        }

        if diagnostically_active && skill_actual < skill_expected {
            push_issue(
                &mut issues,
                "skill.target-missing",
                DoctorSeverity::Warning,
                Some(agent),
                Some(AssetKind::Skill),
                enabled && writable && skill_repairable,
                None,
                "Manifest Skills are not all visible in the target Agent's project paths".into(),
                Some(skill_expected.to_string()),
                Some(skill_actual.to_string()),
            );
        }

        if agent == AgentKind::DeepSeekHarness && detected {
            push_issue(
                &mut issues,
                "agent.read-only",
                DoctorSeverity::Info,
                Some(agent),
                None,
                false,
                None,
                "DeepSeek Harness is available for diagnostics only".into(),
                None,
                None,
            );
        }

        let visible_mcp_names = visible_connections
            .get(&agent)
            .into_iter()
            .flatten()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mcp_expected = expected_mcp_names.len();
        let mcp_actual = if expected_mcp_names.is_empty() {
            visible_mcp_names.len()
        } else {
            expected_mcp_names.intersection(&visible_mcp_names).count()
        };
        let missing_mcp_names = expected_mcp_names
            .difference(&visible_mcp_names)
            .cloned()
            .collect::<Vec<_>>();
        if diagnostically_active && mcp_load_error.is_none() && !missing_mcp_names.is_empty() {
            push_issue(
                &mut issues,
                "mcp.target-missing",
                DoctorSeverity::Warning,
                Some(agent),
                Some(AssetKind::Connection),
                enabled
                    && writable
                    && native_configuration_valid
                    && mcp_target_can_be_repaired(project, agent),
                None,
                "Manifest MCP connections are not all visible to the target Agent".into(),
                Some(
                    expected_mcp_names
                        .into_iter()
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
                Some(visible_mcp_names.into_iter().collect::<Vec<_>>().join(", ")),
            );
        }
        let agent_issues: Vec<_> = issues
            .iter()
            .filter(|issue| issue.agent == Some(agent))
            .collect();
        let instruction_attention = agent_issues.iter().any(|issue| {
            issue.asset_kind == Some(AssetKind::Instruction)
                && issue.severity != DoctorSeverity::Info
        });
        let skill_attention = agent_issues.iter().any(|issue| {
            issue.asset_kind == Some(AssetKind::Skill) && issue.severity != DoctorSeverity::Info
        }) || skill_actual < skill_expected;
        let mcp_attention = mcp_load_error.is_some() && diagnostically_active
            || agent_issues.iter().any(|issue| {
                issue.asset_kind == Some(AssetKind::Connection)
                    && issue.severity != DoctorSeverity::Info
            });
        let base_status = if applicable && manifest_invalid {
            DoctorStatus::Unavailable
        } else if diagnostically_active {
            DoctorStatus::Healthy
        } else {
            DoctorStatus::NotApplicable
        };
        matrix.push(DoctorAgentRow {
            agent,
            detected,
            installed,
            enabled,
            writable,
            instructions: DoctorAssetStatus {
                status: attention_status(base_status, instruction_attention),
                expected: instruction_expected,
                actual: instruction_actual,
            },
            skills: DoctorAssetStatus {
                status: attention_status(base_status, skill_attention),
                expected: skill_expected,
                actual: skill_actual,
            },
            mcp: DoctorAssetStatus {
                status: if mcp_load_error.is_some() && diagnostically_active {
                    DoctorStatus::Unavailable
                } else {
                    attention_status(base_status, mcp_attention)
                },
                expected: mcp_expected,
                actual: mcp_actual,
            },
        });
    }

    for issue in &mut issues {
        for evidence in &mut issue.evidence {
            if evidence.path.is_none() {
                evidence.path = Some(project.to_path_buf());
            }
        }
    }
    if issues
        .iter()
        .any(|issue| issue_blocks_workspace_repair(project, issue))
    {
        for issue in &mut issues {
            issue.repairable = false;
        }
    }
    issues.sort_by_key(|issue| {
        (
            severity_rank(issue.severity),
            issue.code.clone(),
            issue.id.clone(),
        )
    });
    let summary = ContextDoctorSummary {
        workspace_id: workspace_id.to_string(),
        error_count: issues
            .iter()
            .filter(|issue| issue.severity == DoctorSeverity::Error)
            .count(),
        warning_count: issues
            .iter()
            .filter(|issue| issue.severity == DoctorSeverity::Warning)
            .count(),
        info_count: issues
            .iter()
            .filter(|issue| issue.severity == DoctorSeverity::Info)
            .count(),
        repairable_count: issues.iter().filter(|issue| issue.repairable).count(),
        checked_at: Utc::now(),
    };
    Ok(ContextDoctorReport {
        summary,
        matrix,
        issues,
    })
}

fn issue_blocks_workspace_repair(project: &Path, issue: &DoctorIssue) -> bool {
    if issue.repairable || issue.severity == DoctorSeverity::Info {
        return false;
    }
    match issue.code.as_str() {
        "skill.source-unavailable"
        | "native.invalid"
        | "context.unavailable"
        | "mcp.config-unavailable" => true,
        "managed.missing" | "managed.drift" => issue
            .evidence
            .iter()
            .filter_map(|evidence| evidence.path.as_deref())
            .any(|path| path.starts_with(project)),
        _ => false,
    }
}

fn diagnose_skill_sources(project: &Path, manifest: &Manifest, issues: &mut Vec<DoctorIssue>) {
    for skill in &manifest.skills {
        let source = project.join(&skill.path);
        let readable = managed_skill_files(project, &source).is_some();
        if !readable {
            push_issue(
                issues,
                "skill.source-unavailable",
                DoctorSeverity::Error,
                None,
                Some(AssetKind::Skill),
                false,
                Some(source),
                format!(
                    "Skill source is missing, unreadable, or has no SKILL.md: {}",
                    skill.name
                ),
                None,
                None,
            );
        }
    }
}

fn diagnose_managed_files(project: &Path, manifest: &Manifest, issues: &mut Vec<DoctorIssue>) {
    for (agent, state) in &manifest.adapters {
        if !state.enabled {
            continue;
        }
        for (target, expected) in &state.generated_hashes {
            let path = PathBuf::from(target);
            let path = if path.is_absolute() {
                path
            } else {
                project.join(path)
            };
            let file_hash = hash_managed_file(&path);
            let actual = match &file_hash {
                ManagedFileHash::Hashed(hash) => Some(hash.clone()),
                ManagedFileHash::Missing | ManagedFileHash::Unavailable => None,
            };
            if actual.as_deref() == Some(expected) {
                continue;
            }
            let missing = matches!(file_hash, ManagedFileHash::Missing);
            let unavailable = matches!(file_hash, ManagedFileHash::Unavailable);
            let project_scoped = path.starts_with(project);
            let safe_project_target = project_scoped && target_has_safe_ancestors(project, &path);
            push_issue(
                issues,
                if missing {
                    "managed.missing"
                } else {
                    "managed.drift"
                },
                DoctorSeverity::Warning,
                Some(*agent),
                Some(asset_kind_for_path(&path)),
                safe_project_target
                    && !unavailable
                    && state.enabled
                    && AgentKind::WRITABLE.contains(agent),
                Some(path),
                if missing {
                    "AgentKib-managed file is missing".into()
                } else if unavailable {
                    "AgentKib-managed file is not a readable bounded regular file".into()
                } else {
                    "AgentKib-managed file differs from its recorded hash".into()
                },
                Some(expected.clone()),
                actual,
            );
        }
    }
}

enum ManagedFileHash {
    Missing,
    Unavailable,
    Hashed(String),
}

fn hash_managed_file(path: &Path) -> ManagedFileHash {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ManagedFileHash::Missing;
        }
        Err(_) => return ManagedFileHash::Unavailable,
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_MANAGED_FILE_BYTES {
        return ManagedFileHash::Unavailable;
    }
    let Ok(file) = fs::File::open(path) else {
        return ManagedFileHash::Unavailable;
    };
    let mut reader = file.take(MAX_MANAGED_FILE_BYTES + 1);
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => return ManagedFileHash::Unavailable,
        };
        total += read as u64;
        if total > MAX_MANAGED_FILE_BYTES {
            return ManagedFileHash::Unavailable;
        }
        hasher.update(&buffer[..read]);
    }
    ManagedFileHash::Hashed(hex::encode(hasher.finalize()))
}

fn diagnose_exact_duplicates(
    agent: AgentKind,
    sections: &[&crate::ContextSection],
    issues: &mut Vec<DoctorIssue>,
) {
    let mut seen: HashMap<String, &Path> = HashMap::new();
    for section in sections {
        let normalized = normalize(&section.content);
        if normalized.is_empty() {
            continue;
        }
        if let Some(first) = seen.insert(normalized, &section.source) {
            push_issue(
                issues,
                "instruction.exact-duplicate",
                DoctorSeverity::Warning,
                Some(agent),
                Some(AssetKind::Instruction),
                false,
                Some(section.source.clone()),
                format!("Exact duplicate of {}", first.display()),
                None,
                None,
            );
        }
    }
}

fn instruction_fragment_can_be_repaired(
    project: &Path,
    cwd: &Path,
    agent: AgentKind,
    manifest: Option<&Manifest>,
    expected: &str,
    scoped: bool,
) -> bool {
    let platform_override = manifest
        .and_then(|manifest| manifest.instructions.platform_overrides.get(&agent))
        .filter(|content| !content.trim().is_empty());
    let is_platform_override = !scoped
        && equivalent(cwd, project)
        && platform_override.is_some_and(|content| content.trim() == expected.trim());

    if agent == AgentKind::ClaudeCode && !is_platform_override {
        let Some(manifest) = manifest else {
            return false;
        };
        let shared_instructions_are_planned = [
            AgentKind::Codex,
            AgentKind::Cursor,
            AgentKind::OpenCode,
            AgentKind::OpenClaw,
            AgentKind::Hermes,
        ]
        .into_iter()
        .any(|agent| {
            manifest
                .adapters
                .get(&agent)
                .is_none_or(|state| state.enabled)
        });
        if !shared_instructions_are_planned
            || !planned_instruction_file_is_safe(project, &cwd.join("AGENTS.md"))
        {
            return false;
        }
    }

    let target = if is_platform_override {
        match agent {
            AgentKind::ClaudeCode => cwd.join("CLAUDE.md"),
            AgentKind::Codex => cwd.join("AGENTS.override.md"),
            AgentKind::Cursor => cwd.join(".cursor/rules/agentkib.mdc"),
            AgentKind::OpenCode => cwd.join(".opencode/agentkib-instructions.md"),
            AgentKind::OpenClaw => cwd.join("TOOLS.md"),
            AgentKind::Hermes => cwd.join(".hermes.md"),
            AgentKind::DeepSeekHarness => return false,
        }
    } else {
        match agent {
            AgentKind::ClaudeCode => cwd.join("CLAUDE.md"),
            AgentKind::Codex => {
                let override_path = cwd.join("AGENTS.override.md");
                if override_path.is_file() {
                    if !equivalent(cwd, project) {
                        return false;
                    }
                    override_path
                } else {
                    cwd.join("AGENTS.md")
                }
            }
            AgentKind::Cursor | AgentKind::OpenCode | AgentKind::OpenClaw => cwd.join("AGENTS.md"),
            AgentKind::Hermes => {
                let private = cwd.join(".hermes.md");
                let legacy = cwd.join("HERMES.md");
                if private.is_file() || legacy.is_file() {
                    let planner_updates_private = equivalent(cwd, project)
                        && (platform_override.is_some() || has_managed_markdown(&private));
                    if !planner_updates_private {
                        return false;
                    }
                    private
                } else {
                    cwd.join("AGENTS.md")
                }
            }
            AgentKind::DeepSeekHarness => return false,
        }
    };

    planned_instruction_file_is_safe(project, &target)
}

fn mcp_target_can_be_repaired(project: &Path, agent: AgentKind) -> bool {
    let target = match agent {
        AgentKind::Codex => project.join(".codex/config.toml"),
        AgentKind::ClaudeCode => project.join(".mcp.json"),
        AgentKind::Cursor => project.join(".cursor/mcp.json"),
        AgentKind::OpenCode => project.join(".opencode/opencode.json"),
        AgentKind::OpenClaw | AgentKind::Hermes | AgentKind::DeepSeekHarness => return false,
    };
    planned_instruction_file_is_safe(project, &target)
}

fn planned_instruction_file_is_safe(project: &Path, target: &Path) -> bool {
    if !target_has_safe_ancestors(project, target) {
        return false;
    }
    match fs::symlink_metadata(target) {
        Ok(metadata) => metadata.file_type().is_file() && read_bounded_text_file(target).is_some(),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

fn has_managed_markdown(path: &Path) -> bool {
    read_bounded_text_file(path).is_some_and(|content| content.contains(MANAGED_MARKDOWN_START))
}

fn read_bounded_text_file(path: &Path) -> Option<String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        _ => return None,
    };
    if metadata.len() > MAX_MANAGED_FILE_BYTES {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut content = String::new();
    let read = file
        .take(MAX_MANAGED_FILE_BYTES + 1)
        .read_to_string(&mut content)
        .ok()?;
    (read as u64 <= MAX_MANAGED_FILE_BYTES).then_some(content)
}

fn generated_skill_is_current(
    project: &Path,
    manifest: &Manifest,
    agent: AgentKind,
    skill: &crate::SkillDefinition,
) -> bool {
    let roots: &[&str] = match agent {
        AgentKind::ClaudeCode => &[".claude/skills"],
        AgentKind::Cursor => &[".cursor/skills", ".agents/skills"],
        AgentKind::OpenCode => &[".opencode/skills", ".claude/skills", ".agents/skills"],
        AgentKind::DeepSeekHarness => &[".dsh/skills", ".agents/skills"],
        AgentKind::OpenClaw => &["skills", ".agents/skills"],
        AgentKind::Codex | AgentKind::Hermes => &[".agents/skills"],
    };
    let source = project.join(&skill.path);
    let Some(source_files) = managed_skill_files(project, &source) else {
        return false;
    };
    if matches!(
        agent,
        AgentKind::Cursor | AgentKind::OpenCode | AgentKind::OpenClaw
    ) {
        let expected_root = if agent == AgentKind::Cursor {
            cursor_skill_root(manifest, skill)
        } else {
            ".agents/skills"
        };
        let expected_target = project.join(expected_root).join(&skill.name);
        if managed_skill_files(project, &expected_target)
            .is_none_or(|target_files| target_files != source_files)
        {
            return false;
        }
        return roots
            .iter()
            .filter(|root| **root != expected_root)
            .all(|root| {
                let alternate = project.join(root).join(&skill.name);
                match fs::symlink_metadata(&alternate) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                    Ok(_) => managed_skill_files(project, &alternate)
                        .is_some_and(|target_files| target_files == source_files),
                    Err(_) => false,
                }
            });
    }

    roots.iter().any(|root| {
        let target = project.join(root).join(&skill.name);
        managed_skill_files(project, &target)
            .is_some_and(|target_files| target_files == source_files)
    })
}

fn cursor_skill_root(manifest: &Manifest, skill: &crate::SkillDefinition) -> &'static str {
    let shared_skill_enabled = [
        AgentKind::Codex,
        AgentKind::OpenCode,
        AgentKind::OpenClaw,
        AgentKind::Hermes,
    ]
    .into_iter()
    .any(|shared_agent| {
        manifest
            .adapters
            .get(&shared_agent)
            .is_none_or(|state| state.enabled)
            && (skill.targets.is_empty() || skill.targets.contains(&shared_agent))
    });
    if shared_skill_enabled {
        ".agents/skills"
    } else {
        ".cursor/skills"
    }
}

fn managed_skill_files(project: &Path, source: &Path) -> Option<BTreeMap<PathBuf, String>> {
    if !target_has_safe_ancestors(project, source) {
        return None;
    }
    if source.is_file() {
        let name = source.file_name()?;
        if name != OsStr::new("SKILL.md") {
            return None;
        }
        let ManagedFileHash::Hashed(hash) = hash_managed_skill_file(source) else {
            return None;
        };
        return Some(BTreeMap::from([(PathBuf::from(name), hash)]));
    }
    if !source.is_dir() {
        return None;
    }

    let mut files = BTreeMap::new();
    let mut total_bytes = 0_u64;
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.ok()?;
        if !is_safe_scan_entry(entry.path()) {
            return None;
        }
        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() {
            return None;
        }
        if files.len() >= MAX_MANAGED_SKILL_FILES {
            return None;
        }
        let metadata = entry.metadata().ok()?;
        total_bytes = total_bytes.checked_add(metadata.len())?;
        if total_bytes > MAX_MANAGED_SKILL_BYTES {
            return None;
        }
        let relative = entry.path().strip_prefix(source).ok()?.to_path_buf();
        let ManagedFileHash::Hashed(hash) = hash_managed_skill_file(entry.path()) else {
            return None;
        };
        files.insert(relative, hash);
    }
    files.contains_key(Path::new("SKILL.md")).then_some(files)
}

fn hash_managed_skill_file(path: &Path) -> ManagedFileHash {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(_) => return ManagedFileHash::Unavailable,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ManagedFileHash::Missing;
        }
        Err(_) => return ManagedFileHash::Unavailable,
    };
    if metadata.len() > MAX_MANAGED_FILE_BYTES {
        return ManagedFileHash::Unavailable;
    }
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return ManagedFileHash::Unavailable,
    };
    let mut content = String::new();
    if file
        .take(MAX_MANAGED_FILE_BYTES + 1)
        .read_to_string(&mut content)
        .is_err()
        || content.len() as u64 > MAX_MANAGED_FILE_BYTES
    {
        return ManagedFileHash::Unavailable;
    }
    ManagedFileHash::Hashed(hash_content(content.as_bytes()))
}

fn generated_skill_can_be_repaired(
    project: &Path,
    manifest: &Manifest,
    agent: AgentKind,
    skill: &crate::SkillDefinition,
) -> bool {
    let Some(source_files) = managed_skill_files(project, &project.join(&skill.path)) else {
        return false;
    };
    let relative_root = match agent {
        AgentKind::ClaudeCode => ".claude/skills",
        AgentKind::Cursor => cursor_skill_root(manifest, skill),
        AgentKind::Codex | AgentKind::OpenCode | AgentKind::OpenClaw | AgentKind::Hermes => {
            ".agents/skills"
        }
        AgentKind::DeepSeekHarness => return false,
    };
    let target = project.join(relative_root).join(&skill.name);
    if matches!(
        agent,
        AgentKind::Cursor | AgentKind::OpenCode | AgentKind::OpenClaw
    ) {
        let roots: &[&str] = if agent == AgentKind::Cursor {
            &[".cursor/skills", ".agents/skills"]
        } else if agent == AgentKind::OpenCode {
            &[".opencode/skills", ".claude/skills", ".agents/skills"]
        } else {
            &["skills", ".agents/skills"]
        };
        for root in roots {
            if *root == relative_root {
                continue;
            }
            let alternate = project.join(*root).join(&skill.name);
            match fs::symlink_metadata(&alternate) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Ok(_)
                    if managed_skill_files(project, &alternate)
                        .is_some_and(|files| files == source_files) => {}
                _ => return false,
            }
        }
    }
    if !target_has_safe_ancestors(project, &target) {
        return false;
    }
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    if !metadata.file_type().is_dir() {
        return false;
    }
    for entry in WalkDir::new(&target).follow_links(false) {
        let Ok(entry) = entry else {
            return false;
        };
        if !is_safe_scan_entry(entry.path()) {
            return false;
        }
        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() {
            return false;
        }
        let Ok(relative) = entry.path().strip_prefix(&target) else {
            return false;
        };
        if !source_files.contains_key(relative) {
            return false;
        }
    }
    true
}

fn target_has_safe_ancestors(project: &Path, target: &Path) -> bool {
    let Ok(relative) = target.strip_prefix(project) else {
        return false;
    };
    let mut current = project.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return false;
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if !is_safe_scan_entry(&current)
                    || current != target && !metadata.file_type().is_dir()
                {
                    return false;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        }
    }
    true
}

fn asset_kind_for_path(path: &Path) -> AssetKind {
    let value = path.to_string_lossy().replace('\\', "/");
    let normalized = value.to_ascii_lowercase();
    let components = normalized.split('/').collect::<Vec<_>>();
    let file_name = components.last().copied().unwrap_or_default();
    if components.contains(&"skills") {
        AssetKind::Skill
    } else if matches!(
        file_name,
        "agents.md" | "agents.override.md" | "claude.md" | "tools.md" | ".hermes.md" | "hermes.md"
    ) || components
        .windows(2)
        .any(|pair| pair == [".cursor", "rules"])
    {
        AssetKind::Instruction
    } else if normalized.contains("mcp")
        || file_name == "config.toml"
        || components.windows(2).any(|pair| {
            matches!(
                pair,
                [".openclaw", "openclaw.json"] | [".hermes", "config.yaml"]
            )
        })
    {
        AssetKind::Connection
    } else {
        AssetKind::Configuration
    }
}

fn attention_status(base: DoctorStatus, attention: bool) -> DoctorStatus {
    if base == DoctorStatus::NotApplicable {
        base
    } else if attention {
        DoctorStatus::Attention
    } else {
        base
    }
}

fn contains_normalized(content: &str, expected: &str) -> bool {
    let expected = normalize(expected);
    expected.is_empty() || normalize(content).contains(&expected)
}

fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[allow(clippy::too_many_arguments)]
fn push_issue(
    issues: &mut Vec<DoctorIssue>,
    code: &str,
    severity: DoctorSeverity,
    agent: Option<AgentKind>,
    asset_kind: Option<AssetKind>,
    repairable: bool,
    path: Option<PathBuf>,
    detail: String,
    expected: Option<String>,
    actual: Option<String>,
) {
    let id_source = format!("{code}:{agent:?}:{path:?}:{detail}");
    let id = hash_content(id_source.as_bytes())[..16].to_string();
    issues.push(DoctorIssue {
        id,
        code: code.into(),
        severity,
        agent,
        asset_kind,
        repairable,
        evidence: vec![DoctorEvidence {
            path,
            detail,
            expected,
            actual,
        }],
    });
}

fn severity_rank(severity: DoctorSeverity) -> usize {
    match severity {
        DoctorSeverity::Error => 0,
        DoctorSeverity::Warning => 1,
        DoctorSeverity::Info => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AdapterState, ConnectionDefinition, ConnectionTransport, InstructionSet, MemoryPolicy,
        SkillDefinition, WorkspaceIdentity,
    };
    use tempfile::tempdir;

    fn manifest(_project: &Path) -> Manifest {
        Manifest {
            schema_version: 2,
            workspace: WorkspaceIdentity {
                id: "workspace".into(),
                name: "demo".into(),
            },
            instructions: InstructionSet {
                shared: "Shared rule".into(),
                ..Default::default()
            },
            skills: Vec::new(),
            mcp: Default::default(),
            connections: Vec::new(),
            memories: MemoryPolicy::default(),
            adapters: AgentKind::WRITABLE
                .into_iter()
                .map(|agent| {
                    (
                        agent,
                        AdapterState {
                            enabled: true,
                            generated_hashes: Default::default(),
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn reports_missing_managed_file_as_repairable() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value
            .adapters
            .get_mut(&AgentKind::Codex)
            .unwrap()
            .generated_hashes
            .insert("AGENTS.md".into(), hash_content(b"Shared rule"));
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.code == "managed.missing" && issue.repairable)
        );
        fs::write(dir.path().join("AGENTS.md"), "Shared rule").unwrap();
        let repaired = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(
            repaired
                .issues
                .iter()
                .all(|issue| issue.code != "managed.missing" && issue.code != "managed.drift")
        );
    }

    #[cfg(unix)]
    #[test]
    fn missing_managed_file_through_symlinked_parent_is_not_repairable() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value
            .adapters
            .get_mut(&AgentKind::Codex)
            .unwrap()
            .generated_hashes
            .insert(".codex/config.toml".into(), hash_content(b"managed"));
        fs::create_dir(dir.path().join("linked-codex")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("linked-codex"), dir.path().join(".codex"))
            .unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(report.issues.iter().any(|issue| {
            issue.code == "managed.missing"
                && issue.agent == Some(AgentKind::Codex)
                && !issue.repairable
        }));
    }

    #[test]
    fn rejects_oversized_managed_files_without_reading_them() {
        let project = tempdir().unwrap();
        let home = tempdir().unwrap();
        let managed = home.path().join(".openclaw/openclaw.json");
        fs::create_dir_all(managed.parent().unwrap()).unwrap();
        let file = fs::File::create(&managed).unwrap();
        file.set_len(MAX_MANAGED_FILE_BYTES + 1).unwrap();

        let mut value = manifest(project.path());
        value
            .adapters
            .get_mut(&AgentKind::OpenClaw)
            .unwrap()
            .generated_hashes
            .insert(managed.display().to_string(), hash_content(b"expected"));
        fs::create_dir(project.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(project.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            project.path(),
            "workspace",
            &BTreeSet::new(),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(report.issues.iter().any(|issue| {
            issue.code == "managed.drift"
                && issue.agent == Some(AgentKind::OpenClaw)
                && !issue.repairable
                && issue
                    .evidence
                    .iter()
                    .any(|evidence| evidence.detail.contains("bounded regular file"))
        }));
    }

    #[test]
    fn reports_unreadable_skill_source_without_offering_repair() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "missing".into(),
            path: ".agents/skills/missing".into(),
            targets: Vec::new(),
        });
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        let report =
            diagnose_workspace(dir.path(), "workspace", &BTreeSet::new(), &BTreeMap::new())
                .unwrap();
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.code == "skill.source-unavailable" && !issue.repairable)
        );
    }

    #[test]
    fn single_file_skill_requires_skill_md_entrypoint() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("skill-sources/reviewer.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "# Reviewer").unwrap();
        fs::create_dir_all(dir.path().join(".agents/skills/reviewer")).unwrap();
        fs::write(
            dir.path().join(".agents/skills/reviewer/reviewer.md"),
            "# Reviewer",
        )
        .unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer.md".into(),
            targets: vec![AgentKind::Codex],
        });
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = report
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();

        assert_eq!(row.skills.actual, 0);
        assert!(report.issues.iter().any(|issue| {
            issue.code == "skill.source-unavailable"
                && issue.evidence.iter().any(|evidence| {
                    evidence
                        .path
                        .as_deref()
                        .is_some_and(|path| path.ends_with("skill-sources/reviewer.md"))
                })
        }));
    }

    #[cfg(unix)]
    #[test]
    fn skill_source_through_symlinked_ancestor_is_unavailable() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("real-sources/reviewer")).unwrap();
        fs::write(
            dir.path().join("real-sources/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("real-sources"),
            dir.path().join("skill-sources"),
        )
        .unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::Codex],
        });
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(
            report
                .issues
                .iter()
                .any(|issue| { issue.code == "skill.source-unavailable" && !issue.repairable })
        );
    }

    #[test]
    fn rejects_oversized_manifest_skill_sources_without_reading_them() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("skill-sources/large.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::File::create(&source)
            .unwrap()
            .set_len(MAX_MANAGED_FILE_BYTES + 1)
            .unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "large".into(),
            path: "skill-sources/large.md".into(),
            targets: Vec::new(),
        });
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report =
            diagnose_workspace(dir.path(), "workspace", &BTreeSet::new(), &BTreeMap::new())
                .unwrap();
        assert!(
            report
                .issues
                .iter()
                .any(|issue| { issue.code == "skill.source-unavailable" && !issue.repairable })
        );
    }

    #[test]
    fn empty_generated_skill_directory_is_not_counted_as_visible() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });
        fs::create_dir_all(dir.path().join("skill-sources/reviewer")).unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join(".claude/skills/reviewer")).unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::ClaudeCode]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = report
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::ClaudeCode)
            .unwrap();
        assert_eq!(row.skills.expected, 1);
        assert_eq!(row.skills.actual, 0);
        assert_eq!(row.skills.status, DoctorStatus::Attention);

        fs::write(
            dir.path().join(".claude/skills/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        let repaired = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::ClaudeCode]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = repaired
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::ClaudeCode)
            .unwrap();
        assert_eq!(row.skills.actual, 1);
    }

    #[test]
    fn stale_generated_skill_is_not_counted_without_a_recorded_hash() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::Codex],
        });
        fs::create_dir_all(dir.path().join("skill-sources/reviewer")).unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/SKILL.md"),
            "# Current reviewer",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join(".agents/skills/reviewer")).unwrap();
        fs::write(
            dir.path().join(".agents/skills/reviewer/SKILL.md"),
            "# Stale reviewer",
        )
        .unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let stale = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = stale
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();
        assert_eq!(row.skills.expected, 1);
        assert_eq!(row.skills.actual, 0);
        assert!(stale.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Codex) && issue.code == "skill.target-missing"
        }));

        fs::write(
            dir.path().join(".agents/skills/reviewer/SKILL.md"),
            "# Current reviewer",
        )
        .unwrap();
        let current = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = current
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();
        assert_eq!(row.skills.actual, 1);

        fs::create_dir_all(dir.path().join(".agents/skills/reviewer/scripts")).unwrap();
        fs::write(
            dir.path()
                .join(".agents/skills/reviewer/scripts/removed.sh"),
            "echo stale",
        )
        .unwrap();
        let extra = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = extra
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();
        assert_eq!(row.skills.actual, 0);
        assert!(extra.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Codex)
                && issue.code == "skill.target-missing"
                && !issue.repairable
        }));

        #[cfg(unix)]
        {
            fs::remove_file(
                dir.path()
                    .join(".agents/skills/reviewer/scripts/removed.sh"),
            )
            .unwrap();
            std::os::unix::fs::symlink(
                dir.path().join("skill-sources/reviewer/SKILL.md"),
                dir.path()
                    .join(".agents/skills/reviewer/scripts/removed.sh"),
            )
            .unwrap();
            let symlink = diagnose_workspace(
                dir.path(),
                "workspace",
                &BTreeSet::from([AgentKind::Codex]),
                &BTreeMap::new(),
            )
            .unwrap();
            let row = symlink
                .matrix
                .iter()
                .find(|row| row.agent == AgentKind::Codex)
                .unwrap();
            assert_eq!(row.skills.actual, 0);
            assert!(symlink.issues.iter().any(|issue| {
                issue.agent == Some(AgentKind::Codex)
                    && issue.code == "skill.target-missing"
                    && !issue.repairable
            }));
        }
    }

    #[test]
    fn generated_skill_requires_every_source_file_to_match() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::Codex],
        });
        fs::create_dir_all(dir.path().join("skill-sources/reviewer/scripts")).unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/scripts/review.sh"),
            "echo current",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join(".agents/skills/reviewer/scripts")).unwrap();
        fs::write(
            dir.path().join(".agents/skills/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::write(
            dir.path().join(".agents/skills/reviewer/scripts/review.sh"),
            "echo stale",
        )
        .unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let stale = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = stale
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();
        assert_eq!(row.skills.actual, 0);

        fs::write(
            dir.path().join(".agents/skills/reviewer/scripts/review.sh"),
            "echo current",
        )
        .unwrap();
        let current = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = current
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();
        assert_eq!(row.skills.actual, 1);
    }

    #[test]
    fn cursor_sees_untargeted_skills_in_shared_directory() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: Vec::new(),
        });
        fs::create_dir_all(dir.path().join("skill-sources/reviewer")).unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join(".agents/skills/reviewer")).unwrap();
        fs::write(
            dir.path().join(".agents/skills/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Cursor]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = report
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Cursor)
            .unwrap();
        assert_eq!(row.skills.expected, 1);
        assert_eq!(row.skills.actual, 1);
        assert_eq!(row.skills.status, DoctorStatus::Healthy);
        assert!(report.issues.iter().all(|issue| {
            issue.agent != Some(AgentKind::Cursor) || issue.code != "skill.target-missing"
        }));
    }

    #[test]
    fn missing_cursor_skill_is_repairable() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::Cursor],
        });
        fs::create_dir_all(dir.path().join("skill-sources/reviewer")).unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Cursor]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(report.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Cursor)
                && issue.code == "skill.target-missing"
                && issue.repairable
        }));
    }

    #[test]
    fn stale_private_cursor_skill_is_not_hidden_by_the_current_shared_copy() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: Vec::new(),
        });
        for (path, content) in [
            ("skill-sources/reviewer/SKILL.md", "# Current reviewer"),
            (".agents/skills/reviewer/SKILL.md", "# Current reviewer"),
            (".cursor/skills/reviewer/SKILL.md", "# Stale reviewer"),
        ] {
            let path = dir.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Cursor]),
            &BTreeMap::new(),
        )
        .unwrap();

        let row = report
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Cursor)
            .unwrap();
        assert_eq!(row.skills.actual, 0);
        assert!(report.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Cursor)
                && issue.code == "skill.target-missing"
                && !issue.repairable
        }));
    }

    #[test]
    fn openclaw_requires_every_visible_skill_root_to_be_current() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::OpenClaw],
        });
        for (path, content) in [
            ("skill-sources/reviewer/SKILL.md", "# Current reviewer"),
            ("skills/reviewer/SKILL.md", "# Current reviewer"),
            (".agents/skills/reviewer/SKILL.md", "# Stale reviewer"),
        ] {
            let path = dir.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let repairable = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::OpenClaw]),
            &BTreeMap::new(),
        )
        .unwrap();

        let row = repairable
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::OpenClaw)
            .unwrap();
        assert_eq!(row.skills.actual, 0);
        assert!(repairable.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::OpenClaw)
                && issue.code == "skill.target-missing"
                && issue.repairable
        }));

        fs::write(
            dir.path().join("skills/reviewer/SKILL.md"),
            "# Stale reviewer",
        )
        .unwrap();
        fs::write(
            dir.path().join(".agents/skills/reviewer/SKILL.md"),
            "# Current reviewer",
        )
        .unwrap();
        let blocked = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::OpenClaw]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(blocked.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::OpenClaw)
                && issue.code == "skill.target-missing"
                && !issue.repairable
        }));
    }

    #[cfg(unix)]
    #[test]
    fn missing_skill_through_symlinked_parent_is_not_repairable() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::Cursor],
        });
        fs::create_dir_all(dir.path().join("skill-sources/reviewer")).unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::create_dir(dir.path().join("linked-cursor")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("linked-cursor"), dir.path().join(".cursor"))
            .unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Cursor]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(report.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Cursor)
                && issue.code == "skill.target-missing"
                && !issue.repairable
        }));
    }

    #[test]
    fn managed_paths_are_classified_portably() {
        assert_eq!(
            asset_kind_for_path(Path::new("TOOLS.md")),
            AssetKind::Instruction
        );
        assert_eq!(
            asset_kind_for_path(Path::new(r".cursor\rules\agentkib.mdc")),
            AssetKind::Instruction
        );
        assert_eq!(
            asset_kind_for_path(Path::new(".openclaw/openclaw.json")),
            AssetKind::Connection
        );
        assert_eq!(
            asset_kind_for_path(Path::new(r".hermes\config.yaml")),
            AssetKind::Connection
        );
    }

    #[test]
    fn healthy_managed_context_has_no_error_or_warning() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.adapters.remove(&AgentKind::Codex);
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Shared rule").unwrap();
        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(report.summary.error_count, 0);
        assert_eq!(report.summary.warning_count, 0);
        assert!(
            report
                .matrix
                .iter()
                .find(|row| row.agent == AgentKind::Codex)
                .unwrap()
                .enabled
        );
        assert_eq!(
            report
                .matrix
                .iter()
                .find(|row| row.agent == AgentKind::Codex)
                .unwrap()
                .instructions
                .status,
            DoctorStatus::Healthy
        );
    }

    #[test]
    fn reports_each_missing_instruction_fragment() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value
            .instructions
            .platform_overrides
            .insert(AgentKind::Codex, "Codex-only rule".into());
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        fs::write(dir.path().join("AGENTS.override.md"), "Shared rule").unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        let issue = report
            .issues
            .iter()
            .find(|issue| issue.code == "instruction.expected-content-missing")
            .unwrap_or_else(|| panic!("missing fragment issue was not reported: {report:#?}"));
        assert_eq!(issue.evidence[0].expected.as_deref(), Some("2"));
        assert_eq!(issue.evidence[0].actual.as_deref(), Some("1"));
        let row = report
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();
        assert_eq!(row.instructions.expected, 2);
        assert_eq!(row.instructions.actual, 1);
        assert_eq!(row.instructions.status, DoctorStatus::Attention);
    }

    #[test]
    fn hermes_shadowed_instructions_are_only_repairable_when_the_plan_updates_the_selected_source()
    {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(dir.path().join("HERMES.md"), "Unmanaged Hermes rule").unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let shadowed = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Hermes]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(shadowed.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Hermes)
                && issue.code == "instruction.expected-content-missing"
                && !issue.repairable
        }));

        value
            .instructions
            .platform_overrides
            .insert(AgentKind::Hermes, "Hermes-only rule".into());
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        let repairable = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Hermes]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(repairable.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Hermes)
                && issue.code == "instruction.expected-content-missing"
                && issue.repairable
        }));
    }

    #[test]
    fn codex_scoped_override_that_the_plan_cannot_update_is_not_repairable() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.instructions.shared.clear();
        value.instructions.scoped.push(crate::ScopedInstruction {
            path: "packages/api".into(),
            content: "API-only rule".into(),
        });
        fs::create_dir_all(dir.path().join(".agentkib")).unwrap();
        fs::create_dir_all(dir.path().join("packages/api")).unwrap();
        fs::write(
            dir.path().join("packages/api/AGENTS.override.md"),
            "Unmanaged scoped override",
        )
        .unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(report.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Codex)
                && issue.code == "instruction.expected-content-missing"
                && !issue.repairable
        }));
    }

    #[test]
    fn claude_only_shared_instruction_is_not_offered_an_ineffective_repair() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        for agent in [
            AgentKind::Codex,
            AgentKind::Cursor,
            AgentKind::OpenCode,
            AgentKind::OpenClaw,
            AgentKind::Hermes,
        ] {
            value.adapters.get_mut(&agent).unwrap().enabled = false;
        }
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::ClaudeCode]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(report.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::ClaudeCode)
                && matches!(
                    issue.code.as_str(),
                    "instruction.missing" | "instruction.expected-content-missing"
                )
                && !issue.repairable
        }));
    }

    #[test]
    fn diagnoses_scoped_instructions_from_their_configured_directory() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.instructions.shared.clear();
        value.instructions.scoped.push(crate::ScopedInstruction {
            path: "packages/api".into(),
            content: "API-only rule".into(),
        });
        fs::create_dir_all(dir.path().join(".agentkib")).unwrap();
        fs::create_dir_all(dir.path().join("packages/api")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        // Inherited text at the project root must not satisfy a scoped expectation.
        fs::write(dir.path().join("AGENTS.md"), "API-only rule").unwrap();
        let installed = BTreeSet::from([AgentKind::Codex, AgentKind::Cursor, AgentKind::OpenClaw]);

        let missing =
            diagnose_workspace(dir.path(), "workspace", &installed, &BTreeMap::new()).unwrap();
        for agent in [AgentKind::Codex, AgentKind::Cursor, AgentKind::OpenClaw] {
            let row = missing
                .matrix
                .iter()
                .find(|row| row.agent == agent)
                .unwrap();
            assert_eq!(row.instructions.expected, 1);
            assert_eq!(row.instructions.actual, 0);
            assert_eq!(row.instructions.status, DoctorStatus::Attention);
            assert!(missing.issues.iter().any(|issue| {
                issue.agent == Some(agent)
                    && matches!(
                        issue.code.as_str(),
                        "instruction.missing" | "instruction.expected-content-missing"
                    )
            }));
        }

        fs::remove_file(dir.path().join("AGENTS.md")).unwrap();
        fs::write(dir.path().join("packages/api/AGENTS.md"), "API-only rule").unwrap();
        let healthy =
            diagnose_workspace(dir.path(), "workspace", &installed, &BTreeMap::new()).unwrap();
        for agent in [AgentKind::Codex, AgentKind::Cursor, AgentKind::OpenClaw] {
            let row = healthy
                .matrix
                .iter()
                .find(|row| row.agent == agent)
                .unwrap();
            assert_eq!(row.instructions.expected, 1);
            assert_eq!(row.instructions.actual, 1);
            assert_eq!(row.instructions.status, DoctorStatus::Healthy);
        }
    }

    #[test]
    fn reports_manifest_mcp_connections_missing_from_target_visibility() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.connections.push(ConnectionDefinition {
            name: "filesystem".into(),
            transport: ConnectionTransport::Stdio {
                command: "node".into(),
                args: vec!["server.js".into()],
            },
            env: BTreeMap::new(),
            allow_tools: Vec::new(),
            targets: vec![AgentKind::Codex],
        });
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Shared rule").unwrap();

        let missing = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(missing.issues.iter().any(|issue| {
            issue.code == "mcp.target-missing"
                && issue.agent == Some(AgentKind::Codex)
                && issue.repairable
        }));
        let row = missing
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();
        assert_eq!(row.mcp.expected, 1);
        assert_eq!(row.mcp.actual, 0);
        assert_eq!(row.mcp.status, DoctorStatus::Attention);

        let visible = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::from([(AgentKind::Codex, vec!["filesystem".into()])]),
        )
        .unwrap();
        assert!(
            visible
                .issues
                .iter()
                .all(|issue| issue.code != "mcp.target-missing")
        );
        let row = visible
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::Codex)
            .unwrap();
        assert_eq!(row.mcp.expected, 1);
        assert_eq!(row.mcp.actual, 1);
        assert_eq!(row.mcp.status, DoctorStatus::Healthy);

        for agent in [AgentKind::OpenClaw, AgentKind::Hermes] {
            value.connections[0].targets = vec![agent];
            fs::write(
                manifest_path(dir.path()),
                serde_yaml::to_string(&value).unwrap(),
            )
            .unwrap();
            let home_only = diagnose_workspace(
                dir.path(),
                "workspace",
                &BTreeSet::from([agent]),
                &BTreeMap::new(),
            )
            .unwrap();
            assert!(home_only.issues.iter().any(|issue| {
                issue.code == "mcp.target-missing"
                    && issue.agent == Some(agent)
                    && !issue.repairable
            }));
        }
    }

    #[test]
    fn opencode_missing_managed_assets_are_repairable_in_project_paths() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "skill-sources/reviewer".into(),
            targets: vec![AgentKind::OpenCode],
        });
        value.connections.push(ConnectionDefinition {
            name: "filesystem".into(),
            transport: ConnectionTransport::Http {
                url: "http://127.0.0.1/mcp".into(),
            },
            env: Default::default(),
            allow_tools: Vec::new(),
            targets: vec![AgentKind::OpenCode],
        });
        fs::create_dir_all(dir.path().join("skill-sources/reviewer")).unwrap();
        fs::write(
            dir.path().join("skill-sources/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::OpenCode]),
            &BTreeMap::new(),
        )
        .unwrap();

        for code in [
            "instruction.missing",
            "skill.target-missing",
            "mcp.target-missing",
        ] {
            assert!(report.issues.iter().any(|issue| {
                issue.agent == Some(AgentKind::OpenCode) && issue.code == code && issue.repairable
            }));
        }
    }

    #[test]
    fn opencode_registered_override_satisfies_instruction_diagnostics() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value
            .instructions
            .platform_overrides
            .insert(AgentKind::OpenCode, "OpenCode override".into());
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::create_dir(dir.path().join(".opencode")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Shared rule").unwrap();
        fs::write(
            dir.path().join(".opencode/agentkib-instructions.md"),
            "<!-- agentkib:managed:start -->\nOpenCode override\n<!-- agentkib:managed:end -->\n",
        )
        .unwrap();
        fs::write(
            dir.path().join(".opencode/opencode.json"),
            r#"{"instructions":[".opencode/agentkib-instructions.md"]}"#,
        )
        .unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::OpenCode]),
            &BTreeMap::new(),
        )
        .unwrap();

        let row = report
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::OpenCode)
            .unwrap();
        assert_eq!(row.instructions.expected, 2);
        assert_eq!(row.instructions.actual, 2);
        assert!(report.issues.iter().all(|issue| {
            issue.agent != Some(AgentKind::OpenCode)
                || !matches!(
                    issue.code.as_str(),
                    "instruction.missing" | "instruction.expected-content-missing"
                )
        }));
    }

    #[test]
    fn reports_mcp_configuration_failures_without_target_repairs() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.connections.push(ConnectionDefinition {
            name: "filesystem".into(),
            transport: ConnectionTransport::Stdio {
                command: "node".into(),
                args: vec!["server.js".into()],
            },
            env: BTreeMap::new(),
            allow_tools: Vec::new(),
            targets: vec![AgentKind::Codex],
        });
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Shared rule").unwrap();

        let report = diagnose_workspace_with_mcp_error(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
            Some("Invalid MCP JSON config .agentkib/mcp.json"),
        )
        .unwrap();

        assert_eq!(report.summary.error_count, 1);
        assert_eq!(report.summary.repairable_count, 0);
        assert!(report.issues.iter().any(|issue| {
            issue.code == "mcp.config-unavailable"
                && issue.severity == DoctorSeverity::Error
                && !issue.repairable
        }));
        assert!(
            report
                .issues
                .iter()
                .all(|issue| issue.code != "mcp.target-missing")
        );
        assert_eq!(
            report
                .matrix
                .iter()
                .find(|row| row.agent == AgentKind::Codex)
                .unwrap()
                .mcp
                .status,
            DoctorStatus::Unavailable
        );
    }

    #[test]
    fn disabled_agent_is_neutral_and_not_offered_repairs() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        let codex = value.adapters.get_mut(&AgentKind::Codex).unwrap();
        codex.enabled = false;
        codex
            .generated_hashes
            .insert("AGENTS.md".into(), hash_content(b"Shared rule"));
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(
            report
                .issues
                .iter()
                .all(|issue| issue.agent != Some(AgentKind::Codex))
        );
        assert_eq!(
            report
                .matrix
                .iter()
                .find(|row| row.agent == AgentKind::Codex)
                .unwrap()
                .instructions
                .status,
            DoctorStatus::NotApplicable
        );
        assert!(
            !report
                .matrix
                .iter()
                .find(|row| row.agent == AgentKind::Codex)
                .unwrap()
                .enabled
        );
        assert_eq!(report.summary.warning_count, 0);
    }

    #[test]
    fn diagnoses_native_context_without_manifest() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Shared rule").unwrap();
        fs::write(dir.path().join("TOOLS.md"), "Shared rule").unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::OpenClaw]),
            &BTreeMap::new(),
        )
        .unwrap();
        let row = report
            .matrix
            .iter()
            .find(|row| row.agent == AgentKind::OpenClaw)
            .unwrap();

        assert!(row.enabled);
        assert_eq!(row.instructions.status, DoctorStatus::Attention);
        assert!(report.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::OpenClaw) && issue.code == "instruction.exact-duplicate"
        }));
    }

    #[test]
    fn truncated_context_does_not_infer_that_configured_content_is_missing() {
        let dir = tempdir().unwrap();
        let mut value = manifest(dir.path());
        value.instructions.shared = "x".repeat(129 * 1024);
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        fs::write(
            manifest_path(dir.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        fs::write(dir.path().join("AGENTS.md"), &value.instructions.shared).unwrap();

        let report = diagnose_workspace(
            dir.path(),
            "workspace",
            &BTreeSet::from([AgentKind::Codex]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(report.issues.iter().any(|issue| {
            issue.agent == Some(AgentKind::Codex) && issue.code == "context.warning"
        }));
        assert!(report.issues.iter().all(|issue| {
            issue.agent != Some(AgentKind::Codex)
                || issue.code != "instruction.expected-content-missing"
        }));
        assert_eq!(report.summary.repairable_count, 0);
    }

    #[test]
    fn reports_invalid_manifest_and_exact_duplicate_context() {
        let invalid = tempdir().unwrap();
        fs::create_dir(invalid.path().join(".agentkib")).unwrap();
        fs::write(manifest_path(invalid.path()), "schema_version: nope").unwrap();
        let report = diagnose_workspace(
            invalid.path(),
            "invalid",
            &BTreeSet::new(),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.code == "manifest.invalid")
        );

        let duplicate = tempdir().unwrap();
        let value = manifest(duplicate.path());
        fs::create_dir_all(duplicate.path().join(".agentkib")).unwrap();
        fs::create_dir_all(duplicate.path().join(".claude")).unwrap();
        fs::write(
            manifest_path(duplicate.path()),
            serde_yaml::to_string(&value).unwrap(),
        )
        .unwrap();
        fs::write(duplicate.path().join("CLAUDE.md"), "Shared rule").unwrap();
        fs::write(duplicate.path().join(".claude/CLAUDE.md"), "Shared rule").unwrap();
        let report = diagnose_workspace(
            duplicate.path(),
            "duplicate",
            &BTreeSet::from([AgentKind::ClaudeCode]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.code == "instruction.exact-duplicate")
        );
    }

    #[test]
    fn reports_non_regular_manifest_as_invalid() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(manifest_path(dir.path())).unwrap();

        let report =
            diagnose_workspace(dir.path(), "invalid", &BTreeSet::new(), &BTreeMap::new()).unwrap();

        assert_eq!(
            report
                .issues
                .iter()
                .filter(|issue| issue.code == "manifest.invalid")
                .count(),
            1
        );
        assert!(
            report
                .issues
                .iter()
                .all(|issue| issue.code != "native.invalid")
        );
    }
}
