# v15 A 批颜色静态验证记录（2026-10-21）

## 依据和边界

本记录对应 A 批的颜色修改，基线为 `5839d16694f2347dc10883e3654d9f38314d9815`。依据本机只读设计交接及规范板；没有修改或复制 `designs/` 中的文件。其他主题不达标项也纳入本批，已达标的独立角色保留。

以下数据来自最终 CSS 的静态解析和计算，**不是 Chromium computed style、实际截图或真实用户数据的验收结论**。真实浏览器结果和页面截图由本批主 QA 单独记录。

实现和可复跑依据：

- `apps/desktop/src/styles.css`、`apps/web/src/style.css`：主题角色与透明背景。
- `apps/desktop/src/core/theme-contrast.test.ts`：读取两个 CSS，计算 sRGB / OKLCH、透明叠色和 WCAG 对比度。
- 两端 Button / Badge 及共享会话组件：引用文字、图标和背景各自的语义色。

## 计算规则

- 小字和普通正文统一采用 **4.5:1** 的文字对比度阈值，不按大字放宽。
- 对 `background`、`card`、`muted`、`sidebar` 及存在时的 `popover` 分别计算；表中最低值是这些底面的最差结果，不代表只测页面白底。
- 透明背景先与实际底面叠色，再计算文字亮度；包括 10% 品牌浅底、危险按钮正常/悬停背景、Web 危险控件和徽标。
- 使用 sRGB 线性亮度公式；OKLCH 转换到 sRGB 后计算。本算法的转换、色域与浏览器实际绘制仍需 computed style 交叉验证，不能用本表替代真实浏览器证据。
- 本轮没有在真实浏览器重跑基线悬停状态，所以“修改前”是基线 CSS 声明的静态模型，不声称覆盖旧版本所有样式优先级。

表中 `P` 表示该主题当前 `--primary`，`D` 表示当前 `--destructive`。`亮(x, n%)` = `color-mix(in srgb, x n%, white)`，`暗(x, n%)` = `color-mix(in srgb, x n%, black)`；百分比是**保留原色**的比例。通过原色与黑/白混合保留各主题的颜色风格，而不是给其他主题套用 VTRON。

## 文字颜色前后值

### 桌面 10 套主题

| 主题 | 原主色文字 | 新主色文字 | 原次要文字 | 新次要文字 | 原危险文字 | 新危险文字 |
|---|---|---|---|---|---|---|
| VTRON / 浅 | `#2e67ff` | `#285ae0` | `#0e142b` | `#626a7e` | `#ff6c35` | `#bd3a48` |
| VTRON / 深 | `#2b65ff` | `亮(P, 65%)` | `#7b7e8c` | `亮(#7b7e8c, 92%)` | `#ff6c35` | `亮(D, 70%)` |
| Minimal Neutral / 浅 | `oklch(0.205 0 0)` | 保留 | `oklch(0.556 0 0)` | `#666666` | `oklch(0.577 0.245 27.325)` | `暗(D, 60%)` |
| Minimal Neutral / 深 | `oklch(0.922 0 0)` | 保留 | `oklch(0.708 0 0)` | 保留 | `oklch(0.704 0.191 22.216)` | `亮(D, 65%)` |
| Claude / 浅 | `oklch(0.6171 0.1375 39.0427)` | `暗(P, 75%)` | `oklch(0.6059 0.0075 97.4233)` | `oklch(0.5 0.0075 97.4233)` | `oklch(0.1908 0.002 106.5859)` | 保留 |
| Claude / 深 | `oklch(0.6724 0.1308 38.7559)` | `亮(P, 70%)` | `oklch(0.7713 0.0169 99.0657)` | 保留 | `oklch(0.6368 0.2078 25.3313)` | `亮(D, 50%)` |
| Sakura / 浅 | `#ff7ea5` | `暗(P, 60%)` | `#a18e84` | `暗(#a18e84, 75%)` | `#e5484d` | `暗(D, 60%)` |
| Sakura / 深 | `#ff7ea5` | 保留 | `#a18e84` | 保留 | `#e5484d` | `亮(D, 55%)` |
| Ocean Breeze / 浅 | `#22c55e` | `暗(P, 60%)` | `#6b7280` | `暗(#6b7280, 95%)` | `#ef4444` | `暗(D, 60%)` |
| Ocean Breeze / 深 | `#34d399` | 保留 | `#6b7280` | `亮(#6b7280, 65%)` | `#ef4444` | `亮(D, 60%)` |

