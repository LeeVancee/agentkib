import type { WebClient } from "@agentkib/web-client";

type Listener = (sessionId: string, domains: string[]) => void;
const listeners = new WeakMap<WebClient, Set<Listener>>();

export function publishSessionInvalidation(
  client: WebClient,
  sessionId: string,
  domains: string[],
) {
  for (const listener of listeners.get(client) ?? []) listener(sessionId, domains);
}

export function subscribeSessionInvalidation(client: WebClient, listener: Listener) {
  const entries = listeners.get(client) ?? new Set<Listener>();
  entries.add(listener);
  listeners.set(client, entries);
  return () => {
    entries.delete(listener);
  };
}
