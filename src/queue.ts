// Serialize ingestion/removal to avoid common create/delete races; bound queued work.
export class EventQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private onError: () => void;
  readonly capacity: number;
  constructor(onError: () => void, capacity = 1000) { this.onError = onError; this.capacity = capacity; }
  enqueue(task: () => Promise<unknown>): boolean {
    if (this.pending >= this.capacity) return false;
    this.pending++;
    this.tail = this.tail.then(task).then(() => undefined).catch(() => this.onError())
      .finally(() => { this.pending--; });
    return true;
  }
  drain(): Promise<void> { return this.tail; }
}
