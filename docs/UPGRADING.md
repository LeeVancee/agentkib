# Upgrading / 升级指南

[English](#english) · [简体中文](#简体中文)

<a id="english"></a>

## English

Always download AgentKib from the [official Releases page](https://github.com/starroyhq/agentkib/releases) and verify the matching `.sha256` checksum before installing it.

### Current upgrade paths

- **macOS, Windows, and Linux AppImage**: use **Settings → General → Check for updates**. AgentKib downloads the matching package and asks before installation.
- **Ubuntu DEB and Fedora RPM**: the update screen opens the release page. Download the correct package and upgrade through the system package manager so package ownership remains consistent.
- **Manual install**: installing the latest official package over an older installation is supported when in-app update is unavailable. Quit AgentKib before replacing the application.

AgentKib v0.3.1 was the first release with the in-app updater. Install a newer official package manually when upgrading from v0.3.0 or earlier; later supported releases can then use the paths above.

Only the latest stable release is actively supported. Back up the AgentKib application-data directory before moving between distant versions or testing preview packages. Do not copy or merge the isolated `ai.agentkib.dev` development data into the stable `ai.agentkib` directory.

### macOS signing and historical packages

macOS releases starting with v0.3.2 are signed with the AgentKib Developer ID Application certificate and notarized by Apple. After verifying the checksum, drag AgentKib to Applications and open it normally.

The unsigned v0.3.1 and earlier packages are retained only for historical compatibility. If macOS blocks one of those verified historical packages, remove its quarantine attribute after moving it to Applications:

```bash
xattr -cr /Applications/AgentKib.app
```

Run this command only for an official AgentKib package whose checksum you have verified. It is not required for current signed and notarized releases.

### Package-specific notes

- Windows installers are not yet Authenticode-signed and can trigger SmartScreen. Verify the checksum and publisher source before continuing.
- AppImage updates replace the application image; keep the file executable after replacement.
- DEB and RPM users should not replace package-managed files manually. Use the appropriate package manager with the downloaded release artifact.
- Automatic downgrade is not supported. To roll back, quit AgentKib, back up application data, and reinstall an immutable older release only after checking its release notes and checksum.

If an update fails, record the installed version, target version, operating system, architecture, package type, and the exact error. Report ordinary failures through [GitHub Issues](https://github.com/starroyhq/agentkib/issues); report security-sensitive failures through the [private security process](../SECURITY.md).

---

<a id="简体中文"></a>

## 简体中文

请始终从[官方 Releases 页面](https://github.com/starroyhq/agentkib/releases)下载 AgentKib，并在安装前核对对应的 `.sha256` 校验值。

### 当前升级方式

- **macOS、Windows 和 Linux AppImage**：使用“设置 → 常规 → 检查更新”。AgentKib 会下载匹配的包，并在安装前请求确认。
- **Ubuntu DEB 和 Fedora RPM**：更新界面会打开 Release 页面。下载正确的包后通过系统包管理器升级，以保持包归属一致。
- **手动安装**：应用内更新不可用时，可以使用最新官方安装包覆盖旧版本。替换应用前请完全退出 AgentKib。

AgentKib v0.3.1 是首个包含应用内更新器的版本。从 v0.3.0 或更早版本升级时，请先手动安装较新的官方包；之后受支持的版本可以使用上述更新方式。

项目只主动支持最新正式版本。跨越多个版本或测试 Preview 包前，请备份 AgentKib 应用数据目录。不要把隔离的 `ai.agentkib.dev` 开发数据复制或合并到正式版 `ai.agentkib` 目录。

### macOS 签名与历史包

macOS v0.3.2 及以后版本使用 AgentKib Developer ID Application 证书签名，并通过 Apple 公证。核对校验值后，把 AgentKib 拖入“应用程序”即可正常打开。

未签名的 v0.3.1 及更早版本仅为历史兼容保留。如果 macOS 阻止打开已经核验的历史包，把它移入“应用程序”后可以移除隔离属性：

```bash
xattr -cr /Applications/AgentKib.app
```

只应对来自 AgentKib 官方 Release 且校验值一致的应用执行此命令。当前已签名和公证的版本不需要该操作。

### 不同包的注意事项

- Windows 安装包尚未进行 Authenticode 签名，可能触发 SmartScreen；继续前请核对校验值和发布来源。
- AppImage 更新会替换应用镜像；替换后应保持文件可执行。
- DEB 和 RPM 用户不应手工替换包管理器维护的文件，应使用对应包管理器安装下载的 Release 产物。
- 不支持自动降级。如需回退，请完全退出 AgentKib、备份应用数据，并在阅读发布说明和核对校验值后重新安装不可变的历史 Release。

更新失败时，请记录当前版本、目标版本、操作系统、架构、包类型和完整错误信息。普通问题通过 [GitHub Issues](https://github.com/starroyhq/agentkib/issues)反馈；涉及安全的信息按[私密安全流程](../SECURITY.md)报告。
