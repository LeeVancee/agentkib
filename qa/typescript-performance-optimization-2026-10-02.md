已完成 TypeScript 後端效能優化，基準 commit 為 e4c1f1d58d8b99e7652651b0e7ad575fc3b0a686，此報告測量的是尚未提交的修改。

每次掃描內，共享的檔案 metadata、目錄走訪、skill 檢查和設定驗證只執行一次。快取不跨越請求，下一次掃描仍能讀到新增、修改和刪除。後端 bundle 已啟用 minify 並保留 source map，大小約由 2.45 MB 降到 1.35 MB。

以下掃描使用真實的 native asset 目錄結構，每個 skill 包含 SKILL.md 和 5 個 references 檔案；每組前後各量 30 次。原先主要含 src 檔案的 fixture 只測到少量設定查詢，不能用來推論任意專案檔案樹的掃描能力。

| 資料規模 | 優化前 p50 | 優化後 p50 | 時間減少 |
|---|---:|---:|---:|
| 0 個共享 skills | 0.96 ms | 0.18 ms | 81.3% |
| 100 個共享 skills | 107.03 ms | 20.45 ms | 80.9% |
| 500 個共享 skills | 538.49 ms | 102.83 ms | 80.9% |

三組掃描結果經正規化路徑後的 SHA-256 完全一致。額外驗證檔案修改、刪除、無效設定修復和 symlink 排除均通過。

相同標準設定（5 次全新資料啟動、10 次重用啟動，各操作 100 次、無閒置等待）下，後端 RSS 由 127.4 MiB 降至 123.2 MiB；整個 Electron 程序樹全新資料啟動 RSS p50 由 711.8 MiB 降至 708.1 MiB。首頁就緒 p50 為 297.28 → 294.18 ms，維持約 0.3 秒，不能將單輪小差異解讀為確定的啟動加速。

100 個 skills 的重複掃描工作負載後 RSS，本輪由 264.1 降至 169.3 MiB；500 個 skills 為 276.8 → 243.1 MiB。這些是同樣等待和取樣條件下的單輪結果，會受 V8 垃圾回收與 allocator 狀態影響。

10 秒獨立後端閒置量測，CPU 平均 0.055%，含採樣自身成本；這不是整個 Electron 應用的 CPU 使用率。

可重跑的命令：

```sh
pnpm benchmark:runtime -- --clean-runs 5 --reuse-runs 10 --workload-runs 100 --output /tmp/agentkib-standard.json
pnpm benchmark:runtime -- --clean-runs 0 --reuse-runs 0 --workload-runs 30 --skill-count 100 --idle-ms 10000 --output /tmp/agentkib-skills-100.json
```

backend/desktop 型別檢查、生產 backend build、lint 和格式檢查通過。現有套件為 1,034 個通過、14 個失敗；將本次三個修改檔案還原至 HEAD 後，四個失敗套件的同樣 14 個案例均重現，屬既有失敗（startup-flow、local-claude、claude-host、InsightsPage.i18n）。沒有新增或修改測試、建立分支或提交 commit。

完整原始樣本及程式碼 SHA-256 記錄於 [JSON 報告](/Users/leevancee/Desktop/code/agentkib/qa/typescript-performance-optimization-2026-10-02.json)。
