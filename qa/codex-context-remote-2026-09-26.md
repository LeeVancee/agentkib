# Codex 上下文与公网远控验收 — 2026-09-26

## 范围与运行版本

本轮在现有香港中继上更新隔离 macOS arm64 测试应用，保持已安装的 `/Applications/AgentKib.app`、真实用户数据和系统 TUN 路由不变。没有提交、推送 Git，也没有重新部署后端。

测试包：`/tmp/agentkib-context-acceptance-20260926/mac-arm64/AgentKib.app`。使用原隔离配置启动，保留原登记和已授权的 `test` 浏览器。包为本地 ad-hoc 签名，未公证；不能据此宣称公开分发安装已验收。

本次工作树／分支相关交付是**读取指定线程的原生上下文**：执行目录、项目 ID、创建时分支。手机创建 Codex 工作树、指定起始分支及完整双向交接 UI 不在这次交付内；创建时分支不等于当前 Git 分支。

## 本轮通过

| 验收项 | 证据与边界 |
| --- | --- |
| Electron 与内置 Web 构建 | `pnpm --filter @agentkib/desktop build:electron` 成功，包含 release runtime、内置 frpc 与 Web |
| macOS 安装包目录 | electron-builder `--mac --arm64 --dir --publish never` 成功；`codesign --verify --deep --strict` 成功 |
| 包冒烟 | `smoke-remote-package.mjs` 通过：frpc 0.68.0、许可证、Rust CSR、Web、独立配置启动；报告位于测试包目录的 `package-smoke.json` |
| 公网入口与可信 TLS | API `/healthz` 200、控制域名 `/` 200、预览域名 `/` 预期 404；三个请求 TLS 校验均为 0 |
| 双通道恢复 | 最新测试应用启动、保存设置及恢复原设置后，控制与预览均回到通过，桌面显示可供手机连接 |
| 全局配对 | Safari 申请 `Acceptance Safari 0926` 后，桌面全局弹窗显示对应校验数字并完成临时授权 |
| 真实原会话发送 | 通过公网 Web 向“处理测试对话”提交一次无工具消息 `AK-CONTEXT-REMOTE-20260926`，原生任务完成回复，浏览器无需刷新自动显示结果 |
| 刷新与重复执行检查 | 刷新后历史与实时空闲状态恢复；原生 rollout 核对为一条标记用户消息和一条标记助手回复，无重复发送 |
| 原生上下文权限 | 未授权真实项目文件范围时，详情显示“Codex 信息不可用”，不扩大权限以完成测试；正向路由、越界目录和并发授权变化由定向测试覆盖 |
| 原生锁与元信息读取 | 两个真实 Codex app-server 进程、隔离 CODEX_HOME、本地模拟模型：第二进程能 `thread/read(includeTurns:false)`，返回同 ID、正确 cwd、空 turns；writer 占用时 resume 被拒绝，释放后以原 ID 恢复且历史保留 |
| 项目文件 | 仅临时开放独立样例 workspace；真实 agentkib 项目始终未进入文件授权范围。文件列表包含六个样例；真实会话不会把其他 workspace 文件标为其产物 |
| 隔离 HTML | 预览在独立 preview origin 加载，出现标题、相对图片和“相对 JSON 加载成功”；样例同时引用相对 CSS |
| 图片、视频与下载 | 独立图片查看器加载；8 秒 MP4 播放完成，可通过原生进度控件定位第 4 秒；图片下载到 Downloads 后 SHA-256 与源样例相同 |
| 撤销 | 桌面撤销临时 Safari 后，页面自动进入“远程访问已结束”，会话内容清空；原有 `test` 浏览器保留 |
| 清理 | 临时 workspace 授权撤回，`allowedWorkspaceIds` 恢复为空；隔离中继保持在线，原有浏览器授权数量恢复为 1 |

测试不会访问真实项目文件，测试消息没有调用工具。视频拖动的浏览器观察不等于本轮抓取过公网 206 请求；206/416、文件变化、限速和大文件内存上界由下列本地测试验证。

## 自动化验证

共 **346 项通过**，后端两项显式集成测试跳过：

- 桌面 6 文件、134 项：`pnpm exec vitest run electron/main/web/service.test.ts electron/main/web/artifacts.test.ts electron/main/web/artifacts-streaming.test.ts electron/main/web/relay src/features/remote/WebPairingPrompt.test.tsx src/features/remote/WebAccessSettings.test.tsx`（在 `apps/desktop` 执行）。包含授权、上下文、票据、Range、活动流关闭、512 MiB／8 GiB 稀疏文件流播与控制延迟上界。
- Web 全量 14 文件、128 项：在 `apps/web` 执行 `pnpm test`。
- 托管 runtime 14 项：`cargo test -p agentkib-runtime codex_managed`。
- follower bridge 52 项：`cargo test -p agentkib-codex-bridge --lib`，包含长会话、增量 patch、重连、竞争与不重复分发。
- 后端默认测试 18 项通过、2 项跳过：在独立后端工作区执行 `pnpm test`。本轮没有重新运行完整 Compose 和独立 frpc/frps 集成环境，不能将跳过计为通过。
- `pnpm typecheck`、`pnpm build:web:hosted`、`git diff --check` 通过。
- 原生验收命令：`python3 crates/agentkib-runtime/tests/fixtures/codex_native_writer_lock.py /Applications/ChatGPT.app/Contents/Resources/codex /opt/homebrew/bin/codex`。真实可执行文件，本地模型响应为模拟；没有使用真实模型鉴权。

本轮扩展了原生验收脚本，在 writer 锁竞争前验证另一个进程只读元信息，不恢复线程、不获取 writer、不拉取历史。

## 尚未验收

- iPhone Safari、Android Chrome 的扫码、控制、媒体及 Wi-Fi／蜂窝切换。本轮 macOS Safari 不能替代真机。
- 单轮生成中的逐字呈现与刷新发生在命令结果未知时的真实网络故障注入；本轮验证的是完成回复自动到达和完成后刷新，相关竞态另有自动化测试。
- 真实公网持续大视频传输期间的撤销、丢包／限速下控制延迟，以及本轮 VPS 私有租约与流量计数核对。不能以本地流播测试替代这些项目。
- 真实项目授权下的原生上下文正向浏览器展示：为保持该项目不开放文件／任务管理权限，本轮未扩大其目录授权；只读正向行为由 runtime、HTTP 测试及真实双进程验证覆盖。
- TUN 无专属 DIRECT 例外的完整设备域名复测。本轮保持原规则；此前该代理路径的 API／隧道 TLS 失败结论仍有效，不宣称单节点对所有代理零配置可达。
- 可收信 ACME 联系地址、续期通知及正式签名／公证分发。

因此，本轮可确认新版 Mac＋香港中继＋macOS Safari 的发送、自动更新、静态预览、视频播放／定位、下载和撤销闭环；不能宣称全部手机与弱网验收完成。
