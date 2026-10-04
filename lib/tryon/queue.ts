/** Tiny in-process job queue with a concurrency limit (the app runs on one long-lived Node server). */
export class JobQueue {
  private running = 0;
  private waiting: Array<() => Promise<void>> = [];
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly concurrency = 2) {}

  push(job: () => Promise<void>) {
    this.waiting.push(job);
    this.pump();
  }

  private pump() {
    while (this.running < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      void job()
        .catch((err) => console.error("[jobs] job failed", err))
        .finally(() => {
          this.running--;
          this.pump();
          if (!this.running && !this.waiting.length) this.idleWaiters.splice(0).forEach((r) => r());
        });
    }
  }

  /** Resolves when nothing is running or waiting (tests, graceful shutdown). */
  idle(): Promise<void> {
    return !this.running && !this.waiting.length ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }
}
