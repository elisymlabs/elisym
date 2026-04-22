import { getPublicKey, nip19 } from 'nostr-tools';
import type { Filter } from 'nostr-tools';
import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity, type StoredIdentity } from '~/hooks/useIdentity';

function hexToPublicKey(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return getPublicKey(bytes);
}

export function NostrKeys() {
  const {
    npub,
    nsecEncode,
    allIdentities,
    activeId,
    addIdentity,
    switchIdentity,
    removeIdentity,
    renameIdentity,
  } = useIdentity();

  const { client } = useElisymClient();

  const [nsecVisible, setNsecVisible] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StoredIdentity | null>(null);
  const [deleteInput, setDeleteInput] = useState('');

  // Fetch kind:0 names for all identities
  useEffect(() => {
    if (!client?.pool) {
      return;
    }

    for (const entry of allIdentities) {
      let pubkey: string;
      try {
        pubkey = hexToPublicKey(entry.hex);
      } catch {
        continue;
      }

      client.pool
        .querySync({ kinds: [0], authors: [pubkey] } as Filter)
        .then((events) => {
          if (events.length > 0) {
            try {
              const profile = JSON.parse(events[0]!.content);
              const name = profile.name || profile.display_name || profile.displayName;
              if (name && name !== entry.name) {
                renameIdentity(entry.id, name);
              }
            } catch {}
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renameIdentity/allIdentities excluded to avoid infinite loops (renameIdentity updates allIdentities)
  }, [client?.pool, allIdentities.length]);

  const copyToClipboard = useCallback(
    async (type: 'npub' | 'nsec') => {
      const val = type === 'npub' ? npub : nsecEncode();
      await navigator.clipboard.writeText(val);
      toast.success('Copied!');
      setCopyFeedback(type);
      setTimeout(() => setCopyFeedback(null), 1200);
    },
    [npub, nsecEncode],
  );

  function handleGenerate() {
    addIdentity();
    setNsecVisible(false);
  }

  function handleDelete() {
    if (!deleteTarget) {
      return;
    }
    removeIdentity(deleteTarget.id);
    setDeleteTarget(null);
    setDeleteInput('');
  }

  function truncateNpub(hex: string): string {
    try {
      const pub = hexToPublicKey(hex);
      const encoded = nip19.npubEncode(pub);
      return encoded.slice(0, 12) + '…' + encoded.slice(-6);
    } catch {
      return hex.slice(0, 8) + '…';
    }
  }

  return (
    <div className="bg-surface border border-border rounded-2xl p-8">
      <div className="text-base font-semibold mb-5 flex items-center gap-2.5">
        <svg
          width="18"
          height="18"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
        Nostr Keys
      </div>

      {/* Identity list */}
      <div className="mb-4 flex flex-col gap-1.5">
        {allIdentities.map((entry) => (
          <div
            key={entry.id}
            onClick={() => switchIdentity(entry.id)}
            className={`flex items-center gap-3 p-3 px-4 rounded-xl cursor-pointer transition-all border ${
              entry.id === activeId
                ? 'bg-accent/10 border-accent/30'
                : 'bg-surface-2 border-border hover:bg-border/50'
            }`}
          >
            {/* Avatar placeholder */}
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                entry.id === activeId ? 'bg-accent text-white' : 'bg-border text-text-2'
              }`}
            >
              {entry.name.charAt(0).toUpperCase()}
            </div>

            {/* Name + truncated npub */}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text truncate">{entry.name}</div>
              <div className="text-[11px] font-mono text-text-2 truncate">
                {truncateNpub(entry.hex)}
              </div>
            </div>

            {/* Active badge */}
            {entry.id === activeId && (
              <span className="text-[10px] font-semibold text-accent uppercase tracking-wider shrink-0">
                Active
              </span>
            )}

            {/* Delete button (hidden if only 1 identity) */}
            {allIdentities.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(entry);
                  setDeleteInput('');
                }}
                className="bg-transparent border-none text-text-2 cursor-pointer p-1 rounded-md transition-all hover:text-red-400 hover:bg-red-400/10 flex items-center shrink-0"
                title="Delete identity"
              >
                <svg
                  width="14"
                  height="14"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Delete confirmation popup */}
      {deleteTarget && (
        <div className="mb-4 p-4 bg-surface-2 border border-red-400/30 rounded-xl">
          <div className="text-sm text-text mb-2">
            Type <strong className="text-red-400">{deleteTarget.name}</strong> to confirm deletion
          </div>
          <input
            type="text"
            value={deleteInput}
            onChange={(e) => setDeleteInput(e.target.value)}
            placeholder={deleteTarget.name}
            className="w-full p-2 px-3 bg-surface border border-border rounded-lg text-sm text-text font-mono mb-3 outline-none focus:border-accent/50"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={deleteInput !== deleteTarget.name}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-all bg-red-500 text-white hover:bg-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Delete
            </button>
            <button
              onClick={() => {
                setDeleteTarget(null);
                setDeleteInput('');
              }}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-all bg-border text-text-2 hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* npub */}
      <div className="flex items-center gap-3 p-3.5 px-4 bg-surface-2 rounded-[10px] mb-2.5 border border-border">
        <span className="text-xs font-semibold text-text-2 uppercase tracking-wider w-12 shrink-0">
          npub
        </span>
        <span className="flex-1 font-mono text-[12.5px] text-text overflow-hidden text-ellipsis whitespace-nowrap">
          {copyFeedback === 'npub' ? 'Copied!' : npub}
        </span>
        <button
          onClick={() => void copyToClipboard('npub')}
          className="bg-transparent border-none text-text-2 cursor-pointer p-1 px-1.5 rounded-md transition-all hover:text-text hover:bg-border flex items-center"
          title="Copy"
        >
          <svg
            width="14"
            height="14"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </div>

      {/* nsec */}
      <div className="flex items-center gap-3 p-3.5 px-4 bg-surface-2 rounded-[10px] mb-2.5 border border-border">
        <span className="text-xs font-semibold text-text-2 uppercase tracking-wider w-12 shrink-0">
          nsec
        </span>
        <span
          className={`flex-1 font-mono text-[12.5px] overflow-hidden text-ellipsis whitespace-nowrap ${
            nsecVisible ? 'text-text' : 'text-text-2'
          }`}
        >
          {(() => {
            if (copyFeedback === 'nsec') {
              return 'Copied!';
            }
            return nsecVisible ? nsecEncode() : '••••••••••••••••••••••••••';
          })()}
        </span>
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => setNsecVisible((v) => !v)}
            className="bg-transparent border-none text-text-2 cursor-pointer p-1 px-1.5 rounded-md transition-all hover:text-text hover:bg-border flex items-center"
            title="Show/Hide"
          >
            <svg
              width="14"
              height="14"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button
            onClick={() => void copyToClipboard('nsec')}
            className="bg-transparent border-none text-text-2 cursor-pointer p-1 px-1.5 rounded-md transition-all hover:text-text hover:bg-border flex items-center"
            title="Copy"
          >
            <svg
              width="14"
              height="14"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
      </div>

      <button onClick={handleGenerate} className="btn btn-outline mt-3.5">
        <svg
          width="14"
          height="14"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          className="inline align-[-2px] mr-1.5"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        Generate new keypair
      </button>
      <div className="text-xs text-text-2 mt-3 leading-relaxed">
        Your Nostr keys are used for agent discovery and task coordination via NIP-89/NIP-90 relays.
        Keep your nsec private.
      </div>
    </div>
  );
}
