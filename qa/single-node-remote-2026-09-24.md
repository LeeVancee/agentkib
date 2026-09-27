# 单节点远控完善验收 — 2026-09-24

本轮在现有未提交实现上增量完善，保留工作区已有改动；没有 commit、push、发布或部署公网服务。此处记录客户端检查及与托管服务的集成验收摘要；服务端实现和运维资料不包含在本仓库中。

## 实现范围

- 默认 API `remote.agentkib.com`，连接器 `tunnel.remote.agentkib.com`；设备域名位于 `control.remote.agentkib.com` / `preview.remote.agentkib.com`。单节点 v2 描述和传输生命周期接口已保留，不包含多节点调度。
- 构建校验并内置 frpc 0.68.0，包含许可证；现有各平台 CI staging 已接入，Web 构建产物同步打包。本机 Rust CSR 替代桌面 OpenSSL 调用，私钥不上传。
- 注册先持久化 request ID / credential，再请求；响应丢失可恢复，显式重新登记成功前保留原文件。服务端只保存哈希，JSON 事务写入成功才发布内存状态；包含迁移、备份及写失败封闭鉴权。
- 控制与预览分别使用 frpc、固定目标 TLS listener。20 秒刷新 / 最长 60 秒租约，按请求起点计算，单调时钟加墙钟防超期；撤销、到期、休眠销毁公网 sockets，迟到结果不能复活连接。保留仍有效证书并重试续期。
- Follower / managed 共用持久回执，按配对设备查询。浏览器 sessionStorage 只保存按主机和设备隔离的 pending 标识；刷新不重发，未知结果不凭 idle 或手动确认解锁。审批 accepted 不等于原生 resolved。
- 预览合计默认 2 MiB/s；大文件最多 8 路、每设备 4 路，所有预览请求另有 64 / 16 上限，避免小文件堆积。取消释放排队名额；HTML 快照和普通文件都周期复核授权。续票暂时失败保留有效 URL，到期停止；恢复播放位置并拒绝混合文件版本。
- 拦截 agent 私有根、Git/SSH/云凭证目录和 AgentKib 私有数据目录；Codex worktrees 下已授权项目仍可浏览。回执查询沿用原控制的权限边界，避免 follower 请求可执行但无法查询回执。

## 自动化检查

| 范围 | 实际结果 |
| --- | --- |
| `cargo test -p agentkib-codex-bridge -p agentkib-remote -p agentkib-runtime` | bridge 46、remote 23、runtime 143、stdio 1 通过；后续私有根调整的 diff 专项 2 项通过 |
| 原生 Codex 双 CLI 离线 fixture | 原策略、client message ID、writer 冲突、释放后相同 ID 恢复及历史检查通过；模型由隔离本地 fixture 提供 |
| `pnpm --dir apps/web test` | 12 文件、112 项通过，含 pending、创建恢复、续票和播放位置 |
| 桌面 service / LAN / capabilities / settings | 4 文件、91 项通过，含回执设备隔离、权限、撤销竞态、新增参数集成 |
| `artifacts.test.ts` | 30 项通过，含小文件排队上限、HTML 快照授权撤销、Range、版本变化、根目录与链接边界 |
| `relay/manager.test.ts` | 16 项通过，含授权单飞/挂起/迟到、回拨、重登记恢复、双通道、持续流撤销、续期和休眠恢复 |
| `stage-frpc.test.mjs` | 官方归档目标选择及篡改校验拒绝通过；本机真实官方归档 staging 成功 |
| TypeScript、Web/Desktop/Electron build | 通过；Rust release 构建通过 |
| 后端默认测试 | 17 通过，2 个需要显式环境的集成测试默认跳过；两类真实集成另行执行通过 |
| 后端真实双 frpc/frps | WSS、独立双域 HTTPS 206、计数器、撤销后新连接拒绝通过 |
| 完整本地 Compose | HAProxy → Caddy PROXY protocol → broker/frps → 双 frpc 实际链路通过，含独立来源预算及伪造 HTTP 头不能绕过限流 |

