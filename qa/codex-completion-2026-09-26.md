# Codex 远控补全验收（2026-09-26）

后续解锁后的真实公网交互、验收发现的修复及清理结果见 [真实公网补全验收](codex-completion-public-2026-09-26.md)。本文保留先前测试时间线；下文锁屏阻塞已在后续轮次解除。

## 范围

本轮补充原生能力查询、只读未知结果核对、明确恢复、附件输入、托管追加与原生队列、会话整理及下一轮设置、扩展审批、秘密问答与页面待处理入口。保留原有未提交改动；未提交、推送、部署或覆盖已安装应用，未更改 TUN。

能力按官方 follower / 托管 app-server 分开。工作树创建、分支切换没有已验证官方接口，保持禁用。手动 queue-start 未验证成功路径，保持禁用；原生队列本身会自动消费。高级操作不能因为 UI 出现便推断已在所有频道开放。

## 覆盖清单

| 需求 | 检查方式 | 边界 |
| --- | --- | --- |
| 旧设备无新增权限 | Electron API、配对与设置测试 | 不替代原有浏览器真机升级 |
| 附件上传及边界 | 流式配额、归属、版本、TTL、撤销测试 | 普通文件仍受原生沙箱约束 |
| 原生追加与队列 | 双版本真实 app-server + loopback 模拟模型 | 不调用真实账户模型 |
| 整理与下一轮设置 | 原生 rename/readback、fork、archive/unarchive/resume、模型请求检查 | unarchive 不代表持有执行宿主 |
| 审批／问题 | 完整候选精确匹配，秘密/自定义回答，resolved 事件验证 | 未验证的 follower 高级审批保持关闭 |
| 未知结果 | 持久回执、刷新恢复、原生 clientId 证据测试 | 未证实结果不自动重发 |
| 页面操作 | 真实浏览器 + 合成 API | 只算界面验收，不算公网链路 |
| 安装包 | 隔离目录构建与启动冒烟 | 不安装、不替换当前运行版本 |

额外负向场景：含附件的待发消息编辑不得静默丢失附件；任务完成不能代替审批 resolved；未知结果仍可执行只读核对；新模型不可用／原生队列消息被自动消费时明确失败。

## 已执行

- `cargo test -p agentkib-codex-bridge --lib`：56 passed。
- `cargo test -p agentkib-runtime web::tests -- --test-threads=1`：24 passed（后续整合测试见下）。
- `pnpm --filter @agentkib/desktop exec vitest run electron/main/web src/features/remote`：295 passed，1 skipped；后续修改的定向回归另记。
- `codex_native_questions.py`：`/opt/homebrew/bin/codex` (0.155.1) 和 Desktop bundled Codex (0.155.0-alpha.16.3) 都确认 `isSecret`、自定义答案、匹配 requestId 的 `serverRequest/resolved` 及 turn/completed。仅合成答案，隔离 HOME/CODEX_HOME。

## 待完成的真实环境验收

本轮新功能尚不算在 iPhone Safari / Android Chrome、公网断线与 Wi-Fi／蜂窝切换全部通过。现有香港中继及已配对浏览器不用于本轮合成测试；本地测试不替代这些验收。ACME 联系邮箱和长期证书续期的既有待办也未因本轮测试完成。

## 整合回归

- `cargo test -p agentkib-runtime -p agentkib-codex-bridge`：bridge 56、runtime 154、stdio 集成 1 全通过。
- 桌面最终附件／高级动作定向回归：20 passed；桌面 `typecheck`、`build:web`、`electron:build` 通过。
- 原生 writer 互斥 fixture 再次通过：第二进程被拒，原端释放后同 ID 恢复，历史与 clientId 保留。
- `codex_native_approvals.py`：两引擎各验证一次执行、拟议命令规则及 permissions 会话范围授权；每项都确认精确 `serverRequest/resolved`。权限由原生请求提供，测试没有构造任意外加根目录。

## 浏览器交互（合成 API）

使用 Codex 内置浏览器访问仅监听 127.0.0.1 的临时 fixture，页面是实际自托管构建。没有连接用户会话、真实模型或生产中继。

- 重命名后目录与标题更新；模型／模式选择及提交可操作。
- 运行态输入后可以加入原生队列；普通队列条目出现编辑输入，含附件条目禁用正文编辑并显示原因。
- 模拟写请求 503/unknown 后，重命名等写按钮禁用；只读核对仍可点；刷新后未知回执和写阻断保留。
- 合成文件通过真实 file chooser 上传，显示 100%，允许只有附件的发送；接受后附件列表和输入清空。
- 密码问答实际渲染 `type=password`；提交合成答案后关闭表单。真实引擎答案 resolved 由独立协议 fixture 验证。
- 待处理中心列出本页观察到的审批与本浏览器未知回执，未宣称后台全设备推送。
- 390×844 窄屏审批弹窗测得宽 358px，document scrollWidth=390，无横向溢出。原本大段上下文 JSON 占满屏的问题在目视检查后调整为权限摘要与折叠详情。

