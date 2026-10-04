use std::{fs, io::Read, path::Path};

use agentkib_core::{SkillPackageFile, SkillPreviewFile, is_private_skill_path};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};

use super::{
    MAX_PREVIEW_BYTES, bounded_package_files, bounded_package_manifest, is_executable,
    safe_relative_path, utf8_package_relative,
};

pub(crate) fn copy_package(source: &Path, destination: &Path) -> Result<()> {
    let package = bounded_package_manifest(source)?;
    fs::create_dir_all(destination)?;
    for directory in package.directories {
        fs::create_dir_all(destination.join(directory.strip_prefix(source)?))?;
    }
    for (file, metadata) in package.files {
        let relative = file.strip_prefix(source)?;
        let target = destination.join(relative);
        fs::create_dir_all(target.parent().context("Skill file has no parent")?)?;
        let input = fs::File::open(&file)?;
        let mut output = fs::File::create(&target)?;
        let copied = std::io::copy(
            &mut input.take(super::MAX_SKILL_FILE_BYTES + 1),
            &mut output,
        )?;
        ensure!(
            copied <= super::MAX_SKILL_FILE_BYTES && copied == metadata.len(),
            "Skill resource changed or exceeded the file limit while copying"
        );
        fs::set_permissions(&target, metadata.permissions())?;
    }
    Ok(())
}

pub(crate) fn ensure_importable(root: &Path) -> Result<()> {
    // Local imports preserve the whole package or fail, rather than silently
    // dropping files that might contain credentials from the selected source.
    for (file, _) in bounded_package_files(root)?.0 {
        let relative = file.strip_prefix(root)?;
        ensure!(
            !is_private_skill_path(relative),
            "Skill package contains a private file: {}",
            relative.display()
        );
    }
    Ok(())
}

pub(crate) fn package_files(root: &Path) -> Result<(Vec<SkillPackageFile>, Vec<String>)> {
    let mut output = Vec::new();
    let mut diagnostics = Vec::new();
    let mut total = 0_u64;
    let mut file_count = 0_usize;
    for (index, entry) in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        ensure!(
            index < super::MAX_SKILL_PACKAGE_ENTRIES,
            "Skill package contains more than 4096 entries"
        );
        let entry = entry?;
        if entry.depth() == 0 {
            continue;
        }
        let path = entry.path();
        let relative = utf8_package_relative(root, path)?;
        if entry.file_type().is_dir() && !agentkib_platform::path::is_reparse_or_symlink(path)? {
            // A trailing slash distinguishes a directory from a historical file at
            // the same path. Directories are visible entries, never file-read targets.
            output.push(SkillPackageFile {
                path: format!("{relative}/"),
                size: 0,
                sha256: String::new(),
                executable: false,
                binary: false,
            });
            continue;
        }
        ensure!(
            file_count < super::MAX_SKILL_FILES,
            "Skill package contains more than 512 files"
        );
        file_count += 1;
        if !entry.file_type().is_file() || agentkib_platform::path::is_reparse_or_symlink(path)? {
            diagnostics.push(format!(
                "Unsupported linked or special file cannot be read or copied: {relative}"
            ));
            output.push(SkillPackageFile {
                path: relative,
                size: 0,
                sha256: String::new(),
                executable: false,
                binary: false,
            });
            continue;
        }
        let metadata = fs::symlink_metadata(path)?;
        ensure!(
            metadata.len() <= super::MAX_SKILL_FILE_BYTES,
            "Skill resource exceeds the file limit"
        );
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(super::MAX_SKILL_FILE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= super::MAX_SKILL_FILE_BYTES,
            "Skill resource exceeds the file limit"
        );
        total += bytes.len() as u64;
        ensure!(
            total <= super::MAX_SKILL_TOTAL_BYTES,
            "Skill package exceeds the total size limit"
        );
        if is_private_skill_path(Path::new(&relative)) {
            diagnostics.push(format!("Private file cannot be read or copied: {relative}"));
        }
        output.push(SkillPackageFile {
            path: relative,
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            executable: is_executable(&metadata),
            binary: bytes.contains(&0) || std::str::from_utf8(&bytes).is_err(),
        });
    }
    output.sort_by(|left, right| left.path.cmp(&right.path));
    Ok((output, diagnostics))
}

