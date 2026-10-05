#[cfg(all(test, target_os = "macos"))]
use crate::EXTENSION_VERSION;
use crate::{DESKTOP_VERSION, DESKTOP_VERSION_CURRENT};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[derive(Debug, Default, Clone)]
pub struct Compatibility {
    desktop: Option<String>,
    extension: Option<String>,
    router_root: Option<PathBuf>,
}

impl Compatibility {
    /// Reads package metadata only; never loads/evaluates official application code.
    pub fn inspect(desktop_asar: &Path, extension_package: &Path) -> Self {
        // The running peer's bundle is authoritative. Relocated/user Applications
        // installations must not be confused with a different /Applications copy.
        let router_root = desktop_asar
            .parent()
            .and_then(Path::parent)
            .filter(|root| {
                root.file_name().is_some_and(|n| n == "Contents")
                    && root
                        .parent()
                        .is_some_and(|app| app.extension().is_some_and(|s| s == "app"))
                    && root.join("Resources/app.asar") == desktop_asar
                    && desktop_asar.canonicalize().ok().as_deref() == Some(desktop_asar)
            })
            .map(Path::to_owned);
        Self {
            router_root,
            desktop: asar_version(desktop_asar).ok(),
            extension: (|| -> Result<String> {
                let file = File::open(extension_package)?;
                ensure!(
                    file.metadata()?.len() <= 1024 * 1024,
                    "package metadata too large"
                );
                let value: Value = serde_json::from_reader(file.take(1024 * 1024))?;
                ensure!(
                    value["publisher"] == "openai" && value["name"] == "chatgpt",
                    "not Codex extension metadata"
                );
                Ok(value["version"]
                    .as_str()
                    .context("missing version")?
                    .to_owned())
            })()
            .ok(),
        }
    }

    /// Installation eligibility only; the selected owner must still pass the
    /// exact native stream and control contracts before any mutation is allowed.
    pub fn is_known(&self) -> bool {
        self.desktop_version_at_least(DESKTOP_VERSION)
    }

    pub fn desktop_version(&self) -> Option<&str> {
        self.desktop.as_deref()
    }
    pub fn extension_version(&self) -> Option<&str> {
        self.extension.as_deref()
    }

    pub fn supports_thread_settings(&self) -> bool {
        self.desktop_version_at_least(DESKTOP_VERSION_CURRENT)
    }

