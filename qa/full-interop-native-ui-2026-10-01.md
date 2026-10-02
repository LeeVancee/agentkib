# 离线原生界面与恢复补验 — 2026-10-01

HEAD `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，沿用 dirty 的 `main-acceptance-20260930/agentkib`。本次不重新导入，仅打开9月30日已完成公开Runtime交接的原生目标，补齐原生历史界面和进程重启后的恢复证据。没有真实模型提示或登录。

## 实际通过范围

| 合成原生来源 | OpenCode 1.18.32 | Hermes 0.21.5 |
| --- | --- | --- |
| Codex rollout / SQLite | 两次独立TUI恢复通过 | 两次独立TUI恢复通过 |
| Grok Build JSONL | 通过 | 通过 |
| Hermes JSONL | 通过 | 通过 |
| Cursor固定版本blob SQLite | 通过 | 通过 |
| OpenCode官方import创建的来源 | 通过 | 通过 |
| OpenClaw 2026.9.6 SQLite | 通过 | 通过 |

共12个已有公开方向、24次独立原生TUI进程。每次按计划中的既有ID恢复，PTY实际输出该用例唯一marker及完整项目决定。每个case在两次TUI之前和之后独立回读完整角色、顺序与正文，严格等于冻结预览投影；核对来源字节或官方来源导出/事件、操作回执和唯一目标数量。自身导入自身保留原来源ID，不能把来源加目标两条误判为重复导入。

主代理另从24份原始ANSI和前后原生回读重新逐条检查，核对命令末尾ID、版本、所有自有PGID均已消失；汇总 `independent-12-directions-audit.json`。该补验不增加原先35个公开方向的计数，也不证明12个方向的真实模型上下文继承。历史仅含两轮纯文本，不能外推历史工具、附件本体或长历史的原生界面验收。

Claude来源到上述两个目标的先前原生界面证据仍见9月30日专项；本次没有重跑或改写其结果。Codex的app-server回读、OpenClaw目标、Claude目标和Antigravity来源的边界分别保留，不由本表代替。

## 执行与隔离

```text
python3 qa/probes/native-offline-tui.py <existing-case> <new-evidence-directory>
# runner实际运行的原生命令：
sandbox-exec -p '(version 1)(allow default)(deny network*)' <opencode> --session <existing-id>
sandbox-exec -p '(version 1)(allow default)(deny network*)' <hermes> --profile default --resume <existing-id>
```

来源目录为旧档案 `2026-09-30/full-interop/<source>-to-<target>`，Codex→Hermes使用已成功的 `codex-to-hermes-no-update`。新证据在 `~/Documents/AgentKib-archives/2026-10-01/offline-native-ui/{OpenCode,Hermes}/`，新目录0700且禁止覆盖。

所有原生TUI、版本查询及整个Python独立回读子进程均由OS禁止全部网络；回读启动的来源export子进程继承该限制。监督器只做PTY、证据写入及自有进程检查，放在沙箱外以可靠执行Darwin进程清理。原生进程只接收已核对的隔离HOME/状态路径及白名单环境，没有用户凭据；版本输出必须与导入计划及固定版本同时相等。

OpenCode没有发送任何键盘输入。Hermes仅在精确识别官方同步setup问题后发送一次 `n\n` 拒绝配置，随后不发送prompt。单次TUI最多25秒、输出上限2MiB，退出前清理自行创建的完整进程组，即使leader先退出也检查后代。前后回读各有45秒上限。

## 失败与脚本修复

Hermes首case两次未进入TUI的监督器失败原记录保留：完整监督器沙箱内无法运行 `ps`；随后发现须先reap已退出leader再检查PGID。修复后才以新证据目录运行原生恢复，没有重发任何模型请求。遇到Darwin `killpg(..., 0)` 的EPERM不能视为进程不存在；现在通过受控 `ps` 数字PGID快照核对，无法核验即失败。

独立审查另发现清理期间 `SIG_IGN` 会丢失首次取消。已改为保留首次取消、完成清理和证据保存后报失败，补测leader先退出、后代忽略TERM、输出上限、重复信号及清理期间首次取消。成功TUI用例未收到取消，不因这项监督器修复重跑原生流程。

可复现自检 `python3 qa/probes/native-offline-tui-selftest.py <new-evidence-directory>` 已执行一次，3项通过：leader先退出仍清理忽略TERM的后代、实际活跃输出达到2MiB被截断、清理开始后首次SIGTERM及随后SIGINT均被记录且取消不丢失。所有假CLI是禁网本地Python，未启动Agent或模型；证据 `offline-native-ui/native-lifecycle-selftest-1/result.json`。自检源码SHA256 `2fafc47b77c8817a45c3a5d8ef908627840b836b52f303d5775d02b2e8bb208e`。

最终脚本SHA256为 `0d82ceef5bf83fa288de6f5355828f71693a1ce6e3156db3c01b5bc478bf4d99`，独立子代理复核无剩余确定阻断问题。运行中后加入每case源码快照功能，因此早期case没有启动时脚本哈希证明；历史源码快照和执行时间线保留，推断记录明确标识，不用最终SHA冒充所有历史case的执行身份。CLI版本则各case均实际核验。

`interop_native_readback.verify` 仅新增可选evidence_dir，把追加回读产物写入新目录；旧默认调用行为不变。语法及原有三项负例自检通过。本次无产品源码、依赖或协议变更，不需要重跑前端构建。未提交、推送、部署或发布。

## Grok → Claude Code 原生恢复

同一个公开交接目标 UUID `8002b131-73ca-409b-8dd6-172a540a1e23` 使用用户已有、未修改的 Claude Code `2.1.285` 二进制，SHA256 `51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4`。原生子进程禁网，使用隔离HOME、空白名单环境及官方 `--bare --safe-mode --setting-sources '' --settings '{}' --strict-mcp-config --tools '' --no-chrome --resume <UUID>`；官方bare帮助明确跳过keychain/OAuth读取。未传入prompt、凭据或print参数。

此前探测通过实际界面完成主题与安全提示；首次成功恢复确认合成工作区信任，没有登录选择；第二次独立恢复零输入。两次均展示导入说明、用户和助手的完整正文及角色顺序，包括该用例随机标记与完整项目决定。第一次原生CLI追加83字节的同UUID空 `atis-latch` 元记录；原1883字节生产载荷前缀逐字节未变。第二次文件全SHA不变，无新增用户/助手消息，来源与原始元数据SHA、唯一目标均保持。自有PGID `72115`、`90240` 已退出。

证据为 `offline-native-ui/claude-onboarding-grok-v3/`、`claude-grok-restart/` 和主代理独立核对的 `independent-grok-claude-audit.json`。第二次CLI提示前次fullscreen renderer未完成启动并采用classic renderer；因此不宣称两个renderer均完整启动。两次ANSI尾部均有一个截断UTF-8字符，原始字节保留；完整目标正文另行逐条核对均可见，不能把宽松解码当正文忽略规则。此前停在主题、安全说明或错误选择退出的探测均保留，不计成功，也没有模型请求。

本项仅证明Grok→Claude这一既有纯文本方向的原生历史显示和同UUID重启恢复，不提升真实回复、工具或附件验收状态。

## 其余六来源 → Claude Code

Claude、Codex、Cursor固定blob、Hermes JSONL、OpenCode、OpenClaw SQLite 六个剩余来源各完成两次同UUID独立禁网TUI恢复，6方向全部通过。首轮只发送实际当前屏幕显示的主题、安全提示及合成工作区信任操作，第二轮均零输入。每个当前屏幕完整展示notice、用户和助手正文及角色顺序，不发送prompt或登录。

新执行器 `claude-offline-tui.py` 经一次独立审查和一轮最小修复：纠正alternate screen切换及cursor恢复、未完成控制/UTF-8/同步帧时禁止判定或输入、清理期间取消推翻成功并阻止第二次启动。离线历史ANSI回放、屏幕/后缀负例及取消mock通过；复核后仅执行这一轮六例。最终SHA256 `4d05191a0107149e4b7e5f2e420d44f4a0fed548fc91796efaea09158221b741`，各例启动时保存执行器与清理助手源码。

源文件与元数据SHA、原生产载荷字节前缀和启动前完整日志前缀均不变，新增后缀只允许同UUID空atis-latch，0新增user/assistant。自分叉保留来源与新目标两个文件，其余case仅一个目标。Codex旧403例冻结包含既有失败回合的完整16767字节baseline并核对失败回执，既有失败原文不删除、不重发，也不改成真实回复通过。

证据 `offline-native-ui/claude-remaining-once/batch-results.json`、`independent-final-audit.json`，主代理又从12份原始ANSI重放当前屏幕、逐条正文/角色、输入前帧、来源/日志哈希及外部ps独立核对，保存 `root-independent-audit.json`。12份新日志均无未完UTF-8尾；12个自有PGID全部退出。连同Grok方向，七个已有来源到Claude的离线原生恢复证据已齐。

## OpenClaw 六个方向：列表通过、双TUI阻塞

固定 OpenClaw `2026.9.6 (eb377ac)`、隔离 Node `v26.9.0`。Codex、Grok、Hermes JSONL、Cursor固定blob、OpenCode、OpenClaw SQLite 六个已有目标均由官方 `sessions list --agent main --limit all --json` 在两个独立禁网进程中识别，目标ID恰好各1个；普通case总6个会话，自己到自己保留来源，总7个。列表前后完整角色/正文、来源与操作回执核对通过。证据 `OpenClaw/official-session-list-summary.json`，不等同于完整TUI重启。

本地TUI命令 `tui --local --session <official-session-key> --history-limit 1000` 不传message、零输入，子进程禁网。首Codex case的旧runner只等marker/decision，过早停止，助手正文缺失；旧result仍保存，其原passed已由 `codex-first-attempt-independent-audit.json` 明确降级。只做一轮最小修复：等待末条助手全文、逐条校验角色样式及全文顺序、精确版本、窄化原生元数据变化；Codex只执行一次针对性复验，其余五例首次运行。

修复后六例均在完整历史输出后因原始PTY尾部单字节 `e2` 截断UTF-8而严格解码失败；每例只启动一次TUI，第二次未执行。执行器结果全部失败，双TUI方向通过数0/6。遵守用户一轮修复上限，保留已知执行器缺陷，不再修改或重跑，不将其解释为目标正文损坏。

只读审查原始字节有效前缀，六例均能逐字核对notice、用户与助手正文及順序。TUI无字面role标签；固定renderer按官方role分别使用用户背景色与助手组件，样式和官方原生投影共同佐证角色，不外推其他主题/版本。原始尾字节及文件完整SHA保持不变，不覆盖日志或宽松忽略正文。

每例前后SQLite backup只作证据，不作为运行目标。所有agent数据库表逐行不变，源和完整目标事件不变；state仅有精确 `tui.lastSession.<scopehash>` 指向同sessionKey行的更新时间戳变化，其他表/行/schema及隔离配置SHA均不变。所有自有PGID已退出。汇总 `OpenClaw/openclaw-offline-completion-summary.json`，主代理另核对原始全文/角色、backup全表行及进程，见 `root-independent-tui-audit.json`。

本节结果为官方列表/全文回读/身份/来源保护通过、单次原生全文可见、双TUI恢复阻塞。没有模型或登录请求，不提升完整原生互通等级。
