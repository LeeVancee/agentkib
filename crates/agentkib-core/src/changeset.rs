use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use agentkib_platform::fs::{ExpectedFile, atomic_replace_checked, move_path};
use anyhow::{Context, Result, anyhow, bail};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::path_policy::ensure_project_target_has_safe_ancestors;
use crate::{ApplyReport, ChangeScope, ChangeSet, ensure_allowed_target};

#[derive(Debug, Clone, Default)]
pub struct ApplyOptions {
    pub approved_home_files: Vec<PathBuf>,
    pub protected_home_roots: Vec<PathBuf>,
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
    apply_changeset_with_hook(changeset, backup_root, options, |_| {})
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone)]
enum ApplyEvent {
    BeforeReplace {
        index: usize,
        target: PathBuf,
    },
    AfterReplace {
        index: usize,
        backup: Option<PathBuf>,
    },
    BeforeRollback {
        index: usize,
        target: PathBuf,
    },
}

#[derive(Debug, Clone)]
enum OriginalFile {
    Existing { backup: PathBuf, hash: String },
    Missing,
}

struct PreparedChange {
    temp: NamedTempFile,
    original: OriginalFile,
}

#[derive(Debug, Clone)]
struct AppliedChange {
    index: usize,
    written_hash: String,
    original: OriginalFile,
}

fn apply_changeset_with_hook<F>(
    changeset: &ChangeSet,
    backup_root: &Path,
    options: &ApplyOptions,
    mut hook: F,
) -> Result<ApplyReport>
where
    F: FnMut(ApplyEvent),
{
    if changeset.requires_home_approval && !options.home_approval {
        bail!("This ChangeSet contains Agent Home files and requires separate authorization");
    }
    for change in &changeset.changes {
        ensure_change_target_is_safe(changeset, change, options)?;
        let current_hash = match fs::read(&change.target) {
            Ok(current) => Some(hash_content(&current)),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Failed to read ChangeSet target: {}",
                        change.target.display()
                    )
                });
            }
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
        ensure_change_target_is_safe(changeset, change, options)?;
        fs::create_dir_all(parent)?;
        ensure_change_target_is_safe(changeset, change, options)?;
        let original = match &change.original_hash {
            Some(original_hash) => {
                let backup = backup_dir.join(format!("{index}.bak"));
                fs::copy(&change.target, &backup).with_context(|| {
                    format!(
                        "Failed to back up {} to {}",
                        change.target.display(),
                        backup.display()
                    )
                })?;
                verify_backup(&backup, original_hash)?;
                OriginalFile::Existing {
                    backup,
                    hash: original_hash.clone(),
                }
            }
            None => OriginalFile::Missing,
        };
        let mut temp = NamedTempFile::new_in(parent)?;
        ensure_change_target_is_safe(changeset, change, options)?;
        use std::io::Write;
        temp.write_all(change.after.as_bytes())?;
        if let Ok(metadata) = fs::metadata(&change.target) {
            temp.as_file_mut().set_permissions(metadata.permissions())?;
        }
        temp.as_file().sync_all()?;
        prepared.push(PreparedChange { temp, original });
    }

    let mut applied = Vec::new();
    let mut rollback_log = Vec::new();
    for (index, (change, prepared)) in changeset.changes.iter().zip(prepared).enumerate() {
        let backup = match &prepared.original {
            OriginalFile::Existing { backup, .. } => Some(backup.clone()),
            OriginalFile::Missing => None,
        };
        hook(ApplyEvent::BeforeReplace {
            index,
            target: change.target.clone(),
        });
        if let Err(error) = ensure_change_target_is_safe(changeset, change, options) {
            return Err(error_with_rollback(
                error,
                changeset,
                options,
                &rollback_log,
                &mut hook,
            ));
        }
        if let OriginalFile::Existing { backup, hash } = &prepared.original
            && let Err(error) = verify_backup(backup, hash)
        {
            return Err(error_with_rollback(
                error,
                changeset,
                options,
                &rollback_log,
                &mut hook,
            ));
        }
        let expected = change
            .original_hash
            .as_deref()
            .map(ExpectedFile::Sha256)
            .unwrap_or(ExpectedFile::Missing);
        // Windows ReplaceFileW cannot replace from a still-open NamedTempFile.
        let temp_path = prepared.temp.into_temp_path();
        if let Err(error) = atomic_replace_checked(&temp_path, &change.target, expected)
            .with_context(|| format!("Failed to write {}", change.target.display()))
        {
            return Err(error_with_rollback(
                error,
                changeset,
                options,
                &rollback_log,
                &mut hook,
            ));
        }

        let written_hash = hash_content(change.after.as_bytes());
        rollback_log.push(AppliedChange {
            index,
            written_hash: written_hash.clone(),
            original: prepared.original,
        });
        hook(ApplyEvent::AfterReplace { index, backup });
        let validation_result = fs::read_to_string(&change.target)
            .with_context(|| format!("Failed to read written file: {}", change.target.display()))
            .and_then(|written| {
                if hash_content(written.as_bytes()) != written_hash {
                    bail!(
                        "File was modified externally after write: {}",
                        change.target.display()
                    );
                }
                validate_written(&change.validator, &written).with_context(|| {
                    format!("Post-write validation failed: {}", change.target.display())
                })
            });
        if let Err(error) = validation_result {
            return Err(error_with_rollback(
                error,
                changeset,
                options,
                &rollback_log,
                &mut hook,
            ));
        }
        applied.push(change.target.clone());
    }
    Ok(ApplyReport {
        changeset_id: changeset.id.clone(),
        applied,
        backup_dir,
    })
}

