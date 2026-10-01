本輪改善主要在大型會話索引、事件讀取及 workspace 列表。500 會話三輪對照，索引 p50 降低約 33%，最新一頁降低約 68%，workspace 列表降低約 37%。首頁啟動未見穩定加速；初始化閒置後端 RSS 仍約 86.23 MiB。

日期為 2026-10-02（Asia/Shanghai）；原始 UTC 時间保存在 JSON。使用同一 Apple M3、macOS arm64、同一 Node／Electron 安裝與隔離 fixture。改前是已完成上輪記憶體優化的 TS 後端；沒有把 Rust 或早期未壓縮版本混入對照。本輪比較的四個後端檔案改前取自當前 HEAD，其餘已完成的改動保留；來源與建置 SHA-256 在 JSON。

500 會話含 1 個 50,000 行 Claude 原生 JSONL 和 499 個短會話，101 個 workspace。改前／改後各跑 3 輪，每個項目每輪 30 次請求，表格取各輪 p50 的中位數；fixture 的原生工作區會話數必須等於預期，否則量測失敗。兩版均使用同一個新增規模參數的 benchmark 腳本。

| 項目 | 改前 p50 ms | 改後 p50 ms | 時間降低 |
| --- | ---: | ---: | ---: |
| 強制刷新會話索引 | 62.98 | 42.21 | 32.98% |
| 最新 100 個事件的 RPC | 68.64 | 21.63 | 68.49% |
| workspace 列表 RPC | 1.31 | 0.82 | 37.40% |

2,000 會話與 501 個 workspace 各量測一輪、每項 30 次，作為規模確認；不把單輪數據當成統計顯著性證明。

| 項目 | 改前 p50 ms | 改後 p50 ms | 時間降低 |
| --- | ---: | ---: | ---: |
| 強制刷新會話索引 | 265.49 | 174.91 | 34.12% |
| 最新 100 個事件的 RPC | 290.08 | 90.71 | 68.73% |
| workspace 列表 RPC | 6.56 | 3.97 | 39.48% |

事件 RPC 是從 50,000 行 transcript 讀最新 100 個事件，包含會話驗證與原生來源發現，並不是解析完整 50,000 行文件。原腳本 legacy 欄位名稱 largeSessionParse 保留相容性。主要改善來自只發現一次原生來源，而非宣稱 JSON parser 加速。

重用每個 Sql instance 的 prepared statement，最多保留 64 個 SQL 形狀，one 使用 get 直接取得一列。讀取 Codex／Claude 事件與文件時，將同一請求已驗證的 transcript 路徑傳給 reader，省去第二次全目錄掃描；下一個請求仍重新發現來源。Claude 的探測標記及 cwd 所屬工作區檢查只在單次同步掃描內重用。workspace 列表在同一讀取交易中一次取得所有來源，再分組映射；等時間戳按 workspace／agent／evidence 排序，維持舊查詢來源順序。沒有跨請求保留會話內容或結果。

同一份實際 fixture 逐一比對改前／改後的 workspace 列表、會話列表、最新事件頁、下一頁及完整 50,000 行會話文件；SHA-256 一致。新增內容、刪除 transcript、加入與移除 .codexbar-session-id 都通過即時更新驗收。另以逆序插入同時間戳的多來源，驗證 workspace 輸出順序與基線一致。完整文件用來驗證正確性，未量測其時間。

原本小規模（1 會話、5,000 行、101 workspace）仍跑 100 次請求：索引 3.65 → 3.46 ms，事件頁 0.88 → 0.73 ms，workspace 列表 1.3 → 0.82 ms；簡單掃描 0.17 → 0.17 ms，未優化此低成本路徑。

正式 AgentKib 首頁用相同隔離空白 profile 設定重跑 3 次冷啟動、5 次熱啟動。home-data-ready 中位數：冷 297.44 → 309.64 ms，熱 291.37 → 284.31 ms。冷啟動稍慢、熱啟動稍快，沒有足夠證據宣稱啟動加速；首頁包含多個非 SQL／會話流程。本輪沒有修改首頁載入流程，也未用預填資料將首頁就緒提前。

最後實際 Electron utilityProcess RSS：初始化閒置 86.23 MiB、啟用 MCP 後 94.00 MiB、再啟用 Web 後 94.92 MiB。仍是日常閒置 80–90 MiB 目標，非硬上限；大型工作負載仍會佔用更多記憶體。完整每秒採樣在 JSON，與獨立 Node 工作負載 RSS 分開記錄。

後端／桌面 typecheck、production backend build、lint（有既有警告）、format、git diff --check 通過。既有完整套件首次 1,033 通過、15 失敗，其中額外導覽測試單獨重跑 15 項全過；最終完整重跑 1,034 通過、14 失敗，與上一輪已回退驗證的基線失敗名稱和檔案完全一致。沒有新增或修改測試、建立分支或 commit。需要登入的 AI 呼叫及其他平台建置未執行。

重跑大型 workload：pnpm --filter @agentkib/desktop backend:build；pnpm benchmark:runtime -- --clean-runs 0 --reuse-runs 0 --workload-runs 30 --session-count 500 --transcript-lines 50000 --workspace-count 100 --output qa/scale-verify.json。新規模參數的預設值仍與原測試一致。詳見 performance-scale-optimization-2026-10-02.json 的 raw、sourceHashes、artifactHashes 與 validation。