VTRON 浅色指定值：`--primary` 和其主要按钮悬停仍为 `#2e67ff`；`--primary-text` 为 `#285ae0`；`--muted-foreground` 为 `#626a7e`；危险文字和危险背景为 `#bd3a48`，图标继续为 `#ff6c35`。Claude 浅色次要文字只将原 OKLCH 的 L 从 `0.6059` 改为 `0.5`，C、H 保留。

### Web 6 套主题

表中的“默认（界面蓝色）”对应界面中的蓝色（`blue`）选项。静态测试内部使用 `neutral` 指代 CSS 默认分支，不代表界面存在 Neutral 选项，也没有新增主题。

| 主题 | 主色文字 | 次要文字 | 危险文字 |
|---|---|---|---|
| 默认（界面蓝色） / 浅 | 保留 `#242427` | `#71717a` → `#6b6b74` | `#c03943` → `#98262f` |
| 默认（界面蓝色） / 深 | 保留 `#f1f1f3` | 保留 `#a1a1ab` | 保留 `#ff919b` |
| Violet / 浅 | 保留 `#242427` | `#71717a` → `#6b6b74` | `#c03943` → `#98262f` |
| Violet / 深 | 保留 `#f1f1f3` | 保留 `#a1a1ab` | 保留 `#ff919b` |
| Green / 浅 | 保留 `#242427` | `#71717a` → `#6b6b74` | `#c03943` → `#98262f` |
| Green / 深 | 保留 `#f1f1f3` | 保留 `#a1a1ab` | 保留 `#ff919b` |

Web 保留自己的 Blue / Violet / Green 外观配色，没有新增或切换到 VTRON。Web 深色原危险文字 `#ff919b` 在实际 20% 菜单焦点底加 muted 面上达到 **4.677:1**，因此保持原色；没有用 Web 中不存在的 30% 焦点底作为改色理由。

## 静态组合的最低对比度

### 桌面文字和状态底

单位均为 `:1`。`accent` 列严格指 `accent-foreground / accent` 的菜单文字组合；它不等同于分段控件，后者另测 `primary-text / primary-selected-bg`。

| 主题 | 主色文字 / 普通底 | 主色文字 / 10% 浅底 | 次要文字 / 普通底 | 危险文字 / 普通底 | 危险按钮悬停文字 | accent 文字 |
|---|---|---|---|---|---|---|
| VTRON / 浅 | 4.471 → 5.544 | 3.923 → 4.865 | 17.440 → 5.182 | 2.701 → 5.209 | 2.208 → 4.510 | 4.666 → 5.787 |
| VTRON / 深 | 3.727 → 6.667 | 3.422 → 6.121 | 4.401 → 5.058 | 6.298 → 8.448 | 3.854 → 5.169 | 3.929 → 7.028 |
| Minimal Neutral / 浅 | 15.480（保留） | 12.663（保留） | 4.089 → 4.962 | 4.118 → 8.661 | 2.901 → 6.102 | 15.480（保留） |
| Minimal Neutral / 深 | 12.003（保留） | 9.145（保留） | 5.829（保留） | 5.226 → 7.458 | 3.277 → 4.676 | 9.951（保留） |
| Claude / 浅 | 3.215 → 5.148 | 2.893 → 4.633 | 3.174 → 4.941 | 15.196（保留） | 9.966（保留） | 12.158（保留） |
| Claude / 深 | 4.235 → 6.101 | 3.698 → 5.327 | 6.420（保留） | 3.513 → 6.678 | 2.556 → 4.859 | 15.967（保留） |
| Sakura / 浅 | 2.180 → 5.381 | 2.018 → 4.981 | 2.850 → 4.701 | 3.568 → 7.786 | 2.780 → 6.067 | 4.385 → 4.640 |
| Sakura / 深 | 6.335（保留） | 5.331（保留） | 4.847（保留） | 3.872 → 7.116 | 2.700 → 4.963 | 8.363（保留） |
| Ocean Breeze / 浅 | 1.986 → 4.961 | 1.845 → 4.609 | 4.213 → 4.578 | 3.280 → 7.259 | 2.546 → 5.636 | 9.089（保留） |
| Ocean Breeze / 深 | 7.610（保留） | 6.236（保留） | 3.026 → 5.805 | 3.887 → 6.415 | 2.830 → 4.670 | 4.022 → 4.990 |

VTRON 浅色规范组合另算：

