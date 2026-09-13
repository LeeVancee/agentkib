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
