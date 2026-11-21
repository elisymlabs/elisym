import { isIPv6 } from 'node:net';

/** An IPv6 address as its eight groups, lower case and without leading zeros. */
function ipv6Groups(bare: string): string[] {
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
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/u, ''));
}

/** The address without an IPv4-mapped IPv6 prefix. */
function bareAddress(address: string): string {
  return address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/u, '');
}

/**
 * The key a per-IP limit counts under (2.4): the IPv4 address, or the IPv6
 * /64 prefix, since one IPv6 host can rotate through a whole /64.
 */
export function ipKey(address: string): string {
  const bare = bareAddress(address);
  if (!isIPv6(bare)) {
    return bare;
  }
  return `${ipv6Groups(bare).slice(0, 4).join(':')}::/64`;
}

/**
 * The key one person's daily asks count under across sessions and stores: the IPv4 address, or
 * the IPv6 /56 prefix, since a home connection is commonly given a /56 and can rotate through its
 * 256 /64s. The trade-off: visitors behind one NAT (IPv4) or sharing one /56 share the limit.
 */
export function personKey(address: string): string {
  const bare = bareAddress(address);
  if (!isIPv6(bare)) {
    return bare;
  }
  const [first = '0', second = '0', third = '0', fourth = '0'] = ipv6Groups(bare);
  const masked = `${fourth.padStart(4, '0').slice(0, 2)}00`.replace(/^0+(?=.)/u, '');
  return `${first}:${second}:${third}:${masked}::/56`;
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

  /**
   * Count a hit; false when the key is over its limit in the current window.
   * Windows are created in time order and share one length, so pruning stops
   * at the first live one.
   */
  hit(key: string, nowMs: number, limit: number = this.limit): boolean {
    if (limit <= 0) {
      return false;
    }
    for (const [stored, window] of this.windows) {
      if (nowMs - window.start < this.windowMs) {
        break;
      }
      this.windows.delete(stored);
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
