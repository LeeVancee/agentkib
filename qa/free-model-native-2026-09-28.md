# 官方免费模型：Hermes / OpenClaw 原生续接验收（2026-09-28）

## 结果

官方 OpenCode Zen 当前仍列 `big-pickle` 为免费模型，实时模型列表也包含该 ID。但 Hermes 与 OpenClaw 各自的一次原生续接请求，都被官方服务以 **HTTP 403 / FreeTierError** 拒绝：

> OpenCode's free tier can only be used from within OpenCode

没有真实模型回复，不计原生互通验收通过。服务没有返回供应商 usage，客户端记录的 0 不能当作账单或“零收费”的实证；这里只能确认请求模型在当次官方文档中标为免费。没有使用已失效的 moka 凭据、现有付费密钥、注册帐号、购买额度、伪造 OpenCode 客户端、自动重试或换模型。本记录不替代 root 单独执行的 OpenCode 原生验收。

## 官方模型及认证证据

- 当次读取 [OpenCode Zen 官方文档](https://opencode.ai/docs/zen/)：`big-pickle` 输入/输出/缓存读取均为 Free，接口为 `https://opencode.ai/zen/v1/chat/completions`。
- 当次读取[实时模型列表](https://opencode.ai/zen/v1/models)：存在 `big-pickle`。快照：`/tmp/agentkib-free-native-2026-09-28/catalog.json`、`zen.html`。
- 官方 [Zen handler](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/handler.ts) 把字面量 `public` 视为匿名占位，不是用户密钥；当前 handler 会先调用 [inference proxy](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/lib/inference-proxy.ts)，认证与撤销由目标后端执行。公开源码不足以确定后端以哪些字段识别 OpenCode 客户端，因此没有猜测或制造识别字段。
- 固定版 [Hermes auth.py](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/hermes_cli/auth.py) 已明确移除 `opencode-free`：匿名免费层不再向外部客户端开放，Zen 常规接入需要 API key。本次实际 403 与此一致。
- OpenClaw `2026.9.6` 官方随包 `docs/providers/opencode.md` 要求 OpenCode API key；环境中 `OPENCODE_API_KEY`、`OPENCODE_ZEN_API_KEY` 均未设置。这里只检查变量是否存在，没有读取其他凭据文件。

## 隔离与单请求控制

源码 revision：`057da8b81a3f3c9536a568287175af8e50c12176`，dirty。生产代码、依赖及锁文件未改。本批只新增 QA 与临时 probe。

两目标均使用 `/tmp/agentkib-free-native-2026-09-28/` 下独立 HOME、数据目录及非用户配置。由原生客户端产生实际模型请求，经本地 HTTP 计数代理转发到唯一允许的官方 URL。代理只放行 `big-pickle`、不带 tools 的一次 chat/completions POST；没有 curl retry。发送诚实的 AgentKib/Hermes 或 AgentKib/OpenClaw 验收 User-Agent，没有伪装成 OpenCode。`public` 仅为 SDK/API 的公开匿名占位。

每目标的模型提示只要求回忆历史中的 marker 与决策，不把答案再放进新提示。实际 outbound request 检查确认，两者的上下文都包含历史随机 marker 和项目 namespace，且 `tools=0`；这是上下文进入原生请求的证据，不是模型已经正确回复的证据。

## Hermes 0.21.5

- 使用生产转换器已生成的载荷：`/tmp/agentkib-tui-rendered-2026-09-28/openclaw/hermes-payload.json`，并严格比较 `hermes-expected.json`。
- 使用官方固定 `v2026.9.24` 完整源码，隔离 Python venv。原临时源码不含 plugins，第一次启动失败于 `ModuleNotFoundError: plugins`；补齐相同 tag 完整源后缺 `openai`；再安装其官方精确版本 `openai==2.24.0`。这些准备失败均没有上游模型请求。补齐依赖仅发生在 `/tmp/agentkib-interop-tools/hermes-env`，没有安装到项目、用户 Python 或修改生产依赖。
- 官方 `sessions import --from claude` 创建独立会话；CLI 退出后重新打开 SessionDB，角色与全文精确符合预览。
- 最终会话：`20260928_003639_9ecb8e`。
- 调用官方 `hermes chat --resume <id> --provider custom --model big-pickle --toolsets '' --max-turns 1 --run-budget 110 --oneshot --format stream-json -q <无答案提示>`。
- 配置禁用应用重试、自动恢复及 fallback，CLI toolsets 为空；外部代理另有真正上游请求数上限。
- 结果：1 个上游 POST，HTTP 403；原生 CLI 退出码 1；原始历史前缀不变，只有新用户问题与客户端失败说明追加。失败说明不能冒充模型回复。新 HOME 中 sessions 数量仍为 1。
- 模型用量：供应商未返回 usage；Hermes 客户端报告输入/输出 0。没有成功模型响应。

初版计数代理将 Hermes 的本地 `/api/show` 元数据探测误算成模型额度，因而没有放行任何上游请求。修复后只计算真实上游 POST；该元数据探测仍由本地拒绝，没有转发。此准备故障单独保留，不能算供应商拒绝或第二次模型调用。

## OpenClaw 2026.9.6 / schema 23

- 使用保留的实际 OpenClaw SQLite 来源解析所得 `document.json`，通过本工作树已编译的公开 `prepare_native_import(OpenClaw, ...)` 生成新目标载荷与 expected。
- 目标数据目录由先前官方 schema 23 合成 fixture 的 SQLite backup 创建；没有复制用户数据。新操作 UUID：`469d4e54-4d80-4ab3-b495-7ba2669dafb4`。
- 从生产 `native_import/openclaw.rs` 读取原样 BRIDGE，使用它执行原生导入；第二个独立进程回读，全部事件与生产载荷精确一致。没有自写 SQL 插入会话或跳过 schema 校验。
- 原生执行：`openclaw agent --local --session-key agent:main:agentkib:469d4e54-4d80-4ab3-b495-7ba2669dafb4 --model zenfree/big-pickle --thinking off --timeout 110 --json --message <无答案提示>`。
- 配置唯一模型、空 fallback、`tools.deny=["*"]`，没有外部频道 deliver。`zenfree` 为隔离配置中的 OpenAI-compatible provider 名称，实际唯一上游是已核验的官方 Zen 地址。
- 结果：1 个上游 POST，HTTP 403；原生 CLI 退出码 1，保存 `stopReason:error`、`errorType:FreeTierError`。导入事件前缀保持逐对象相等；新目标 UUID 对应会话对象数仍为 1，未额外创建会话。
- 模型用量：供应商未返回 usage；原生失败事件字段记录 0，不能作为成功推理用量。

准备阶段曾选到上一轮故意把 `PRAGMA user_version` 改为 24 的负例 fixture，生产 BRIDGE 正确拒绝，且没有模型请求。随后改用未损坏的 schema 23 合成 fixture；没有放宽 gate 或修写原 fixture。

## 来源保护与重启读取

最终两用例完成后，manifest 中保留的实际来源文件 SHA256 均不变。两目标重新打开 SQLite，导入历史前缀未改变；该读取验证在各自模型进程退出后执行。目标的正常错误事件或失败说明保留，没有清理现场。

## 产物与实际命令

临时根：`/tmp/agentkib-free-native-2026-09-28/`。

```sh
/tmp/agentkib-interop-tools/hermes-env/bin/python \
  /tmp/agentkib-free-native-2026-09-28/hermes-case-live.py
/tmp/agentkib-interop-tools/hermes-env/bin/python \
  /tmp/agentkib-free-native-2026-09-28/openclaw-case-live.py
```

结果目录 `hermes-case-live/`、`openclaw-case-live/` 中均保留：`attempt.json`、`import.log`、`request.json`、`response.headers`、`response.body`、`resume.log`、`result.json`、`request-checks.json`。文件均仅涉及合成数据及公开匿名占位，没有用户凭据。

## 其他免费路径的调查边界

Hermes 同版源码包含 Nous `nous/welcome` 免费层，但它仍是默认关闭的集成期功能，依赖 deployment secret；启用流程会 `POST /api/anonymous/create` 创建 identity。没有尝试获取部署密钥、强开集成开关、创建匿名帐号或迁移其 token 给 OpenClaw。当前没有找到已验证、公开开放、无需现有授权且可供这两个第三方客户端使用的替代免费官方模型；不据此声称所有免费服务都不可用。
