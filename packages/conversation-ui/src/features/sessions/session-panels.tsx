/** @jsxImportSource octane */

import { createContext, useContext } from "octane";
export type SessionPanels = {
  filesOpen: boolean;
  setFilesOpen: (open: boolean) => void;
  actionsOpen: boolean;
  setActionsOpen: (open: boolean) => void;
};
export const SessionPanelsContext = createContext<SessionPanels | null>(null);
export function useSessionPanels() {
  return useContext(SessionPanelsContext);
}
