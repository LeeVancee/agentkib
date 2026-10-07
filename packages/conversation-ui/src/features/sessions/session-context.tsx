/** @jsxImportSource octane */

import { createContext, useContext, type ReactNode } from "octane";
import { ToastViewport } from "../../components/toast";
import { codexCopy } from "./codex-copy";
import {
  useSessionController,
  type SessionController,
  type SessionOptions,
} from "./use-session-controller";

const SessionContext = createContext<SessionController | null>(null);
export function SessionProvider({
  children,
  ...options
}: SessionOptions & { children: ReactNode }) {
  const value = useSessionController(options);
  return (
    <SessionContext value={value}>
      {children}
      <ToastViewport closeLabel={codexCopy[value.locale].close} />
    </SessionContext>
  );
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is missing");
  return value;
}
