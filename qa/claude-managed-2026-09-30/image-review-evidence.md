# DeepSeek 图片验收独立调查

调查日期：2026-09-30。仅只读本机记录、二进制和公开官方源码；未调用模型、未修改配置或凭据。

## 确定证据

- 原生实测使用 Claude Code 2.1.285、deepseek-v4-pro；会话正常完成，文本文件中的随机标记与项目决策回复正确，图片颜色断言失败。证据：同目录 results.json。
- 上传附件与原生 Claude JSONL 中 image/png 的解码字节完全一致：95 bytes，SHA256 `4f53aad3f14de29b6627045fd1da8db81ddb354fdeab573f675a77e350bc7c96`。PNG 为 32×32、8 bit RGB；IHDR/IDAT/IEND CRC 均正确，IDAT 可正常解压为 3104 bytes。因此 AgentKib 至 Claude 原生历史之间没有丢弃或破坏图片。
- 原生回复明确表示图片是 `[Unsupported Image]`。本机 Claude Code 二进制没有这个字面量；本机 CC Switch 3.20.4 二进制包含精确字面量以及媒体回退相关符号。
- CC Switch 只读数据库显示本次会话 provider 为 DeepSeek，apiFormat 为 anthropic，三条记录的请求及上游模型均为 deepseek-v4-pro，记录的最终 HTTP 状态均为 200。这只能证明最终请求成功，不能证明图片送达模型。
- 本次 provider 的 settings_config 只有 env，没有显式 modelCatalog/modalities。未输出任何 env 值或凭据。
- DeepSeek 当前官方模型文档明确给出 deepseek-v4-pro 的 input_modalities=[text]；deepseek-flash 为 [text,image]。Vision 文档提供 deepseek-flash 的 Anthropic image/source 输入示例。

## 代理定位与证据限制

固定 CC Switch v3.20.4 源码 media_sanitizer.rs 第 10 行定义相同占位符。19–39 行实现针对声明纯文本模型的图片替换；51–108 行识别上游 400/415/422/501 的图片不支持错误；170–179 行将 image block 替换为文本占位符。model_capabilities.rs 第 62–75 行明确 V4 Pro 不在全局名称推测名单中，第一方预设可显式声明纯文本。

综合本地字节证据、模型官方能力和代理源码，故障位于 CLI 后方的代理/供应商能力链路，最符合 CC Switch 媒体回退。由于该 provider 无显式模态声明，响应式回退比主动名称推测更吻合；但没有本次逐跳请求体或回退事件日志，不能将具体分支视为已抓包证实。二进制不存在字面量也不能单独证明 CLI 没有任何图片转换。

## 验收方式

- 保持当前 deepseek-v4-pro 的结果为：文本、普通文件和原生图片传输成立；模型识图未通过，原因有供应商能力证据。
- 如用户明确选择支持图片的模型，可在独立一次性合成用例中验证，例如同渠道 deepseek-flash；不得自动改模型、关闭代理回退或重试原目录。
- 新用例仍须验证上传与原生历史图片哈希、只存在于像素中的随机内容、最终真实回复，以及实际模型和用量。HTTP 200、图片出现在日志、模型泛泛声称看见图片均不足以单独通过。

## 官方来源

- https://api-docs.deepseek.com/api/list-models/
- https://api-docs.deepseek.com/guides/vision/
- https://github.com/farion1231/cc-switch/blob/v3.20.4/src-tauri/src/proxy/media_sanitizer.rs
- https://github.com/farion1231/cc-switch/blob/v3.20.4/src-tauri/src/model_capabilities.rs
- https://github.com/farion1231/cc-switch/blob/main/docs/release-notes/v3.20.4-en.md