fn ensure_change_target_is_safe(
    changeset: &ChangeSet,
    change: &crate::FileChange,
    options: &ApplyOptions,
) -> Result<()> {
    ensure_allowed_target(
        &changeset.project_root,
        &change.target,
        &options.approved_home_files,
        &options.approved_application_files,
    )?;
    match change.scope {
        ChangeScope::Project => {
            ensure_project_target_has_safe_ancestors(&changeset.project_root, &change.target)?;
        }
        ChangeScope::AgentHome => {
            if !options.home_approval {
                bail!("Agent Home write is not authorized");
            }
            ensure_protected_home_parent_chain(&change.target, options)?;
        }
        ChangeScope::ApplicationData => {
            if !options
                .approved_application_files
                .iter()
                .any(|path| path == &change.target)
            {
                bail!("Application data write is not authorized");
            }
            ensure_application_data_parent_chain(&change.target)?;
        }
    }
    Ok(())
}

fn verify_backup(backup: &Path, expected_hash: &str) -> Result<()> {
    let content =
        fs::read(backup).with_context(|| format!("Backup is unavailable: {}", backup.display()))?;
    let actual_hash = hash_content(&content);
    if actual_hash != expected_hash {
        bail!(
            "Backup content does not match the original file: {}",
            backup.display()
        );
    }
    Ok(())
}

fn ensure_protected_home_parent_chain(target: &Path, options: &ApplyOptions) -> Result<()> {
    let Some(root) = options
        .protected_home_roots
        .iter()
        .find(|root| target.starts_with(root))
    else {
        return Ok(());
    };
    let relative = target
        .strip_prefix(root)
        .context("Protected Agent Home target is outside its root")?;
    if relative
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        bail!("Protected Agent Home target contains an unsafe path component");
    }
    let parent = target.parent().context("Target has no parent directory")?;
    let mut reached_root = false;
    // Continue above the session root so a replaced Agent Home (or one of its parents)
    // cannot redirect a write after the target was planned.
    for directory in parent.ancestors() {
        match fs::symlink_metadata(directory) {
            Ok(metadata) => {
                if agentkib_platform::path::is_reparse_or_symlink(directory)? || !metadata.is_dir()
                {
                    bail!("Protected Agent Home parent is not a regular directory")
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Protected Agent Home parent is unavailable: {}",
                        directory.display()
                    )
                });
            }
        }
        if directory == root {
            reached_root = true;
        }
    }
    if !reached_root {
        bail!("Protected Agent Home target is outside its root")
    }
    Ok(())
}

