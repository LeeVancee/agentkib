# Electron Forge

Forge 目前是與 Electron Builder 並行的實驗打包路徑，不會改動正式 release workflow。

在 repository root 執行：

```bash
pnpm forge:package
pnpm dist:forge
```

`forge:package` 產生未封裝成安裝器的應用程式；`dist:forge` 另外執行目前平台的 makers。輸出位於 `apps/desktop/release-forge`。

目前 makers：

- macOS：DMG、ZIP
- Windows：Squirrel installer
- Linux：DEB、RPM

打包前會建立兩個被 Git 忽略的 staging 目錄：

- `build/forge-app`：只包含 Vite 產物與執行時需要的 `electron-updater`。
- `build/forge-resources`：按照既有 `process.resourcesPath` 介面組合 runtime、quota sidecar、原生資源和 icons。

桌面 pnpm scripts 固定使用 Node.js 22.17.1，因為 Forge 7.11.2 在部分 Node.js 24 和 26 版本有已知的 package finalization 問題。pnpm 會自動準備這個 runtime。

macOS 本機建置使用 ad-hoc signing。設定以下環境變數後會改用正式簽名；三個 notarization 變數完整存在時也會執行 notarization：

- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_KEY_PATH`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

正式發佈暫時保留 Electron Builder，因為現行 release 與 updater 仍依賴 NSIS、AppImage、blockmap 和 `latest*.yml`。Forge 的 Squirrel/DEB/RPM 產物尚未取代這套 metadata 流程。