struct FileSnapshot {
    content: Option<String>,
    size: u64,
    sha256: String,
    executable: bool,
    binary: bool,
    truncated: bool,
}

fn snapshot(root: &Path, relative: &Path) -> Result<Option<FileSnapshot>> {
    let file = root.join(relative);
    // Verify all parent components before opening; internal links may not
    // turn a selected package resource into an arbitrary filesystem read.
    // A file may replace a directory between versions, so a regular file in
    // the parent chain or a directory at the requested path means this side
    // has no file. Inspect each component before taking that shortcut.
    let mut cursor = root.to_path_buf();
    let mut components = relative.components().peekable();
    let mut metadata = None;
    while let Some(component) = components.next() {
        cursor.push(component);
        let current = match fs::symlink_metadata(&cursor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            !agentkib_platform::path::is_reparse_or_symlink(&cursor)?,
            "Symbolic Skill resources cannot be read"
        );
        if components.peek().is_some() {
            if current.is_file() {
                return Ok(None);
            }
            ensure!(
                current.is_dir(),
                "Skill resource parent must be a regular directory"
            );
        } else {
            if current.is_dir() {
                return Ok(None);
            }
            ensure!(current.is_file(), "Skill resource must be a regular file");
            metadata = Some(current);
        }
    }
    let metadata = metadata.context("Skill resource path is empty")?;
    ensure!(
        metadata.len() <= super::MAX_SKILL_FILE_BYTES,
        "Skill resource exceeds the file limit"
    );
    let mut bytes = Vec::new();
    fs::File::open(&file)?
        .take(super::MAX_SKILL_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= super::MAX_SKILL_FILE_BYTES,
        "Skill resource exceeds the file limit"
    );
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    let truncated = bytes.len() as u64 > MAX_PREVIEW_BYTES;
    let content = if binary {
        None
    } else {
        let text = std::str::from_utf8(&bytes)?;
        let mut end = text.len().min(MAX_PREVIEW_BYTES as usize);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Some(text[..end].to_string())
    };
    Ok(Some(FileSnapshot {
        content,
        size: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        executable: is_executable(&metadata),
        binary,
        truncated,
    }))
}

