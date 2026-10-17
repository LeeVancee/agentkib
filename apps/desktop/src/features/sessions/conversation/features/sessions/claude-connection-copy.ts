import type { SupportedLocale as Locale } from "@/core/types";

const zh = {
  disconnectBeforeCode: "若要生成新的连接码，请先断开当前原终端连接。",
  invalidCode: "连接码无效。请重新生成，并在目标终端使用完整的新连接码。",
  versionMismatch: "Claude Code 或插件版本不匹配。请按安装指引更新后重新连接。",
  identityMismatch: "目标终端与所选会话不匹配。请在所选会话的原终端重新连接。",
  connectionUnconfirmed: "上次操作结果尚未确认。请先核对原终端状态，再重新连接。",
  connectionLimit: "原终端连接数量已达上限。请先断开不再使用的连接，再重试。",
  connectionRejected: "连接请求被拒绝。请检查原终端与主机状态后重新连接。",

  handoff: "待交接",
  handoffInfo: "交给 AgentKib 后可在这里执行；也可连接原终端，仅同步观察并取消当前轮次。",
  released: "已交还原客户端",
  releasedInfo: "此会话已交还原客户端。请在原客户端继续，或重新交给 AgentKib。",
  lostTitle: "原终端连接已断开",
  manage: "管理原终端连接",
  platformUnsupported: "连接原 Claude 终端仅支持 macOS。请在 macOS 主机上操作。",
  bridgeUnavailable: "原终端桥接服务无法启动。请检查主机日志并重新启动 AgentKib 后重试。",
  requiredVersion: "需要 Claude Code",
  copyInstall: "复制安装命令",
  copyCommand: "复制连接命令",
  copyCode: "复制连接码",
  copied: "已复制",
  copyFailed: "复制失败，请手动选择并复制。",
  codeSafety: "连接码只用于你自己的终端，请勿发给他人。",
  disconnectInfo: "断开后，原终端照常运行，AgentKib 停止同步。",
  confirmDisconnect: "确认断开",
  cancel: "取消",
  disconnectFirst: "请先断开原终端连接，再交给 AgentKib。",
  connectionFailed: "原终端连接失败：",

  title: "连接原 Claude 终端",
  connected: "已连接原会话",
  managed: "由 AgentKib 执行",
  history: "仅查看历史",
  info: "同步观察原 Claude Code 会话，可取消当前轮次。关闭 AgentKib 不会停止原终端。",
  disconnected: "尚未连接原终端。请在桌面打开连接指引，并在目标 Claude Code 会话中连接。",
  lost: "原终端连接已断开。请在原终端重新连接；不会另起执行进程。",
  approval: "正在等待工具审批，请在原终端处理。",
  question: "正在等待问题回答，请在原终端处理。",
  gap: "事件同步出现缺口，正在重新读取快照和原生历史；恢复前暂停控制。",
  turnUnconfirmed: "原终端正在执行，当前轮次身份尚未核实；暂不能取消，请在原终端处理。",
  permissionUnconfirmed: "原终端曾请求工具审批，当前授权或执行状态尚未核实，请查看原终端。",
  attachments: "原终端连接尚未验证附件输入，请在原终端添加附件。",
  sendUnverified: "原会话发送尚未开放，请在原终端发送；AgentKib 可同步观察并取消当前轮次。",
  generate: "生成一次性连接码",
  disconnect: "断开原终端连接",
  refresh: "检查连接",
  loading: "正在检查连接…",
  failed: "无法完成连接操作，请检查主机状态后重试。",
  expires: "连接码有效至",
  expired: "连接码已过期，请重新生成。",
  instructions: "先按以下指引安装插件，再在目标终端执行连接命令；连接不会发送消息或接管会话。",
  localOnly: "插件安装和连接管理仅在本机桌面提供。",
};
type Copy = { [K in keyof typeof zh]: string };
export const claudeConnectionCopy: Record<Locale, Copy> = {
  "zh-CN": zh,
  "zh-TW": {
    disconnectBeforeCode: "若要產生新的連線碼，請先中斷目前原終端連線。",
    invalidCode: "連線碼無效。請重新產生，並在目標終端使用完整的新連線碼。",
    versionMismatch: "Claude Code 或外掛版本不符。請依安裝指引更新後重新連接。",
    identityMismatch: "目標終端與所選對話不符。請在所選對話的原終端重新連接。",
    connectionUnconfirmed: "上次操作結果尚未確認。請先核對原終端狀態，再重新連接。",
    connectionLimit: "原終端連線數量已達上限。請先中斷不再使用的連線，再重試。",
    connectionRejected: "連線要求遭拒。請檢查原終端與主機狀態後重新連接。",

    handoff: "待交接",
    handoffInfo: "交給 AgentKib 後可在此執行；也可連接原終端，僅同步觀察並取消目前輪次。",
    released: "已交還原客戶端",
    releasedInfo: "此對話已交還原客戶端。請在原客戶端繼續，或重新交給 AgentKib。",
    lostTitle: "原終端連線已中斷",
    manage: "管理原終端連線",
    platformUnsupported: "連接原 Claude 終端僅支援 macOS。請在 macOS 主機上操作。",
    bridgeUnavailable: "原終端橋接服務無法啟動。請檢查主機記錄並重新啟動 AgentKib 後重試。",
    requiredVersion: "需要 Claude Code",
    copyInstall: "複製安裝命令",
    copyCommand: "複製連線命令",
    copyCode: "複製連線碼",
    copied: "已複製",
    copyFailed: "複製失敗，請手動選取並複製。",
    codeSafety: "連線碼僅用於你自己的終端，請勿傳給他人。",
    disconnectInfo: "中斷後，原終端照常執行，AgentKib 停止同步。",
    confirmDisconnect: "確認中斷",
    cancel: "取消",
    disconnectFirst: "請先中斷原終端連線，再交給 AgentKib。",
    connectionFailed: "原終端連線失敗：",

    title: "連接原 Claude 終端",
    connected: "已連接原對話",
    managed: "由 AgentKib 執行",
    history: "僅查看歷史",
    info: "同步觀察原 Claude Code 對話，可取消目前輪次。關閉 AgentKib 不會停止原終端。",
    disconnected: "尚未連接原終端。請在桌面開啟連線指引，並在目標 Claude Code 對話中連接。",
    lost: "原終端連線已中斷。請在原終端重新連接；不會另啟執行程序。",
    approval: "正在等待工具審批，請在原終端處理。",
    question: "正在等待問題回答，請在原終端處理。",
    gap: "事件同步出現缺口，正在重新讀取快照與原生歷史；恢復前暫停控制。",
    turnUnconfirmed: "原終端正在執行，目前輪次身分尚未核實；暫時無法取消，請在原終端處理。",
    permissionUnconfirmed: "原終端曾要求工具審批，目前授權或執行狀態尚未核實，請查看原終端。",
    attachments: "原終端連線尚未驗證附件輸入，請在原終端新增附件。",
    sendUnverified: "原對話傳送尚未開放，請在原終端傳送；AgentKib 可同步觀察並取消目前輪次。",
    generate: "產生一次性連線碼",
    disconnect: "中斷原終端連線",
    refresh: "檢查連線",
    loading: "正在檢查連線…",
    failed: "無法完成連線操作，請檢查主機狀態後重試。",
    expires: "連線碼有效至",
    expired: "連線碼已過期，請重新產生。",
    instructions: "先依照以下指引安裝外掛，再於目標終端執行連線命令；連接不會傳送訊息或接管對話。",
    localOnly: "外掛安裝與連線管理僅在本機桌面提供。",
  },
  "en-US": {
    disconnectBeforeCode:
      "Disconnect the current original terminal before generating a new connection code.",
    invalidCode:
      "The connection code is invalid. Generate a new code and use it in full in the target terminal.",
    versionMismatch:
      "The Claude Code or plugin version does not match. Update using the installation guide and reconnect.",
    identityMismatch:
      "The terminal does not match the selected session. Reconnect from that session’s original terminal.",
    connectionUnconfirmed:
      "The previous outcome is unconfirmed. Check the original terminal state before reconnecting.",
    connectionLimit:
      "The terminal connection limit was reached. Disconnect unused connections and retry.",
    connectionRejected:
      "The connection request was rejected. Check the original terminal and host, then reconnect.",

    handoff: "Handoff required",
    handoffInfo:
      "Hand over to AgentKib to execute here, or connect the original terminal to observe and cancel its current turn.",
    released: "Returned to original client",
    releasedInfo:
      "This session was returned to the original client. Continue there or hand it over to AgentKib again.",
    lostTitle: "Original terminal disconnected",
    manage: "Manage terminal connection",
    platformUnsupported:
      "Connecting the original Claude terminal requires macOS. Use a macOS host.",
    bridgeUnavailable:
      "The terminal bridge could not start. Check the host logs and restart AgentKib before retrying.",
    requiredVersion: "Requires Claude Code",
    copyInstall: "Copy install command",
    copyCommand: "Copy connection command",
    copyCode: "Copy connection code",
    copied: "Copied",
    copyFailed: "Copy failed. Select and copy the text manually.",
    codeSafety: "Use this code only in your own terminal. Do not share it with others.",
    disconnectInfo:
      "The original terminal keeps running after disconnection. AgentKib stops synchronizing.",
    confirmDisconnect: "Confirm disconnect",
    cancel: "Cancel",
    disconnectFirst: "Disconnect the original terminal before handing over to AgentKib.",
    connectionFailed: "Original terminal connection failed: ",

    title: "Connect original Claude terminal",
    connected: "Connected to original session",
    managed: "Executed by AgentKib",
    history: "History only",
    info: "Observe the original Claude Code session and cancel its current turn. Closing AgentKib does not stop that terminal.",
    disconnected:
      "The original terminal is not connected. Open the desktop connection guide and connect from the target Claude Code session.",
    lost: "The original terminal disconnected. Reconnect there; AgentKib will not start another executor.",
    approval: "Waiting for tool approval. Please handle it in the original terminal.",
    question: "Waiting for an answer. Please respond in the original terminal.",
    gap: "Some live events were missed. Reloading the snapshot and native history; controls are paused until recovery.",
    turnUnconfirmed:
      "The original terminal is running, but the current turn identity is unconfirmed. Cancel in the original terminal for now.",
    permissionUnconfirmed:
      "The original terminal requested tool approval. Its current approval or execution state is unconfirmed; check the terminal.",
    attachments:
      "Attachment input is not verified for terminal connections. Add attachments in the original terminal.",
    sendUnverified:
      "Sending to the original session is not enabled. Send in the original terminal; AgentKib can observe and cancel the current turn.",
    generate: "Generate one-time connection code",
    disconnect: "Disconnect original terminal",
    refresh: "Check connection",
    loading: "Checking connection…",
    failed: "The connection operation failed. Check the host state and try again.",
    expires: "Connection code expires at",
    expired: "The connection code expired. Generate a new one.",
    instructions:
      "Install the plugin using the guide below, then run its connection command in the target terminal. Connecting does not send a message or take over execution.",
    localOnly:
      "Plugin installation and connection management are available on the local desktop only.",
  },
  "ja-JP": {
    disconnectBeforeCode:
      "新しい接続コードを生成するには、現在の元のターミナル接続を先に切断してください。",
    invalidCode:
      "接続コードが無効です。新しいコードを生成し、対象ターミナルで完全なコードを使用してください。",
    versionMismatch:
      "Claude Code またはプラグインのバージョンが一致しません。インストールガイドに従って更新し、再接続してください。",
    identityMismatch:
      "ターミナルが選択した会話と一致しません。その会話の元のターミナルから再接続してください。",
    connectionUnconfirmed:
      "前回の操作結果が未確認です。元のターミナルの状態を確認してから再接続してください。",
    connectionLimit:
      "ターミナルの接続数が上限に達しました。未使用の接続を切断して再試行してください。",
    connectionRejected:
      "接続要求が拒否されました。元のターミナルとホストを確認して再接続してください。",

    handoff: "引き継ぎ待ち",
    handoffInfo:
      "ここで実行するには AgentKib に引き渡してください。元のターミナルに接続して同期表示と現在のターンのキャンセルもできます。",
    released: "元のクライアントに返却済み",
    releasedInfo:
      "元のクライアントに返却しました。元のクライアントで続けるか、再度 AgentKib に引き渡してください。",
    lostTitle: "元のターミナルとの接続が切断",
    manage: "ターミナル接続を管理",
    platformUnsupported:
      "元の Claude ターミナルへの接続は macOS のみ対応です。macOS ホストで操作してください。",
    bridgeUnavailable:
      "ターミナルブリッジを起動できません。ホストのログを確認し、AgentKib を再起動して再試行してください。",
    requiredVersion: "必要な Claude Code",
    copyInstall: "インストールコマンドをコピー",
    copyCommand: "接続コマンドをコピー",
    copyCode: "接続コードをコピー",
    copied: "コピーしました",
    copyFailed: "コピーに失敗しました。手動でテキストを選択してコピーしてください。",
    codeSafety: "接続コードは自分のターミナルでのみ使用し、他の人に共有しないでください。",
    disconnectInfo: "切断後も元のターミナルは実行を続け、AgentKib は同期を停止します。",
    confirmDisconnect: "切断を確認",
    cancel: "キャンセル",
    disconnectFirst: "AgentKib に引き渡す前に、元のターミナルとの接続を切断してください。",
    connectionFailed: "元のターミナルへの接続に失敗しました：",

    title: "元の Claude ターミナルに接続",
    connected: "元の会話に接続済み",
    managed: "AgentKib が実行",
    history: "履歴の閲覧のみ",
    info: "元の Claude Code 会話を同期表示し、現在のターンをキャンセルできます。AgentKib を閉じても元のターミナルは停止しません。",
    disconnected:
      "元のターミナルに未接続です。デスクトップの接続ガイドを開き、対象の Claude Code 会話から接続してください。",
    lost: "元のターミナルとの接続が切れました。元のターミナルから再接続してください。別の実行プロセスは起動しません。",
    approval: "ツールの承認待ちです。元のターミナルで処理してください。",
    question: "回答待ちです。元のターミナルで回答してください。",
    gap: "イベントの欠落を検出しました。スナップショットと元の履歴を再取得しています。復旧まで操作は停止します。",
    turnUnconfirmed:
      "元のターミナルは実行中ですが、現在のターンIDは未確認です。キャンセルは元のターミナルで行ってください。",
    permissionUnconfirmed:
      "元のターミナルでツール承認が要求されました。現在の承認・実行状態は未確認です。元のターミナルを確認してください。",
    attachments: "ターミナル接続の添付入力は未検証です。元のターミナルで追加してください。",
    sendUnverified:
      "元の会話への送信は未対応です。元のターミナルから送信してください。AgentKib では同期表示と現在のターンのキャンセルができます。",
    generate: "一回限りの接続コードを生成",
    disconnect: "元のターミナルとの接続を解除",
    refresh: "接続を確認",
    loading: "接続を確認中…",
    failed: "接続操作に失敗しました。ホストの状態を確認して再試行してください。",
    expires: "接続コードの有効期限",
    expired: "接続コードの期限が切れました。再生成してください。",
    instructions:
      "以下のガイドでプラグインをインストールし、対象ターミナルで接続コマンドを実行してください。接続はメッセージを送信せず、実行を引き継ぎません。",
    localOnly: "プラグインのインストールと接続管理はローカルのデスクトップでのみ利用できます。",
  },
};

