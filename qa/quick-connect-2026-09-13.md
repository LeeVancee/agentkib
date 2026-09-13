# 快速连接入口验收

本轮将快速弹窗独立为 QuickConnect；完整远程设置继续使用原管理组件。未改变网络接口或授权。

## 代码检查

- `pnpm --filter @agentkib/desktop exec vitest run src/features/remote`：8 文件、110 项通过，含快速弹窗及完整设置回归。
- `pnpm --filter @agentkib/desktop typecheck`：通过。
- `pnpm --filter @agentkib/desktop build:web`：通过。
- 相关文件 oxfmt、QuickConnect oxlint、git diff --check：通过。
- React Compiler 对 try/finally 等代码发出跳过优化警告；构建成功，未通过改变错误语义消除警告。

## 浏览器检查

使用临时 Vite 页面挂载真实 RemoteConnectionPanel，并注入模拟 remote-store 数据；页面已移除，未调用真实发现或配对接口。

- Chromium 1360×860：浅色空状态、480px 弹窗。
- Chromium 390×844：深色手动表单、浅色 12 设备列表、长名称换行、内部滚动。
- 点击第三个设备后配对码自动获得焦点；返回后实测 activeElement 的稳定入口键为 discover:2。
- 截图：output/playwright/quick-connect-light.png、quick-connect-narrow-form.png、quick-connect-narrow-list-light.png。
- 等待恢复、拒绝、过期、重复提交和关闭后异步结果由组件测试覆盖。

## 限制

未进行真实跨设备配对、安装版 Electron 或 Safari 验收。此次前端预览不代表已安装 v0.11.0 已更新。无提交、推送、部署或发布。

## PR #72 修复复验

- CI 失败来自 `ui-source-constraints.test.ts`：设备行直接使用原生 button。已改用共享 Button，保留整行点击、长名称换行和稳定焦点标识；未放宽约束测试。
- Review 评论 3998258877：成功删除待确认主机时同步清理匹配 pairing。删除失败、其他主机及 disconnect 不清理；新增回归验证删除完成前保留、完成后清除以及旧状态回执不能恢复。
- 全量 `pnpm test`、`pnpm typecheck`、`pnpm build` 通过；相关格式、lint 和 diff 检查通过。真实设备未追加测试。
