import type { Agent } from '@elisym/sdk';

const KEY_PREFIX = 'agent:';
const MAX_ENTRIES = 2000;

const snapshots = new Map<string, Agent>();

function key(network: string, pubkey: string): string {
  return `${KEY_PREFIX}${network}:${pubkey}`;
}

/**
 * Module-scope mirror of fetched agents. Read synchronously from `useAgent`
 * to seed the detail page on Home -> detail navigation, avoiding a NotFound
 * flash for an agent the user just scrolled past.
 *
 * Bounded at MAX_ENTRIES with FIFO eviction (Map preserves insertion order;
 * deleting the oldest key is O(1) via the iterator). SPA reload clears it.
 *
 * Setters must run from effects/event handlers, not from a render path -
 * module-scope writes during render would re-trigger under React 19
 * strict-mode double-invocation.
 */
export function getAgentSnapshot(network: string, pubkey: string): Agent | undefined {
  return snapshots.get(key(network, pubkey));
}

export function setAgentSnapshot(network: string, agent: Agent): void {
  const k = key(network, agent.pubkey);
  if (snapshots.has(k)) {
    snapshots.delete(k);
  }
  snapshots.set(k, agent);
  if (snapshots.size > MAX_ENTRIES) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) {
      snapshots.delete(oldest);
    }
  }
}
