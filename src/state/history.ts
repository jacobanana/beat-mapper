/**
 * Undo/redo over immutable snapshots. Because documents are never mutated, a snapshot is just a
 * reference: recording costs nothing, and any field added to the document is undoable for free.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private readonly limit = 120) {}

  /** Remembers `current` as the state to go back to, and forgets anything that was undone. */
  record(current: T): void {
    this.past.push(current);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
}
