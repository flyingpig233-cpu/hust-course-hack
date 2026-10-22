// Minimal pub/sub used by the demo backend to imitate Tauri events.
const listeners = new Map<string, Set<(payload: unknown) => void>>();

export function demoOn<T>(
  channel: string,
  handler: (payload: T) => void,
): () => void {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  const wrapped = handler as (payload: unknown) => void;
  set.add(wrapped);
  return () => {
    set.delete(wrapped);
  };
}

export function demoEmit<T>(channel: string, payload: T): void {
  for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
}
