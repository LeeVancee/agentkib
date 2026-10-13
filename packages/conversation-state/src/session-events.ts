type Listener = (sessionId: string, domains: string[]) => void;
const listeners = new WeakMap<object, Set<Listener>>();

export function publishSessionInvalidation(client: object, sessionId: string, domains: string[]) {
  for (const listener of listeners.get(client) ?? []) listener(sessionId, domains);
}

export function subscribeSessionInvalidation(client: object, listener: Listener) {
  const entries = listeners.get(client) ?? new Set<Listener>();
  entries.add(listener);
  listeners.set(client, entries);
  return () => {
    entries.delete(listener);
  };
}
