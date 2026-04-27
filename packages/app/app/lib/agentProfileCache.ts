import type { Agent } from '@elisym/sdk';
import { getDB, KV_STORE } from './idb';

const KEY_PREFIX = 'agent:';
const LEGACY_KEY_PREFIX = 'agents:';

function key(network: string, pubkey: string): string {
  return `${KEY_PREFIX}${network}:${pubkey}`;
}

function rangeFor(network: string): IDBKeyRange {
  const lower = `${KEY_PREFIX}${network}:`;
  const upper = `${KEY_PREFIX}${network}:￿`;
  return IDBKeyRange.bound(lower, upper);
}

export async function getAgentProfile(network: string, pubkey: string): Promise<Agent | undefined> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).get(key(network, pubkey));
      req.onsuccess = () => resolve(req.result as Agent | undefined);
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

export async function getAllAgentProfiles(network: string): Promise<Agent[]> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).openCursor(rangeFor(network));
      const result: Agent[] = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(result);
          return;
        }
        const value = cursor.value as Agent | undefined;
        if (value) {
          result.push(value);
        }
        cursor.continue();
      };
      req.onerror = () => resolve(result);
    });
  } catch {
    return [];
  }
}

export async function setAgentProfile(network: string, agent: Agent): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).put(agent, key(network, agent.pubkey));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // best-effort
  }
}

export async function setAgentProfiles(network: string, agents: Agent[]): Promise<void> {
  if (agents.length === 0) {
    return;
  }
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      const store = tx.objectStore(KV_STORE);
      for (const agent of agents) {
        store.put(agent, key(network, agent.pubkey));
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // best-effort
  }
}

export async function migrateLegacyListSnapshot(network: string): Promise<void> {
  const legacyKey = `${LEGACY_KEY_PREFIX}${network}`;
  try {
    const db = await getDB();
    const legacy = await new Promise<Agent[] | undefined>((resolve) => {
      const tx = db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).get(legacyKey);
      req.onsuccess = () => resolve(req.result as Agent[] | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!legacy || legacy.length === 0) {
      if (legacy) {
        await deleteKey(legacyKey);
      }
      return;
    }
    await setAgentProfiles(network, legacy);
    await deleteKey(legacyKey);
  } catch {
    // best-effort
  }
}

async function deleteKey(rawKey: string): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).delete(rawKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // best-effort
  }
}
