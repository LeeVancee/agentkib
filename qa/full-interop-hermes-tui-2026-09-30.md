# Hermes 原生历史界面补验 — 2026-09-30

固定 Hermes `0.21.5` / tag `v2026.9.24`，既有 `hermes-rpc` 的同一原生 session `20260930_213422_565847`。此前空配置停留在 setup，因此没有把初次 TUI 记为通过。

本次只在隔离进程设置 `OPENAI_BASE_URL=http://127.0.0.1:9/v1`；没有填写假 key，没有选择远端 provider。通过 macOS `/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)'` 启动固定 CLI `--profile default --resume <id>`，操作系统拒绝网络。识别官方 `Set up a provider now? [Y/n]:` 后仅回答 `n`，不发送模型 prompt。

两个独立 PTY 进程均实际绘制出 marker `AKIB-bebf7d4c9f714bbcbd` 和完整项目决定 `append-only SQLite WAL with namespace cobalt-lake`。两次恢复没有重新导入。自有进程组 PID 96910、97283 收到 SIGTERM 后未在 3 秒内退出，已定向 SIGKILL 并 wait 回收，未处理其他进程。

完成后再次运行 `python3 qa/probes/interop_native_readback.py <hermes-rpc>`：完整原生消息角色/正文与预览投影一致、原始来源 SHA 不变、目标仍 1 个、同 ID 与原 operation 回执有效。

可复现脚本：`qa/probes/hermes-offline-tui.py`。实际本轮先执行了私有证据目录中的同内容 runner，随后提取为参数化脚本；没有为提取脚本再次启动目标。日志位于 `~/Documents/AgentKib-archives/2026-09-30/native-interop/hermes-rpc/native-tui-offline-{0,1}.ansi`，汇总 `native-tui-offline-result.json`，独立回读 `independent-verification.json`。本次仅关闭历史界面显示和进程重启恢复的缺口，**没有模型调用，不提升真实回复互通等级**。
