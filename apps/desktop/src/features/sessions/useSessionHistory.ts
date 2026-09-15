/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "octane";
import { api } from "@/core/api";
import { readRemoteHistory } from "@/features/remote/remote-catalog-store";
import type { ConversationEvent, ConversationSessionSummary } from "@/core/types";

interface HistoryState {
  key: string;
  events: ConversationEvent[];
  warnings: string[];
  loading: boolean;
  error: unknown;
  loadingEarlier: boolean;
  nextCursor?: string;
}

function emptyHistory(key: string, loading = false): HistoryState {
  return { key, events: [], warnings: [], loading, error: "", loadingEarlier: false };
}

function uniqueEvents(events: ConversationEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

export function useSessionHistory(
  session: ConversationSessionSummary | undefined,
  enabled: boolean,
  revision = 0,
) {
  const { localizeMessage } = useI18n();
  const sessionRef = useRef(session);
  const sessionId = enabled && session?.availability === "readable" ? session.id : "";
  const key = sessionId ? JSON.stringify([session?.workspace_id, sessionId, revision]) : "";
  const [state, setState] = useState<HistoryState>(() => emptyHistory(key, !!key));
  const activeKey = useRef("");
  const sequence = useRef(0);
  const availableCursor = useRef<string | undefined>(undefined);
  const pending = useRef({ initial: false, earlier: false });

  // Invalidate at commit, before passive effects, so an old page cannot refill a new selection.
  useLayoutEffect(() => {
    sessionRef.current = session;
    activeKey.current = key;
    sequence.current += 1;
    availableCursor.current = undefined;
    pending.current = { initial: false, earlier: false };
    return () => {
      activeKey.current = "";
      sequence.current += 1;
    };
  }, [key, session]);

  const read = useCallback(
    async (stateCleared = false) => {
      if (!sessionId || activeKey.current !== key || pending.current.initial) return;
      const request = ++sequence.current;
      pending.current = { initial: true, earlier: false };
      availableCursor.current = undefined;
      const currentSession = sessionRef.current;
      const pagePromise = currentSession?.remote
        ? readRemoteHistory(currentSession)
        : api.sessionEvents(sessionId);
      await Promise.resolve();
      if (!stateCleared) setState(emptyHistory(key, true));
      const isCurrent = () => activeKey.current === key && sequence.current === request;
      try {
        const page = await pagePromise;
        if (!isCurrent()) return;
        availableCursor.current = page.next_cursor;
        setState({
          ...emptyHistory(key),
          events: uniqueEvents(page.events),
          warnings: [...new Set(page.warnings)],
          nextCursor: page.next_cursor,
        });
      } catch (reason) {
        if (isCurrent()) setState({ ...emptyHistory(key), error: reason });
      } finally {
        if (isCurrent()) pending.current.initial = false;
      }
    },
    [key, sessionId],
  );

  useEffect(() => {
    if (!key) {
      void Promise.resolve().then(() => setState(emptyHistory("")));
      return;
    }
    void read();
  }, [key, read]);

  const retry = useCallback(() => {
    if (!sessionId || activeKey.current !== key || pending.current.initial) return;
    setState(emptyHistory(key, true));
    void read(true);
  }, [key, read, sessionId]);

  const loadEarlier = useCallback(async () => {
    if (
      !sessionId ||
      activeKey.current !== key ||
      state.key !== key ||
      !state.nextCursor ||
      state.nextCursor !== availableCursor.current ||
      pending.current.initial ||
      pending.current.earlier
    ) {
      return;
    }
    const request = sequence.current;
    const cursor = state.nextCursor;
    pending.current.earlier = true;
    setState((current) => ({ ...current, loadingEarlier: true, error: "" }));
    const isCurrent = () => activeKey.current === key && sequence.current === request;
    try {
      const currentSession = sessionRef.current;
      const page = currentSession?.remote
        ? await readRemoteHistory(currentSession, cursor)
        : await api.sessionEvents(sessionId, cursor);
      if (!isCurrent()) return;
      availableCursor.current = page.next_cursor;
      setState((current) => ({
        ...current,
        events: uniqueEvents([...page.events, ...current.events]),
        // A scan-budget notice describes the current cursor window, not permanent damage.
        warnings: [
          ...new Set([
            ...page.warnings,
            ...current.warnings.filter((warning) => warning !== "TRANSCRIPT_SCAN_BUDGET"),
          ]),
        ],
        nextCursor: page.next_cursor,
        loadingEarlier: false,
      }));
    } catch (reason) {
      if (isCurrent()) {
        setState((current) => ({
          ...current,
          loadingEarlier: false,
          error: reason,
        }));
      }
    } finally {
      if (isCurrent()) pending.current.earlier = false;
    }
  }, [key, sessionId, state.key, state.nextCursor]);

  // Render-time gating also prevents one frame of the previous conversation before effects run.
  const visible = state.key === key ? state : emptyHistory(key, !!key);
  return {
    ...visible,
    rawError: visible.error,
    error: visible.error ? localizeMessage(visible.error) : "",
    loadEarlier,
    retry,
  };
}
/** @jsxImportSource octane */
