use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use walkdir::{DirEntry, WalkDir};

const MAX_SKILL_ENTRY_BYTES: u64 = 1024 * 1024;
const MAX_SKILL_METADATA_ENTRIES: usize = 4_096;
const MAX_SKILL_METADATA_FILES: usize = 512;
const MAX_SKILL_METADATA_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillPackage {
    pub name: String,
    pub root: PathBuf,
    pub entrypoint: PathBuf,
    pub size: u64,
    pub modified_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
}

pub fn inspect_skill_entrypoint(entrypoint: &Path) -> Result<SkillPackage> {
    if entrypoint.file_name().and_then(|value| value.to_str()) != Some("SKILL.md") {
        bail!("Skill entrypoint must be named SKILL.md");
    }
    let metadata = fs::symlink_metadata(entrypoint)
        .with_context(|| format!("Could not inspect {}", entrypoint.display()))?;
    if !metadata.file_type().is_file()
        || agentkib_platform::path::is_reparse_or_symlink(entrypoint)?
    {
        bail!("Skill entrypoint must be a regular file");
    }
    let root = entrypoint
        .parent()
        .context("Skill entrypoint has no parent directory")?
        .to_path_buf();
    if agentkib_platform::path::is_reparse_or_symlink(&root)? {
        bail!("Skill root must be a regular directory");
    }
    let root = agentkib_platform::path::canonicalize(&root)
        .with_context(|| format!("Could not resolve Skill root {}", root.display()))?;
    let entrypoint = root.join("SKILL.md");
    let fallback_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("skill")
        .to_string();
    let name = read_skill_name(&entrypoint).unwrap_or(fallback_name);
    let (size, modified_at) = package_metadata(&root);
    Ok(SkillPackage {
        name,
        root,
        entrypoint,
        size,
        modified_at,
    })
}

pub fn is_readable_skill_file(entrypoint: &Path, requested: &Path) -> bool {
    let Ok(package) = inspect_skill_entrypoint(entrypoint) else {
        return false;
    };
    let Ok(requested_metadata) = fs::symlink_metadata(requested) else {
        return false;
    };
    if !requested_metadata.file_type().is_file()
        || agentkib_platform::path::is_reparse_or_symlink(requested).unwrap_or(true)
    {
        return false;
    }
    let mut current = requested;
    loop {
        if agentkib_platform::path::equivalent(current, &package.root) {
            break;
        }
        if agentkib_platform::path::is_reparse_or_symlink(current).unwrap_or(true) {
            return false;
        }
        let Some(parent) = current.parent() else {
            return false;
        };
        current = parent;
    }
    let Ok(root) = agentkib_platform::path::canonicalize(&package.root) else {
        return false;
    };
    let Ok(requested) = agentkib_platform::path::canonicalize(requested) else {
        return false;
    };
    if !agentkib_platform::path::starts_with(&requested, &root) {
        return false;
    }
    let Ok(relative) = requested.strip_prefix(&root) else {
        return false;
    };
    !is_private_skill_path(relative)
}

fn read_skill_name(entrypoint: &Path) -> Option<String> {
    let metadata = fs::metadata(entrypoint).ok()?;
    if metadata.len() > MAX_SKILL_ENTRY_BYTES {
        return None;
    }
    let mut content = String::new();
    fs::File::open(entrypoint)
        .ok()?
        .take(MAX_SKILL_ENTRY_BYTES + 1)
        .read_to_string(&mut content)
        .ok()?;
    let frontmatter = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    let end = frontmatter.find("\n---")?;
    let parsed: SkillFrontmatter = serde_yaml::from_str(&frontmatter[..end]).ok()?;
    parsed.name.and_then(|name| {
        let name = name.trim();
        valid_skill_name(name).then(|| name.to_string())
    })
}

fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-')
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !name.contains("--")
}

fn package_metadata(root: &Path) -> (u64, Option<DateTime<Utc>>) {
    let mut size = 0_u64;
    let mut files = 0_usize;
    let mut modified_at: Option<DateTime<Utc>> = None;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .same_file_system(true)
        .into_iter()
        .filter_entry(allowed_skill_entry)
        .filter_map(Result::ok)
        .take(MAX_SKILL_METADATA_ENTRIES)
    {
        if !entry.file_type().is_file()
            || entry
                .path()
                .strip_prefix(root)
                .is_ok_and(is_private_skill_path)
        {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        if files >= MAX_SKILL_METADATA_FILES {
            break;
        }
        files += 1;
        size = size
            .saturating_add(metadata.len())
            .min(MAX_SKILL_METADATA_BYTES);
        if let Ok(modified) = metadata.modified() {
            let modified = DateTime::<Utc>::from(modified);
            modified_at = Some(modified_at.map_or(modified, |current| current.max(modified)));
        }
        if size >= MAX_SKILL_METADATA_BYTES {
            break;
        }
    }
    (size, modified_at)
}

fn allowed_skill_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(".git" | "node_modules" | "target" | "dist" | "build" | "__pycache__")
    ) && agentkib_platform::path::is_safe_scan_entry(entry.path())
}

