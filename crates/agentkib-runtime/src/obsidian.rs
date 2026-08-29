use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use agentkib_platform::fs::atomic_write;
use agentkib_platform::path::{canonicalize, starts_with as path_starts_with};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct ObsidianInstallation {
    pub installed: bool,
    pub app_path: Option<PathBuf>,
    pub version: Option<String>,
    pub cli_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObsidianVaultSource {
    Discovered,
    Manual,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObsidianVault {
    pub path: PathBuf,
    pub name: String,
    pub source: ObsidianVaultSource,
    pub last_opened_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsidianWorkspaceLink {
    pub workspace_id: String,
    pub vault_path: PathBuf,
    pub target_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObsidianIntegration {
    pub installation: ObsidianInstallation,
    pub vaults: Vec<ObsidianVault>,
    pub workspace_links: Vec<ObsidianWorkspaceLink>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredObsidianIntegration {
    #[serde(default)]
    manual_vaults: Vec<PathBuf>,
    #[serde(default)]
    workspace_links: BTreeMap<String, ObsidianWorkspaceLink>,
}

pub fn integration(data_dir: &Path) -> Result<ObsidianIntegration> {
    let stored = load_stored(data_dir)?;
    Ok(ObsidianIntegration {
        installation: detect_installation(),
        vaults: merged_vaults(&stored),
        workspace_links: stored.workspace_links.into_values().collect(),
    })
}

pub fn add_vault(data_dir: &Path, path: &Path) -> Result<ObsidianIntegration> {
    let canonical = validate_vault(path)?;
    let mut stored = load_stored(data_dir)?;
    if !stored.manual_vaults.contains(&canonical) {
        stored.manual_vaults.push(canonical);
        stored.manual_vaults.sort();
    }
    save_stored(data_dir, &stored)?;
    integration(data_dir)
}

pub fn link_workspace(
    data_dir: &Path,
    workspace_id: &str,
    vault_path: &Path,
    relative_target: Option<&str>,
) -> Result<ObsidianWorkspaceLink> {
    let vault = validate_vault(vault_path)?;
    let stored = load_stored(data_dir)?;
    let known_vaults: BTreeSet<_> = merged_vaults(&stored)
        .into_iter()
        .map(|item| item.path)
        .collect();
    if !known_vaults.contains(&vault) {
        bail!("The Obsidian vault must be added before it can be linked");
    }
    let target = resolve_target(&vault, relative_target)?;
    let link = ObsidianWorkspaceLink {
        workspace_id: workspace_id.to_string(),
        vault_path: vault,
        target_path: target,
    };
    let mut stored = stored;
    stored
        .workspace_links
        .insert(workspace_id.to_string(), link.clone());
    save_stored(data_dir, &stored)?;
    Ok(link)
}

pub fn unlink_workspace(data_dir: &Path, workspace_id: &str) -> Result<()> {
    let mut stored = load_stored(data_dir)?;
    stored.workspace_links.remove(workspace_id);
    save_stored(data_dir, &stored)
}

pub fn open_app() -> Result<()> {
    open_uri("obsidian://open")
}

pub fn open_workspace(data_dir: &Path, workspace_id: &str) -> Result<()> {
    let stored = load_stored(data_dir)?;
    let link = stored
        .workspace_links
        .get(workspace_id)
        .context("The workspace is not linked to Obsidian")?;
    let target =
        canonicalize(&link.target_path).context("The linked Obsidian target no longer exists")?;
    let vault =
        canonicalize(&link.vault_path).context("The linked Obsidian vault no longer exists")?;
    if !path_starts_with(&target, &vault) {
        bail!("The linked target is outside its Obsidian vault");
    }
    open_uri(&format!(
        "obsidian://open?path={}",
        percent_encode(&target.to_string_lossy())
    ))
}

fn integration_path(data_dir: &Path) -> PathBuf {
    data_dir.join("obsidian-integration.json")
}

fn load_stored(data_dir: &Path) -> Result<StoredObsidianIntegration> {
    let path = integration_path(data_dir);
    if !path.is_file() {
        return Ok(StoredObsidianIntegration::default());
    }
    serde_json::from_str(&fs::read_to_string(&path)?)
        .with_context(|| format!("Failed to parse {}", path.display()))
}

fn save_stored(data_dir: &Path, value: &StoredObsidianIntegration) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    let path = integration_path(data_dir);
    atomic_write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(value)?).as_bytes(),
    )?;
    Ok(())
}

fn validate_vault(path: &Path) -> Result<PathBuf> {
    let canonical = canonicalize(path)
        .with_context(|| format!("Obsidian vault does not exist: {}", path.display()))?;
    if !canonical.is_dir() || !canonical.join(".obsidian").is_dir() {
        bail!("The selected folder is not an Obsidian vault");
    }
    Ok(canonical)
}

fn resolve_target(vault: &Path, relative_target: Option<&str>) -> Result<PathBuf> {
    let relative = relative_target.unwrap_or("").trim();
    if relative.is_empty() {
        return Ok(vault.to_path_buf());
    }
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        bail!("The linked path must be relative to the Obsidian vault");
    }
    let target = canonicalize(&vault.join(relative_path))
        .with_context(|| format!("The linked Obsidian path does not exist: {relative}"))?;
    if !path_starts_with(&target, vault) {
        bail!("The linked path is outside the Obsidian vault");
    }
    Ok(target)
}

fn merged_vaults(stored: &StoredObsidianIntegration) -> Vec<ObsidianVault> {
    let mut vaults = discover_vaults();
    let discovered: BTreeSet<_> = vaults.iter().map(|item| item.path.clone()).collect();
    for path in &stored.manual_vaults {
        let Ok(path) = validate_vault(path) else {
            continue;
        };
        if !discovered.contains(&path) {
            vaults.push(vault_from_path(path, ObsidianVaultSource::Manual, None));
        }
    }
    vaults.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    vaults
}

fn discover_vaults() -> Vec<ObsidianVault> {
    let Some(path) = vault_registry_path() else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_vault_registry(&content)
}

fn vault_registry_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|home| home.join("Library/Application Support/obsidian/obsidian.json"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(dirs::config_dir)
            .map(|app_data| obsidian_registry_in(&app_data))
    }
    #[cfg(target_os = "linux")]
    {
        agentkib_platform::xdg::config_home().map(|config| config.join("obsidian/obsidian.json"))
    }
}

