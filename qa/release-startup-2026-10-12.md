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
- 已安装 v0.17.0 的隔离负向：默认空配置可启动；启用本机 Web 后未产生就绪报告，探针在 75 秒期限内判定失败并清理自有进程。负向日志没有输出 JS 堆栈，因此该次实验只证明启动门槛能拦截，具体模块根因依据安装包检查与构建负向测试。
- `bash -n .github/scripts/smoke-test-linux-installed.sh`、工作流 YAML 解析、`git diff --check`：通过。
- 独立子代理复核：no finding；Windows/Linux 实际进程与 macOS x64 执行仍由 CI 候选包检验。Windows 超时清理使用活跃父进程的 `taskkill /T`，不宣称提供父进程已经消失后的通用孤儿进程追踪。

平台候选包与正式发布结果以关联 PR 和 Desktop Package Artifacts 运行记录为准。不下载 CI 安装包到本地，不替换已安装应用。
