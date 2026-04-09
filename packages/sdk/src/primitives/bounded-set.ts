/** A Set that evicts the oldest entries when it exceeds maxSize. Uses a ring buffer for O(1) eviction. */
export class BoundedSet<T> {
  private items: (T | undefined)[];
  private set = new Set<T>();
  private head = 0;
  private count = 0;
  constructor(private maxSize: number) {
    if (maxSize <= 0) {
      throw new Error('BoundedSet maxSize must be positive.');
    }
    this.items = new Array(maxSize);
  }
  has(item: T): boolean {
    return this.set.has(item);
  }
  add(item: T): void {
    if (this.set.has(item)) {
      return;
    }
    if (this.count >= this.maxSize) {
      const evicted = this.items[this.head]!;
      this.set.delete(evicted);
    } else {
      this.count++;
    }
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.maxSize;
    this.set.add(item);
  }
}