pub(crate) fn preview_file(
    before: Option<&Path>,
    after: Option<&Path>,
    relative: &str,
) -> Result<SkillPreviewFile> {
    let relative_path = safe_relative_path(relative)?;
    ensure!(
        !relative_path.as_os_str().is_empty() && !is_private_skill_path(&relative_path),
        "Skill resource is private or unsafe"
    );
    let before = before
        .map(|root| snapshot(root, &relative_path))
        .transpose()?
        .flatten();
    let after = after
        .map(|root| snapshot(root, &relative_path))
        .transpose()?
        .flatten();
    ensure!(
        before.is_some() || after.is_some(),
        "Skill resource does not exist"
    );
    Ok(SkillPreviewFile {
        path: super::package_relative_path(&relative_path)?,
        before: before.as_ref().and_then(|value| value.content.clone()),
        after: after.as_ref().and_then(|value| value.content.clone()),
        binary: before.as_ref().is_some_and(|value| value.binary)
            || after.as_ref().is_some_and(|value| value.binary),
        truncated: before.as_ref().is_some_and(|value| value.truncated)
            || after.as_ref().is_some_and(|value| value.truncated),
        before_size: before.as_ref().map(|value| value.size),
        after_size: after.as_ref().map(|value| value.size),
        before_sha256: before.as_ref().map(|value| value.sha256.clone()),
        after_sha256: after.as_ref().map(|value| value.sha256.clone()),
        before_executable: before.as_ref().map(|value| value.executable),
        after_executable: after.as_ref().map(|value| value.executable),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_empty_directories_and_detects_their_changes() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let copy = temp.path().join("copy");
        fs::create_dir_all(source.join("output/nested")).unwrap();
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(source.join("SKILL.md"), "Skill").unwrap();
        fs::write(
            source.join("scripts/guide.txt"),
            "Write reports under output/nested",
        )
        .unwrap();
        let expected = crate::package_hash(&source).unwrap().0;

        copy_package(&source, &copy).unwrap();

        assert!(copy.join("output/nested").is_dir());
        assert_eq!(crate::package_hash(&copy).unwrap().0, expected);
        // The copied package retains the directory required by its instructions.
        fs::write(copy.join("output/nested/report.txt"), "report").unwrap();
        assert_ne!(crate::package_hash(&copy).unwrap().0, expected);
        fs::remove_file(copy.join("output/nested/report.txt")).unwrap();
        assert_eq!(crate::package_hash(&copy).unwrap().0, expected);
        fs::rename(copy.join("output/nested"), copy.join("output/renamed")).unwrap();
        assert_ne!(crate::package_hash(&copy).unwrap().0, expected);
        fs::remove_dir_all(copy.join("output")).unwrap();
        assert_ne!(crate::package_hash(&copy).unwrap().0, expected);
        assert!(source.join("output/nested").is_dir());
    }

    #[test]
    fn directory_entries_are_visible_without_consuming_the_file_budget() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("SKILL.md"), "# Skill").unwrap();
        for index in 0..=super::super::MAX_SKILL_FILES {
            fs::create_dir(root.join(format!("output-{index:04}"))).unwrap();
        }
        let (entries, diagnostics) = package_files(root).unwrap();
        assert!(diagnostics.is_empty());
        assert_eq!(entries.len(), super::super::MAX_SKILL_FILES + 2);
        assert!(entries.iter().any(|entry| entry.path == "SKILL.md"));
        assert!(entries.iter().any(|entry| entry.path == "output-0000/"));
        assert!(preview_file(None, Some(root), "output-0000/").is_err());
    }

    #[test]
    fn preview_deltas_include_directory_only_changes_and_file_transitions() {
        let temp = tempfile::tempdir().unwrap();
        let before = temp.path().join("before");
        let after = temp.path().join("after");
        for root in [&before, &after] {
            fs::create_dir_all(root).unwrap();
            fs::write(root.join("SKILL.md"), "# Skill").unwrap();
        }
        fs::create_dir_all(before.join("old/nested")).unwrap();
        fs::create_dir_all(after.join("new/nested")).unwrap();
        let (added, modified, removed) = crate::file_delta(&before, &after).unwrap();
        assert_eq!(added, ["new/", "new/nested/"]);
        assert_eq!(removed, ["old/", "old/nested/"]);
        assert!(modified.is_empty());

        fs::write(after.join("old"), "Now a regular file").unwrap();
        let (added, modified, removed) = crate::file_delta(&before, &after).unwrap();
        assert!(added.contains(&"old".into()));
        assert!(removed.contains(&"old/".into()));
        assert!(removed.contains(&"old/nested/".into()));
        assert!(modified.is_empty());
        let (reverse_added, _, reverse_removed) = crate::file_delta(&after, &before).unwrap();
        assert_eq!(reverse_added, removed);
        assert_eq!(reverse_removed, added);
    }

    #[test]
    fn packages_without_empty_directories_keep_the_legacy_hash() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("SKILL.md"), "Skill").unwrap();
        let before = crate::package_hash(temp.path()).unwrap().0;
        assert_eq!(
            before,
            "5b21bb74959830235a44a0b3c0ee19d2813e2a6d145583624e783b011a3fef78"
        );
        fs::create_dir(temp.path().join("output")).unwrap();
        assert_ne!(crate::package_hash(temp.path()).unwrap().0, before);
        fs::remove_dir(temp.path().join("output")).unwrap();
        assert_eq!(crate::package_hash(temp.path()).unwrap().0, before);
    }

    #[test]
    fn private_ancestors_block_import_and_preview_without_hiding_custom_resources() {
        for relative in [
            "secrets/config.json",
            "access-token/data.json",
            "custom/Secrets/nested/config.json",
            "custom/access-token/nested/data.json",
            "custom/production.env/data.json",
            "custom/archive-state.db/data.json",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            fs::write(root.join("SKILL.md"), "# Skill").unwrap();
            let safe = "custom/examples/guide.json";
            fs::create_dir_all(root.join(safe).parent().unwrap()).unwrap();
            fs::write(root.join(safe), "Safe custom resource").unwrap();
            fs::create_dir_all(root.join(relative).parent().unwrap()).unwrap();
            fs::write(root.join(relative), "Synthetic private fixture").unwrap();

            let (files, diagnostics) = package_files(root).unwrap();
            assert!(files.iter().any(|file| file.path == relative));
            assert!(files.iter().any(|file| file.path == safe));
            assert!(diagnostics.iter().any(|message| message.contains(relative)));
            assert!(
                ensure_importable(root)
                    .unwrap_err()
                    .to_string()
                    .contains(relative)
            );
            assert!(preview_file(None, Some(root), relative).is_err());
            assert_eq!(
                preview_file(None, Some(root), safe)
                    .unwrap()
                    .after
                    .as_deref(),
                Some("Safe custom resource")
            );
        }
    }

    #[test]
    fn previews_file_directory_transitions_in_both_directions() {
        let temp = tempfile::tempdir().unwrap();
        let flat = temp.path().join("flat");
        let nested = temp.path().join("nested");
        fs::create_dir(&flat).unwrap();
        fs::create_dir_all(nested.join("resources")).unwrap();
        fs::write(flat.join("resources"), "flat content").unwrap();
        fs::write(nested.join("resources/guide.md"), "nested content").unwrap();

        for (before, after, reversed) in [(&flat, &nested, false), (&nested, &flat, true)] {
            let parent = preview_file(Some(before), Some(after), "resources").unwrap();
            let child = preview_file(Some(before), Some(after), "resources/guide.md").unwrap();
            let (flat_side, absent_parent_side, nested_side, absent_child_side) = if reversed {
                (parent.after, parent.before, child.before, child.after)
            } else {
                (parent.before, parent.after, child.after, child.before)
            };
            assert_eq!(flat_side.as_deref(), Some("flat content"));
            assert_eq!(nested_side.as_deref(), Some("nested content"));
            assert!(absent_parent_side.is_none());
            assert!(absent_child_side.is_none());
        }
        assert!(preview_file(None, Some(&nested), "resources").is_err());
        assert!(preview_file(None, Some(&flat), "resources/guide.md").is_err());
        assert!(preview_file(Some(&flat), Some(&nested), "../flat/resources").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_linked_parents_even_when_the_selected_file_is_absent() {
        let temp = tempfile::tempdir().unwrap();
        let before = temp.path().join("before");
        let after = temp.path().join("after");
        let outside = temp.path().join("outside");
        fs::create_dir(&before).unwrap();
        fs::create_dir_all(after.join("resources")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(after.join("resources/guide.md"), "safe content").unwrap();

        for destination in [&outside, &temp.path().join("missing")] {
            std::os::unix::fs::symlink(destination, before.join("resources")).unwrap();
            for relative in ["resources", "resources/guide.md"] {
                let error = preview_file(Some(&before), Some(&after), relative).unwrap_err();
                assert!(error.to_string().contains("Symbolic Skill resources"));
            }
            fs::remove_file(before.join("resources")).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn copies_and_previews_colons_in_unix_package_filenames() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let copy = temp.path().join("copy");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("C:notes.md"), "colon filename").unwrap();

        copy_package(&source, &copy).unwrap();
        let (files, diagnostics) = package_files(&copy).unwrap();
        assert!(diagnostics.is_empty());
        assert_eq!(files[0].path, "C:notes.md");
        let preview = preview_file(Some(&source), Some(&copy), "C:notes.md").unwrap();
        assert_eq!(preview.before.as_deref(), Some("colon filename"));
        assert_eq!(preview.after, preview.before);
        assert_eq!(
            preview.after_sha256.as_deref(),
            Some(files[0].sha256.as_str())
        );
    }

    #[test]
    fn nested_file_manifest_and_preview_refer_to_the_copied_file() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let copy = temp.path().join("copy");
        fs::create_dir_all(source.join("a")).unwrap();
        fs::write(source.join("SKILL.md"), "Skill").unwrap();
        fs::write(source.join("b.txt"), "root resource").unwrap();
        fs::write(source.join("a/b.txt"), "nested resource").unwrap();

        copy_package(&source, &copy).unwrap();

        assert_eq!(
            crate::package_hash(&source).unwrap().0,
            crate::package_hash(&copy).unwrap().0
        );
        let (files, diagnostics) = package_files(&copy).unwrap();
        assert!(diagnostics.is_empty());
        assert_eq!(files.len(), 4);
        assert!(files.iter().any(|entry| entry.path == "a/"));
        for file in files.iter().filter(|entry| !entry.path.ends_with('/')) {
            let preview = preview_file(Some(&source), Some(&copy), &file.path).unwrap();
            let original = fs::read_to_string(source.join(&file.path)).unwrap();
            assert_eq!(preview.path, file.path);
            assert_eq!(preview.before.as_deref(), Some(original.as_str()));
            assert_eq!(preview.after.as_deref(), Some(original.as_str()));
            assert_eq!(preview.after_size, Some(file.size));
            assert_eq!(preview.after_sha256.as_deref(), Some(file.sha256.as_str()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_unrepresentable_directory_names_even_without_files() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir_all(source.join(r"empty\directory")).unwrap();
        fs::write(source.join("SKILL.md"), "Skill").unwrap();
        let copy = temp.path().join("copy");

        assert!(ensure_importable(&source).is_err());
        assert!(copy_package(&source, &copy).is_err());
        assert!(package_files(&source).is_err());
        assert!(crate::package_hash(&source).is_err());
        assert!(!copy.exists());
        assert!(source.join(r"empty\directory").is_dir());
    }

    #[test]
    fn lists_custom_binary_and_private_files_but_refuses_private_imports_and_reads() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir(root.join("custom")).unwrap();
        fs::write(root.join("SKILL.md"), "Skill").unwrap();
        fs::write(root.join("custom/image.bin"), [0, 255, 13]).unwrap();
        fs::write(root.join("LICENSE"), "license").unwrap();
        fs::write(root.join(".env.local"), "private fixture").unwrap();
        let (files, diagnostics) = package_files(root).unwrap();
        assert_eq!(files.len(), 5);
        assert!(files.iter().any(|entry| entry.path == "custom/"));
        assert!(
            files
                .iter()
                .any(|file| file.path == "custom/image.bin" && file.binary && file.size == 3)
        );
        assert_eq!(diagnostics.len(), 1);
        assert!(ensure_importable(root).is_err());
        assert!(preview_file(None, Some(root), ".env.local").is_err());
        let binary = preview_file(None, Some(root), "custom/image.bin").unwrap();
        assert!(binary.binary);
        assert!(binary.after.is_none());
        assert_eq!(binary.after_size, Some(3));
        assert_eq!(
            preview_file(None, Some(root), "LICENSE")
                .unwrap()
                .after
                .as_deref(),
            Some("license")
        );
    }

    #[cfg(unix)]
    #[test]
    fn internal_links_are_diagnosed_without_reading_the_destination() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("package");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), "Skill").unwrap();
        let outside = temp.path().join("outside");
        fs::write(&outside, "outside").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked.txt")).unwrap();
        let (files, diagnostics) = package_files(&root).unwrap();
        assert!(
            files
                .iter()
                .any(|file| file.path == "linked.txt" && file.sha256.is_empty())
        );
        assert!(diagnostics.iter().any(|line| line.contains("linked.txt")));
        assert!(ensure_importable(&root).is_err());
        assert!(preview_file(None, Some(&root), "linked.txt").is_err());
    }

    #[test]
    fn previews_bound_text_while_preserving_full_hash_and_size() {
        let temp = tempfile::tempdir().unwrap();
        let text = "文".repeat(MAX_PREVIEW_BYTES as usize / 3 + 2);
        fs::write(temp.path().join("large.txt"), &text).unwrap();
        let preview = preview_file(None, Some(temp.path()), "large.txt").unwrap();
        assert!(preview.truncated);
        assert!(!preview.binary);
        assert_eq!(preview.after_size, Some(text.len() as u64));
        assert!(preview.after.unwrap().len() <= MAX_PREVIEW_BYTES as usize);
        assert_eq!(
            preview.after_sha256.unwrap(),
            format!("{:x}", Sha256::digest(text.as_bytes()))
        );
    }
}