服务端集成测试在内部测试环境执行，其部署和复现配置不随本仓库提供。临时测试项目只绑定 loopback，容器、网络及卷已清理。

## 传输实测

### 本机文件服务（不含公网或丢包）

`artifacts-streaming.test.ts` 使用 512 MiB 与 8 GiB 稀疏文件，各执行两路并发 Range、合计读取 8 MiB，同时测独立控制端口响应。

| 文件总大小 | 读取耗时 | 同一 Node 测试进程 RSS 峰值增量 | 控制 P95 |
| --- | --- | --- | --- |
| 512 MiB | 3.910s | 34.50 MiB | 1.79ms |
| 8 GiB | 4.019s | 3.91 MiB | 2.07ms |

RSS 包含同进程 HTTP 客户端、服务端及 GC 影响，不是服务端单独常驻内存，也不代表完整下载 8 GiB。检查的是相同读取量下内存不按源文件总大小分配，以及两路共享约 2 MiB/s 的预算。[原始结果](single-node-streaming-2026-09-24.json)

复现：

```sh
AGENTKIB_STREAM_BENCHMARK_OUTPUT="$PWD/qa/single-node-streaming-2026-09-24.json" \
pnpm --dir apps/desktop exec vitest run electron/main/web/artifacts-streaming.test.ts
```

### 本机 TLS 延迟与断流

媒体 TCP 转发每块延迟 80ms，512 KiB 内容在 48,957 字节处主动断开，再以 206 续传 475,331 字节，字节总数正确。并行 3 次控制请求最大 4ms，SSE 收到 25 条。这是实际 loopback TLS/HTTP 和 TCP 转发测试，不能称为内核丢包或真实 Codex 执行。

### Linux 内核丢包

完整 Compose 测试在两个临时 Linux connector 容器上，仅对到测试网关 TCP 443 的出站包施加 80ms 延迟和 1% 随机丢包。临时使用 NET_ADMIN / iproute2，生产部署未增加这些权限或依赖。

- 20 次控制请求：P50 173ms，P95 277ms。
- 4 MiB Range：16.134s，约 0.25 MiB/s；SSE 20/20。
- `tc` 实际丢包：控制 3 个、预览 18 个。
- 控制 connector 重启：858ms 后探测恢复。

这是一次仿真，不是 SLA；尤其视频在 TCP 丢包下仍有明显吞吐损失，独立通道不能消除运营商带宽瓶颈。

## 本机打包

使用 `electron-builder --dir --mac --arm64 --publish never --config.mac.identity=-` 生成本地 ad-hoc `.app`，不是签名公证的正式发布。`smoke-remote-package.mjs` 在临时独立 Electron / runtime 数据目录验证内置 frpc 版本、许可证、Web 文件、真实 bundled Rust CSR RPC，并启动应用直到 `home-data-ready` 后自动退出。

复现（先完成常规构建和 staging）：

```sh
node apps/desktop/scripts/smoke-remote-package.mjs \
  apps/desktop/release-electron/mac-arm64/AgentKib.app \
  qa/single-node-package-2026-09-24.json
```

[打包冒烟原始结果](single-node-package-2026-09-24.json)。本机仅验证 macOS arm64；其他平台已接入构建流程，但未在此主机执行。

## 未完成的环境验收

- 用户尚未确定 VPS：真实 DNS / HTTP-01、生产 CA 信任链、实际续期及公网跨网络访问未验证。
- iPhone Safari、Android Chrome 真实发送/审批/问答、视频拖动、HTML 相对资源、下载、Wi-Fi/蜂窝切换尚待真机。
- 当前官方 Codex Desktop 的真实 follower 交互仍需独立验收；离线 writer fixture 不替代它。
- 实际 macOS 休眠/唤醒依赖电源事件的场景尚待实机操作；自动化已验证 suspend/resume 生命周期。
- 中国电信、联通、移动与晚高峰线路需要对最终 VPS 测量。

预览 URL 是短效 bearer 凭证；电脑授权租约只约束正常 AgentKib，不宣称能强制关闭恶意修改客户端的所有旧连接。正常转发中业务 TLS 在电脑终止，仍依赖标准域名/DNS/CA 信任。
