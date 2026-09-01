use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use agentkib_platform::fs::{ExpectedFile, atomic_replace_checked, atomic_write};
use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::{ApplyReport, ChangeScope, ChangeSet, ensure_allowed_target};

#[derive(Debug, Clone, Default)]
pub struct ApplyOptions {
    pub approved_home_files: Vec<PathBuf>,
    pub approved_application_files: Vec<PathBuf>,
    pub home_approval: bool,
}

pub fn hash_content(content: &[u8]) -> String {
    hex::encode(Sha256::digest(content))
}

pub fn apply_changeset(
    changeset: &ChangeSet,
    backup_root: &Path,
    options: &ApplyOptions,
) -> Result<ApplyReport> {
    if changeset.requires_home_approval && !options.home_approval {
        bail!("This ChangeSet contains Agent Home files and requires separate authorization");
    }
    for change in &changeset.changes {
        ensure_allowed_target(
            &changeset.project_root,
            &change.target,
            &options.approved_home_files,
            &options.approved_application_files,
        )?;
        if matches!(change.scope, ChangeScope::AgentHome) && !options.home_approval {
            bail!("Agent Home write is not authorized");
        }
        if matches!(change.scope, ChangeScope::ApplicationData)
            && !options
                .approved_application_files
                .iter()
                .any(|path| path == &change.target)
        {
            bail!("Application data write is not authorized");
        }
        if matches!(change.scope, ChangeScope::ApplicationData) {
            ensure_application_data_parent_chain(&change.target)?;
        }
        let current = fs::read(&change.target).unwrap_or_default();
        let current_hash = if change.target.exists() {
            Some(hash_content(&current))
        } else {
            None
        };
        if current_hash != change.original_hash {
            bail!("File was modified externally: {}", change.target.display());
        }
    }

    let backup_dir = backup_root.join(&changeset.id);
    fs::create_dir_all(&backup_dir)?;
    let mut prepared = Vec::new();
    for (index, change) in changeset.changes.iter().enumerate() {
        let parent = change
            .target
            .parent()
            .context("Target has no parent directory")?;
        if matches!(change.scope, ChangeScope::ApplicationData) {
            ensure_application_data_parent_chain(&change.target)?;
        }
        fs::create_dir_all(parent)?;
        if matches!(change.scope, ChangeScope::ApplicationData) {
            ensure_application_data_parent_chain(&change.target)?;
        }
        if change.target.exists() {
            fs::copy(&change.target, backup_dir.join(format!("{index}.bak")))?;
        }
        let mut temp = NamedTempFile::new_in(parent)?;
        if matches!(change.scope, ChangeScope::ApplicationData) {
            ensure_application_data_parent_chain(&change.target)?;
        }
        use std::io::Write;
        temp.write_all(change.after.as_bytes())?;
        if let Ok(metadata) = fs::metadata(&change.target) {
            temp.as_file_mut().set_permissions(metadata.permissions())?;
        }
        temp.as_file().sync_all()?;
        prepared.push(temp);
    }

    let mut applied = Vec::new();
    for (index, (change, temp)) in changeset.changes.iter().zip(prepared).enumerate() {
        if matches!(change.scope, ChangeScope::ApplicationData)
            && let Err(error) = ensure_application_data_parent_chain(&change.target)
        {
            if index > 0 {
                rollback(changeset, &backup_dir, index - 1);
            }
            return Err(error);
        }
        let expected = change
            .original_hash
            .as_deref()
            .map(ExpectedFile::Sha256)
            .unwrap_or(ExpectedFile::Missing);
        let write_result = atomic_replace_checked(temp.path(), &change.target, expected)
            .with_context(|| format!("Failed to write {}", change.target.display()))
            .and_then(|_| {
                let written = fs::read_to_string(&change.target)?;
                validate_written(&change.validator, &written).with_context(|| {
                    format!("Post-write validation failed: {}", change.target.display())
                })
            });
        if let Err(error) = write_result {
            rollback(changeset, &backup_dir, index);
            return Err(error);
        }
        applied.push(change.target.clone());
    }
    Ok(ApplyReport {
        changeset_id: changeset.id.clone(),
        applied,
        backup_dir,
    })
}

fn ensure_application_data_parent_chain(target: &Path) -> Result<()> {
    let parent = target.parent().context("Target has no parent directory")?;
    // ApplicationData currently stores continuation files under
    // continuations/<workspace-hash>/<archive-id>; validate that entire private subtree.
    for directory in parent.ancestors().take(3) {
        match fs::symlink_metadata(directory) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    bail!("Application data parent is not a regular directory")
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Application data parent is unavailable: {}",
                        directory.display()
                    )
                });
            }
        }
    }
    Ok(())
}

