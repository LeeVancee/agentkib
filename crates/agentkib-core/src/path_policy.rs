use std::path::{Path, PathBuf};

use agentkib_platform::path::{canonicalize, canonicalize_allow_missing, equivalent, starts_with};
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
    approved_application_files: &[PathBuf],
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
    if approved_application_files
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
        assert!(ensure_allowed_target(&project, &target, &[], &[]).is_err());
    }
}
