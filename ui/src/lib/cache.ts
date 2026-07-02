const store = new Map<string, Promise<unknown>>();

export function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!store.has(key)) {
    // Evict on rejection — otherwise one transient failure (network blip, cold
    // Ollama) poisons this key for the rest of the session, re-throwing on every
    // subsequent read even after the underlying request would now succeed.
    const promise = fn().catch((err: unknown) => {
      store.delete(key);
      throw err;
    });
    store.set(key, promise);
  }
  return store.get(key) as Promise<T>;
}

export function invalidate(key: string) {
  store.delete(key);
}

export function invalidateAll() {
  store.clear();
}
