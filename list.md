Rust → TypeScript 遷移清單

已完成基礎批次：Electron 獨立 TypeScript 後端程序、重啟／Rust 回退、共享協議、六項介面設定、四種列表讀取；Windows CodexBar 改用預編譯 CLI。

- [x] 1. 資料庫寫入、工作區管理、探索與剩餘應用設定（已完成）。
- [x] 2. 配置／資產、原生資產掃描、診斷修復、變更套用、記憶（已完成）。
- [x] 3. 會話讀取、原生會話探索、索引、交接與續接（已完成；MCP gateway 設定計畫屬第 6 批）。
- [x] 4. Git、使用統計、成就（已完成）。
- [ ] 5. Skills、Agent 工具、Obsidian 整合。
- [ ] 6. MCP 設定、程序管理、OAuth、套件安裝。
- [ ] 7. 遠端閘道、Web、Agent 橋接。
- [ ] 8. 額度採集與儲存空間掃描。
- [ ] 9. TypeScript 協議／構建收尾、三平台效能與安裝包驗收，最後移除 Rust 原始碼與 Cargo／Rust 工具鏈依賴。

第一批已完成：TypeScript 負責工作區新增／刷新／排除／還原、掃描根目錄新增／移除、探索結果入庫與報告、剩餘應用偏好寫入；維持 schema 15、外鍵與交易、Rust 資料相容性，以及錯誤與重啟行為。遷移期間的原生資產／會話讀取器與資料庫升級由 Rust 提供，分別在第 2、3、9 批移除；不能將整個工作區或探索操作交回 Rust 代跑。

第 2、3、4 批目前已接到 TypeScript 的功能：九種 Agent 的工作區資產掃描、工作區刷新／探索所用的資產檢查、manifest 匯入、九種 Agent 的上下文解析、安裝清單與資產搜尋、記憶提議／審核／全文搜尋；會話快取列表與索引狀態；Git 概況／歷史分頁／提交檔案／差異；統計概況／熱圖／Agent、模型、工作區、儲存庫分類／合併視圖／狀態，成就讀取／解鎖狀態寫入與 Git 身分設定。Git 指令已支援非同步回覆、輸出上限、逾時與正常關閉時清理子程序。

第 3 批已整合的索引與探索：會話索引交易、部分來源失敗保留既有資料、別名歸屬與穩定雜湊 ID；Codex、Claude、Grok Build、OpenClaw、Hermes、OpenCode 與 Antigravity 原生會話中繼資料讀取器。七個讀取器已和 Rust 索引結果比對；保留父子／分叉關係、側鏈判斷、Grok 封存移動後的穩定 ID、OpenClaw instance 歸屬，以及 Hermes 多設定檔／SQLite 中繼資料優先與 JSONL 備援。讀取會話標頭／尾端時維持原有大小上限，目錄探索計數與 Hermes 每個資料庫 500 筆限制也保留。原生讀取器現已整合至 TypeScript 索引刷新。原生探索、九種 Agent 安裝狀態、home assets 和 scan roots 現已由 TypeScript 組成 `refreshDiscovery` snapshot，Rust 原生探索不再位於正式路由。Codex、Claude、OpenCode 和 Antigravity 的原生 session document parser 現由 TypeScript `sessions.readDocument` 路由執行；handoff 預覽、續接規劃、ChangeSet／archive 規劃、套用前範圍驗證、審核後檔案與 archive 寫入、封存完整性驗證、CLI 命令準備及跨平台終端啟動均已切到 TypeScript。handoff 檔案仍會一併加入 `.gitignore` 規則。續接所需的 MCP gateway 設定計畫仍由 Rust 提供，歸第 6 批 MCP 設定遷移。Grok Build、OpenClaw、Hermes 維持原有不支援匯出行為。

第 3 批完成核查：型別、格式、相關 lint、後端 bundle 與 diff 檢查通過；已透過 computer use 開啟 AgentKib 開發版，確認工作區概覽、會話清單、TypeScript 分支標籤及「在工作區續接」入口正常。續接的 MCP gateway 設定計畫維持在第 6 批範圍。

第 4 批使用統計正式刷新已由 TypeScript 接管：Claude stats-cache、OpenClaw usage-cost、Hermes 多設定檔 SQLite、DeepSeek Harness projection-cache 和 Codex JSONL／SQLite checkpoint 都由 TypeScript 採集；Codex 保留追加讀取、尾端不完整行重試、截斷／替換重建、模型資料庫回退、來源刪除只在完整探索時生效、workspace salted identity 重映射，以及和 usage 事件／cursor／checkpoint 的同交易提交。provider 失敗更新不可用狀態而保留最後成功統計。Git 統計的 refs／HEAD 指紋、提交、全域／repo email 發現、身份重分類與統計入庫也由 TypeScript 負責；成就讀取會執行與 Rust 相同門檻日期和特殊成就解鎖持久化。

