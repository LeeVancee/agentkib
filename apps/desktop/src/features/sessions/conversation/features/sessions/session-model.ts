export {
  MAX_MESSAGE_LENGTH,
  beginHistoryRead,
  completeHistoryRead,
  failHistoryRead,
  hasAppliedNewerHistory,
  isValidMessage,
  mergeLatestPage,
  mergeNativeCoverage,
  mergeOrderedPersistedHistory,
  mergePersistedHistory,
  removePersistedOverlays,
} from "@agentkib/conversation-state";
export type { HistoryReadAttempt, NativeCoverage } from "@agentkib/conversation-state";