#[cfg(all(test, target_os = "linux"))]
fn linux_vault_registry_path(
    xdg_config_home: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    xdg_config_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| home.map(|path| path.join(".config")))
        .map(|config| config.join("obsidian/obsidian.json"))
}

#[cfg(any(target_os = "windows", test))]
fn obsidian_registry_in(config_directory: &Path) -> PathBuf {
    config_directory.join("obsidian/obsidian.json")
}

fn parse_vault_registry(content: &str) -> Vec<ObsidianVault> {
    let Ok(document) = serde_json::from_str::<serde_json::Value>(content) else {
        return Vec::new();
    };
    let Some(entries) = document.get("vaults").and_then(|value| value.as_object()) else {
        return Vec::new();
    };
    entries
        .values()
        .filter_map(|entry| {
            let path = Path::new(entry.get("path")?.as_str()?);
            let canonical = validate_vault(path).ok()?;
            Some(vault_from_path(
                canonical,
                ObsidianVaultSource::Discovered,
                entry.get("ts").and_then(|value| value.as_i64()),
            ))
        })
        .collect()
}

fn vault_from_path(
    path: PathBuf,
    source: ObsidianVaultSource,
    last_opened_at: Option<i64>,
) -> ObsidianVault {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Obsidian Vault")
        .to_string();
    ObsidianVault {
        path,
        name,
        source,
        last_opened_at,
    }
}

fn detect_installation() -> ObsidianInstallation {
    let app_path = detect_app_path();
    ObsidianInstallation {
        installed: app_path.is_some(),
        version: app_path.as_deref().and_then(read_app_version),
        app_path,
        cli_available: detect_cli(),
    }
}

fn detect_app_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from("/Applications/Obsidian.app")];
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications/Obsidian.app"));
        }
        if let Ok(output) = Command::new("mdfind")
            .arg("kMDItemCFBundleIdentifier == 'md.obsidian'")
            .output()
        {
            candidates.extend(
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(PathBuf::from),
            );
        }
        candidates
            .into_iter()
            .find(|path| path.join("Contents/Info.plist").is_file())
            .and_then(|path| canonicalize(&path).ok())
    }
    #[cfg(target_os = "windows")]
    {
        windows_app_candidates(
            std::env::var_os("LOCALAPPDATA").as_deref(),
            std::env::var_os("ProgramFiles").as_deref(),
            std::env::var_os("ProgramFiles(x86)").as_deref(),
        )
        .into_iter()
        .find(|path| path.is_file())
    }
    #[cfg(target_os = "linux")]
    {
        linux_app_candidates(
            agentkib_platform::xdg::home_dir().as_deref(),
            &agentkib_platform::xdg::application_dirs(),
            &agentkib_platform::command::search_directories(),
        )
        .into_iter()
        .find(|path| agentkib_platform::command::is_executable(path))
    }
}