| 前景 / 背景 | 修改后 |
|---|---:|
| `#285ae0` / `#ebf0ff` | 5.081 |
| `#285ae0` / `#fafafa` | 5.544 |
| `#285ae0` / `#ffffff` | 5.787 |
| `#626a7e` / `#fafafa` | 5.183 |
| `#bd3a48` / `#fcfcfc` | 5.299 |
| `#bd3a48` / 危险色 5% + `#fcfcfc` | 4.933 |
| `#bd3a48` / 危险色 10% + `#fcfcfc` | 4.584 |
| 白字 / `#bd3a48` 实底 | 5.437 |
| 白字 / `#2e67ff` 主按钮实底及悬停 | 4.666 |

### 桌面实底主按钮

| 主题 | 主按钮前景变化 | 正常态 | 悬停态最低值 |
|---|---|---|---|
| VTRON / 浅 | 保留 | 4.666（保留） | 3.369 → 4.666 |
| VTRON / 深 | 保留 | 4.764（保留） | 6.317（保留） |
| Minimal Neutral / 浅 | 保留 | 17.157（保留） | 9.116（保留） |
| Minimal Neutral / 深 | 保留 | 14.225（保留） | 9.153（保留） |
| Claude / 浅 | `oklch(1 0 0)` → `#181818` | 3.900 → 4.552 | 2.901 → 5.813 |
| Claude / 深 | `oklch(1 0 0)` → `#181818` | 3.122 → 5.687 | 4.083 → 6.426 |
| Sakura / 浅 | `#ffffff` → `#1a1412` | 2.392 → 7.616 | 2.016 → 8.847 |
| Sakura / 深 | 保留 | 7.616（保留） | 5.207（保留） |
| Ocean Breeze / 浅 | `#ffffff` → `#0f172a` | 2.279 → 7.835 | 1.961 → 8.846 |
| Ocean Breeze / 深 | 保留 | 9.286（保留） | 6.329（保留） |

- VTRON 浅色悬停取消原有 80% / 90% 透明造成的失标，仍使用原 `P`，没有把主色文字当按钮底色。
- Claude 深色 80% 悬停改为 `亮(P, 90%)`；其他原本达标的主按钮悬停计算保留。
- 不达标实底危险前景按主题改为深色：VTRON 深色 `#000000`、Minimal Neutral 深色 `#171717`、Claude 深色 `#181818`、Sakura 浅/深 `#1a1412`、Ocean 浅色 `#0f172a`；其他达标前景保留。
- 危险文字与危险底色分开，所以其他主题无需为了文字对比度一起改掉原危险背景/图标色。VTRON 浅色危险按钮为 5% 正常底、10% 悬停底；其他主题沿用原浅色 10% / 20%、深色 20% / 30% 背景，由独立危险文字色保证可读。

### Web 文字、accent 与真实危险控件

| 主题 | 主色文字 / 普通底 | 主色文字 / 10% 浅底 | 次要文字 / 普通底 | 危险文字 / 普通底 | accent 文字 |
|---|---|---|---|---|---|
| 默认（界面蓝色） / 浅 | 13.722（保留） | 11.359（保留） | 4.284 → 4.677 | 4.764 → 7.016 | 5.667（保留） |
| 默认（界面蓝色） / 深 | 13.177（保留） | 9.846（保留） | 5.805（保留） | 6.919（保留） | 7.656（保留） |
| Violet / 浅 | 13.722（保留） | 11.359（保留） | 4.284 → 4.677 | 4.764 → 7.016 | 4.982（保留） |
| Violet / 深 | 13.177（保留） | 9.846（保留） | 5.805（保留） | 6.919（保留） | 7.508（保留） |
| Green / 浅 | 13.722（保留） | 11.359（保留） | 4.284 → 4.677 | 4.764 → 7.016 | 4.849（保留） |
| Green / 深 | 13.177（保留） | 9.846（保留） | 5.805（保留） | 6.919（保留） | 7.710（保留） |

危险 Button 保留原白字外观：浅色实底、90% 悬停保持不变；深色只将原 60% 底改为 50%，悬停改为 45%。深色 Badge 同样使用 50% 底白字。没有改成全实底加深色字。

| 主题 | Button 正常态修改前 → 后 | Button 修改后悬停 |
|---|---|---:|
| 默认（界面蓝色） / 浅 | 5.374（保留） | 4.566 |
| 默认（界面蓝色） / 深 | 4.348 → 5.312 | 5.890 |
| Violet / 浅 | 5.374（保留） | 4.566 |
| Violet / 深 | 4.348 → 5.312 | 5.890 |
| Green / 浅 | 5.374（保留） | 4.566 |
| Green / 深 | 4.348 → 5.312 | 5.890 |

## 保留项、图标和禁用状态

