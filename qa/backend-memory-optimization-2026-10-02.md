本輪已達到日常初始化閒置 80–90 MiB RSS 的目標。實際 Electron 後端三次初始化閒置中位數 86.16 MiB；正式 AgentKib 首頁冷啟動 88.97 MiB，熱啟動 87.45 MiB。啟用更多功能或大量操作後仍會超過 90 MiB，未設定記憶體硬上限。

量測日期為 2026-10-02（Asia/Shanghai）；原始 UTC 時間在 JSON。使用 Apple M3、macOS arm64、Electron 44.0.0，同一套隔離資料。專用量測採用實際 utilityProcess，每秒擷取 process.memoryUsage()，載入後等待 3 秒、各初始化／功能階段等待 8 秒，取階段 RSS 中位數；三次順序執行。無 inspector、強制 GC、堆積上限或把工作轉移到另一個程序。RSS 僅指後端程序，不是整個 Electron 應用的 RAM。

| 階段 | 改前 MiB | 改後三次中位數 MiB | 改後範圍 MiB |
| --- | ---: | ---: | ---: |
| loaded | 92.53 | 81.50 | 81.50–81.52 |
| initialized-idle | 96.84 | 86.16 | 86.08–86.16 |
| after-mcp-idle | 99.67 | 93.98 | 93.81–94.00 |
| after-web-and-mcp-idle | 未測 | 94.92 | 94.75–94.94 |

改前是上一輪掃描優化及壓縮後的後端，基線僅一次；改前未量測 Web 與 MCP 同時使用的階段，因此沒有該階段的前後降幅。初始化閒置減少 10.69 MiB（約 11.04%）。實際正式首頁另外跑了 3 次冷啟動、5 次熱啟動，後端 RSS 範圍 87.41–89.06 MiB。

將 MCP SDK 的伺服器、客戶端、傳輸及 OAuth 模組延至首次需要時載入；Web／Codex managed owner 也延至首次請求建立。並行首次請求共用同一 owner，載入期間若已關閉或重新初始化則拒絕掛接舊 store。所有功能保留。後端入口由 1,348.33 kB 減為 852.98 kB，其餘程式碼存在 CommonJS 分塊中；打包仍需包含這些分塊，這不是總程式碼大小等比例縮減。

代價是首次功能使用需要載入模組。此 fixture 的 MCP 初始化及工具列舉改前 43.88 ms，改後三次中位數 53.36 ms；首次並行 Web catalog 約 16.78 ms。正式首頁 home-data-ready 冷啟動中位數 297.44 ms、熱啟動 291.37 ms，未宣稱顯著啟動加速。

100 次常用操作的 p50 與上一輪相近：掃描 0.17 ms、索引 3.65 ms、大會話解析 0.88 ms、workspace SQLite 列表 1.3 ms。大量工作負載後獨立 Node 後端 RSS 為 109.47 MiB（前值 123.19 MiB）；這與 Electron 閒置階段是不同測量，不能混用來宣稱一直低於 90 MiB。

後端／桌面 typecheck、lint、format、production backend build 均通過。既有測試 1,034 通過、14 失敗；失敗檔案和名稱與上一輪已回退變更重現的基線完全一致，詳細清單在 JSON。沒有新增或修改測試。

並行首次 Web catalog、切換到全新 dataDir 後 catalog 清空、關閉生命週期均通過。以實際 app.asar 格式封裝後端及所有分塊後，同樣跑過初始化、MCP 工具列舉、Web catalog、重新初始化與關閉；此為 ASAR 載入驗收，未重新產生 DMG。建置也驗證舊 backend 分塊及 map 清除，同時 main／preload 內容保持不變。未測需要登入的 AI 呼叫，未建置其他平台。

可重跑：先執行 pnpm --filter @agentkib/desktop backend:build，再執行 pnpm benchmark:memory -- --label verify --output qa/backend-memory-verify.json。完整原始資料、每秒採樣、版本與來源 SHA-256 保存在 backend-memory-optimization-2026-10-02.json；正式首頁及工作負載原始資料在 runtime-benchmark-typescript-memory-optimized-2026-10-02.json。