fn ensure_application_data_parent_chain(target: &Path) -> Result<()> {
    let parent = target.parent().context("Target has no parent directory")?;
    // Validate through the data root and all existing ancestors so replacing the root itself
    // cannot redirect a private archive write after planning.
    for directory in parent.ancestors() {
        match fs::symlink_metadata(directory) {
            Ok(metadata) => {
                if agentkib_platform::path::is_reparse_or_symlink(directory)? || !metadata.is_dir()
                {
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

fn error_with_rollback<F>(
    original_error: anyhow::Error,
    changeset: &ChangeSet,
    options: &ApplyOptions,
    applied: &[AppliedChange],
    hook: &mut F,
) -> anyhow::Error
where
    F: FnMut(ApplyEvent),
{
    let rollback_errors = rollback(changeset, options, applied, hook);
    if rollback_errors.is_empty() {
        original_error
    } else {
        anyhow!(
            "{original_error:#}; rollback incomplete: {}",
            rollback_errors.join("; ")
        )
    }
}

fn rollback<F>(
    changeset: &ChangeSet,
    options: &ApplyOptions,
    applied: &[AppliedChange],
    hook: &mut F,
) -> Vec<String>
where
    F: FnMut(ApplyEvent),
{
    let mut errors = Vec::new();
    for applied_change in applied.iter().rev() {
        let change = &changeset.changes[applied_change.index];
        let target = &change.target;
        hook(ApplyEvent::BeforeRollback {
            index: applied_change.index,
            target: target.clone(),
        });

        if let Err(error) = ensure_change_target_is_safe(changeset, change, options) {
            errors.push(format_rollback_error(
                target,
                &applied_change.original,
                format!("target is no longer safe: {error:#}"),
            ));
            continue;
        }

        let current = match fs::read(target) {
            Ok(current) => current,
            Err(error)
                if error.kind() == ErrorKind::NotFound
                    && matches!(applied_change.original, OriginalFile::Missing) =>
            {
                continue;
            }
            Err(error) => {
                errors.push(format_rollback_error(
                    target,
                    &applied_change.original,
                    format!("failed to read current target: {error}"),
                ));
                continue;
            }
        };
        if hash_content(&current) != applied_change.written_hash {
            errors.push(format_rollback_error(
                target,
                &applied_change.original,
                "content changed after AgentKib wrote it; external content was preserved".into(),
            ));
            continue;
        }

        match &applied_change.original {
            OriginalFile::Existing { backup, hash } => {
                let backup_content = match fs::read(backup) {
                    Ok(content) => content,
                    Err(error) => {
                        errors.push(format_rollback_error(
                            target,
                            &applied_change.original,
                            format!("failed to read backup: {error}"),
                        ));
                        continue;
                    }
                };
                if hash_content(&backup_content) != *hash {
                    errors.push(format_rollback_error(
                        target,
                        &applied_change.original,
                        "backup content does not match the original hash".into(),
                    ));
                    continue;
                }
                if let Err(error) = restore_existing_file_checked(
                    target,
                    &backup_content,
                    &applied_change.written_hash,
                ) {
                    errors.push(format_rollback_error(
                        target,
                        &applied_change.original,
                        format!(
                            "failed to restore backup without overwriting external content: {error}"
                        ),
                    ));
                }
            }
            OriginalFile::Missing => {
                if let Err(error) =
                    remove_written_file_checked(target, &applied_change.written_hash)
                {
                    errors.push(format_rollback_error(
                        target,
                        &applied_change.original,
                        format!("failed to remove newly created file: {error}"),
                    ));
                }
            }
        }
    }
    errors
}

fn restore_existing_file_checked(
    target: &Path,
    backup_content: &[u8],
    written_hash: &str,
) -> std::io::Result<()> {
    restore_existing_file_checked_with_hook(target, backup_content, written_hash, |_| {})
}

fn restore_existing_file_checked_with_hook(
    target: &Path,
    backup_content: &[u8],
    written_hash: &str,
    after_move: impl FnOnce(&Path),
) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "target has no parent"))?;
    let quarantine_dir = tempfile::Builder::new()
        .prefix(".agentkib-rollback-")
        .tempdir_in(parent)?;
    let mut replacement = NamedTempFile::new_in(quarantine_dir.path())?;
    replacement.write_all(backup_content)?;
    replacement
        .as_file_mut()
        .set_permissions(fs::metadata(target)?.permissions())?;
    replacement.as_file_mut().sync_all()?;
    let replacement = replacement.into_temp_path();
    let quarantined = quarantine_dir.path().join("written");
    move_path(target, &quarantined)?;
    after_move(&quarantined);
    let current = match fs::symlink_metadata(&quarantined) {
        Ok(metadata) if metadata.is_file() => fs::read(&quarantined),
        Ok(_) => Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "moved target is not a regular file",
        )),
        Err(error) => Err(error),
    };
    let reason = match current {
        Ok(current) if hash_content(&current) == written_hash => {
            match fs::hard_link(&replacement, target) {
                Ok(()) => {
                    drop(replacement);
                    return quarantine_dir.close();
                }
                Err(error) => format!("could not atomically restore backup: {error}"),
            }
        }
        Ok(_) => "file was modified externally".to_owned(),
        Err(error) => format!("failed to verify moved target: {error}"),
    };
    drop(replacement);
    let preserved = quarantine_dir.keep().join("written");
    let restore = if fs::symlink_metadata(&preserved).is_ok_and(|meta| meta.is_file()) {
        fs::hard_link(&preserved, target)
    } else {
        Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "moved target is not a regular file",
        ))
    };
    let restore_note = match restore {
        Ok(()) => "also restored to the original path".to_owned(),
        Err(error) => format!("could not restore the original path: {error}"),
    };
    Err(std::io::Error::new(
        ErrorKind::InvalidData,
        format!(
            "{reason}: {}; inspect moved content at {} ({restore_note})",
            target.display(),
            preserved.display()
        ),
    ))
}

