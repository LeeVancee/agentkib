# Windows x64 卸载残留调查与修复（2026-10-21）

## 范围与原始证据

- v0.20.1 发布提交：`cee23c4ef869fbc49c0f8734c978eb82cc02f7b9`。
- [首次失败 job](https://github.com/starroyhq/agentkib/actions/runs/39436343192/job/118678713504)：安装、启动和覆盖安装已通过，卸载后 `AgentKib.exe` 仍在。该次发布门禁正确失败。
- 原失败诊断 artifact：`12271813257`；对照的成功诊断：`12287131639`。本轮只读取两份小型 `summary.json`，未下载或安装 AgentKib 安装包。
- 首次卸载于 `2026-10-20T14:18:12.1635893Z` 开始，启动器 PID 5620 于 `14:18:13.3677198Z` 返回 0。两分钟后结束快照仅剩 `AgentKib.exe`（244460544 字节），其余安装文件已删除。目标目录进程列表为空。
- 原快照注册表列表也为空，但旧过滤器只接受 `DisplayName == AgentKib`，不能据此证明卸载注册项确实消失。新诊断改为按目标安装路径匹配，兼容带版本的显示名。
- 原标签、同一源代码、同一门禁的第二次 Windows x64 冒烟在 31 秒内通过。这只能证明没有再次复现，不能作为根因。

## 已确认的缺陷与尚缺的证据

1. 冒烟等待原始 NSIS 自复制启动器，并把其返回 0 当成实际卸载成功。[NSIS 官方约定](https://nsis.sourceforge.io/Docs/AppendixD.html)明确：要取得真正卸载退出码，应自行复制卸载器到安装目录外，并在末尾传 `_?=<安装路径>`。
2. 当前 electron-builder 26.15.7 的 `templates/nsis/uninstaller.nsh` 普通卸载只执行一次 `RMDir /r $INSTDIR`，未处理删除错误，随后继续清除注册项并返回成功。[RMDir 文档](https://nsis.sourceforge.io/Docs/Chapter4.html#rmdir)明确无法删除文件时会设置错误标记。它没有安排延迟或重启删除；一次失败后，单纯等待两分钟不会再次删除文件。
3. 原诊断没有文件属性、Win32 删除访问错误码或目标文件的锁拥有者。**无法追溯首次是哪一个进程、句柄或文件属性阻止删除**；不能认定是 Defender、杀软、持续应用进程或慢扫描。

因此，本轮修复的是已证实的“单次删除失败后无恢复、错误被吞掉、退出码观测错误”链路，并补齐下次精确定位所需证据；不声称已查明首次 Win32 拒绝者。

## 本轮修复

- `apps/desktop/scripts/windows-installer.nsh`、`apps/desktop/electron-builder.yml`：跟踪自定义删除钩子。普通卸载在五秒预算内有限重试，目录仍存在则明确退出 2 并中止，保留卸载注册信息；不用 `/REBOOTOK`，不强杀锁拥有者，不删用户数据。保留默认升级时的原子搬移、失败恢复及在位卸载器回退逻辑。失败提示包含简体中文、繁体中文、英语和日语，其余原有安装器语言回退英语。
- `.github/scripts/windows-uninstall.ps1`、`smoke-test-windows-installer.ps1`：执行安装目录外的私有卸载副本，工作目录也在安装目录外；`/S` 后以完整、无嵌套引号的 `_?=` 路径结束命令。记录真正退出码。原两分钟预算覆盖执行和残留检查；原 EXE 消失、覆盖安装保留数据和卸载保留数据断言均保留。超时只终止本次私有副本；未确认退出时明确记录清理不完整。
- `.github/scripts/windows-file-removal-diagnostics.ps1`：失败时只读探测目标 EXE 的属性、DELETE 访问错误及 Restart Manager 锁拥有者。不开启 DeleteOnClose，不删文件、不改属性、不终止拥有者，不采集命令行、环境或凭据；所有已开始的 RM 会话最终结束，列表增长最多三次、最多 256 项，采集失败明确标记。
- Windows 类型检查工作流纳入全部 release helper 测试；发布打包后两架构强制执行原生 NSIS 回归。测试和编译器从真正源码目录解析，兼容 `.release-helpers` 稀疏 checkout，不依赖该目录拥有 `node_modules`。

## 回归测试与本地验证

本机是 macOS ARM64，没有 Windows。使用校验官方 SHA256 的临时 PowerShell 7.6.7 和 electron-builder 固定校验和的同版 NSIS 3.0.4.1 编译器；工具仅放在临时目录，未改依赖、锁文件或系统配置。

- 卸载控制测试：真实退出非零、返回零但 EXE 残留、进程持续运行、EXE 提前删除但进程未退出、原 120000ms 边界、异步终止未确认、用户数据丢失、复制失败、安装目录内复制被拒绝、诊断失败不掩盖原错误、含空格参数和私有临时文件清理。
- 只读诊断测试：P/Invoke 声明编译、唯一目标注册、拥有者字段裁剪、有限重试、分配上限、数值错误、异常脱敏、始终释放 RM 会话及非 Windows 明确不完整。
- NSIS 测试：上游升级逻辑保持、语言覆盖、生产钩子与原子升级函数在同版编译器中以 warnings-as-errors 编译；另有真实 Windows 临时锁、持续锁、原子升级成功/回滚及在位升级回退用例。
- 最终完整 helper 套件：`AGENTKIB_PWSH=<临时 pwsh> AGENTKIB_NSIS_COMPILER=<同版 makensis> NSISDIR=<同版 NSIS 目录> node --test .github/scripts/*.test.mjs`，**43 项：36 通过、0 失败、7 跳过，12.21 秒**。跳过为 1 项默认未开启的 Windows 强制门禁、1 项 Win32 API 原生测试及 5 项 Windows NSIS 执行测试；本机的 PowerShell 控制逻辑、诊断控制逻辑和 NSIS 编译均实际执行，未因缺少工具全部跳过。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 均通过。lint 仍有既有警告，本轮未修改其涉及的应用代码。pnpm 使用临时 userconfig 的 `manage-package-manager-versions=false`，没有修改依赖或锁文件。
- 四个新增/修改 `.mjs` 文件的 `oxfmt --check`、四个相关 PowerShell 文件的 AST 解析、两份修改工作流及 electron-builder 配置的 YAML 解析、`git diff --check` 均通过。
- 独立复核发现并修复了稀疏 helper 依赖解析、升级在位执行兼容、异步终止清理状态三处边界；再次复核 **no finding**。这只表示当前补丁未发现新的确定缺陷，不等于已运行 Windows 原生验收或还原首次 Win32 拒绝者。
- 本轮只涉及安装器、release helper、测试与文档；未修改应用 TypeScript/React 运行逻辑，因此没有重跑桌面/Web 全量业务测试。相关安装器及 helper 套件、三项仓库检查均已完成；真实 Windows 部分仍见下节。
- 首次本地验证结束后确认没有临时 PowerShell/NSIS 进程残留，已移除临时运行时、编译器和 pnpm userconfig。当时 HEAD 为 `990727df2f4649b4c6e34605b255a8b9b8ee9062`，尚未提交或推送；原有四处无关未跟踪内容保持不变。

## 尚未覆盖与用户环境影响

- 真实 Win32 DELETE/Restart Manager、NSIS 锁文件和真实 AgentKib Windows x64/ARM64 安装卸载：本机无法执行，原生用例已接入 Windows CI，但按本轮要求未提交、未推送，故本轮尚未在 CI 运行修改后的代码。
- 不修改或替换已发布 v0.20.1 的标签和安装包。本地改动只有经过后续提交、CI 和新版本发布后才会影响安装卸载行为。
- 没有读取真实账号凭据、改变会话安全校验、跨 Agent 继续或 Codex follower；原有无关工作区文件保留。

## PR 与 Windows CI 原生复验（2026-10-21）

- 按后续用户授权提交补丁并创建 PR，使用最新 `main`（`edd282035`）为基线，分支 `codex/windows-uninstall-verification`，只纳入本轮安装卸载修复、测试、工作流及文档。
- PR 的 Windows x64/ARM64 检查执行 PowerShell 控制与真实 Win32 文件诊断测试；另手动运行 `Desktop Package Artifacts`，选择该分支且留空 `release_tag`，以 artifact-only 路径验证两个架构的 NSIS 原生锁/升级回归和实际 AgentKib 安装、启动、覆盖安装、卸载与用户数据保留。
- 禁止合并或发布，不创建/移动标签、不修改 v0.20.1 Release，也不下载安装包到本地验收。CI 结果将在实际运行后补充。
