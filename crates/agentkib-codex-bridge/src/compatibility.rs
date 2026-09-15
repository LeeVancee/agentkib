use crate::{DESKTOP_VERSION, EXTENSION_VERSION};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[derive(Debug, Default)]
pub struct Compatibility {
    desktop: Option<String>,
    extension: Option<String>,
    router_root: Option<PathBuf>,
}

impl Compatibility {
    /// Reads package metadata only; never loads/evaluates official application code.
    pub fn inspect(desktop_asar: &Path, extension_package: &Path) -> Self {
        let expected_asar = Path::new("/Applications/ChatGPT.app/Contents/Resources/app.asar");
        let expected_extension = dirs::home_dir().map(|home| {
            home.join(format!(
                ".vscode/extensions/openai.chatgpt-{EXTENSION_VERSION}-darwin-arm64/package.json"
            ))
        });
        let verified_paths = desktop_asar == expected_asar
            && desktop_asar.canonicalize().ok().as_deref() == Some(expected_asar)
            && expected_extension.as_deref() == Some(extension_package)
            && extension_package.canonicalize().ok().as_deref() == Some(extension_package);
        Self {
            router_root: verified_paths
                .then(|| PathBuf::from("/Applications/ChatGPT.app/Contents")),
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

    pub fn is_known(&self) -> bool {
        self.router_root.is_some()
            && self.desktop.as_deref() == Some(DESKTOP_VERSION)
            && self.extension.as_deref() == Some(EXTENSION_VERSION)
    }

    pub fn desktop_version(&self) -> Option<&str> {
        self.desktop.as_deref()
    }
    pub fn extension_version(&self) -> Option<&str> {
        self.extension.as_deref()
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
}

fn asar_version(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let mut prefix = [0; 16];
    file.read_exact(&mut prefix)?;
    let header_size = u32::from_le_bytes(prefix[4..8].try_into()?) as u64;
    let json_size = u32::from_le_bytes(prefix[12..16].try_into()?) as usize;
    ensure!(
        json_size > 0 && json_size <= 4 * 1024 * 1024 && header_size >= json_size as u64 + 8,
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn versions_alone_do_not_enable_control() {
        let mut compatibility = Compatibility {
            desktop: Some(DESKTOP_VERSION.into()),
            extension: Some(EXTENSION_VERSION.into()),
            router_root: None,
        };
        assert!(!compatibility.is_known());
        compatibility.router_root = Some(PathBuf::from("/Applications/ChatGPT.app/Contents"));
        assert!(compatibility.is_known());
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
    }
}