    fn desktop_version_at_least(&self, minimum: &str) -> bool {
        let Some(version) = self.desktop.as_deref().and_then(parse_desktop_version) else {
            return false;
        };
        self.router_root.is_some()
            && parse_desktop_version(minimum).is_some_and(|minimum| version >= minimum)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn for_router(executable: &Path) -> Self {
        let Some(root) = executable.ancestors().find(|p| {
            p.file_name().is_some_and(|n| n == "Contents")
                && p.parent()
                    .is_some_and(|app| app.extension().is_some_and(|e| e == "app"))
        }) else {
            return Self::default();
        };
        // Extension presence is not proof of the selected owner. Desktop-only
        // operation is supported; every owner still passes the stream contract.
        Self::inspect(
            &root.join("Resources/app.asar"),
            Path::new("/nonexistent-codex-extension-metadata"),
        )
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn matches_router(&self, executable: &Path) -> bool {
        self.is_known()
            && self
                .router_root
                .as_ref()
                .is_some_and(|root| executable.starts_with(root))
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn fixture() -> Self {
        Self {
            desktop: Some(DESKTOP_VERSION.into()),
            extension: Some(EXTENSION_VERSION.into()),
            router_root: Some(
                std::env::current_exe()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .to_owned(),
            ),
        }
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn settings_fixture() -> Self {
        Self::version_fixture(DESKTOP_VERSION_CURRENT)
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn version_fixture(version: &str) -> Self {
        Self {
            desktop: Some(version.into()),
            ..Self::fixture()
        }
    }
}

fn parse_desktop_version(value: &str) -> Option<[u64; 3]> {
    let mut components = value.split('.');
    let mut version = [0; 3];
    for component in &mut version {
        let value = components.next()?;
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        *component = value.parse().ok()?;
    }
    components.next().is_none().then_some(version)
}

fn asar_version(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let mut prefix = [0; 16];
    file.read_exact(&mut prefix)?;
    let header_size = u32::from_le_bytes(prefix[4..8].try_into()?) as u64;
    let json_size = u32::from_le_bytes(prefix[12..16].try_into()?) as usize;
    // The verified Desktop build has a 4.3 MiB ASAR index. Keep a bounded read
    // while allowing that index to grow without silently disabling the bridge.
    ensure!(
        json_size > 0 && json_size <= 8 * 1024 * 1024 && header_size >= json_size as u64 + 8,
        "invalid ASAR header"
    );
    let mut bytes = vec![0; json_size];
    file.read_exact(&mut bytes)?;
    let header: Value = serde_json::from_slice(&bytes)?;
    let package = &header["files"]["package.json"];
    ensure!(
        package.get("link").is_none() && package.get("unpacked").is_none(),
        "unsupported ASAR package"
    );
    let offset: u64 = package["offset"]
        .as_str()
        .context("missing offset")?
        .parse()?;
    let size = package["size"].as_u64().context("missing size")?;
    ensure!(size > 0 && size <= 1024 * 1024, "invalid package size");
    let start = header_size
        .checked_add(8)
        .and_then(|v| v.checked_add(offset))
        .context("invalid offset")?;
    ensure!(
        start.checked_add(size).is_some_and(|end| end <= length),
        "package outside ASAR"
    );
    file.seek(SeekFrom::Start(start))?;
    let value: Value = serde_json::from_reader(file.take(size))?;
    ensure!(
        value["name"] == "openai-codex-electron",
        "not Codex desktop metadata"
    );
    Ok(value["version"]
        .as_str()
        .context("missing version")?
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    #[cfg(target_os = "macos")]
    fn versions_alone_do_not_enable_control() {
        let mut compatibility = Compatibility {
            desktop: Some(DESKTOP_VERSION.into()),
            extension: Some(EXTENSION_VERSION.into()),
            router_root: None,
        };
        assert!(!compatibility.is_known());
        compatibility.router_root = Some(PathBuf::from("/Applications/ChatGPT.app/Contents"));
        assert!(compatibility.is_known());
        compatibility.extension = None;
        assert!(
            compatibility.is_known(),
            "Desktop peer validation must not require an installed extension"
        );
        assert!(compatibility.matches_router(Path::new(
            "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
        )));
        assert!(!compatibility.matches_router(Path::new(
            "/Applications/ChatGPT.app/Contents-copy/MacOS/ChatGPT"
        )));
        assert!(!compatibility.matches_router(Path::new("/tmp/ChatGPT")));
        compatibility.desktop = Some("unknown-build".into());
        assert!(!compatibility.matches_router(Path::new(
            "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
        )));
        compatibility.desktop = Some(DESKTOP_VERSION_CURRENT.into());
        assert!(compatibility.matches_router(Path::new(
            "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
        )));
        assert!(compatibility.supports_thread_settings());
        compatibility.desktop = Some(DESKTOP_VERSION.into());
        assert!(!compatibility.supports_thread_settings());
    }

    #[test]
    fn desktop_versions_use_numeric_minimums_for_each_feature() {
        for (version, basic, settings) in [
            (None, false, false),
            (Some("25.9999.99999"), false, false),
            (Some("26.916.99999"), false, false),
            (Some("26.917.62050"), false, false),
            (Some(DESKTOP_VERSION), true, false),
            (Some("26.917.62052"), true, false),
            (Some("26.924.22137"), true, false),
            (Some(DESKTOP_VERSION_CURRENT), true, true),
            (Some("26.924.22139"), true, true),
            (Some("26.930.51102"), true, true),
            (Some("26.1000.1"), true, true),
            (Some("26.924.100000"), true, true),
            (Some("26.99.999999"), false, false),
            (Some("27.0.0"), true, true),
        ] {
            let mut compatibility = Compatibility {
                desktop: version.map(str::to_owned),
                router_root: Some(PathBuf::from("/Applications/ChatGPT.app/Contents")),
                ..Default::default()
            };
            assert_eq!(compatibility.is_known(), basic, "{version:?}");
            assert_eq!(
                compatibility.supports_thread_settings(),
                settings,
                "{version:?}"
            );
            compatibility.router_root = None;
            assert!(!compatibility.is_known(), "{version:?}");
            assert!(!compatibility.supports_thread_settings(), "{version:?}");
        }
    }

    #[test]
    fn malformed_or_overflowing_versions_never_pass_the_minimum() {
        for version in [
            "",
            "unknown-build",
            "26.930",
            "26.930.51102.1",
            "26..51102",
            ".930.51102",
            "26.930.",
            " 26.930.51102",
            "26.930.51102 ",
            "v26.930.51102",
            "+26.930.51102",
            "26.-930.51102",
            "26.+930.51102",
            "26.930.51102-beta",
            "26.930.51102+build",
            "２６.930.51102",
            "18446744073709551616.930.51102",
            "26.18446744073709551616.51102",
            "26.930.18446744073709551616",
        ] {
            let compatibility = Compatibility {
                desktop: Some(version.into()),
                router_root: Some(PathBuf::from("/Applications/ChatGPT.app/Contents")),
                ..Default::default()
            };
            assert!(!compatibility.is_known(), "{version}");
            assert!(!compatibility.supports_thread_settings(), "{version}");
        }
    }

    #[test]
    fn accepts_current_desktop_asar_header_size() {
        let directory = tempfile::tempdir().unwrap();
        let asar = directory.path().join("app.asar");
        let package = serde_json::json!({
            "name": "openai-codex-electron",
            "version": DESKTOP_VERSION,
        })
        .to_string();
        let header = serde_json::json!({
            "files": {
                "package.json": {"offset": "0", "size": package.len()},
                "padding": "x".repeat(4 * 1024 * 1024),
            },
        })
        .to_string();
        assert!(header.len() > 4 * 1024 * 1024);
        let mut file = File::create(&asar).unwrap();
        file.write_all(&4u32.to_le_bytes()).unwrap();
        file.write_all(&(header.len() as u32 + 8).to_le_bytes())
            .unwrap();
        file.write_all(&(header.len() as u32 + 4).to_le_bytes())
            .unwrap();
        file.write_all(&(header.len() as u32).to_le_bytes())
            .unwrap();
        file.write_all(header.as_bytes()).unwrap();
        file.write_all(package.as_bytes()).unwrap();
        drop(file);
        assert_eq!(asar_version(&asar).unwrap(), DESKTOP_VERSION);
    }
}