fn is_private_skill_path(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    text.contains("credential")
        || text.contains("telemetry")
        || text.ends_with(".env")
        || text.contains("session")
        || text.ends_with("state.db")
        || path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| {
                let name = name.to_ascii_lowercase();
                name.contains("token")
                    || name.contains("secret")
                    || name.ends_with(".pem")
                    || name.ends_with(".key")
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_frontmatter_and_aggregates_safe_package_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("folder-name");
        fs::create_dir_all(root.join("references")).unwrap();
        let entrypoint = "---\nname: skill-installer\ndescription: Test\n---\nBody";
        let guide = "guide";
        fs::write(root.join("SKILL.md"), entrypoint).unwrap();
        fs::write(root.join("references/guide.md"), guide).unwrap();
        fs::write(root.join("access-token.txt"), "private").unwrap();

        let package = inspect_skill_entrypoint(&root.join("SKILL.md")).unwrap();

        assert_eq!(package.name, "skill-installer");
        assert_eq!(
            package.root,
            agentkib_platform::path::canonicalize(&root).unwrap()
        );
        assert_eq!(package.size, (entrypoint.len() + guide.len()) as u64);
        let expected_modified = [root.join("SKILL.md"), root.join("references/guide.md")]
            .into_iter()
            .filter_map(|path| fs::metadata(path).ok()?.modified().ok())
            .map(DateTime::<Utc>::from)
            .max();
        assert_eq!(package.modified_at, expected_modified);
    }

    #[test]
    fn invalid_frontmatter_falls_back_to_directory_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("fallback-name");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), "---\nname: [broken\n---\nBody").unwrap();

        let package = inspect_skill_entrypoint(&root.join("SKILL.md")).unwrap();

        assert_eq!(package.name, "fallback-name");

        fs::write(root.join("SKILL.md"), "---\nname: Display Name\n---\nBody").unwrap();
        let package = inspect_skill_entrypoint(&root.join("SKILL.md")).unwrap();
        assert_eq!(package.name, "fallback-name");
    }

    #[test]
    fn sensitive_words_outside_the_skill_root_do_not_hide_package_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("session-project/skill");
        fs::create_dir_all(root.join("references")).unwrap();
        let entrypoint = root.join("SKILL.md");
        let guide = root.join("references/guide.md");
        fs::write(&entrypoint, "# Skill").unwrap();
        fs::write(&guide, "guide").unwrap();

        let package = inspect_skill_entrypoint(&entrypoint).unwrap();

        assert_eq!(package.size, 12);
        assert!(is_readable_skill_file(&entrypoint, &guide));
    }

    #[test]
    fn package_metadata_stops_after_the_file_limit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("skill");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), "x").unwrap();
        for index in 0..MAX_SKILL_METADATA_FILES {
            fs::write(root.join(format!("file-{index:03}")), "x").unwrap();
        }

        let package = inspect_skill_entrypoint(&root.join("SKILL.md")).unwrap();

        assert_eq!(package.size, MAX_SKILL_METADATA_FILES as u64);
    }

    #[cfg(unix)]
    #[test]
    fn supporting_file_must_be_regular_private_free_and_inside_the_package() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("skill");
        fs::create_dir_all(root.join("references")).unwrap();
        let entrypoint = root.join("SKILL.md");
        fs::write(&entrypoint, "# Skill").unwrap();
        let guide = root.join("references/guide.md");
        fs::write(&guide, "guide").unwrap();
        let private = root.join("secret.txt");
        fs::write(&private, "private").unwrap();
        let outside = dir.path().join("outside.md");
        fs::write(&outside, "outside").unwrap();
        let link = root.join("references/link.md");
        symlink(&guide, &link).unwrap();

        assert!(is_readable_skill_file(&entrypoint, &guide));
        assert!(!is_readable_skill_file(&entrypoint, &private));
        assert!(!is_readable_skill_file(&entrypoint, &outside));
        assert!(!is_readable_skill_file(&entrypoint, &link));
    }
}