队列 UI fixture 没有模拟所有原生行为；队列修改、排序及原生消费的正确性依据 API/组件测试与真实 app-server fixture，不把按钮点击等同真实执行成功。

- 最终 Web：16 文件／143 tests passed；Web typecheck、同源构建、托管构建通过。
- 能力请求新增性能回归：19 次文字／revision 增量不触发额外能力查询；实际能力随相关状态、权限或用户手动刷新更新。
- 最终 390px 审批复核：网络及读取路径摘要在首屏可见，原生详细 JSON 默认折叠；持久命令规则显示 `git status` 前缀，明确勾选后才能提交。
- `codex_native_completion.py` 两真实引擎再次通过全部报告项；无真实账户模型调用。
- 最后仅调整 fork 禁用原因后，managed 22 项定向回归通过。

- 补充释放归属回归：已交接的官方任务 release 后，能力查询恢复 follower；新建托管任务 release 后仍是 managed。最终 managed 23/23 定向通过。

## 明确保留的限制

- 高级控制以已经验证的托管 app-server 为主；官方 Desktop follower 的高级队列、设置、整理及扩展审批没有因这次测试自动开放。
- 手动启动队列、官方工作树创建与分支切换继续禁用，界面给出原因。
- 无法核对的原生内部错误、或 runtime 重启后失去 resolved 证据的审批/问答，仍会保留未知结果阻断。不能把 native 报错一律解释为完全没有副作用。
- 已发送附件读取受原生沙箱约束；含附件队列条目暂不能只改正文。
- 旧设备新增权限默认 false；本轮没有替换当前运行应用，也没有给已配对浏览器自动授权。


## 最终安装包冒烟

最终代码重新执行 release runtime build、runtime stage、macOS arm64 Electron 目录打包，输出 `/tmp/agentkib-completion-acceptance-20260926/mac-arm64/AgentKib.app`。使用 `CSC_IDENTITY_AUTO_DISCOVERY=false` 和 `--publish never`；该包仅用于本地验证，未签发发布或公证。

```sh
node apps/desktop/scripts/smoke-remote-package.mjs /tmp/agentkib-completion-acceptance-20260926/mac-arm64/AgentKib.app qa/codex-completion-package-2026-09-26.json
```

结果：内置 frpc 0.68.0／许可证／Web 资源检查通过；捆绑 runtime 的 Rust CSR RPC 通过；独立 Electron profile 与 runtime 数据目录启动至 `home-data-ready` 后正常退出。结果记录见 [安装包冒烟 JSON](codex-completion-package-2026-09-26.json)。没有覆盖 `/Applications/AgentKib.app`、正在运行的应用数据或已有配对。临时浏览器已关闭、viewport 已复位、合成 QA HTTP 服务已停止。

最终 `git diff --check` 通过；没有执行 commit、push 或部署。

## 公网复查与真实交互阻塞（2026-09-26 19:45 CST）

用户要求实际连接验收后，复查现有香港公网入口。以下是实际 HTTPS 请求，不是合成 API；保持当前 TUN 和原有路由规则。

| 检查 | 结果 |
| --- | --- |
| 管理 API `/healthz` | HTTP 200，TLS 校验成功 |
| 控制域名 `/` | HTTP 200，TLS 校验成功 |
| 预览域名 `/` | HTTP 404，TLS 校验成功；根目录没有预览票据 |
| 无浏览器凭证读取 catalog、live、files/list、requests 回执 | 全部 HTTP 401 |
| 在预览域名访问控制 API `/api/web/v1/catalog` | HTTP 404 |

当前提供公网服务的是 `agentkib-context-acceptance-20260926` 测试包；本轮新构建 `agentkib-completion-acceptance-20260926` 尚未切换运行，不能把这些探测计作新版高级功能验收。隔离测试数据的托管会话表为空，未发现 dispatched 托管命令；指定原生“处理测试对话”读取状态为 idle。

两次尝试选择隔离测试应用时，电脑控制工具均报告 Mac 锁定且无法自动解锁，已请求用户手动解锁。本次因此尚未执行新版浏览器配对、真实发送／追加／队列／附件／审批交互，也未修改现有配对或替换已安装应用。后续解锁后继续从隔离包切换和临时浏览器配对开始；上述在线检查不替代真实交互和手机验收。
