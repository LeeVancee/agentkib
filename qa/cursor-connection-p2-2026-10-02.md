# Cursor 连接入口与失效登记隔离回归

2026-10-02，继续工作树 `codex/main-acceptance-20260930`，起始 revision 为 `f706abaffac9950d616121f4dc86ef830a41aa09`，修改前工作树干净。以下结果针对本轮 dirty 源码，不沿用此前原生客户端验收的二进制身份。使用已有 Node `22.23.2`、pnpm `10.8.1`；不安装或升级依赖、不变更数据库表及 RPC 数据结构。

## 修复与回归

- 登记文件只校验文件安全、大小、schema、结构和数量；连接资源在按工作区或 binding 筛选后校验。状态与撤销按 Store 保存的工作区身份处理，目录被移动后仍可列出原绑定并撤销凭据。配对、读取、预览和执行保留固定版本、安装哈希及路径校验；当前连接同时检查数据库正规文件与 SQLite sidecar 边界。
- 来源 provider 接收 Store 中的工作区路径，只检查当前工作区未撤销的记录。失效来源继续走 unavailable/partial sync，保留已有缓存；其他工作区的首次配对、读取及完整索引不受影响。Web 的三处内部 provider 调用同步传入原有 Store 工作区，鉴权、控制请求与回执流程不变。
- 工作区会话页增加独立 Cursor 连接入口，不需要可读会话、导入记录或 Cursor 目标选择。真实连接面板配对成功后仅强扫历史一次；状态轮询不重复强扫。远程工作区不挂载本机入口，平台不支持时不能配对；切换工作区卸载连接码并拒绝迟到状态影响。

Runtime 的三个新增集成用例分别移动 A 工作区、修改 A 安装版本、移走 A 数据库。通过真实 Runtime RPC、Unix socket peer 和隔离合成 SQLite 验证：B 状态查询及首次配对成功、B 原生历史正文准确且索引 fresh；A 缓存保留，正文读取和原生预览被拒绝；错误工作区不能撤销 A，正确工作区可清除 A 凭据、保留冻结身份并关闭旧 socket，B 不受影响。

桌面五个新增用例挂载真实 `CursorBridgePanel`，只模拟 API 边界，覆盖空列表首次配对后历史可见、已有连接不重复强扫、不支持平台、远程工作区、切换工作区及迟到响应。原有交接与恢复面板的相邻回归同时运行。

## 实际命令与结果

前端命令使用 Node 22 的 PATH；原始日志位于私有本机目录 `~/Documents/AgentKib-archives/2026-10-02/cursor-connection-p2/`。

| 命令                                                            | 结果                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `cargo test -p agentkib-runtime --test cursor_bridge`           | 11 passed，0 failed，0 ignored                                                        |
| `cargo test -p agentkib-runtime`                                | 5 suites，243 passed，0 failed，1 ignored；`runtime-tests.log`                        |
| `cargo clippy -p agentkib-runtime --all-targets -- -D warnings` | exit0；`clippy.log`                                                                   |
| `cargo fmt --all -- --check`                                    | exit0；`rust-format.log`                                                              |
| `pnpm format:check`                                             | exit0；`frontend-format.log`                                                          |
| `pnpm lint`                                                     | exit0，84 条既有 warning；`frontend-lint.log`                                         |
| `pnpm typecheck`                                                | 桌面与 Web exit0；Web 路由工具有既有循环依赖 warning；`frontend-typecheck.log`        |
| `pnpm test`                                                     | 扩展 Node 11 passed；桌面 964 passed / 7 skipped；Web 230 passed；`frontend-test.log` |
| `git diff --check`                                              | 通过                                                                                  |

验证过程保留以下失败事实：第一次编译发现 Web 的三处内部调用尚未增传工作区，已同步修正；新增 fixture 起初未刷新导入后的原生索引，已通过公共 force refresh 建立真实缓存基线；随后数据库丢失用例发现上下文校验缺少数据库存在性检查，已补齐。最终测试保留缓存、正文、权限归属与凭据撤销断言，没有降低校验。

Runtime 登记/来源隔离、数据库校验和 Web 调用，以及桌面入口/异步竞态，分别由独立子代理只读复核；最终未发现确定缺陷。

本轮只完成代码和自动化回归，没有重新执行真实 Cursor GUI、模型回复、手机或 Windows/Linux 实机验收，未提升兼容矩阵的原生验收等级。没有提交、推送、发布或替换已安装应用。
