# Claude 排除规则计算预算修复与回归

## 源码与范围

- 审查基线：`origin/main @ efb7904e3ce369929708f81d02f3d0b21150d9e5`。
- 本地 HEAD：`bfde761ead3ade80fca4ebcaa58e68b2cb99b0ef`，`main`，dirty。保留此前的 Claude 修复及用户其他改动。
- 本轮修复上一轮审查发现的 `claudeMdExcludes` 同步匹配阻塞问题，修改两个生产文件、三个测试文件和功能说明，另增加本 QA。没有提交、推送、新依赖、协议或数据库变更。
- 按用户要求，不审查或修改尚未完成的 Skills 功能。最终验证使用上一轮非 Skills 源码快照叠加本轮六个文件的固定副本；没有覆盖或回滚共享主目录中的并发改动。
- Node `22.23.3`、pnpm `12.10.1`，macOS arm64；通过 `pnpm install --offline --frozen-lockfile` 安装锁定依赖，865 个包复用、零下载。

## 缺陷与修复

修复前，包含十层嵌套否定 extglob 的 59 字节设置文件即可使真实 Context 请求超过 4 秒仍未返回，100 ms 定时器也无法执行。该计算发生在 Runtime 主线程，连带阻塞其他工作区查询和 MCP 请求；原复现由独立进程看门狗终止。

`context-glob.ts` 新增可选计算预算，覆盖花括号展开、解析、字符串与路径处理、候选遍历、重复匹配及集合操作。段内匹配增加有界缓存，避免重复计算相同状态。显式使用预算时，超过工作量、展开或深度限制抛出专用错误，不把未完成计算伪装成匹配或不匹配；不传预算的旧调用保持原有语义。

`context-claude.ts` 在一次 Context 装配中共享 500,000 单位预算，跨规则和文件累计，下一次请求重新开始。耗尽后保留尚未确定是否被排除的指令来源，并显示一次明确的“不完整评估”提示。已确定的排除结果缓存复用，避免发现阶段已排除的文件在加载阶段重新出现。现有个人内容、外部路径和脱敏边界保持，Doctor 继续跳过 Claude 设置评估。

这里的预算是确定性计算工作量上限，不是所有 Context IO 的墙钟超时。功能说明同步记录预算和不确定结果的处理方式。

## 新增回归

共新增 57 项测试，未新增跳过或削弱断言：

- `context-glob-budget.test.ts`：48 项，覆盖原触发模式、Unicode、globstar、字符类、转义、花括号、否定和重复 extglob；验证跨调用预算、各阶段限额、深度错误与异常传播。
- `claude-exclusion-budget.test.ts`：8 项，使用真实 Context 和合成配置验证 Full/MCP/Doctor 行为、一次警告、跨规则及跨文件累计预算、保留已确定排除结果、正常配置恢复，以及个人正文和路径不泄漏。
- `claude-settings-runtime.test.ts`：保留原有测试，增加 1 项真实编译 Backend 子进程及 MCP HTTP 协议测试。依次使用原触发规则、超限规则和恢复后的普通配置；Context/MCP 请求与并发工作区查询均须在 1 秒内完成，由独立父进程看门狗兜底。测试核对实际正文、警告、排除和 AGENTS 回退结果，不只检查返回速度。

## 验证结果

以下最终检查均在固定源码副本中通过。结果不代表共享工作区正在开发的 Skills 改动已验收。

| 命令                                                                                                                                                                                                                                                                                  | 结果                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm --filter @agentkib/desktop protocol:generate`                                                                                                                                                                                                                                   | 通过                                                              |
| `pnpm --filter @agentkib/desktop backend:build`                                                                                                                                                                                                                                       | 编译子进程及原生模块 staging 通过                                 |
| `pnpm --filter @agentkib/desktop exec vitest run test/context-glob-budget.test.ts test/claude-exclusion-budget.test.ts test/claude-settings-runtime.test.ts test/claude-settings-context.test.ts test/claude-settings-boundary-regressions.test.ts test/claude-context-rules.test.ts` | 6 文件、249 项通过                                                |
| `pnpm format:check`                                                                                                                                                                                                                                                                   | 818 个文件通过                                                    |
| `pnpm lint`                                                                                                                                                                                                                                                                           | 通过，无错误；保留既有 React/compiler 等警告                      |
| `pnpm typecheck`                                                                                                                                                                                                                                                                      | Backend、桌面、Web 通过                                           |
| `pnpm test`                                                                                                                                                                                                                                                                           | 桌面 263 文件、5021 项通过、2 项既有跳过；Web 37 文件、765 项通过 |
| `pnpm build`                                                                                                                                                                                                                                                                          | 桌面、Electron、Backend 及随附 Web 构建通过                       |
| `pnpm build:web:hosted`                                                                                                                                                                                                                                                               | 通过                                                              |
| 本轮文件 `git diff --check`                                                                                                                                                                                                                                                           | 通过                                                              |
| 本轮六个文件 SHA256 核对                                                                                                                                                                                                                                                              | 主目录与固定验证源码一致                                          |

构建 staging 脚本校验了 macOS arm64 的 frpc `0.68.0` 归档。没有启动已安装应用、处理个人钥匙串或调用真实模型；本轮未执行 Windows/Linux 实机和签名安装包验收。

## 独立复核

独立子代理只读复核本轮生产增量，结果为 no finding。复核包括 23,000 组确定性旧/新匹配差分，以及嵌套否定、深度、展开、大量分支和重复模式的预算探针；检查缓存不可变性、预算异常传播和 Context 的隐私边界。该结论仅针对本轮修复与相邻路径，不代表整个分支没有其他问题。

## 本机证据

- `/tmp/agentkib-glob-budget-fix-20261015/source/`：排除未完成 Skills 改动的固定验证源码及构建产物。
- 同目录上层的 `identity.json`：源码身份及六个修复文件 SHA256；`baseline.json`：修复前快照及其文件哈希；`fixes.patch`：本轮增量。
- `install.log`、`protocol.log`、`backend-build.log`、`focused.log`、`format.log`、`lint.log`、`typecheck.log`、`test.log`、`build.log`、`hosted.log`：本次实际命令日志。
- `/tmp/agentkib-r8-standards-probe/`：修复前隔离复现及看门狗记录。

临时目录可能被系统清理，本文是结果摘要，不替代完整原始日志。