fn remove_written_file_checked(target: &Path, written_hash: &str) -> std::io::Result<()> {
    remove_written_file_checked_with_hook(target, written_hash, |_| {})
}

fn remove_written_file_checked_with_hook(
    target: &Path,
    written_hash: &str,
    after_move: impl FnOnce(&Path),
) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "target has no parent"))?;
    let quarantine_dir = tempfile::Builder::new()
        .prefix(".agentkib-rollback-")
        .tempdir_in(parent)?;
    let quarantined = quarantine_dir.path().join("written");
    // Move the pathname away first: a replacement at the original path after
    // this point cannot be unlinked by our rollback.
    move_path(target, &quarantined)?;
    after_move(&quarantined);
    let current = match fs::symlink_metadata(&quarantined) {
        Ok(metadata) if metadata.is_file() => fs::read(&quarantined),
        Ok(_) => Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "moved target is not a regular file",
        )),
        Err(error) => Err(error),
    };
    let reason = match current {
        Ok(current) if hash_content(&current) == written_hash => {
            match fs::remove_file(&quarantined) {
                Ok(()) => return Ok(()),
                Err(error) => format!("failed to remove verified moved file: {error}"),
            }
        }
        Ok(_) => "file was modified externally".to_owned(),
        Err(error) => format!("failed to verify moved target: {error}"),
    };
    let preserved = quarantine_dir.keep().join("written");
    let restore = if fs::symlink_metadata(&preserved).is_ok_and(|meta| meta.is_file()) {
        fs::hard_link(&preserved, target)
    } else {
        Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "moved target is not a regular file",
        ))
    };
    let restore_note = match restore {
        Ok(()) => "also restored to the original path".to_owned(),
        Err(error) => format!("could not restore the original path: {error}"),
    };
    Err(std::io::Error::new(
        ErrorKind::InvalidData,
        format!(
            "{reason}: {}; inspect moved content at {} ({restore_note})",
            target.display(),
            preserved.display()
        ),
    ))
}

