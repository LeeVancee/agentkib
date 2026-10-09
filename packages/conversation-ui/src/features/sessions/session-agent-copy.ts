import type { Locale } from "../../i18n";

export const sessionAgentCopy: Record<
  Locale,
  {
    permission: string;
    queue: string;
    pauseQueue: string;
    resumeQueue: string;
    queuePaused: string;
    queueRecovery: string;
  }
> = {
  "zh-CN": {
    permission: "工具权限",
    queue: "待发送队列",
    pauseQueue: "暂停队列",
    resumeQueue: "恢复队列",
    queuePaused: "队列已暂停，恢复后才会继续执行。",
    queueRecovery: "队列不会自动继续。请确认后恢复执行。",
  },
  "zh-TW": {
    permission: "工具權限",
    queue: "待傳送佇列",
    pauseQueue: "暫停佇列",
    resumeQueue: "恢復佇列",
    queuePaused: "佇列已暫停，恢復後才會繼續執行。",
    queueRecovery: "佇列不會自動繼續。請確認後恢復執行。",
  },
  "en-US": {
    permission: "Tool permissions",
    queue: "Submission queue",
    pauseQueue: "Pause queue",
    resumeQueue: "Resume queue",
    queuePaused: "The queue is paused. Resume it to continue execution.",
    queueRecovery: "The queue will not continue automatically. Confirm by resuming it to continue.",
  },
  "ja-JP": {
    permission: "ツール権限",
    queue: "送信待ちキュー",
    pauseQueue: "キューを一時停止",
    resumeQueue: "キューを再開",
    queuePaused: "キューは一時停止中です。再開すると実行を続けます。",
    queueRecovery: "キューは自動的に続行されません。確認してから再開してください。",
  },
};
