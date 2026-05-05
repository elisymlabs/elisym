/**
 * Agent fleet simulator - synthetic NIP-89 announcements + ephemeral pings.
 *
 * Goal: load the relay with N "online" elisym agents so discovery scenarios
 * can measure how `fetchAgents` latency grows with fleet size. Each synthetic
 * agent publishes:
 *
 *   - one kind:31990 (NIP-89 app handler) on start, tagged
 *     `["t","elisym"]` + capability tag, marking it discoverable.
 *   - one kind:20200 (ephemeral ping) every `pingIntervalMs`, so it looks
 *     "live" instead of stale-cached.
 *
 * Re-publishes the NIP-89 announcement every `republishMs` to defend against
 * relay GC of older parameterized-replaceable events under churn. The fleet
 * uses a single shared SimplePool so all events fan out across the configured
 * relay list.
 *
 * Scale up: only the new keys publish. Scale down: ping timers cancelled and
 * keypairs zeroed out (we rely on relay-side TTL for the NIP-89 cards because
 * NIP-09 deletion would itself add load we don't want to measure here).
 */
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';

interface FleetMember {
  sk: Uint8Array;
  pk: string;
  pingTimer: ReturnType<typeof setInterval> | null;
}

export interface FleetConfig {
  capability: string;
  relays: string[];
  pingIntervalMs: number;
  republishMs: number;
}

export interface FleetSnapshot {
  size: number;
  capability: string;
  relays: string[];
  pingIntervalMs: number;
  republishMs: number;
  publishedAnnounceTotal: number;
  publishedPingTotal: number;
}

export class FleetSimulator {
  private pool = new SimplePool();
  private members: FleetMember[] = [];
  private republishTimer: ReturnType<typeof setInterval> | null = null;
  private publishedAnnounceTotal = 0;
  private publishedPingTotal = 0;
  private config: FleetConfig;

  constructor(config: FleetConfig) {
    this.config = config;
  }

  size(): number {
    return this.members.length;
  }

  snapshot(): FleetSnapshot {
    return {
      size: this.size(),
      capability: this.config.capability,
      relays: this.config.relays,
      pingIntervalMs: this.config.pingIntervalMs,
      republishMs: this.config.republishMs,
      publishedAnnounceTotal: this.publishedAnnounceTotal,
      publishedPingTotal: this.publishedPingTotal,
    };
  }

  /** Set the fleet to exactly `target` members, growing or shrinking as needed. */
  async resize(target: number): Promise<FleetSnapshot> {
    if (target < 0 || !Number.isInteger(target)) {
      throw new Error('fleet target must be a non-negative integer');
    }
    if (target > this.members.length) {
      await this.grow(target - this.members.length);
    } else if (target < this.members.length) {
      this.shrink(this.members.length - target);
    }
    if (this.members.length > 0 && !this.republishTimer) {
      this.startRepublishTimer();
    }
    if (this.members.length === 0 && this.republishTimer) {
      clearInterval(this.republishTimer);
      this.republishTimer = null;
    }
    return this.snapshot();
  }

  stop(): FleetSnapshot {
    this.shrink(this.members.length);
    if (this.republishTimer) {
      clearInterval(this.republishTimer);
      this.republishTimer = null;
    }
    this.pool.close(this.config.relays);
    return this.snapshot();
  }

  private async grow(delta: number): Promise<void> {
    const fresh: FleetMember[] = [];
    for (let i = 0; i < delta; i++) {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      fresh.push({ sk, pk, pingTimer: null });
    }
    // Publish announcements first; pings after a small splay so the relay
    // doesn't see N synchronous pings every pingIntervalMs tick.
    await Promise.all(fresh.map((m) => this.publishAnnounce(m)));
    for (let i = 0; i < fresh.length; i++) {
      const member = fresh[i];
      const splay = Math.floor(Math.random() * this.config.pingIntervalMs);
      member.pingTimer = setTimeout(() => {
        this.publishPing(member).catch(() => {
          // ignore - publish errors should not crash the fleet
        });
        member.pingTimer = setInterval(() => {
          this.publishPing(member).catch(() => {
            // ignore
          });
        }, this.config.pingIntervalMs);
      }, splay) as unknown as ReturnType<typeof setInterval>;
      this.members.push(member);
    }
  }

  private shrink(delta: number): void {
    for (let i = 0; i < delta; i++) {
      const member = this.members.pop();
      if (!member) {
        return;
      }
      if (member.pingTimer) {
        clearInterval(member.pingTimer);
        clearTimeout(member.pingTimer as unknown as ReturnType<typeof setTimeout>);
        member.pingTimer = null;
      }
      // Zero the secret key so it cannot leak.
      member.sk.fill(0);
    }
  }

  private startRepublishTimer(): void {
    this.republishTimer = setInterval(() => {
      // Stagger republishes across the fleet so we don't slam the relay.
      for (let i = 0; i < this.members.length; i++) {
        const member = this.members[i];
        const delay = (i / Math.max(1, this.members.length)) * this.config.republishMs;
        setTimeout(() => {
          this.publishAnnounce(member).catch(() => {
            // ignore
          });
        }, delay);
      }
    }, this.config.republishMs);
  }

  private async publishAnnounce(member: FleetMember): Promise<void> {
    const event = this.makeAnnounce(member);
    try {
      await Promise.any(this.pool.publish(this.config.relays, event));
      this.publishedAnnounceTotal++;
    } catch {
      // ignore - we only need at least one relay to ack
    }
  }

  private async publishPing(member: FleetMember): Promise<void> {
    const event = this.makePing(member);
    try {
      await Promise.any(this.pool.publish(this.config.relays, event));
      this.publishedPingTotal++;
    } catch {
      // ignore
    }
  }

  private makeAnnounce(member: FleetMember): Event {
    return finalizeEvent(
      {
        kind: 31990,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', `${this.config.capability}:${member.pk.slice(0, 8)}`],
          ['k', '5100'],
          ['t', this.config.capability],
          ['t', 'elisym'],
        ],
        content: JSON.stringify({
          name: `perf-agent-${member.pk.slice(0, 6)}`,
          about: 'synthetic perf-test agent',
          picture: '',
        }),
      },
      member.sk,
    );
  }

  private makePing(member: FleetMember): Event {
    return finalizeEvent(
      {
        kind: 20200,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'elisym']],
        content: '',
      },
      member.sk,
    );
  }
}
