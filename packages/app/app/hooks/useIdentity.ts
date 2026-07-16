import { ElisymIdentity } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  createElement,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { loadIdentities, saveIdentities } from '~/lib/keyVault';

const ACTIVE_KEY = 'elisym:active-identity';

export interface StoredIdentity {
  id: string;
  hex: string;
  name: string;
  createdAt: number;
  /** Absent = generated in this browser; 'imported' = pasted provider key. */
  kind?: 'imported';
}

function toHex(sk: Uint8Array): string {
  return Array.from(sk)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

function writeActiveId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

function firstOrThrow<T>(items: T[], context: string): T {
  const first = items[0];
  if (!first) {
    throw new Error(`Unexpected empty list: ${context}`);
  }
  return first;
}

const HEX_SECRET_REGEX = /^[0-9a-fA-F]{64}$/;

type ParsedSecret = { ok: true; hex: string } | { ok: false; error: string };

/**
 * Parse a pasted secret key (nsec or raw hex) into vault hex. Both branches
 * MUST construct an ElisymIdentity here, inside try/catch: the hex regex
 * admits scalars outside the secp256k1 group (all-f, all-0) and the
 * constructor throws from getPublicKey - a throw inside the provider's
 * setState would white-screen the app (ErrorBoundary wraps only <main>).
 */
function parseSecretInput(input: string): ParsedSecret {
  const trimmed = input.trim();
  if (HEX_SECRET_REGEX.test(trimmed)) {
    const hex = trimmed.toLowerCase();
    try {
      ElisymIdentity.fromHex(hex);
    } catch {
      return { ok: false, error: 'Invalid secret key: not a valid secp256k1 scalar.' };
    }
    return { ok: true, hex };
  }
  // Try nip19 for ANY bech32-looking input (not just nsec-prefixed) so a
  // pasted npub gets a type error instead of the generic one.
  let decoded: ReturnType<typeof nip19.decode> | undefined;
  try {
    decoded = nip19.decode(trimmed);
  } catch {
    decoded = undefined;
  }
  if (decoded) {
    if (decoded.type !== 'nsec') {
      return { ok: false, error: `That is a ${decoded.type} key, not an nsec secret key.` };
    }
    try {
      return { ok: true, hex: toHex(ElisymIdentity.fromSecretKey(decoded.data).secretKey) };
    } catch {
      return { ok: false, error: 'Invalid nsec key.' };
    }
  }
  if (trimmed.startsWith('nsec')) {
    return { ok: false, error: 'Invalid nsec key.' };
  }
  return { ok: false, error: 'Paste an nsec1… key or 64 hex characters.' };
}

function freshEntry(name: string): { entry: StoredIdentity; identity: ElisymIdentity } {
  const identity = ElisymIdentity.generate();
  const entry: StoredIdentity = {
    id: crypto.randomUUID(),
    hex: toHex(identity.secretKey),
    name,
    createdAt: Date.now(),
  };
  return { entry, identity };
}

interface IdentityState {
  allIdentities: StoredIdentity[];
  activeId: string;
  identity: ElisymIdentity;
}

export type ImportIdentityResult = { ok: true } | { ok: false; error: string };

interface IdentityContextValue {
  loading: boolean;
  identity: ElisymIdentity;
  npub: string;
  publicKey: string;
  nsecEncode: () => string;
  allIdentities: StoredIdentity[];
  activeId: string;
  /** True when the active identity was imported (provider session). */
  providerSession: boolean;
  addIdentity: () => void;
  importIdentity: (secret: string, name?: string) => ImportIdentityResult;
  switchIdentity: (id: string) => void;
  removeIdentity: (id: string) => void;
  renameIdentity: (id: string, name: string) => void;
  logoutProvider: () => void;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

async function loadInitialState(): Promise<IdentityState> {
  const { identities, vaultLost } = await loadIdentities();
  if (vaultLost) {
    toast.error('Saved identities could not be decrypted. A new identity was generated.', {
      duration: 10_000,
    });
  }
  let list = identities;
  let activeId = readActiveId();

  if (list.length === 0) {
    const { entry } = freshEntry('Key 1');
    list = [entry];
    activeId = entry.id;
    await saveIdentities(list);
    writeActiveId(activeId);
  }

  if (!activeId || !list.find((entry) => entry.id === activeId)) {
    activeId = firstOrThrow(list, 'activeId resolution').id;
    writeActiveId(activeId);
  }

  const active = list.find((entry) => entry.id === activeId);
  if (!active) {
    throw new Error('Active identity not found after selection');
  }

  try {
    return {
      allIdentities: list,
      activeId,
      identity: ElisymIdentity.fromHex(active.hex),
    };
  } catch {
    // Corrupted key - remove it and fall back (or regenerate if it was the last one).
    list = list.filter((entry) => entry.id !== active.id);
    if (list.length === 0) {
      const { entry, identity } = freshEntry('Key 1');
      list = [entry];
      activeId = entry.id;
      await saveIdentities(list);
      writeActiveId(activeId);
      return { allIdentities: list, activeId, identity };
    }
    const fallback = firstOrThrow(list, 'fallback after corrupted key');
    activeId = fallback.id;
    await saveIdentities(list);
    writeActiveId(activeId);
    return {
      allIdentities: list,
      activeId,
      identity: ElisymIdentity.fromHex(fallback.hex),
    };
  }
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState | null>(null);
  const [loading, setLoading] = useState(true);

  // The first state we observe comes from `loadInitialState`, which itself
  // already wrote to localStorage if it had to regenerate; skip persisting
  // that one to avoid a redundant re-encrypt on mount.
  const skipNextPersistRef = useRef(true);

  useEffect(() => {
    if (!state) {
      return;
    }
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    writeActiveId(state.activeId);
    void saveIdentities(state.allIdentities);
  }, [state]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    loadInitialState().then((initial) => {
      setState(initial);
      setLoading(false);
    });
  }, []);

  const nsecEncode = useCallback(
    () => (state ? nip19.nsecEncode(state.identity.secretKey) : ''),
    [state],
  );

  const addIdentity = useCallback(() => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      const { entry, identity } = freshEntry(`Key ${prev.allIdentities.length + 1}`);
      const newList = [...prev.allIdentities, entry];
      return { allIdentities: newList, activeId: entry.id, identity };
    });
  }, []);

  const importIdentity = useCallback((secret: string, name?: string): ImportIdentityResult => {
    const parsed = parseSecretInput(secret);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      // Dedupe by hex: re-importing a stored key just switches to it. A match
      // against a generated entry deliberately keeps its kind - marking it
      // imported would let logoutProvider delete the browser's native key.
      const existing = prev.allIdentities.find((entry) => entry.hex === parsed.hex);
      if (existing) {
        return {
          allIdentities: prev.allIdentities,
          activeId: existing.id,
          identity: ElisymIdentity.fromHex(existing.hex),
        };
      }
      const entry: StoredIdentity = {
        id: crypto.randomUUID(),
        hex: parsed.hex,
        name: name ?? 'Provider key',
        createdAt: Date.now(),
        kind: 'imported',
      };
      return {
        allIdentities: [...prev.allIdentities, entry],
        activeId: entry.id,
        identity: ElisymIdentity.fromHex(entry.hex),
      };
    });
    return { ok: true };
  }, []);

  const logoutProvider = useCallback(() => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      const active = prev.allIdentities.find((entry) => entry.id === prev.activeId);
      if (!active || active.kind !== 'imported') {
        return prev;
      }
      let newList = prev.allIdentities.filter((entry) => entry.id !== active.id);
      if (newList.length === 0) {
        newList = [freshEntry('Key 1').entry];
      }
      // Prefer the browser's own generated key; an all-imported remainder is
      // unreachable through the UI today, but never plant a throw for it.
      const next =
        newList.find((entry) => entry.kind !== 'imported') ??
        firstOrThrow(newList, 'logoutProvider: next active');
      return {
        allIdentities: newList,
        activeId: next.id,
        identity: ElisymIdentity.fromHex(next.hex),
      };
    });
  }, []);

  const switchIdentity = useCallback((id: string) => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      const entry = prev.allIdentities.find((candidate) => candidate.id === id);
      if (!entry) {
        return prev;
      }
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
      const newList = prev.allIdentities.filter((entry) => entry.id !== id);
      const newActiveId =
        prev.activeId === id
          ? firstOrThrow(newList, 'removeIdentity: new active').id
          : prev.activeId;
      const active = newList.find((entry) => entry.id === newActiveId);
      if (!active) {
        return prev;
      }
      return {
        allIdentities: newList,
        activeId: newActiveId,
        identity: ElisymIdentity.fromHex(active.hex),
      };
    });
  }, []);

  const renameIdentity = useCallback((id: string, name: string) => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      const newList = prev.allIdentities.map((entry) =>
        entry.id === id ? { ...entry, name } : entry,
      );
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
    providerSession: allIdentities.find((entry) => entry.id === activeId)?.kind === 'imported',
    addIdentity,
    importIdentity,
    switchIdentity,
    removeIdentity,
    renameIdentity,
    logoutProvider,
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