第 4 批驗收：型別、格式、相關 lint、後端正式 bundle 與 diff 檢查通過；已透過 computer use 重啟並打開 AgentKib Dev（127.0.0.1:1420），由洞察頁實際觸發 TypeScript 統計刷新。Codex 覆蓋日期、token 趨勢、commit 指標、成就牆和資料來源狀態正常呈現；本機缺少 Claude stats-cache、OpenClaw CLI、Hermes state.db、DeepSeek Harness projection cache 的錯誤詳情與 Rust provider unavailable 行為一致，最後成功統計保留。

所有既有功能保留；操作失敗不跨後端重送。第三方 CodexBar 預編譯二進位可保留。完成全部功能遷移及 macOS、Windows、Linux 安裝包驗收前，不移除 Rust。

第一批驗證：桌面完整測試 962 項通過、1 項略過；Rust Runtime／Store 回歸測試 236 項通過；九種 Agent 的資料格式與 Rust 比對通過。TypeScript 型別、格式、相關 lint、Rust clippy、正式構建，以及實際 Electron utility process 的工作區／探索操作和兩個後端各自重啟後的資料保留均通過。

以下為遷移過程記錄，按進度先後排列；其中的待辦狀態是記錄當時的狀態，當前批次狀態以本檔上方清單為準。

當時剩餘 7 批。這批在 macOS arm64 驗證；Windows、Linux 的實機與安裝包驗收仍列在第 9 批。第 3 批已將 `backend.nativeContext`、原生 discovery snapshot 及七種 Agent 的會話索引／事件讀取切到 TypeScript；`backend.nativeInspect` 已退出正式路由，目前只用於遷移比對。Codex、Claude、OpenCode 和 Antigravity 文件解析、handoff 預覽、續接規劃、archive 寫入、變更套用、驗證與跨平台終端啟動已遷入 TypeScript。續接所需的 MCP gateway 設定計畫歸第 6 批。原生 `backend.sessionIndexChanged` 工作執行緒隔離 RPC 已移除；遠端閘道快取撤銷通知暫留至第 7 批。第 9 批移除 Rust 資料庫升級與構建依賴。

第 2、3、4 批階段驗證：桌面完整回歸 968 項通過、1 項略過；補上 Claude 原生中繼資料讀取器後，遷移比對／路由共 26 項通過。型別、格式、變更範圍 lint、後端 bundle 與 diff 檢查通過；實際 Electron 44 utility process 已驗證資產／manifest、非同步 Git、統計視圖、會話快取、記憶提議／審核／搜尋，以及 TS／Rust 各自重啟後的資料保留。stdio EOF 能等待非同步 Git 回覆送出再退出。尚未整合的會話讀取器只驗證模組與 Rust 結果一致，不代表原生刷新、事件讀取或續接已遷移完成。

第 2 批上下文解析已接到 TypeScript：保留九種 Agent 的全域／專案指令優先序、遞迴匯入與循環／邊界檢查、字元和位元組預覽上限、OpenCode glob 與私密檔案排除、Antigravity 插件驗證／啟停、Grok 相容設定／Git 忽略規則、DeepSeek 專案根目錄／讀取預算，以及 manifest 覆寫、Skills 目標篩選、核准記憶與 MCP 可見性。MCP 僅遷移上下文所需的設定讀取與合併；完整設定操作、程序、OAuth 仍在第 6 批。

上下文階段驗證：桌面完整回歸 974 項通過、1 項略過；共用 OpenCode glob 匹配移植收尾後，遷移比對／路由 31 項再驗通過。型別、格式、相關 lint、後端正式 bundle 與 diff 檢查通過；Electron 44 utility process 中九種 Agent 與 Rust 的上下文結果一致，TypeScript 程序重啟後仍能讀取核准記憶，stdio EOF 能等待非同步 Git 與上下文回覆後正常退出。第 2、3、4 批仍未全部完成。

第 2 批收尾完成：TypeScript 已接管診斷報告／摘要、修復所用變更計畫與安全套用。同步保留八種可寫 Agent 的未代管指令、原生設定與既有 MCP；保留 home 獨立核准、審查時雜湊校驗、符號連結／重解析點防護、備份與原子替換、寫入後驗證、失敗回滾及外部變更保護。續接所需的原生 JSONL 與應用封存寫入白名單也保留，續接本身仍屬第 3 批。原生檔案操作使用已打包的第三方 Koffi 預編譯模組；Windows API 與 Linux 實機驗收仍列第 9 批。

