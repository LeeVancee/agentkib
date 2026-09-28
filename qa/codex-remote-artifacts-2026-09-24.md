# Codex 远控、产物与 HTTPS 中继验收记录

本次修改在 macOS 开发工作区完成。没有提交或推送 Git，没有部署 VPS，没有读取或修改用户已有 Codex 会话来做执行测试。原有 design-qa.md、设计稿与截图等工作区改动保留。

## 已实现

- 官方 Desktop follower 根据实际 IPC peer 定位安装，严格版本与协议门控。
- 官方 app-server 托管创建、原 ID 交接、执行/审批/问答/停止、释放与原生状态核对；独立持久账本和请求去重。
- 手机新建与执行管理、项目/产物浏览、只读 diff；设备新增权限默认关闭，工作区由桌面授权。
- 独立预览 origin，HTML bundle 沙箱及固定快照，媒体流式 Range，受限文件访问、短效票据及撤销；可注册可信 viewer 扩展。
- frp HTTPS 透传、邀请注册与独立设备凭证、域名约束、CSR 证书签发、本机 TLS 与续期、就绪检查、桌面设置接入和 VPS 配置。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| `cargo test -p agentkib-codex-bridge -p agentkib-runtime --quiet` | bridge 46、runtime 141、stdio 集成 1，通过 |
| `pnpm test:web` | 11 文件、101 项，通过 |
| Electron Web 服务、产物、中继、设置与轮询的定向 Vitest | 9 文件、133 项通过；完整命令见下 |
| `pnpm typecheck` | Desktop、Web 均通过 |
| `pnpm --filter @agentkib/web build` | 通过 |
| `pnpm --filter @agentkib/desktop electron:build` | 主进程、preload 构建通过 |
| 中继服务及本机真实 frpc/frps 测试 | 7 项通过，没有跳过；HTTPS Range、真实插件 payload、设备撤销、双向流量计数和示例管理员凭证拒绝通过 |
| 本机真实双版本 Codex 离线验收 | 固定策略、writer 冲突、释放后同 ID 恢复、历史和 clientId 持久化均通过 |
| Docker 镜像与部署配置 | broker/frps 镜像构建成功；HAProxy、Caddy、frps 配置用真实二进制校验通过；frps 容器回环 metrics 可读且无公开端口 |
| 格式与 `git diff --check` | 本次修改文件通过；未格式化用户已有修改 |

Electron 定向测试：

```sh
pnpm --filter @agentkib/desktop exec vitest run \
  electron/main/web/service.test.ts \
  electron/main/web/lan-service.test.ts \
  electron/main/web/acceptance.test.ts \
  electron/main/web/remote-capabilities.test.ts \
  electron/main/web/artifacts.test.ts \
  electron/main/web/relay/manager.test.ts \
  src/features/remote/WebAccessSettings.test.tsx \
  src/features/remote/LanWebAccessSettings.test.tsx \
  src/features/remote/remote-polling.test.ts
```

真实原生 Codex 离线测试：

```sh
python3 crates/agentkib-runtime/tests/fixtures/codex_native_writer_lock.py \
  /Applications/ChatGPT.app/Contents/Resources/codex /opt/homebrew/bin/codex
```

输出六项布尔值均为 true。测试创建临时 HOME、CODEX_HOME 与工作区，仅使用 loopback fake Responses 服务；没有使用用户 token 或付费模型。服务端集成测试在内部测试环境执行，其部署和复现配置不随本仓库提供。

验证过程中发现并修复：旧 grant 自动扩权风险、管理操作未知回执误报成功、重复提交和卸载竞态、HTML 本地/公网 origin 混用、额外目录换行丢失、异步证书域名被设置草稿覆盖、原始 agent 状态目录读取、managed 历史反向分页、原生索引别名重复，以及 ACME 依赖树 ASN.1 schema 版本分裂。

构建保留现有工具链提示：路由生成器循环依赖提示、测试环境 localStorage 提示、TypeScript 7 与部分 i18n 包 peer 范围提示。定向 lint 无错误，React effect 状态同步等仍有 warning；没有禁用检查或降低规则。

## 尚未验收与实际限制

- 未部署用户 VPS、配置公网 DNS、申请正式公网证书或完成长期证书续期实测。
- 未在真实 iPhone Safari、Android Chrome 上验证配对、蜂窝切网、播放、HTML 交互和下载；桌面浏览器/组件测试不能替代实机。
- 没有在用户真实官方 Desktop 会话上发送、审批、问答。当前 follower allowlist 的元数据/协议检查不是完整生产验收。
- 官方新建后从未发送过消息的空线程，在原生进程退出后不能 resume。本实现保留账本并允许释放，不伪造恢复或自动 fork。有真实 turn 的同 ID 恢复已离线验证。
- 首版需用户安装并填写经校验的 frpc **0.68.0** 路径；不包含自动安装守护进程或自动下载隧道二进制。
- HTML 限静态包和包内相对资源；无开发服务器/API 代理。音视频受浏览器编码支持限制；Office 等提供下载，不自动转换。
- 会话产物当前从明确 Markdown 文件引用关联；其他文件可用项目目录浏览。项目 diff 不等于全部由当前会话生成。
- 中继正常数据面只转发密文，域名/DNS/CA 主动冒用仍属于标准 Web PKI 信任边界。

本记录证明源码及本地测试状态，不代表发布包、线上可用性或手机生产验收完成。
