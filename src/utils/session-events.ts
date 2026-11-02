const listeners = new Map<number, Set<() => void>>();
export function onSessionRevoked(userId: number, close: () => void) {
  const callbacks = listeners.get(userId) ?? new Set(); callbacks.add(close); listeners.set(userId, callbacks);
  return () => { callbacks.delete(close); if (!callbacks.size) listeners.delete(userId); };
}
export function revokeLiveSessions(userId: number) {
  for (const close of listeners.get(userId) ?? []) {
    try { close(); } catch { /* The idle watcher remains a fallback for failed socket cleanup. */ }
  }
}
