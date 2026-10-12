# v0.17.1 启动回归与发布验证

## 源码与问题

- 基线：`origin/main ac1d08e88b0a505b26ff2f15d903db330bf0ef79`，开始时工作树干净；主目录的 `prototypes/` 未改动。
- 出错版本：`v0.17.0`，源码 `68beb90d4112114760f16d6c6cef5a6f9263d18d`。
- 直接读取已安装的 v0.17.0 `app.asar`：主进程包含 `ws` 的浏览器占位实现，并调用不存在的 `import_browser.WebSocketServer`。
- 主线提交 `093f5da37` 已将主进程 `ws` 精确解析到 Node 入口并内联打包。本次保留该修正，增加构建和启动回归门槛。

## 新增验证

- 使用真实 `vite.main.config.ts` 构建 WebSocket fixture，将单个 CJS 文件放到无依赖临时目录，完成构造、握手和回显。内存移除 alias 的负向实验退出码为 1，重现原始构造错误。
- 跨平台启动探针为每次执行创建隔离 HOME、Agent 配置、应用数据和 Electron profile，关闭自动刷新；不调用模型，不读取个人配置。隔离配置显式启用本机 Web，使用独立空闲端口和空设备授权，不启用公网 Relay 或 LAN。默认空配置会跳过 WebSocket 初始化，不能用来证明这次回归已修复。
- 通过条件为进程正常退出，且本次报告包含 `runtime-handshake`、`window-shown`、`home-data-ready`。错误窗口、缺失报告、缺失就绪标记、异常退出和超时均失败。
- macOS 在构建后的 `.app` 执行；Ubuntu/Fedora 在安装包安装后执行；Windows 保留原有安装、升级保留数据和卸载检查，并以就绪探针替换进程存活判断。
- 每次测试有期限；失败清理仅针对探针自有进程及临时目录。无需删除用户配置或会话数据。

## 验证记录

工具链为 Node 22.23.3、pnpm 12.10.1，依赖使用 `pnpm install --frozen-lockfile`。

- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`：通过。
- `pnpm test`：桌面 210 个测试文件，3110 项通过、2 项既有跳过；Web 36 个文件，683 项通过。
- `pnpm build`、`pnpm build:web:hosted`：通过。
- `node --test .github/scripts/*.test.mjs`：14/14 通过。
- 首次 PR CI 发现既有 Skills 测试死锁：第八个请求若为 `SKILL.md`，测试等待的 barrier 不会被释放。保持原断言，把释放移到共同路径，并参数化首个／最后到达；旧逻辑确定性重现超时，修正后 `skills-lifecycle.test.ts` 96/96 通过。只改测试，无生产逻辑变化。
- 已安装 v0.17.0 的首次隔离负向：默认空配置可启动；启用本机 Web 后未产生就绪报告，探针在 75 秒期限内判定失败并清理自有进程。当时日志没有 JS 堆栈，不作为 WebSocket 根因证据。
- 首次 artifact-only 运行 `38239069412`：Windows 双架构、Ubuntu 双架构及 Fedora 安装启动均通过；macOS 双架构被 75 秒就绪期限拦截。独立本机重现采样显示主线程停在 `SecItemAdd → defaultKeychainUI → AuthorizationCopyRights`，隔离 HOME 没有登录钥匙串，引发同步原生授权等待。相同已安装 v0.17.0 加 `--use-mock-keychain` 后立即退出 1，准确输出 `import_browser.WebSocketServer is not a constructor`。这证明测试钥匙串不会掩盖本次模块错误。仅 macOS 合成 CI 启动添加此参数；正式应用启动和安全存储代码不变，不宣称通过真实钥匙串或账号登录验收。
- 本机构建临时未签名 `.app`，使用相同开启 Web 的隔离探针及测试钥匙串，三个就绪标记全部出现，正常退出 0。构建位置 `/tmp/agentkib-release-v0.17.1/local-candidate/mac-arm64/AgentKib.app`；报告 `local-package-ready.json`。此本地诊断包未暂存 quota sidecar，不替代 CI 完整候选包；没有下载 CI 安装包或覆盖 `/Applications/AgentKib.app`。
- `bash -n .github/scripts/smoke-test-linux-installed.sh`、工作流 YAML 解析、`git diff --check`：通过。
- 独立子代理复核：no finding；Windows/Linux 实际进程与 macOS x64 执行仍由 CI 候选包检验。Windows 超时清理使用活跃父进程的 `taskkill /T`，不宣称提供父进程已经消失后的通用孤儿进程追踪。

平台候选包与正式发布结果以关联 PR 和 Desktop Package Artifacts 运行记录为准。不下载 CI 安装包到本地，不替换已安装应用。