fn rollback(changeset: &ChangeSet, backup_dir: &Path, last_index: usize) {
    for index in (0..=last_index).rev() {
        let target = &changeset.changes[index].target;
        let backup = backup_dir.join(format!("{index}.bak"));
        if backup.exists() {
            if let Ok(content) = fs::read(backup) {
                let _ = atomic_write(target, &content);
            }
        } else {
            let _ = fs::remove_file(target);
        }
    }
}

fn validate_written(validator: &str, content: &str) -> Result<()> {
    match validator {
        "yaml" => {
            let _: serde_yaml::Value = serde_yaml::from_str(content)?;
        }
        "json" => {
            let _: serde_json::Value = serde_json::from_str(content)?;
        }
        "jsonl" => {
            for (index, line) in content.lines().enumerate() {
                if !line.trim().is_empty() {
                    let _: serde_json::Value = serde_json::from_str(line)
                        .with_context(|| format!("Invalid JSONL record {}", index + 1))?;
                }
            }
        }
        "toml" => {
            let _: toml::Value = toml::from_str(content)?;
        }
        "markdown" | "text" => {}
        other => bail!("Unknown validator: {other}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FileChange, RiskLevel};
    use chrono::Utc;
    use tempfile::tempdir;
    use uuid::Uuid;

    #[test]
    fn rejects_hash_conflict() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("AGENTS.md");
        fs::write(&target, "new").unwrap();
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: dir.path().canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes: vec![FileChange {
                target,
                scope: ChangeScope::Project,
                original_hash: Some(hash_content(b"old")),
                before: "old".into(),
                after: "next".into(),
                risk: RiskLevel::Low,
                validator: "markdown".into(),
            }],
        };
        assert!(
            apply_changeset(&set, &dir.path().join("backup"), &ApplyOptions::default()).is_err()
        );
    }

    #[test]
    fn restores_all_files_when_post_write_validation_fails() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("AGENTS.md");
        let second = dir.path().join("config.json");
        fs::write(&first, "original").unwrap();
        fs::write(&second, "{}").unwrap();
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: dir.path().canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes: vec![
                FileChange {
                    target: first.clone(),
                    scope: ChangeScope::Project,
                    original_hash: Some(hash_content(b"original")),
                    before: "original".into(),
                    after: "changed".into(),
                    risk: RiskLevel::Low,
                    validator: "markdown".into(),
                },
                FileChange {
                    target: second.clone(),
                    scope: ChangeScope::Project,
                    original_hash: Some(hash_content(b"{}")),
                    before: "{}".into(),
                    after: "not-json".into(),
                    risk: RiskLevel::Low,
                    validator: "json".into(),
                },
            ],
        };
        assert!(
            apply_changeset(&set, &dir.path().join("backup"), &ApplyOptions::default()).is_err()
        );
        assert_eq!(fs::read_to_string(first).unwrap(), "original");
        assert_eq!(fs::read_to_string(second).unwrap(), "{}");
    }

    #[test]
    fn validates_each_jsonl_record() {
        assert!(validate_written("jsonl", "{\"type\":\"one\"}\n{\"type\":\"two\"}\n").is_ok());
        assert!(validate_written("jsonl", "{\"type\":\"one\"}\nnot-json\n").is_err());
    }

    #[test]
    fn application_data_requires_exact_file_authorization() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        fs::create_dir(&project).unwrap();
        let target = dir.path().join("private/archive/document.json");
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: project.canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes: vec![FileChange {
                target: target.clone(),
                scope: ChangeScope::ApplicationData,
                original_hash: None,
                before: String::new(),
                after: "{}".into(),
                risk: RiskLevel::Medium,
                validator: "json".into(),
            }],
        };
        assert!(
            apply_changeset(&set, &dir.path().join("backup"), &ApplyOptions::default()).is_err()
        );

        apply_changeset(
            &set,
            &dir.path().join("backup"),
            &ApplyOptions {
                approved_application_files: vec![target.clone()],
                ..ApplyOptions::default()
            },
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(target).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn application_data_rejects_a_symlinked_private_parent() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let outside = dir.path().join("outside");
        let continuation_root = dir.path().join("continuations");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &continuation_root).unwrap();
        let target = continuation_root
            .join("workspace")
            .join("archive")
            .join("document.json");
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: project.canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes: vec![FileChange {
                target: target.clone(),
                scope: ChangeScope::ApplicationData,
                original_hash: None,
                before: String::new(),
                after: "{}".into(),
                risk: RiskLevel::Medium,
                validator: "json".into(),
            }],
        };
        let options = ApplyOptions {
            approved_application_files: vec![target],
            ..ApplyOptions::default()
        };

        assert!(apply_changeset(&set, &dir.path().join("backup"), &options).is_err());
        assert!(!outside.join("workspace/archive/document.json").exists());
    }
}