第 2 批驗證：桌面完整回歸 977 項通過、1 項略過；遷移比對／路由 34 項通過，包含 Hermes／OpenClaw home 設定合併、原生會話／封存寫入、過期審查拒絕及驗證失敗回滾。型別、格式、相關 lint、bundle 與 diff 檢查通過；Electron 44 utility process 的同步、診斷與實際原生回滾通過。已透過 computer use 開啟本專案 Electron 開發版（127.0.0.1:1420），確認工作區概覽與九種 Agent 的診斷矩陣正常顯示；並修正開發啟動時 TypeScript 後端路徑重複 dist-electron 的問題。第 3、4 批繼續進行。

第 3 批讀取器階段驗證：遷移比對／路由 37 項通過，新增 Grok、OpenClaw、Hermes 比對，包含重複来源先決定歸屬、UTF-8 尾端截斷、SQLite 與 JSONL 來源優先、損壞來源標為部分結果，以及 500 筆掃描上限。這些新模組尚未接入正式刷新和事件讀取。

第 3 批 JSONL 事件分頁模組完成：Codex／Claude／Grok／OpenClaw／Hermes 維持反向 64 KiB 分塊讀取、每頁最多 16 MiB／20,000 行掃描、4 MiB 單行與 256 KiB 訊息上限、2 MiB 頁面預算，以及 15 分鐘／32 個／64 MiB 游標快取。快照游標保留重讀與追加後舊快照，拒絕被替換或修改的來源；保留損壞／超大行提示、工具結果關聯與 Codex 鏡像去重、回合邊界和 phase 衝突處理。這些模組尚未接管公開 session.events 路由。

事件分頁階段驗證：桌面完整回歸 982 項通過、1 項略過；遷移比對／路由 39 項通過，五種來源逐頁對照 Rust，包含單頁 1／2／100 項切分、鏡像衝突／歧義、注入上下文與 Claude 指令回顯排除、工具結果跨頁關聯、Unicode 訊息截斷、20 MiB 超大行跨掃描預算、游標重讀／追加／檔案替換。型別、格式、相關 lint 與 diff 檢查通過。

第 3 批 Hermes SQLite 事件頁與 OpenCode CLI 讀取器完成：SQLite 游標綁定檔案身分、rowid 高水位與有界內容錨點；維持 500 筆掃描上限、UTF-8 訊息／頁面預算、追加後舊快照，以及來源替換／錨點修改拒絕。OpenCode 保留 CLI 工作區範圍、64 位整數毫秒時間、原有 offset 游標與工具／附件摘要；完整匯出與列表分別維持 256／16 MiB 上限、stderr 64 KiB 與 30 秒逾時。CLI 查找保留三平台既有搜尋順序，子程序在輸出超限及主程序退出時清理；Windows Job Object 與 .cmd 引數處理由第三方 Koffi／cross-spawn 支援，Windows 實機驗收仍在第 9 批。尚未切換公開刷新和事件路由；中性文件匯出、交接／續接仍待完成。

本階段驗證：桌面完整回歸 984 項通過、1 項略過；新增 SQLite 逐頁精確游標對照、跨 UTF-8 頁面預算不漏訊息、損壞資料拒絕，以及 OpenCode 原生列表／事件對照與 CLI 輸出超限／子程序持有 pipe 的收尾。型別、格式、相關 lint、後端 bundle 與 diff 檢查通過；Electron 44 utility process 的 Git、診斷、原生回滾、後端重啟與 stdio EOF 收尾再驗通過。第 3、4 批完成框仍未勾選。

第 3 批 Antigravity ACP 橋接與原生中繼資料讀取器完成：官方可執行檔查找／驗證、ACP v1 能力協商、原生 session/list 分頁、工作區篩選與跨頁去重、部分來源保留、session/load 回放收集均已移植。保留 1 MiB 訊框、128 筆待回覆／權限要求、32 筆命令佇列、64 KiB prompt，以及整個操作共用截止時間；分段 UTF-8 輸入跨觀察逾時保留，寫入逾時或協議損壞後關閉並拒絕重送。保留明確權限選項、取消／完成後拒絕過期權限、未知客戶端工具拒絕，以及讀取時不得要求權限。控制能力的已驗證官方版本識別保留，尚未接管公開控制路由。原生列表限制 100 頁／10,000 筆，回放收集限制 100,000 筆／256 MiB；此階段完成時，Antigravity 事件內容解析、中性文件與快照分頁尚待完成；回放與公開事件整合的後續進度見下方。

