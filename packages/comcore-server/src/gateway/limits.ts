import { isIPv6 } from 'node:net';

/**
 * The key a per-IP limit counts under (2.4): the IPv4 address, or the IPv6
 * /64 prefix, since one IPv6 host can rotate through a whole /64.
 */
export function ipKey(address: string): string {
  const bare = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/u, '');
  if (!isIPv6(bare)) {
    return bare;
  }
  const [head = '', tail = ''] = bare.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const groups = bare.includes('::')
    ? [
        ...headGroups,
        ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'),
        ...tailGroups,
      ]
    : headGroups;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/u, ''))
    .join(':')}::/64`;
}

/**
 * A fixed-window counter: at most `limit` hits per key per window. The gateway
 * keeps IPs only inside these windows and never logs them with V (3).
 */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Count a hit; false when the key is over its limit in the current window. */
  hit(key: string, nowMs: number, limit: number = this.limit): boolean {
    for (const [stored, window] of this.windows) {
      if (nowMs - window.start >= this.windowMs) {
        this.windows.delete(stored);
      }
    }
    const window = this.windows.get(key);
    if (!window) {
      this.windows.set(key, { start: nowMs, count: 1 });
      return true;
    }
    if (window.count >= limit) {
      return false;
    }
    window.count += 1;
    return true;
  }
}