- 主按钮基色、状态点和独立蓝色图标继续使用原主题 `primary`；图表填色没有随文字色替换。活动栏为纯图标导航，VTRON 使用原 `primary`，Sakura 浅色保留 `#b33e5d`，Ocean 深色保留 `#a1a1aa`。带文字的导航使用达标文字前景。
- VTRON 橙色 `#ff6c35` 只保留在图标角色，不再作危险文字或按钮文字。图标不作为本表 4.5:1 文字合格的证据；已有可访问名称和文字说明保留。
- `context`、首页、Quota 等独立图标块以及小箭头/折叠提示保留原颜色或装饰透明度；没有机械替换所有 `text-primary` / SVG。
- Metadata、时间、placeholder 等需要阅读的文字去掉造成失标的 `/60`、`/70` 二次透明度；蓝底用户消息中的可读元数据同样不再叠加文字透明度。
- disabled 状态与装饰图标不纳入“启用的普通正文”4.5:1 判定。没有为了通过测试删除 disabled、改变安全校验或让禁用按钮可操作。
- 原本已经达标的独立角色保留，例如 Minimal Neutral 主色文字、Sakura 深色主色/次要文字、Ocean 深色主色文字、Claude 浅色危险文字、Web 主色/深色次要及危险文字。对同一角色确有失败背景的情况才拆出独立文字色。

## 已运行的验证

运行使用项目原工具链；pnpm 版本切换问题通过临时 userconfig 的 `manage-package-manager-versions=false` 处理，没有修改依赖或锁文件。以下命令只省略该机器相关的临时环境前缀。

```sh
pnpm --filter @agentkib/desktop exec vitest run src/core/theme-contrast.test.ts src/core/theme.test.ts src/features/mcp/McpHubPage.test.tsx src/features/mcp/McpManagementActions.test.tsx src/features/skills/SkillManagerPanels.test.tsx
pnpm --filter @agentkib/web exec vitest run src/features/sessions/session-continuation.test.tsx
pnpm --filter @agentkib/desktop exec vitest run src/core/theme-contrast.test.ts src/components/AppSidebar.test.tsx
pnpm exec oxlint apps/desktop/src/core/theme-contrast.test.ts
pnpm exec oxfmt --check apps/desktop/src/core/theme-contrast.test.ts apps/desktop/src/styles.css apps/web/src/style.css apps/web/src/features/conversation/components/ui/button.tsx
git diff --check
```

- 桌面定向 5 文件 **231 项通过**，包括 91 个颜色回归。
- Web 续接 **45 项通过**。
- 颜色回归加 AppSidebar **107 项通过**。
- Web 危险控件最终 50% / 45% 方案加入同一静态回归后，91 项颜色测试再次通过；Web 45 项再次通过。
- 新测试 oxlint、相关文件 oxfmt、`git diff --check` 均通过。
- 上述测试命令有重叠，不将项数相加当成独立覆盖数。全量 typecheck、lint、format、桌面/Web 测试及真实浏览器结果以主 QA 为准。

## 真实浏览器证据

最终真实浏览器采样已完成：桌面 700、Web 420 个组合无失败；另有 32 个实际鼠标悬停状态、256 个文字样本无失败。四语页面、截图及最终全量结果详见 [主 QA](v15-a-terminology-colors-2026-10-21.md) 与对应 computed JSON。本分录的前后值表仍是静态模型，不把静态数据冒充浏览器绘制。

## 独立复核 P2 补修

本节记录独立复核确认的三处可读性遗漏；修复仅涉及文字颜色或透明度，没有改变权限模式、状态判断、诊断数据或操作能力。

- 双端权限告知的“先前检测到的模式”说明去掉 `opacity-80`。普通展示与 compact 展开后的完整解释使用同一可读前景；`bypassPermissions` 的危险色、模式判定、图标和四语说明均保留。双端既有测试覆盖四语、三个已知提示模式的普通/展开状态，并验证上一模式说明可见、不再叠加透明度。
- 双端 Tabs 未选中的启用标签改用独立 `text-tab-inactive-foreground`。仅不达标主题映射到次要文字色；原先达标的正文 60% 透明色保留（最终取舍见下节）。新增普通/line 两种变体的组件回归，验证未选中标签语义色、实际选中切换及面板内容、图标的隐藏语义；禁用标签的 `aria-disabled`、禁用外观和阻止选择均保留。
- 工作区诊断的“不适用”计数去掉 `opacity-75`；问题说明的 `opacity-80` 和预期/实际 hash 的 `opacity-75` 同时移除。回归使用合成诊断记录，验证计数和 hash 完整展示、无附加文字透明度，也不会因此开放自动修复。

定向验证：

