/**
 * Serialization primitives shared by the chat stores (thread + active session).
 *
 * Every store mutation is serialized twice, per the stage-2 design
 * (docs/plans/job-conversation-context-stage2-3.md):
 *
 * 1. an in-process per-key FIFO queue - two same-tab writers never interleave,
 *    even when the Web Locks API is unavailable;
 * 2. a `navigator.locks` mutex whose name equals the storage key - cross-tab
 *    exclusion for the check-then-act sequences (localStorage is synchronous,
 *    but a read-decide-write spanning it is not).
 *
 * When `navigator.locks` is missing, writes still serialize in-process and the
 * cross-tab worst case degrades to last-writer-wins - degraded, stated, not
 * silent (paid thread entries are re-derived by the next tab-open reconcile +
 * hydration).
 */

export interface LocksAdapter {
  /** Run `task` while holding the exclusive lock `name`. */
  withLock<T>(name: string, task: () => Promise<T>): Promise<T>;
}

/** Real Web Locks API, falling back to plain execution when unavailable. */
export const webLocks: LocksAdapter = {
  withLock(name, task) {
    if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
      return navigator.locks.request(name, task);
    }
    return task();
  },
};

export type QueuedRunner = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * Per-key in-process FIFO queue (the MCP `withLock` pattern): each task runs
 * strictly after the previous task for the same key, whether that task
 * resolved or rejected. Rejections propagate to the task's own caller but
 * never poison the chain.
 */
export function createKeyedQueue(): QueuedRunner {
  const tails = new Map<string, Promise<void>>();
  return function runQueued<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = tails.get(key) ?? Promise.resolve();
    const run = tail.then(task);
    const nextTail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, nextTail);
    void nextTail.then(() => {
      if (tails.get(key) === nextTail) {
        tails.delete(key);
      }
    });
    return run;
  };
}