#[cfg(target_os = "linux")]
fn linux_app_candidates(
    home: Option<&Path>,
    desktop_directories: &[PathBuf],
    search_directories: &[PathBuf],
) -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/usr/bin/obsidian"),
        PathBuf::from("/usr/local/bin/obsidian"),
        PathBuf::from("/opt/Obsidian/obsidian"),
        PathBuf::from("/opt/Obsidian/Obsidian"),
        PathBuf::from("/usr/share/obsidian/obsidian"),
    ];
    if let Some(home) = home {
        candidates.push(home.join(".local/bin/obsidian"));
        candidates.extend(app_images_in(&home.join("Applications")));
    }

    for directory in desktop_directories {
        candidates.extend(obsidian_desktop_executables(directory, search_directories));
    }
    candidates
}

#[cfg(target_os = "linux")]
fn app_images_in(directory: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            agentkib_platform::command::is_executable(path)
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        let lowercase = name.to_ascii_lowercase();
                        lowercase.contains("obsidian") && lowercase.ends_with(".appimage")
                    })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn obsidian_desktop_executables(directory: &Path, search_directories: &[PathBuf]) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|value| value.to_str()) == Some("desktop")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.to_ascii_lowercase().contains("obsidian"))
        })
        .filter_map(|path| {
            agentkib_platform::command::desktop_entry_executable(&path, search_directories)
                .ok()
                .flatten()
        })
        .collect()
}

#[cfg(any(target_os = "windows", test))]
fn windows_app_candidates(
    local_app_data: Option<&std::ffi::OsStr>,
    program_files: Option<&std::ffi::OsStr>,
    program_files_x86: Option<&std::ffi::OsStr>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = local_app_data {
        let root = Path::new(root);
        candidates.push(root.join("Obsidian/Obsidian.exe"));
        candidates.push(root.join("Programs/Obsidian/Obsidian.exe"));
    }
    for root in [program_files, program_files_x86].into_iter().flatten() {
        candidates.push(Path::new(root).join("Obsidian/Obsidian.exe"));
    }
    candidates
}

fn read_app_version(app_path: &Path) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("plutil")
            .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
            .arg(app_path.join("Contents/Info.plist"))
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_path;
        None
    }
}

fn detect_cli() -> bool {
    #[cfg(target_os = "linux")]
    {
        agentkib_platform::command::resolve("obsidian").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    let directories: Vec<_> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    #[cfg(target_os = "windows")]
    {
        command_exists_in(
            &directories,
            &["obsidian.exe", "obsidian.cmd", "obsidian.bat"],
        )
    }
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![
            PathBuf::from("/usr/local/bin/obsidian"),
            PathBuf::from("/opt/homebrew/bin/obsidian"),
        ];
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local/bin/obsidian"));
        }
        candidates.extend(directories.into_iter().map(|path| path.join("obsidian")));
        candidates.into_iter().any(|path| path.is_file())
    }
}

#[cfg(any(target_os = "windows", test))]
fn command_exists_in(directories: &[PathBuf], names: &[&str]) -> bool {
    directories
        .iter()
        .any(|directory| names.iter().any(|name| directory.join(name).is_file()))
}

fn open_uri(uri: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open").arg(uri).status()?;
        if !status.success() {
            bail!("Failed to open Obsidian");
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(uri)
            .spawn()
            .context("Failed to invoke the Windows Obsidian URI handler")?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let executable = agentkib_platform::command::resolve("xdg-open")
            .context("Obsidian URI handler is unavailable: xdg-open was not found")?;
        let output = Command::new(executable)
            .arg(uri)
            .output()
            .context("Obsidian URI handler is unavailable: xdg-open could not be started")?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            let detail = detail.trim();
            let suffix = if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            };
            bail!("Obsidian URI handler is unavailable{}", suffix);
        }
        Ok(())
    }
}

