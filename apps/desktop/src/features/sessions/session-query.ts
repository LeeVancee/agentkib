import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import { homeKeys, queryDefaults } from "@/features/home/home-query";

export const sessionKeys = {
  status: (id: string) => [...homeKeys.continuations(id), "status"] as const,
  history: (workspaceId: string, id: string, remote: unknown, revision: number) =>
    ["session-history", workspaceId, id, remote, revision] as const,
  capability: (id: string, revision: number) => ["session-capability", id, revision] as const,
};

// Electron RPC cannot be aborted once sent. Keep its slot until it settles and
// reuse the physical read if a cancelled Query is observed again before then.
let active = 0;
const queue: Array<() => void> = [];
const pending = new WeakMap<
  QueryClient,
  Map<string, { signals: Set<AbortSignal>; promise: Promise<unknown> }>
>();
function drain() {
  while (active < 4 && queue.length) queue.shift()!();
}
export function queuedSessionRead<T>(
  client: QueryClient,
  key: string,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  let requests = pending.get(client);
  if (!requests) {
    requests = new Map();
    pending.set(client, requests);
  }
  let entry = requests.get(key);
  if (!entry) {
    const signals = new Set([signal]);
    const promise = new Promise<T>((resolve, reject) => {
      queue.push(() => {
        if ([...signals].every((item) => item.aborted)) {
          reject(new DOMException("Cancelled", "AbortError"));
          return;
        }
        active += 1;
        const finish = () => {
          active -= 1;
          drain();
        };
        try {
          void read().then(resolve, reject).finally(finish);
        } catch (error) {
          reject(error);
          finish();
        }
      });
    });
    entry = { signals, promise };
    requests.set(key, entry);
    const cleanup = () => {
      if (requests!.get(key) === entry) requests!.delete(key);
    };
    void promise.then(cleanup, cleanup);
    drain();
  } else entry.signals.add(signal);
  return (entry.promise as Promise<T>).then((value) => {
    signal.throwIfAborted();
    return value;
  });
}

export function sessionListOptions(client: QueryClient, id: string) {
  const queryKey = homeKeys.continuations(id);
  return queryOptions({
    ...queryDefaults,
    queryKey,
    queryFn: async ({ signal }) => {
      const before = client.getQueryState(queryKey)?.dataUpdateCount;
      const records = await queuedSessionRead(client, `sessions:${id}`, signal, () =>
        api.workspaceSessions(id),
      );
      const latest = client.getQueryData<typeof records>(queryKey);
      return client.getQueryState(queryKey)?.dataUpdateCount !== before && latest !== undefined
        ? latest
        : records;
    },
  });
}
export function sessionStatusOptions(client: QueryClient, id: string) {
  return queryOptions({
    ...queryDefaults,
    queryKey: sessionKeys.status(id),
    queryFn: ({ signal }) =>
      queuedSessionRead(client, `status:${id}`, signal, () => api.workspaceSessionStatus(id)),
  });
}
