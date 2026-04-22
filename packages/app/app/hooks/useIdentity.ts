import { ElisymIdentity } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  createElement,
  type ReactNode,
} from 'react';
import { loadIdentities, saveIdentities } from '~/lib/keyVault';

const ACTIVE_KEY = 'elisym:active-identity';

export interface StoredIdentity {
  id: string;
  hex: string;
  name: string;
  createdAt: number;
}

function toHex(sk: Uint8Array): string {
  return Array.from(sk)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function readActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

function writeActiveId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

interface IdentityState {
  allIdentities: StoredIdentity[];
  activeId: string;
  identity: ElisymIdentity;
}

interface IdentityContextValue {
  loading: boolean;
  identity: ElisymIdentity;
  npub: string;
  publicKey: string;
  nsecEncode: () => string;
  allIdentities: StoredIdentity[];
  activeId: string;
  addIdentity: () => void;
  switchIdentity: (id: string) => void;
  removeIdentity: (id: string) => void;
  renameIdentity: (id: string, name: string) => void;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState | null>(null);
  const [loading, setLoading] = useState(true);

  // Async init: load encrypted identities
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    (async () => {
      let list = await loadIdentities();
      let activeId = readActiveId();

      if (list.length === 0) {
        const fresh = ElisymIdentity.generate();
        const hex = toHex(fresh.secretKey);
        const entry: StoredIdentity = {
          id: crypto.randomUUID(),
          hex,
          name: 'Key 1',
          createdAt: Date.now(),
        };
        list = [entry];
        activeId = entry.id;
        await saveIdentities(list);
        writeActiveId(activeId);
      }

      if (!activeId || !list.find((e) => e.id === activeId)) {
        activeId = list[0]!.id;
        writeActiveId(activeId);
      }

      const active = list.find((e) => e.id === activeId)!;
      let identity: ElisymIdentity;
      try {
        identity = ElisymIdentity.fromHex(active.hex);
      } catch {
        // Corrupted key - remove it and generate a fresh one
        list = list.filter((e) => e.id !== active.id);
        if (list.length === 0) {
          const fresh = ElisymIdentity.generate();
          const hex = toHex(fresh.secretKey);
          const entry: StoredIdentity = {
            id: crypto.randomUUID(),
            hex,
            name: 'Key 1',
            createdAt: Date.now(),
          };
          list = [entry];
          identity = fresh;
        } else {
          identity = ElisymIdentity.fromHex(list[0]!.hex);
        }
        activeId = list[0]!.id;
        await saveIdentities(list);
        writeActiveId(activeId);
      }
      setState({
        allIdentities: list,
        activeId,
        identity,
      });
      setLoading(false);
    })();
  }, []);

  // All hooks must be called unconditionally (React rules of hooks)
  const nsecEncode = useCallback(
    () => (state ? nip19.nsecEncode(state.identity.secretKey) : ''),
    [state],
  );

  const addIdentity = useCallback(() => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      const fresh = ElisymIdentity.generate();
      const hex = toHex(fresh.secretKey);
      const entry: StoredIdentity = {
        id: crypto.randomUUID(),
        hex,
        name: `Key ${prev.allIdentities.length + 1}`,
        createdAt: Date.now(),
      };
      const newList = [...prev.allIdentities, entry];
      writeActiveId(entry.id);
      void saveIdentities(newList);
      return { allIdentities: newList, activeId: entry.id, identity: fresh };
    });
  }, []);

  const switchIdentity = useCallback((id: string) => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      const entry = prev.allIdentities.find((e) => e.id === id);
      if (!entry) {
        return prev;
      }
      writeActiveId(id);
      return {
        allIdentities: prev.allIdentities,
        activeId: id,
        identity: ElisymIdentity.fromHex(entry.hex),
      };
    });
  }, []);

  const removeIdentity = useCallback((id: string) => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      if (prev.allIdentities.length <= 1) {
        return prev;
      }
      const newList = prev.allIdentities.filter((e) => e.id !== id);
      void saveIdentities(newList);

      let newActiveId = prev.activeId;
      if (prev.activeId === id) {
        newActiveId = newList[0]!.id;
        writeActiveId(newActiveId);
      }

      return {
        allIdentities: newList,
        activeId: newActiveId,
        identity: ElisymIdentity.fromHex(newList.find((e) => e.id === newActiveId)!.hex),
      };
    });
  }, []);

  const renameIdentity = useCallback((id: string, name: string) => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      const newList = prev.allIdentities.map((e) => (e.id === id ? { ...e, name } : e));
      void saveIdentities(newList);
      return { ...prev, allIdentities: newList };
    });
  }, []);

  if (loading || !state) {
    return null;
  }

  const { identity, allIdentities, activeId } = state;

  const value: IdentityContextValue = {
    loading: false,
    identity,
    npub: identity.npub,
    publicKey: identity.publicKey,
    nsecEncode,
    allIdentities,
    activeId,
    addIdentity,
    switchIdentity,
    removeIdentity,
    renameIdentity,
  };

  return createElement(IdentityContext.Provider, { value }, children);
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) {
    throw new Error('useIdentity must be used within <IdentityProvider>');
  }
  return ctx;
}