```sh
pnpm --filter @agentkib/desktop exec vitest run src/features/sessions/conversation/features/sessions/permission-mode-notice.test.tsx src/components/ui/tabs.test.tsx src/features/workspace/WorkspaceDoctorPage.test.tsx src/core/theme-contrast.test.ts
pnpm --filter @agentkib/web exec vitest run src/features/sessions/claude-permission-mode.test.tsx src/features/sessions/conversation-tabs.test.tsx
```

结果：桌面 4 文件 **127 项通过**，Web 2 文件 **40 项通过**；原颜色静态回归 91 项仍通过。这些是组件行为与静态颜色验证，不声称已经完成三处页面的真实浏览器复验；实际 computed style 和全量检查由主 QA 记录。

## Tabs 最终取舍：已达标项不动

独立复核进一步确认：VTRON 和 Minimal Neutral 浅色原 `foreground / 60%` 已达到 4.5:1，统一替换成次要文字色会改变已经合格的外观。因此双端 Tabs 使用独立 `--tab-inactive-foreground`：

- 桌面浅色默认保留 `color-mix(in srgb, var(--foreground) 60%, transparent)`，VTRON 和 Minimal Neutral 的原 RGBA 值逐项相等。
- 只有 Claude、Sakura、Ocean Breeze 浅色原组合不达标，改为既有达标的 `muted-foreground`；Web 三种浅色原 60% 均失败，统一使用已有次要文字色。
- 深色保持原先的 `muted-foreground` 角色；某些深色比率提升来自本批已经必要调整的次要文字色，不另外给 Tabs 调色。
- 已选中前景、图标、禁用外观与禁用行为均不变。新增的两个精确 RGBA 回归专门防止将 VTRON / Minimal Neutral 浅色的已达标组合一起替换。

以下是同一组普通底面（含 sidebar）的静态最低值；因此 Ocean Breeze 浅色的最低值 3.162 比仅在 muted 底测到的 3.218 更低。它们不是截图像素或 computed style 数据。

| 平台 / 主题 | 未选中项修改前 → 后 | 最终处理 |
|---|---:|---|
| 桌面 / VTRON / 浅 | 4.722 → 4.722 | 原 60% RGBA 保留 |
| 桌面 / VTRON / 深 | 4.401 → 5.058 | 保留次要文字角色 |
| 桌面 / Minimal Neutral / 浅 | 5.011 → 5.011 | 原 60% RGBA 保留 |
| 桌面 / Minimal Neutral / 深 | 5.829 → 5.829 | 保留次要文字角色 |
| 桌面 / Claude / 浅 | 3.286 → 4.941 | 仅失败项使用次要文字色 |
| 桌面 / Claude / 深 | 6.420 → 6.420 | 保留次要文字角色 |
| 桌面 / Sakura / 浅 | 2.885 → 4.701 | 仅失败项使用次要文字色 |
| 桌面 / Sakura / 深 | 4.847 → 4.847 | 保留次要文字角色 |
| 桌面 / Ocean Breeze / 浅 | 3.162 → 4.578 | 仅失败项使用次要文字色 |
| 桌面 / Ocean Breeze / 深 | 3.026 → 5.805 | 保留次要文字角色 |
| Web / 默认（界面蓝色） / 浅 | 4.016 → 4.677 | 仅失败项使用次要文字色 |
| Web / 默认（界面蓝色） / 深 | 5.805 → 5.805 | 保留次要文字角色 |
| Web / Violet / 浅 | 4.016 → 4.677 | 仅失败项使用次要文字色 |
| Web / Violet / 深 | 5.805 → 5.805 | 保留次要文字角色 |
| Web / Green / 浅 | 4.016 → 4.677 | 仅失败项使用次要文字色 |
| Web / Green / 深 | 5.805 → 5.805 | 保留次要文字角色 |

最终定向验证：颜色静态回归新增两个保留项后为 **93 项通过**；加桌面 Tabs 为 2 文件 **95 项通过**，Web Tabs 为 **2 项通过**。与前面的 91 项记录是同一测试文件的后续扩充，不叠加计数。

最终收尾另跑：

```sh
pnpm --filter @agentkib/desktop exec vitest run src/features/workspace/WorkspaceDoctorPage.test.tsx src/core/theme-contrast.test.ts src/components/ui/tabs.test.tsx
pnpm --filter @agentkib/desktop typecheck
```

结果：3 文件 **121 项通过**；桌面 `tsc -b --pretty false` 类型检查通过。涉及的新诊断 fixture 使用项目规定的 `claude-code` Agent 标识。最终全仓验证仍以主 QA 的统一运行结果为准。