ACP 階段驗證：桌面完整回歸 988 項通過、1 項略過，涵蓋 Rust 原生索引與事件回放對照、循環分頁／跨工作區 ID 衝突拒絕、缺少 load 能力與部分来源、唯讀權限要求拒絕、分段 UTF-8、過期核准、64 位 RPC ID、訊框與 JSON 遞迴上限，以及共用截止時間／部分寫入不重送；補驗命令佇列滿載仍可讀取事件，以及工具輸入的 64 位整數、浮點格式和 UTF-8 JSON 鍵排序與 Rust 一致。型別、格式、相關 lint 與 diff 檢查通過；Electron 44／Node 24.18.1 實際子程序握手、列表、回放與退出清理通過。第 3、4 批仍未完成。

第 3 批 Antigravity 回放與公開事件整合完成：解析器保留舊式與帶 ID 的訊息 chunk 合併、交錯更新、工具名稱優先序／輸入補丁／獨立 rawOutput 和內容快照、終態工具結果更新、附件與損失紀錄、64 位 JSON 整數及原生浮點／鍵排序格式；工具名稱與輸出維持 16／64 MiB 預算。分頁保留四個／256 MiB／120 秒不可變快照、v1／v2 游標與快照淘汰後依 offset 重新回放。七種 Agent 的公開 session.events 已由 TypeScript 接管；讀取前重新驗證索引工作區與穩定 HMAC ID，再透過原生 Provider 解析來源，拒絕移至其他工作區的會話，舊快取不能繞過檢查。索引刷新、原生探索與交接／續接仍未完成，第 3、4 批維持未勾選。

事件整合階段驗證：桌面完整回歸 988 項通過、1 項略過；遷移比對／路由 45 項通過；涵蓋七種 Provider 的公開事件讀取與跨頁重讀、Antigravity 逐頁比對／追加後舊快照／淘汰回退、畸形回放拒絕，以及有效 ACP 訊框累積後的工具名稱／輸出上限。型別、格式、相關 lint、正式後端 bundle 與 diff 檢查通過；Electron 44／Node 24.18.1 的實際 TypeScript utility process 已驗證原生事件分頁、Unicode 內容、游標重讀，以及原有 Git、診斷、原生回滾、後端重啟、EOF 收尾與子程序清理。

完整回歸曾出現一項未修改的導航測試 React 更新迴圈；該檔案單獨重跑 15 項全部通過，再次完整回歸也全部通過，未變更導航實作。

第 3 批 TypeScript 原生會話索引刷新與清除完成：公開 `workspace.refreshSessions`／`sessions.clearIndex` 由 TypeScript Provider 和 schema 15 SQLite 寫入模組負責；逐一更新七種來源、保留不完整來源已有會話並標記錯誤，只在成功完整讀取時移除舊記錄。索引停用會立即清空快取；刷新期間的停用／清除會使舊結果失效，避免稍後寫回。移除原生會話工作執行緒隔離 RPC；仍保留極小原生通知，讓尚未遷移的遠端閘道撤銷舊索引快照，直到該模組遷移。

索引整合階段驗證：遷移比對／路由 45 項通過，包含七種 Provider 公開事件讀取、Antigravity ACP 部分來源刷新與 last-good 記錄保留、索引狀態、清除、停用及錯誤來源不刪資料。Electron 44／Node 24.18.1 utility process 驗證原生索引刷新、分頁、清除、停用／重新啟用、Agent 路徑清單與 Rust 對照，以及遠端快照撤銷；Rust Runtime 原生通知修改已重建並通過。

第 3 批 TypeScript Agent 路徑上下文完成：工作區與探索計畫所用的九個 Agent home 和 AgentKib skills home 已由 TypeScript 按原生平台目錄／環境變數規則計算，並依路徑身分去重及排序；`backend.nativeContext` 正式路由移至 TypeScript。Electron 44／Node 24.18.1 utility process 的回歸 smoke 已將完整路徑清單逐項與 Rust 比對。原生探索 snapshot 已移出 Rust 正式路由；中性文件匯出與交接／續接仍待完成。

第 3 批原生探索遷移已接入正式路由：TypeScript 組合九種 Agent 安裝狀態、各原生候選與來源診斷、allowlist home assets、AgentKib skills 和 scan-root 候選，不再向 Rust 索取 discovery snapshot。掃描根目錄保留深度 1–8、忽略目錄、連結／重解析點與跨檔案系統防護、專案標記、根目錄正規化、Git repository group ID 及逐根診斷；原生來源涵蓋 Codex state SQLite、Claude history/index、Cursor workspaceStorage、OpenCode SQLite/legacy JSON、OpenClaw 設定/JSONL、Hermes profiles/SQLite/JSONL、Grok sessions/archive、Antigravity 空來源與 DeepSeek workspace.json。這是程式整合狀態，整批開發版檢查尚待第 3 批其他工作完成後進行。
