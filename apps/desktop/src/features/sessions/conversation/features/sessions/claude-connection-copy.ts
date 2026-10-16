import type { SupportedLocale as Locale } from "@/core/types";

const zh = {
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
    title: "連接原 Claude 終端",
    connected: "已連接原會話",
    managed: "由 AgentKib 執行",
    history: "僅查看歷史",
    info: "同步觀察原 Claude Code 會話，可取消目前輪次。關閉 AgentKib 不會停止原終端。",
    disconnected: "尚未連接原終端。請在桌面開啟連線指引，並在目標 Claude Code 會話中連接。",
    lost: "原終端連線已中斷。請在原終端重新連接；不會另啟執行程序。",
    approval: "正在等待工具審批，請在原終端處理。",
    question: "正在等待問題回答，請在原終端處理。",
    gap: "事件同步出現缺口，正在重新讀取快照與原生歷史；恢復前暫停控制。",
    turnUnconfirmed: "原終端正在執行，目前輪次身分尚未核實；暫時無法取消，請在原終端處理。",
    permissionUnconfirmed: "原終端曾要求工具審批，目前授權或執行狀態尚未核實，請查看原終端。",
    attachments: "原終端連線尚未驗證附件輸入，請在原終端新增附件。",
    sendUnverified: "原會話傳送尚未開放，請在原終端傳送；AgentKib 可同步觀察並取消目前輪次。",
    generate: "產生一次性連線碼",
    disconnect: "中斷原終端連線",
    refresh: "檢查連線",
    loading: "正在檢查連線…",
    failed: "無法完成連線操作，請檢查主機狀態後重試。",
    expires: "連線碼有效至",
    expired: "連線碼已過期，請重新產生。",
    instructions: "先依照以下指引安裝外掛，再於目標終端執行連線命令；連接不會傳送訊息或接管會話。",
    localOnly: "外掛安裝與連線管理僅在本機桌面提供。",
  },
  "en-US": {
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
