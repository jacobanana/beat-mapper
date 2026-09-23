/** A minimal typed pub/sub: listeners per topic, plus '*' for every topic. */
export class Emitter<T extends string> {
  private listeners = new Map<T | '*', Set<(topic: T) => void>>();

  on(topic: T | '*' | readonly T[], fn: (topic: T) => void): () => void {
    const topics = Array.isArray(topic) ? topic : [topic as T | '*'];
    for (const t of topics) {
      let set = this.listeners.get(t);
      if (!set) this.listeners.set(t, (set = new Set()));
      set.add(fn);
    }
    return () => { for (const t of topics) this.listeners.get(t)?.delete(fn); };
  }

  emit(...topics: T[]): void {
    const called = new Set<(topic: T) => void>();
    for (const topic of topics) {
      for (const fn of [...(this.listeners.get(topic) ?? []), ...(this.listeners.get('*') ?? [])]) {
        if (called.has(fn)) continue;
        called.add(fn);
        fn(topic);
      }
    }
  }
}
