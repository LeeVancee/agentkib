type Locale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP";

const zh = {
  disconnectBeforeCode: "若要生成新的连接码，请先断开当前终端连接。",
  invalidCode: "连接码无效。请重新生成，并在目标终端使用完整的新连接码。",
  versionMismatch: "Claude Code 或插件版本不匹配。请按安装指引更新后重新连接。",
  identityMismatch: "目标终端与所选会话不匹配。请在所选会话的终端重新连接。",
  connectionUnconfirmed: "上次操作结果尚未确认。请先核对终端状态，再重新连接。",
  managedUnconfirmed:
    "上次操作及后台进程状态尚未确认，暂时无法在 AgentKib 中继续。你可以回到 Claude Code 继续这条会话；不会自动重发消息。",
  connectionLimit: "终端连接数量已达上限。请先断开不再使用的连接，再重试。",
  connectionRejected: "连接请求被拒绝。请检查终端与主机状态后重新连接。",

  handoff: "可以继续",
  handoffInfo: "直接输入即可继续这条会话。",
  released: "后台进程已结束",
  releasedInfo: "后台进程已结束，下次发送时会自动继续",
  lostTitle: "终端连接已断开",
  hostDisconnected: "与主机的连接已中断",
  hostDisconnectedInfo: "暂时无法核实终端状态。请检查与主机的连接，恢复后再操作。",
  manage: "管理终端连接",
  platformUnsupported: "连接终端仅支持 macOS。请在 macOS 主机上操作。",
  bridgeUnavailable: "终端桥接服务无法启动。请检查主机日志并重新启动 AgentKib 后重试。",
  requiredVersion: "需要 Claude Code",
  copyInstall: "复制安装命令",
  copyCommand: "复制连接命令",
  copyCode: "复制连接码",
  copied: "已复制",
  copyFailed: "复制失败，请手动选择并复制。",
  codeSafety: "连接码只用于你自己的终端，请勿发给他人。",
  disconnectInfo: "断开后，终端照常运行，AgentKib 停止同步。",
  confirmDisconnect: "确认断开",
  cancel: "取消",
  disconnectFirst: "终端已连接，消息会发送到终端。",
  connectionFailed: "终端连接失败：",

  title: "连接终端",
  connected: "在终端中运行 · 已连接",
  managed: "在 AgentKib 中运行",
  history: "仅可查看",
  notConnected: "未连接",
  info: "审批和提问在终端中处理。关闭 AgentKib 不会停止终端。",
  disconnected: "尚未连接终端。请在桌面打开连接指引，并在目标 Claude Code 会话中连接。",
  lost: "终端连接已断开，正在重新检查会话状态。",
  approval: "正在等待工具审批，请在终端处理。",
  question: "正在等待问题回答，请在终端处理。",
  gap: "事件同步出现缺口，正在重新读取快照和原生历史；恢复前暂停控制。",
  turnUnconfirmed: "终端正在执行，当前轮次身份尚未核实；暂不能取消，请在终端处理。",
  permissionUnconfirmed: "终端曾请求工具审批，当前授权或执行状态尚未核实，请查看终端。",
  attachments: "终端连接尚未验证附件输入，请在终端添加附件。",
  sendUnverified: "消息发送和停止请在终端处理，AgentKib 会同步显示。",
  generate: "生成一次性连接码",
  disconnect: "断开终端连接",
  refresh: "检查连接",
  loading: "正在检查连接…",
  failed: "无法完成连接操作，请检查主机状态后重试。",
  expires: "连接码有效至",
  expired: "连接码已过期，请重新生成。",
  instructions: "先按以下指引安装插件，再在目标终端执行连接命令；连接本身不会发送消息。",
  localOnly: "插件安装和连接管理仅在本机桌面提供。",
};
type Copy = { [K in keyof typeof zh]: string };
export const claudeConnectionCopy: Record<Locale, Copy> = {
  "zh-CN": zh,
  "zh-TW": {
    disconnectBeforeCode: "若要產生新的連線碼，請先中斷目前終端連線。",
    invalidCode: "連線碼無效。請重新產生，並在目標終端使用完整的新連線碼。",
    versionMismatch: "Claude Code 或外掛版本不符。請依安裝指引更新後重新連接。",
    identityMismatch: "目標終端與所選對話不符。請在所選對話的終端重新連接。",
    connectionUnconfirmed: "上次操作結果尚未確認。請先核對終端狀態，再重新連接。",
    managedUnconfirmed:
      "上次操作與背景程序狀態尚未確認，暫時無法在 AgentKib 中繼續。你可以回到 Claude Code 繼續這段對話；不會自動重送訊息。",
    connectionLimit: "終端連線數量已達上限。請先中斷不再使用的連線，再重試。",
    connectionRejected: "連線要求遭拒。請檢查終端與主機狀態後重新連接。",

    handoff: "可以繼續",
    handoffInfo: "直接輸入即可繼續這段對話。",
    released: "背景程序已結束",
    releasedInfo: "背景程序已結束，下次傳送訊息時會自動繼續",
    lostTitle: "終端連線已中斷",
    hostDisconnected: "與主機的連線已中斷",
    hostDisconnectedInfo: "暫時無法核實終端狀態。請檢查與主機的連線，恢復後再操作。",
    manage: "管理終端連線",
    platformUnsupported: "連接終端僅支援 macOS。請在 macOS 主機上操作。",
    bridgeUnavailable: "終端橋接服務無法啟動。請檢查主機記錄並重新啟動 AgentKib 後重試。",
    requiredVersion: "需要 Claude Code",
    copyInstall: "複製安裝命令",
    copyCommand: "複製連線命令",
    copyCode: "複製連線碼",
    copied: "已複製",
    copyFailed: "複製失敗，請手動選取並複製。",
    codeSafety: "連線碼僅用於你自己的終端，請勿傳給他人。",
    disconnectInfo: "中斷後，終端照常執行，AgentKib 停止同步。",
    confirmDisconnect: "確認中斷",
    cancel: "取消",
    disconnectFirst: "終端已連線，訊息會傳送到終端。",
    connectionFailed: "終端連線失敗：",

    title: "連接終端",
    connected: "在終端中執行 · 已連線",
    managed: "在 AgentKib 中執行",
    history: "僅可查看",
    notConnected: "未連線",
    info: "核准和提問在終端中處理。關閉 AgentKib 不會停止終端。",
    disconnected: "尚未連接終端。請在桌面開啟連線指引，並在目標 Claude Code 對話中連接。",
    lost: "終端連線已中斷，正在重新檢查對話狀態。",
    approval: "正在等待工具審批，請在終端處理。",
    question: "正在等待問題回答，請在終端處理。",
    gap: "事件同步出現缺口，正在重新讀取快照與原生歷史；恢復前暫停控制。",
    turnUnconfirmed: "終端正在執行，目前輪次身分尚未核實；暫時無法取消，請在終端處理。",
    permissionUnconfirmed: "終端曾要求工具審批，目前授權或執行狀態尚未核實，請查看終端。",
    attachments: "終端連線尚未驗證附件輸入，請在終端新增附件。",
    sendUnverified: "訊息傳送和停止請在終端處理，AgentKib 會同步顯示。",
    generate: "產生一次性連線碼",
    disconnect: "中斷終端連線",
    refresh: "檢查連線",
    loading: "正在檢查連線…",
    failed: "無法完成連線操作，請檢查主機狀態後重試。",
    expires: "連線碼有效至",
    expired: "連線碼已過期，請重新產生。",
    instructions: "先依照以下指引安裝外掛，再於目標終端執行連線命令；連線本身不會傳送訊息。",
    localOnly: "外掛安裝與連線管理僅在本機桌面提供。",
  },
  "en-US": {
    disconnectBeforeCode:
      "Disconnect the current terminal before generating a new connection code.",
    invalidCode:
      "The connection code is invalid. Generate a new code and use it in full in the target terminal.",
    versionMismatch:
      "The Claude Code or plugin version does not match. Update using the installation guide and reconnect.",
    identityMismatch:
      "The terminal does not match the selected session. Reconnect from that session’s terminal.",
    connectionUnconfirmed:
      "The previous outcome is unconfirmed. Check the terminal state before reconnecting.",
    managedUnconfirmed:
      "The previous operation and background process state are unconfirmed, so this session cannot continue in AgentKib yet. You can continue it in Claude Code. Messages will not be resent automatically.",
    connectionLimit:
      "The terminal connection limit was reached. Disconnect unused connections and retry.",
    connectionRejected:
      "The connection request was rejected. Check the terminal and host, then reconnect.",

    handoff: "Ready to continue",
    handoffInfo: "Type a message to continue this session.",
    released: "Background process ended",
    releasedInfo:
      "The background process ended. It will resume automatically when you send your next message.",
    lostTitle: "Terminal disconnected",
    hostDisconnected: "Host connection lost",
    hostDisconnectedInfo:
      "The terminal's state cannot be checked. Restore the connection to the host before continuing.",
    manage: "Manage terminal connection",
    platformUnsupported: "Connecting the terminal requires macOS. Use a macOS host.",
    bridgeUnavailable:
      "The terminal bridge could not start. Check the host logs and restart AgentKib before retrying.",
    requiredVersion: "Requires Claude Code",
    copyInstall: "Copy install command",
    copyCommand: "Copy connection command",
    copyCode: "Copy connection code",
    copied: "Copied",
    copyFailed: "Copy failed. Select and copy the text manually.",
    codeSafety: "Use this code only in your own terminal. Do not share it with others.",
    disconnectInfo: "The terminal keeps running after disconnection. AgentKib stops synchronizing.",
    confirmDisconnect: "Confirm disconnect",
    cancel: "Cancel",
    disconnectFirst: "The terminal is connected. Messages are sent to the terminal.",
    connectionFailed: "Terminal connection failed: ",

    title: "Connect terminal",
    connected: "Running in terminal · Connected",
    managed: "Running in AgentKib",
    history: "View only",
    notConnected: "Not connected",
    info: "Handle approvals and questions in the terminal. Closing AgentKib does not stop the terminal.",
    disconnected:
      "The terminal is not connected. Open the desktop connection guide and connect from the target Claude Code session.",
    lost: "The terminal disconnected. Rechecking the session state.",
    approval: "Waiting for tool approval. Please handle it in the terminal.",
    question: "Waiting for an answer. Please respond in the terminal.",
    gap: "Some live events were missed. Reloading the snapshot and native history; controls are paused until recovery.",
    turnUnconfirmed:
      "The terminal is running, but the current turn identity is unconfirmed. Cancel in the terminal for now.",
    permissionUnconfirmed:
      "The terminal requested tool approval. Its current approval or execution state is unconfirmed; check the terminal.",
    attachments:
      "Attachment input is not verified for terminal connections. Add attachments in the terminal.",
    sendUnverified:
      "Send messages and stop turns in the terminal. AgentKib keeps the session in sync.",
    generate: "Generate one-time connection code",
    disconnect: "Disconnect terminal",
    refresh: "Check connection",
    loading: "Checking connection…",
    failed: "The connection operation failed. Check the host state and try again.",
    expires: "Connection code expires at",
    expired: "The connection code expired. Generate a new one.",
    instructions:
      "Install the plugin using the guide below, then run its connection command in the target terminal. Connecting does not send a message.",
    localOnly:
      "Plugin installation and connection management are available on the local desktop only.",
  },
  "ja-JP": {
    disconnectBeforeCode:
      "新しい接続コードを生成するには、現在のターミナル接続を先に切断してください。",
    invalidCode:
      "接続コードが無効です。新しいコードを生成し、対象ターミナルで完全なコードを使用してください。",
    versionMismatch:
      "Claude Code またはプラグインのバージョンが一致しません。インストールガイドに従って更新し、再接続してください。",
    identityMismatch:
      "ターミナルが選択した会話と一致しません。その会話のターミナルから再接続してください。",
    connectionUnconfirmed:
      "前回の操作結果が未確認です。ターミナルの状態を確認してから再接続してください。",
    managedUnconfirmed:
      "前の操作とバックグラウンドプロセスの状態を確認できないため、AgentKib ではまだ会話を続けられません。Claude Code に戻ってこの会話を続けられます。メッセージは自動で再送されません。",
    connectionLimit:
      "ターミナルの接続数が上限に達しました。未使用の接続を切断して再試行してください。",
    connectionRejected:
      "接続要求が拒否されました。ターミナルとホストを確認して再接続してください。",

    handoff: "続行可能",
    handoffInfo: "メッセージを入力すると、この会話を続けられます。",
    released: "バックグラウンドプロセスを終了",
    releasedInfo:
      "バックグラウンドプロセスを終了しました。次のメッセージ送信時に自動で続行します。",
    lostTitle: "ターミナルとの接続が切断",
    hostDisconnected: "ホストとの接続が切れました",
    hostDisconnectedInfo:
      "ターミナルの状態を確認できません。ホストとの接続を復旧してから操作してください。",
    manage: "ターミナル接続を管理",
    platformUnsupported:
      "ターミナルへの接続は macOS のみ対応です。macOS ホストで操作してください。",
    bridgeUnavailable:
      "ターミナルブリッジを起動できません。ホストのログを確認し、AgentKib を再起動して再試行してください。",
    requiredVersion: "必要な Claude Code",
    copyInstall: "インストールコマンドをコピー",
    copyCommand: "接続コマンドをコピー",
    copyCode: "接続コードをコピー",
    copied: "コピーしました",
    copyFailed: "コピーに失敗しました。手動でテキストを選択してコピーしてください。",
    codeSafety: "接続コードは自分のターミナルでのみ使用し、他の人に共有しないでください。",
    disconnectInfo: "切断後もターミナルは実行を続け、AgentKib は同期を停止します。",
    confirmDisconnect: "切断を確認",
    cancel: "キャンセル",
    disconnectFirst: "ターミナルに接続済みです。メッセージはターミナルに送信されます。",
    connectionFailed: "ターミナルへの接続に失敗しました：",

    title: "ターミナルに接続",
    connected: "ターミナルで実行中 · 接続済み",
    managed: "AgentKib で実行中",
    history: "閲覧のみ",
    notConnected: "未接続",
    info: "承認と質問はターミナルで対応してください。AgentKib を閉じてもターミナルは停止しません。",
    disconnected:
      "ターミナルに未接続です。デスクトップの接続ガイドを開き、対象の Claude Code 会話から接続してください。",
    lost: "ターミナルとの接続が切れました。会話の状態を再確認しています。",
    approval: "ツールの承認待ちです。ターミナルで処理してください。",
    question: "回答待ちです。ターミナルで回答してください。",
    gap: "イベントの欠落を検出しました。スナップショットと元の履歴を再取得しています。復旧まで操作は停止します。",
    turnUnconfirmed:
      "ターミナルは実行中ですが、現在のターンIDは未確認です。キャンセルはターミナルで行ってください。",
    permissionUnconfirmed:
      "ターミナルでツール承認が要求されました。現在の承認・実行状態は未確認です。ターミナルを確認してください。",
    attachments: "ターミナル接続の添付入力は未検証です。ターミナルで追加してください。",
    sendUnverified:
      "メッセージの送信とターンの停止はターミナルで行ってください。AgentKib に同期して表示されます。",
    generate: "一回限りの接続コードを生成",
    disconnect: "ターミナルとの接続を解除",
    refresh: "接続を確認",
    loading: "接続を確認中…",
    failed: "接続操作に失敗しました。ホストの状態を確認して再試行してください。",
    expires: "接続コードの有効期限",
    expired: "接続コードの期限が切れました。再生成してください。",
    instructions:
      "以下のガイドでプラグインをインストールし、対象ターミナルで接続コマンドを実行してください。接続自体はメッセージを送信しません。",
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
