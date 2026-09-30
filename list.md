Rust → TypeScript 遷移清單

已完成基礎批次：Electron 獨立 TypeScript 後端程序、重啟／Rust 回退、共享協議、六項介面設定、四種列表讀取；Windows CodexBar 改用預編譯 CLI。

- [x] 1. 資料庫寫入、工作區管理、探索與剩餘應用設定（已完成）。
- [ ] 2. 配置／資產、原生資產掃描、診斷修復、變更套用、記憶。
- [ ] 3. 會話讀取、原生會話探索、索引、交接與續接。
- [ ] 4. Git、使用統計、成就。
- [ ] 5. Skills、Agent 工具、Obsidian 整合。
- [ ] 6. MCP 設定、程序管理、OAuth、套件安裝。
- [ ] 7. 遠端閘道、Web、Agent 橋接。
- [ ] 8. 額度採集與儲存空間掃描。
- [ ] 9. TypeScript 協議／構建收尾、三平台效能與安裝包驗收，最後移除 Rust 原始碼與 Cargo／Rust 工具鏈依賴。

第一批已完成：TypeScript 負責工作區新增／刷新／排除／還原、掃描根目錄新增／移除、探索結果入庫與報告、剩餘應用偏好寫入；維持 schema 15、外鍵與交易、Rust 資料相容性，以及錯誤與重啟行為。遷移期間的原生資產／會話讀取器與資料庫升級由 Rust 提供，分別在第 2、3、9 批移除；不能將整個工作區或探索操作交回 Rust 代跑。

所有既有功能保留；操作失敗不跨後端重送。第三方 CodexBar 預編譯二進位可保留。完成全部功能遷移及 macOS、Windows、Linux 安裝包驗收前，不移除 Rust。

第一批驗證：桌面完整測試 962 項通過、1 項略過；Rust Runtime／Store 回歸測試 236 項通過；九種 Agent 的資料格式與 Rust 比對通過。TypeScript 型別、格式、相關 lint、Rust clippy、正式構建，以及實際 Electron utility process 的工作區／探索操作和兩個後端各自重啟後的資料保留均通過。

目前剩餘 8 批。這批在 macOS arm64 驗證；Windows、Linux 的實機與安裝包驗收仍列在第 9 批。第 2、3 批會移除 `backend.nativeContext`／`backend.nativeDiscovery`／`backend.nativeInspect` 原生讀取適配器及 `backend.sessionIndexChanged` 會話工作執行緒隔離；第 9 批移除 Rust 資料庫升級與構建依賴。