fn percent_encode(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_only_existing_obsidian_vaults() {
        let directory = tempdir().unwrap();
        let vault = directory.path().join("Notes");
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        let content = serde_json::json!({
            "vaults": {
                "valid": { "path": vault, "ts": 1234 },
                "missing": { "path": directory.path().join("Missing"), "ts": 5678 }
            }
        });
        let vaults = parse_vault_registry(&content.to_string());
        assert_eq!(vaults.len(), 1);
        assert_eq!(vaults[0].name, "Notes");
        assert_eq!(vaults[0].last_opened_at, Some(1234));
    }

    #[test]
    fn workspace_link_cannot_escape_vault() {
        let directory = tempdir().unwrap();
        let vault = directory.path().join("Notes");
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        assert!(resolve_target(&vault, Some("../outside")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_link_cannot_escape_vault_through_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let vault = directory.path().join("Notes");
        let outside = directory.path().join("Outside");
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, vault.join("linked-outside")).unwrap();

        assert!(resolve_target(&vault, Some("linked-outside")).is_err());
    }

    #[test]
    fn manual_vault_and_workspace_link_round_trip() {
        let directory = tempdir().unwrap();
        let data = directory.path().join("data");
        let vault = directory.path().join("Notes");
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        fs::create_dir_all(vault.join("Projects/AgentKib")).unwrap();

        add_vault(&data, &vault).unwrap();
        let link = link_workspace(&data, "workspace", &vault, Some("Projects/AgentKib")).unwrap();
        assert!(link.target_path.ends_with("Projects/AgentKib"));
        assert_eq!(integration(&data).unwrap().workspace_links, vec![link]);
    }

    #[test]
    fn uri_encoding_handles_paths_and_non_ascii_text() {
        assert_eq!(
            percent_encode("/Users/me/My Notes/项目.md"),
            "%2FUsers%2Fme%2FMy%20Notes%2F%E9%A1%B9%E7%9B%AE.md"
        );
    }

    #[test]
    fn windows_installation_candidates_cover_per_user_and_machine_locations() {
        assert_eq!(
            obsidian_registry_in(Path::new("C:/Users/me/AppData/Roaming")),
            PathBuf::from("C:/Users/me/AppData/Roaming/obsidian/obsidian.json")
        );
        let candidates = windows_app_candidates(
            Some(std::ffi::OsStr::new("C:/Users/me/AppData/Local")),
            Some(std::ffi::OsStr::new("C:/Program Files")),
            Some(std::ffi::OsStr::new("C:/Program Files (x86)")),
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("C:/Users/me/AppData/Local/Obsidian/Obsidian.exe"),
                PathBuf::from("C:/Users/me/AppData/Local/Programs/Obsidian/Obsidian.exe"),
                PathBuf::from("C:/Program Files/Obsidian/Obsidian.exe"),
                PathBuf::from("C:/Program Files (x86)/Obsidian/Obsidian.exe"),
            ]
        );
    }

    #[test]
    fn windows_cli_detection_accepts_cmd_shims() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("obsidian.cmd"), "@echo off").unwrap();
        assert!(command_exists_in(
            &[directory.path().to_path_buf()],
            &["obsidian.exe", "obsidian.cmd", "obsidian.bat"]
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_registry_uses_xdg_then_home_default() {
        assert_eq!(
            linux_vault_registry_path(
                Some(std::ffi::OsStr::new("/tmp/config")),
                Some(Path::new("/home/me")),
            ),
            Some(PathBuf::from("/tmp/config/obsidian/obsidian.json"))
        );
        assert_eq!(
            linux_vault_registry_path(None, Some(Path::new("/home/me"))),
            Some(PathBuf::from("/home/me/.config/obsidian/obsidian.json"))
        );
        assert_eq!(
            linux_vault_registry_path(
                Some(std::ffi::OsStr::new("relative/config")),
                Some(Path::new("/home/me")),
            ),
            Some(PathBuf::from("/home/me/.config/obsidian/obsidian.json"))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_desktop_exec_parser_handles_quoted_env_commands() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("Obsidian AppImage");
        let desktop = directory.path().join("md.obsidian.Obsidian.desktop");
        fs::write(&executable, "binary").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            &desktop,
            format!(
                "[Desktop Entry]\nExec=env FOO=bar \"{}\" %u\n",
                executable.display()
            ),
        )
        .unwrap();
        assert_eq!(
            agentkib_platform::command::desktop_entry_executable(&desktop, &[]).unwrap(),
            Some(executable)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_candidates_cover_appimage_and_desktop_installations() {
        let directory = tempdir().unwrap();
        let home = directory.path().join("home");
        let data = directory.path().join("data");
        let app_image = home.join("Applications/Obsidian-1.8.AppImage");
        let desktop_executable = directory.path().join("bin/obsidian");
        fs::create_dir_all(app_image.parent().unwrap()).unwrap();
        fs::create_dir_all(desktop_executable.parent().unwrap()).unwrap();
        fs::create_dir_all(data.join("applications")).unwrap();
        fs::write(&app_image, "appimage").unwrap();
        fs::write(&desktop_executable, "binary").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&app_image, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&desktop_executable, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            data.join("applications/md.obsidian.Obsidian.desktop"),
            format!(
                "[Desktop Entry]\nName=Obsidian\nExec={} %U\n",
                desktop_executable.display()
            ),
        )
        .unwrap();

        let candidates = linux_app_candidates(
            Some(&home),
            &[data.join("applications")],
            &[desktop_executable.parent().unwrap().to_path_buf()],
        );
        assert!(candidates.contains(&app_image));
        assert!(candidates.contains(&desktop_executable));
    }
}
