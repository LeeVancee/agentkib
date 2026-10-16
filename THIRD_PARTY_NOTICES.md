# Third-party notices

## frp (frpc)

AgentKib bundles the checksum-verified frpc 0.68.0 client for remote connections.

- Project: https://github.com/fatedier/frp
- License: Apache-2.0

The upstream license is copied unchanged into the desktop application's
`bin/licenses/frp-LICENSE`. The relay server implementation is not included.

## CodexBarCLI

AgentKib bundles CodexBarCLI 0.49.5 on macOS and Linux to collect local quota
snapshots. Linux packages use the official statically linked musl release for
their target architecture.

- Project: https://github.com/steipete/CodexBar
- License: MIT
- Copyright: Peter Steinberger and contributors

The complete license text is bundled with the desktop application at
`resources/licenses/CodexBar-LICENSE.txt`.

## Win-CodexBar CLI

AgentKib bundles the prebuilt Win-CodexBar 0.60.3 console CLI on Windows x64 to
collect local quota snapshots. The AgentKib build downloads the upstream release
archive (`CodexBarCLI-v0.60.3-windows-x64.zip`), verifies its pinned SHA-256
checksum, and copies `codexbar-cli.exe` unchanged as the quota sidecar; it does
not compile Win-CodexBar from source. Its installer is not executed during the
AgentKib build.

- Project: https://github.com/nesszer/Win-CodexBar
- License: MIT
- Copyright: Peter Steinberger and contributors

The complete license and upstream attribution notice are bundled at
`resources/licenses/Win-CodexBar-LICENSE.txt` and
`resources/licenses/Win-CodexBar-NOTICE.txt`.

## DeepSeek Harness icon

AgentKib adapts the DeepSeek Harness favicon for the local Agent catalogue.

- Project: https://github.com/deepseek-ai/deepseek-harness
- License: MIT
- Copyright: 2026 DeepSeek

The complete notice is included with the desktop icon assets.
