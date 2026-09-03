use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::{AgentKind, ConnectionTransport, Manifest};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

pub fn manifest_path(project: &Path) -> PathBuf {
    project.join(".agentkib/manifest.yaml")
}

pub(crate) fn manifest_entry_exists(project: &Path) -> bool {
    match fs::symlink_metadata(manifest_path(project)) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

pub fn load_manifest(project: &Path) -> Result<Manifest> {
    let path = manifest_path(project);
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("Could not inspect {}", path.display()))?;
    if !metadata.file_type().is_file() {
        bail!("manifest.yaml must be a regular file");
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        bail!("manifest.yaml exceeds the 1 MiB read limit");
    }
    let file = File::open(&path).with_context(|| format!("Could not read {}", path.display()))?;
    let manifest: Manifest = serde_yaml::from_reader(BufReader::new(
        file.take(metadata.len().min(MAX_MANIFEST_BYTES)),
    ))
    .context("manifest.yaml is invalid")?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if !matches!(manifest.schema_version, 1 | 2) {
        bail!("Only schema_version 1 or 2 is supported");
    }
    if manifest.workspace.id.trim().is_empty() || manifest.workspace.name.trim().is_empty() {
        bail!("workspace.id and workspace.name cannot be empty");
    }
    if matches!(manifest.workspace.id.as_str(), "." | "..") {
        bail!("workspace.id cannot be `.` or `..`");
    }
    let mut skill_names = BTreeSet::new();
    for skill in &manifest.skills {
        reject_read_only_target(&skill.targets)?;
        validate_relative_path(&skill.path, "Skill path")?;
        if skill.name.trim().is_empty() {
            bail!("Skill name cannot be empty");
        }
        validate_path_segment(&skill.name, "Skill name")?;
        if !skill_names.insert(skill.name.as_str()) {
            bail!("Duplicate Skill name: {}", skill.name);
        }
    }
    for scoped in &manifest.instructions.scoped {
        validate_relative_path(&scoped.path, "Scoped instruction path")?;
    }
    if manifest.schema_version >= 2 {
        validate_relative_path(&manifest.mcp.config, "MCP config")?;
    }
    let mut connection_names = BTreeSet::new();
    for connection in &manifest.connections {
        reject_read_only_target(&connection.targets)?;
        if connection.name.trim().is_empty() {
            bail!("MCP connection name cannot be empty");
        }
        if !connection_names.insert(connection.name.as_str()) {
            bail!("Duplicate MCP connection name: {}", connection.name);
        }
        for (name, value) in &connection.env {
            if !value.starts_with("${") || !value.ends_with('}') {
                bail!(
                    "Environment variable {} for connection {} must use a ${{VAR}} reference",
                    name,
                    connection.name
                );
            }
        }
        match &connection.transport {
            ConnectionTransport::Stdio { command, .. } if command.trim().is_empty() => {
                bail!("stdio command cannot be empty")
            }
            ConnectionTransport::Http { url }
                if !(url.starts_with("http://") || url.starts_with("https://")) =>
            {
                bail!("HTTP MCP URL is invalid")
            }
            _ => {}
        }
    }
    if manifest
        .instructions
        .platform_overrides
        .contains_key(&AgentKind::DeepSeekHarness)
        || manifest.adapters.contains_key(&AgentKind::DeepSeekHarness)
    {
        bail!("DeepSeek Harness Beta is read-only and cannot be a manifest write target");
    }
    if manifest
        .instructions
        .platform_overrides
        .get(&AgentKind::GrokBuild)
        .is_some_and(|content| !content.trim().is_empty())
    {
        bail!(
            "Grok Build does not support a safe AgentKib-specific instruction override; use shared or scoped AGENTS.md instructions"
        );
    }
    Ok(())
}

fn reject_read_only_target(targets: &[AgentKind]) -> Result<()> {
    if targets.contains(&AgentKind::DeepSeekHarness) {
        bail!("DeepSeek Harness Beta is read-only and cannot be a manifest write target");
    }
    Ok(())
}

fn validate_relative_path(value: &str, label: &str) -> Result<()> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        bail!("{label} must be a relative path inside the project: {value}");
    }
    Ok(())
}

fn validate_path_segment(value: &str, label: &str) -> Result<()> {
    let mut components = Path::new(value).components();
    if value.contains(['/', '\\'])
        || !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        bail!("{label} must be a single path-safe name: {value}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AdapterState, InstructionSet, MemoryPolicy, SkillDefinition, WorkspaceIdentity};
    use std::collections::BTreeMap;

    fn manifest() -> Manifest {
        Manifest {
            schema_version: 1,
            workspace: WorkspaceIdentity {
                id: "p1".into(),
                name: "demo".into(),
            },
            instructions: InstructionSet::default(),
            skills: vec![],
            mcp: Default::default(),
            connections: vec![],
            memories: MemoryPolicy::default(),
            adapters: BTreeMap::<_, AdapterState>::new(),
        }
    }

    #[test]
    fn rejects_paths_outside_project() {
        let mut value = manifest();
        value.skills.push(SkillDefinition {
            name: "unsafe".into(),
            path: "../secret/SKILL.md".into(),
            targets: vec![],
        });
        assert!(validate_manifest(&value).is_err());
    }

    #[test]
    fn rejects_workspace_ids_that_normalize_away_in_urls() {
        for id in [".", ".."] {
            let mut value = manifest();
            value.workspace.id = id.into();
            assert!(
                validate_manifest(&value)
                    .unwrap_err()
                    .to_string()
                    .contains("cannot be `.` or `..`")
            );
        }
    }

    #[test]
    fn rejects_skill_names_that_can_change_the_output_path() {
        for name in ["../escape", "nested/name", r"nested\name", ".", ".."] {
            let mut value = manifest();
            value.skills.push(SkillDefinition {
                name: name.into(),
                path: ".agents/skills/reviewer".into(),
                targets: vec![],
            });
            assert!(
                validate_manifest(&value)
                    .unwrap_err()
                    .to_string()
                    .contains("single path-safe name")
            );
        }
    }

    #[test]
    fn rejects_deepseek_harness_write_targets() {
        let mut value = manifest();
        value.skills.push(SkillDefinition {
            name: "read-only".into(),
            path: ".agents/skills/read-only".into(),
            targets: vec![AgentKind::DeepSeekHarness],
        });
        assert!(
            validate_manifest(&value)
                .unwrap_err()
                .to_string()
                .contains("read-only")
        );
    }

    #[test]
    fn rejects_grok_build_platform_override() {
        let mut value = manifest();
        value
            .instructions
            .platform_overrides
            .insert(AgentKind::GrokBuild, "Grok-only rule".into());
        assert!(
            validate_manifest(&value)
                .unwrap_err()
                .to_string()
                .contains("does not support")
        );
    }

    #[test]
    fn rejects_oversized_manifest_before_parsing() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        File::create(manifest_path(dir.path()))
            .unwrap()
            .set_len(MAX_MANIFEST_BYTES + 1)
            .unwrap();

        assert!(
            load_manifest(dir.path())
                .unwrap_err()
                .to_string()
                .contains("exceeds the 1 MiB read limit")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.yaml");
        fs::write(&source, serde_yaml::to_string(&manifest()).unwrap()).unwrap();
        fs::create_dir(dir.path().join(".agentkib")).unwrap();
        std::os::unix::fs::symlink(source, manifest_path(dir.path())).unwrap();

        assert!(
            load_manifest(dir.path())
                .unwrap_err()
                .to_string()
                .contains("must be a regular file")
        );
    }
}
