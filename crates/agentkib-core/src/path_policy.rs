use std::fs;
use std::path::{Path, PathBuf};

use agentkib_platform::path::{
    canonicalize, canonicalize_allow_missing, equivalent, is_reparse_or_symlink, starts_with,
};
use anyhow::{Context, Result, bail};

pub fn canonical_project(path: &Path) -> Result<PathBuf> {
    let canonical = canonicalize(path)
        .with_context(|| format!("Project directory does not exist: {}", path.display()))?;
    if !canonical.is_dir() {
        bail!("Project path is not a directory: {}", canonical.display());
    }
    Ok(canonical)
}

pub fn ensure_allowed_target(
    project: &Path,
    target: &Path,
    approved_home_files: &[PathBuf],
) -> Result<()> {
    let project = canonical_project(project)?;
    let candidate = canonicalize_allow_missing(target)?;
    if starts_with(&candidate, &project) {
        return Ok(());
    }
    if approved_home_files
        .iter()
        .filter_map(|path| canonicalize_allow_missing(path).ok())
        .any(|path| equivalent(&path, &candidate))
    {
        return Ok(());
    }
    bail!(
        "Refusing to write outside the project: {}",
        candidate.display()
    )
}

pub(crate) fn ensure_project_target_has_safe_ancestors(
    project: &Path,
    target: &Path,
) -> Result<()> {
    let project = canonical_project(project)?;
    let mut ancestor = Some(target);
    let lexical_project = loop {
        let Some(path) = ancestor else {
            bail!(
                "Project-scoped target is outside the project: {}",
                target.display()
            );
        };
        if canonicalize(path).is_ok_and(|path| equivalent(&path, &project)) {
            break path.to_path_buf();
        }
        ancestor = path.parent();
    };
    let relative = target.strip_prefix(&lexical_project).with_context(|| {
        format!(
            "Project-scoped target is outside the project: {}",
            target.display()
        )
    })?;
    let mut current = lexical_project;
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            bail!("Project target contains an unsafe path component");
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_reparse_or_symlink(&current)? {
                    bail!(
                        "Project ChangeSet targets cannot contain symbolic links or reparse points: {}",
                        current.display()
                    );
                }
                if current != target && !metadata.file_type().is_dir() {
                    bail!(
                        "Project ChangeSet target ancestor is not a directory: {}",
                        current.display()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_target_cannot_escape_with_parent_components() {
        let directory = tempdir().unwrap();
        let project = directory.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let target = project.join("missing/../../outside/config.json");
        assert!(ensure_allowed_target(&project, &target, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn project_target_rejects_a_symlinked_ancestor() {
        let directory = tempdir().unwrap();
        let project = directory.path().join("project");
        let real = project.join("real-opencode");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, project.join(".opencode")).unwrap();

        assert!(
            ensure_project_target_has_safe_ancestors(
                &project,
                &project.join(".opencode/opencode.json")
            )
            .is_err()
        );
    }
}
