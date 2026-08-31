import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";

const APP_HISTORY_LIMIT = 10;

type AppHistoryAction = "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";

export interface AppHistoryLocation {
  href: string;
  pathname: string;
  search: string;
  hash: string;
  state: {
    key?: string;
    __TSR_key?: string;
    __TSR_index: number;
  };
}

export interface AppHistoryEntry {
  key: string;
  href: string;
  pathname: string;
  search: string;
  hash: string;
  browserIndex: number;
}

export interface AppHistoryState {
  entries: AppHistoryEntry[];
  cursor: number;
}

function historyEntry(location: AppHistoryLocation): AppHistoryEntry {
  return {
    key:
      location.state.__TSR_key ??
      location.state.key ??
      `${location.state.__TSR_index}:${location.href}`,
    href: location.href,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    browserIndex: location.state.__TSR_index,
  };
}

export function createAppHistoryState(location: AppHistoryLocation): AppHistoryState {
  return { entries: [historyEntry(location)], cursor: 0 };
}

export function updateAppHistoryState(
  state: AppHistoryState,
  location: AppHistoryLocation,
  action: AppHistoryAction,
): AppHistoryState {
  const entry = historyEntry(location);

  if (action === "PUSH") {
    const entries = state.entries.slice(0, state.cursor + 1);
    const current = entries.at(-1);
    if (current?.href === entry.href) {
      entries[entries.length - 1] = entry;
      return { entries, cursor: entries.length - 1 };
    }
    entries.push(entry);
    if (entries.length > APP_HISTORY_LIMIT) entries.splice(0, entries.length - APP_HISTORY_LIMIT);
    return { entries, cursor: entries.length - 1 };
  }

  if (action === "REPLACE") {
    const entries = [...state.entries];
    entries[state.cursor] = entry;
    return { entries, cursor: state.cursor };
  }

  const cursor = state.entries.findIndex(
    (candidate) =>
      candidate.key === entry.key ||
      (candidate.browserIndex === entry.browserIndex && candidate.href === entry.href),
  );
  return cursor >= 0 ? { entries: state.entries, cursor } : createAppHistoryState(location);
}

export function useAppHistory(beforeMove: (target: AppHistoryEntry) => Promise<boolean> | boolean) {
  const router = useRouter();
  const [historyState, setHistoryState] = useState(() =>
    createAppHistoryState(router.history.location as AppHistoryLocation),
  );
  const [moving, setMoving] = useState(false);
  const releaseTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return router.history.subscribe(({ location, action }) => {
      if (releaseTimer.current !== undefined) window.clearTimeout(releaseTimer.current);
      releaseTimer.current = undefined;
      setMoving(false);
      setHistoryState((state) =>
        updateAppHistoryState(state, location as AppHistoryLocation, action.type),
      );
    });
  }, [router]);

  useEffect(
    () => () => {
      if (releaseTimer.current !== undefined) window.clearTimeout(releaseTimer.current);
    },
    [],
  );

  const move = useCallback(
    async (delta: -1 | 1) => {
      if (moving) return;
      const target = historyState.entries[historyState.cursor + delta];
      if (!target) return;

      setMoving(true);
      if (!(await beforeMove(target))) {
        setMoving(false);
        return;
      }

      const current = historyState.entries[historyState.cursor];
      const browserDelta = target.browserIndex - current.browserIndex;
      if (browserDelta === 0) {
        setMoving(false);
        return;
      }
      router.history.go(browserDelta);
      releaseTimer.current = window.setTimeout(() => {
        releaseTimer.current = undefined;
        setMoving(false);
      }, 1000);
    },
    [beforeMove, historyState, moving, router],
  );

  return {
    canGoBack: !moving && historyState.cursor > 0,
    canGoForward: !moving && historyState.cursor < historyState.entries.length - 1,
    goBack: () => void move(-1),
    goForward: () => void move(1),
    moving,
  };
}
