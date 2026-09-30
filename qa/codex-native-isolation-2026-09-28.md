# Codex 原生续接隔离调查（2026-09-28）

## 结论

本机 Codex `0.155.1` 的现有 ChatGPT 登录已由主任务通过 `codex login status` 确认。本记录没有重读凭据或真实历史，也没有发出模型请求。当前阻塞是**官方 CLI 没有提供与登录根目录独立的完整会话存储根**，不能把隔离 `CODEX_HOME` 后缺少登录解释成用户未登录。

仅保留原 `CODEX_HOME`、设置独立 `sqlite_home` 不足以满足“真实会话目录与数据库完全隔离”。原生落盘版本 gate 仍保留 `0.146.x`，未放宽到 `0.155.1`。另外核验了官方 `0.146.0` 与 `0.146.1` 配置 schema，也未发现独立 auth 根或 sessions 根；仅下载旧 CLI 不能解决这项隔离问题。

## 实际检查

工作树 revision：`057da8b81a3f3c9536a568287175af8e50c12176`，dirty，保留原有修改。本任务仅新增本 QA 文件，没有改生产代码、安装或配置。

- `/opt/homebrew/bin/codex` → `/opt/homebrew/Caskroom/codex/0.155.1/bin/codex`。
- `codex --version` → `codex-cli 0.155.1`。
- 查看 `codex --help`、`codex exec --help`、`codex exec resume --help`、`codex app-server --help`。
- 在空的临时根生成本机实际协议：

  ```sh
  CODEX_HOME=/tmp/agentkib-codex-isolation-probe/home \
    codex app-server generate-json-schema --experimental \
    --out /tmp/agentkib-codex-isolation-probe/schema
  ```

- 下载官方固定 tag `rust-v0.155.1` 源码到 `/tmp/agentkib-codex-isolation-probe/repository`，并对照固定 tag 的 config schema。没有启动用户原 `CODEX_HOME` 的 app-server。
- 下载 `rust-v0.146.0` 与 `rust-v0.146.1` 配置 schema；没有安装或运行这些版本。

## 有效接口与边界

| 接口或参数 | 实际作用 | 对验收的影响 |
|---|---|---|
| `sqlite_home` / `CODEX_SQLITE_HOME` | 重定向 SQLite 数据目录 | 不能单独隔离 rollout 和会话名称索引 |
| `log_dir` | 重定向日志 | 不能重定向会话 |
| `history.persistence = "none"` | 关闭 CLI 输入历史 | 不等于禁用或重定向 rollout |
| `CODEX_HOME` | 同时决定 auth、rollout 和部分索引的根 | 换成空目录会失去该根的登录；不代表用户本机没登录 |
| `thread/resume.path` | app-server 可按明确绝对路径加载合成 rollout | 是进一步实验入口，但不能据此宣称全局会话根已隔离 |
| `thread/resume.history` | schema 明示仅 Codex Cloud 使用的 unstable 参数 | 不作为桌面持久化互通的替代方案 |
| `--ephemeral` | 不保留常规新会话的持久化历史 | 无法证明重启恢复；不是原生持久化验收的解决方案 |
| `experimental_thread_store = in_memory` | 调试用途的内存存储 | 同样不满足重启恢复 |

来源与已核对的实现：

1. [0.155.1 config schema](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json) 中有 `sqlite_home` 和 `log_dir`，无 `auth_home`、`sessions_home` 或 `rollout_dir`。`0.146.1` 的[配置 schema](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/core/config.schema.json)同样如此。
2. [rollout recorder](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/rollout/src/recorder.rs#L1700) 的 `precompute_new_rollout_path` 从 `config.codex_home()` 追加 `sessions/YYYY/MM/DD`；resume 分支按传入路径追加。这说明明确的临时 path 可以控制该条 rollout，但并未改变其他会话的默认根。
3. [LocalThreadStoreConfig](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/thread-store/src/local/mod.rs#L222) 只有 `codex_home`、SQLite 配置及 provider，构造时直接使用主配置的 `codex_home`。
4. [session index](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/rollout/src/session_index.rs#L235) 将名称索引定位为 `codex_home/session_index.jsonl`；元数据修改会更新它，不能由 `sqlite_home` 重定向。
5. [auth storage](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/login/src/auth/storage.rs#L154) 的文件后端读取 `codex_home/auth.json`；Keychain key 也由 canonical `codex_home` 哈希计算。切换为另一个临时根不会自动使用原有 Keychain 项。
6. [thread manager](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/thread_manager.rs#L396) 在相应 feature 开启时，按原 `codex_home` 启动 rollout 迁移或压缩。两个 feature 的[默认值为 false](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/features/src/lib.rs#L1117)，因此不能夸大成所有启动都会迁移；但复用未知用户配置也不能假定不会触及真实会话。
7. [session persistence](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/session/session.rs#L883) 在 `config.ephemeral` 时跳过 LiveThread 持久化，不能作为重启回读证明。`exec resume` 的[参数构造](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/exec/src/lib.rs#L1372)也没有独立的 resume `ephemeral` 字段，不能只看到 CLI flag 就推断已有持久化会话被安全隔离。

## 后续可行实验与当前不执行的原因

可继续研究的路径是：在外部 macOS 文件系统沙箱中保留原认证读取、强制禁止原 Codex 数据目录写入，同时将 SQLite、日志与显式 `thread/resume.path` 指向临时目录，关闭背景迁移/压缩，限定单轮并拒绝工具调用。应先使用全部合成 HOME 和合成 auth 状态验证沙箱确实拦截全局写入及错误路径，再尝试已有登录。

本次没有把这一路径写成“已验证可执行命令”：它尚未证明原生客户端在拒绝写入原根时能完成初始化、刷新认证、会话恢复及重启。若需要通过凭据符号链接、复制 token 或 auth 参数桥接来绕过根目录绑定，会改变既定“不迁移凭据”约束，因此没有采用。

当前可以准确报告：**用户已登录；保持凭据不迁移和真实会话完全隔离的正式原生验收仍未完成**。本机版本与原文件写入版本 gate 的差异也是独立限制，不能通过本调查静默放宽。