fn format_rollback_error(target: &Path, original: &OriginalFile, message: String) -> String {
    match original {
        OriginalFile::Existing { backup, .. } => format!(
            "{} (backup: {}): {message}",
            target.display(),
            backup.display()
        ),
        OriginalFile::Missing => format!("{} (originally absent): {message}", target.display()),
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
        "jsonc" => {
            let _: serde_json::Value = json5::from_str(content)?;
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

    fn project_change(
        target: PathBuf,
        before: Option<&str>,
        after: &str,
        validator: &str,
    ) -> FileChange {
        FileChange {
            target,
            scope: ChangeScope::Project,
            original_hash: before.map(|content| hash_content(content.as_bytes())),
            before: before.unwrap_or_default().into(),
            after: after.into(),
            risk: RiskLevel::Low,
            validator: validator.into(),
        }
    }

    fn change_set(project_root: &Path, changes: Vec<FileChange>) -> ChangeSet {
        ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: project_root.canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes,
        }
    }

    #[test]
    fn preserves_external_modification_when_replace_has_not_happened() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("AGENTS.md");
        fs::write(&target, "old").unwrap();
        let set = change_set(
            dir.path(),
            vec![project_change(
                target.clone(),
                Some("old"),
                "agent",
                "markdown",
            )],
        );

        let error = apply_changeset_with_hook(
            &set,
            &dir.path().join("backup"),
            &ApplyOptions::default(),
            |event| {
                if let ApplyEvent::BeforeReplace {
                    index: 0, target, ..
                } = event
                {
                    fs::write(target, "external").unwrap();
                }
            },
        )
        .unwrap_err();

        assert!(error.to_string().contains("Failed to write"));
        assert_eq!(fs::read_to_string(target).unwrap(), "external");
    }

    #[test]
    fn preserves_external_creation_when_replace_has_not_happened() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("new.md");
        let set = change_set(
            dir.path(),
            vec![project_change(target.clone(), None, "agent", "markdown")],
        );

        apply_changeset_with_hook(
            &set,
            &dir.path().join("backup"),
            &ApplyOptions::default(),
            |event| {
                if let ApplyEvent::BeforeReplace {
                    index: 0, target, ..
                } = event
                {
                    fs::write(target, "external").unwrap();
                }
            },
        )
        .unwrap_err();

        assert_eq!(fs::read_to_string(target).unwrap(), "external");
    }

    #[test]
    fn rolls_back_only_the_applied_prefix_after_a_later_conflict() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.md");
        let second = dir.path().join("second.md");
        fs::write(&first, "first-old").unwrap();
        fs::write(&second, "second-old").unwrap();
        let set = change_set(
            dir.path(),
            vec![
                project_change(first.clone(), Some("first-old"), "first-agent", "markdown"),
                project_change(
                    second.clone(),
                    Some("second-old"),
                    "second-agent",
                    "markdown",
                ),
            ],
        );

        apply_changeset_with_hook(
            &set,
            &dir.path().join("backup"),
            &ApplyOptions::default(),
            |event| {
                if let ApplyEvent::BeforeReplace {
                    index: 1, target, ..
                } = event
                {
                    fs::write(target, "second-external").unwrap();
                }
            },
        )
        .unwrap_err();

        assert_eq!(fs::read_to_string(first).unwrap(), "first-old");
        assert_eq!(fs::read_to_string(second).unwrap(), "second-external");
    }

    #[test]
    fn preserves_external_change_made_before_rollback_and_reports_backup() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.md");
        let second = dir.path().join("second.md");
        fs::write(&first, "first-old").unwrap();
        fs::write(&second, "second-old").unwrap();
        let set = change_set(
            dir.path(),
            vec![
                project_change(first.clone(), Some("first-old"), "first-agent", "markdown"),
                project_change(
                    second.clone(),
                    Some("second-old"),
                    "second-agent",
                    "markdown",
                ),
            ],
        );

        let error = apply_changeset_with_hook(
            &set,
            &dir.path().join("backup"),
            &ApplyOptions::default(),
            |event| match event {
                ApplyEvent::BeforeReplace {
                    index: 1, target, ..
                } => {
                    fs::write(target, "second-external").unwrap();
                }
                ApplyEvent::BeforeRollback { index: 0, target } => {
                    fs::write(target, "first-external").unwrap();
                }
                _ => {}
            },
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("Failed to write"));
        assert!(message.contains("rollback incomplete"));
        assert!(message.contains("external content was preserved"));
        assert!(message.contains("0.bak"));
        assert_eq!(fs::read_to_string(first).unwrap(), "first-external");
        assert_eq!(fs::read_to_string(second).unwrap(), "second-external");
    }

    #[test]
    fn reports_a_missing_backup_without_overwriting_the_written_file() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("config.json");
        fs::write(&target, "{}").unwrap();
        let set = change_set(
            dir.path(),
            vec![project_change(
                target.clone(),
                Some("{}"),
                "not-json",
                "json",
            )],
        );

        let error = apply_changeset_with_hook(
            &set,
            &dir.path().join("backup"),
            &ApplyOptions::default(),
            |event| {
                if let ApplyEvent::AfterReplace {
                    index: 0,
                    backup: Some(backup),
                    ..
                } = event
                {
                    fs::remove_file(backup).unwrap();
                }
            },
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("Post-write validation failed"));
        assert!(message.contains("failed to read backup"));
        assert!(message.contains("0.bak"));
        assert_eq!(fs::read_to_string(target).unwrap(), "not-json");
    }

    #[test]
    fn reports_an_unreadable_backup_without_overwriting_the_written_file() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("config.json");
        fs::write(&target, "{}").unwrap();
        let set = change_set(
            dir.path(),
            vec![project_change(
                target.clone(),
                Some("{}"),
                "not-json",
                "json",
            )],
        );

        let error = apply_changeset_with_hook(
            &set,
            &dir.path().join("backup"),
            &ApplyOptions::default(),
            |event| {
                if let ApplyEvent::AfterReplace {
                    index: 0,
                    backup: Some(backup),
                    ..
                } = event
                {
                    fs::remove_file(&backup).unwrap();
                    fs::create_dir(&backup).unwrap();
                }
            },
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("failed to read backup"));
        assert!(message.contains("0.bak"));
        assert_eq!(fs::read_to_string(target).unwrap(), "not-json");
    }

    #[test]
    fn preserves_an_externally_changed_new_file_instead_of_deleting_it() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("new.json");
        let set = change_set(
            dir.path(),
            vec![project_change(target.clone(), None, "not-json", "json")],
        );

        let error = apply_changeset_with_hook(
            &set,
            &dir.path().join("backup"),
            &ApplyOptions::default(),
            |event| {
                if let ApplyEvent::AfterReplace { index: 0, .. } = event {
                    fs::write(&target, "external-not-json").unwrap();
                }
            },
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("modified externally after write"));
        assert!(message.contains("rollback incomplete"));
        assert!(message.contains("external content was preserved"));
        assert_eq!(fs::read_to_string(target).unwrap(), "external-not-json");
    }

    #[test]
    fn rollback_of_new_file_does_not_delete_a_replacement_after_move() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("new.json");
        fs::write(&target, "agent-write").unwrap();
        remove_written_file_checked_with_hook(&target, &hash_content(b"agent-write"), |_| {
            fs::write(&target, "external-write").unwrap();
        })
        .unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "external-write");
    }

    #[test]
    fn rollback_of_new_file_preserves_moved_external_content() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("new.json");
        fs::write(&target, "external-write").unwrap();
        let error = remove_written_file_checked(&target, &hash_content(b"agent-write"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("file was modified externally"));
        assert!(error.contains("inspect moved content at"));
        assert_eq!(fs::read_to_string(target).unwrap(), "external-write");
        let preserved = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".agentkib-rollback-")
            })
            .unwrap()
            .path()
            .join("written");
        assert_eq!(fs::read_to_string(preserved).unwrap(), "external-write");
    }

    #[test]
    fn rollback_of_existing_file_does_not_overwrite_a_replacement_after_move() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("existing.json");
        fs::write(&target, "agent-write").unwrap();
        let error = restore_existing_file_checked_with_hook(
            &target,
            b"original-content",
            &hash_content(b"agent-write"),
            |_| fs::write(&target, "external-write").unwrap(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("could not atomically restore backup"));
        assert!(error.contains("inspect moved content at"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "external-write");
    }

    #[test]
    fn rollback_of_existing_file_preserves_external_edits_to_moved_target() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("existing.json");
        fs::write(&target, "agent-write").unwrap();
        let error = restore_existing_file_checked_with_hook(
            &target,
            b"original-content",
            &hash_content(b"agent-write"),
            |moved| fs::write(moved, "external-write").unwrap(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("file was modified externally"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "external-write");
    }

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
    fn accepts_jsonc_validator_for_opencode_changes() {
        validate_written("jsonc", "{ // comment\n instructions: [],\n}").unwrap();
    }

    #[test]
    fn applies_an_opencode_jsonc_change() {
        let dir = tempdir().unwrap();
        let target = dir.path().join(".opencode/opencode.jsonc");
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: dir.path().canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes: vec![FileChange {
                target: target.clone(),
                scope: ChangeScope::Project,
                original_hash: None,
                before: String::new(),
                after: "{ // comment\n instructions: [],\n}".into(),
                risk: RiskLevel::Low,
                validator: "jsonc".into(),
            }],
        };

        apply_changeset(&set, &dir.path().join("backup"), &ApplyOptions::default()).unwrap();
        assert!(target.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_project_change_through_a_symlinked_directory() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real-opencode");
        fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join(".opencode")).unwrap();
        let target = dir.path().join(".opencode/opencode.json");
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: dir.path().canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes: vec![FileChange {
                target,
                scope: ChangeScope::Project,
                original_hash: None,
                before: String::new(),
                after: "{}".into(),
                risk: RiskLevel::Low,
                validator: "json".into(),
            }],
        };

        assert!(
            apply_changeset(&set, &dir.path().join("backup"), &ApplyOptions::default()).is_err()
        );
        assert!(!real.join("opencode.json").exists());
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
        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
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

        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
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

    #[cfg(unix)]
    #[test]
    fn protected_agent_home_rejects_a_symlinked_session_parent() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let project = dir.path().join("project");
        let agent_home = dir.path().join("agent-home");
        let session_root = agent_home.join("sessions");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&agent_home).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &session_root).unwrap();
        let target = session_root.join("2026/09/session.jsonl");
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: project.canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: true,
            changes: vec![FileChange {
                target: target.clone(),
                scope: ChangeScope::AgentHome,
                original_hash: None,
                before: String::new(),
                after: "{}\n".into(),
                risk: RiskLevel::High,
                validator: "jsonl".into(),
            }],
        };
        let options = ApplyOptions {
            approved_home_files: vec![target],
            protected_home_roots: vec![session_root],
            home_approval: true,
            ..ApplyOptions::default()
        };

        assert!(apply_changeset(&set, &dir.path().join("backup"), &options).is_err());
        assert!(!outside.join("2026/09/session.jsonl").exists());
    }

    #[cfg(unix)]
    #[test]
    fn protected_agent_home_rejects_a_symlinked_agent_home() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let project = dir.path().join("project");
        let agent_home = dir.path().join("agent-home");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(outside.join("sessions")).unwrap();
        symlink(&outside, &agent_home).unwrap();
        let session_root = agent_home.join("sessions");
        let target = session_root.join("2026/09/session.jsonl");
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: project.canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: true,
            changes: vec![FileChange {
                target: target.clone(),
                scope: ChangeScope::AgentHome,
                original_hash: None,
                before: String::new(),
                after: "{}\n".into(),
                risk: RiskLevel::High,
                validator: "jsonl".into(),
            }],
        };
        let options = ApplyOptions {
            approved_home_files: vec![target],
            protected_home_roots: vec![session_root],
            home_approval: true,
            ..ApplyOptions::default()
        };

        assert!(apply_changeset(&set, &dir.path().join("backup"), &options).is_err());
        assert!(!outside.join("sessions/2026/09/session.jsonl").exists());
    }
}