export function claudeConnectionReason(locale: Locale, reason?: string) {
  const copy = claudeConnectionCopy[locale];
  switch (reason) {
    case "expired-bridge-challenge":
      return copy.expired;
    case "invalid-bridge-challenge":
      return copy.invalidCode;
    case "bridge-version-mismatch":
      return copy.versionMismatch;
    case "bridge-identity-mismatch":
    case "unsupported-native-identity":
    case "native-identity-changed":
      return copy.identityMismatch;

    case "claude-bridge-binding-limit":
      return copy.connectionLimit;
    case "bridge-request-rejected":
      return copy.connectionRejected;
    case "platform-unsupported":
      return copy.platformUnsupported;
    case "claude-bridge-unavailable":
      return copy.bridgeUnavailable;
    case "claude-bridge-not-connected":
      return copy.disconnected;
    case "claude-bridge-disconnected":
      return copy.lost;
    case "claude-terminal-approval":
      return copy.approval;
    case "claude-bridge-event-gap":
      return copy.gap;
    case "claude-follower-turn-unconfirmed":
      return copy.turnUnconfirmed;
    case "claude-terminal-permission-unconfirmed":
      return copy.permissionUnconfirmed;
    case "claude-terminal-question":
      return copy.question;
    case "claude-follower-send-unverified":
      return copy.sendUnverified;
    case "claude-follower-attachments-unavailable":
      return copy.attachments;
    default:
      return undefined;
  }
}
