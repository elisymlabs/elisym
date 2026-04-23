import { getPublicKey, nip19 } from 'nostr-tools';
import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity, type StoredIdentity } from '~/hooks/useIdentity';
import { cn } from '~/lib/cn';

const COPY_FEEDBACK_MS = 1200;

function hexToPublicKey(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return getPublicKey(bytes);
}

function truncateNpub(hex: string): string {
  try {
    const pub = hexToPublicKey(hex);
    const encoded = nip19.npubEncode(pub);
    return `${encoded.slice(0, 12)}…${encoded.slice(-6)}`;
  } catch {
    return `${hex.slice(0, 8)}…`;
  }
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
        .querySync({ kinds: [0], authors: [pubkey] })
        .then((events) => {
          const [firstEvent] = events;
          if (!firstEvent) {
            return;
          }
          try {
            const profile = JSON.parse(firstEvent.content) as {
              name?: string;
              display_name?: string;
              displayName?: string;
            };
            const name = profile.name || profile.display_name || profile.displayName;
            if (name && name !== entry.name) {
              renameIdentity(entry.id, name);
            }
          } catch {
            // malformed profile, ignore
          }
        })
        .catch(() => {
          // relay error, ignore
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renameIdentity/allIdentities excluded to avoid infinite loops (renameIdentity updates allIdentities)
  }, [client?.pool, allIdentities.length]);

  const copyToClipboard = useCallback(
    async (type: 'npub' | 'nsec') => {
      const val = type === 'npub' ? npub : nsecEncode();
      await navigator.clipboard.writeText(val);
      toast.success('Copied!');
      setCopyFeedback(type);
      setTimeout(() => setCopyFeedback(null), COPY_FEEDBACK_MS);
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

  function resolveNsecValue(): string {
    if (copyFeedback === 'nsec') {
      return 'Copied!';
    }
    if (nsecVisible) {
      return nsecEncode();
    }
    return '••••••••••••••••••••••••••';
  }
  const nsecValue = resolveNsecValue();

  return (
    <div className="rounded-2xl border border-border bg-surface p-32">
      <div className="mb-20 flex items-center gap-10 text-base font-semibold">
        <svg
          aria-hidden
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

      <div className="mb-16 flex flex-col gap-6">
        {allIdentities.map((entry) => (
          <div
            key={entry.id}
            onClick={() => switchIdentity(entry.id)}
            className={cn(
              'flex cursor-pointer items-center gap-12 rounded-xl border p-12 px-16 transition-all',
              entry.id === activeId
                ? 'border-accent/30 bg-accent/10'
                : 'border-border bg-surface-2 hover:bg-border/50',
            )}
          >
            <div
              className={cn(
                'flex h-32 w-32 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                entry.id === activeId ? 'bg-accent text-white' : 'bg-border text-text-2',
              )}
            >
              {entry.name.charAt(0).toUpperCase()}
            </div>

            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-text">{entry.name}</div>
              <div className="truncate font-mono text-[11px] text-text-2">
                {truncateNpub(entry.hex)}
              </div>
            </div>

            {entry.id === activeId && (
              <span className="shrink-0 text-[10px] font-semibold tracking-wider text-accent uppercase">
                Active
              </span>
            )}

            {allIdentities.length > 1 && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteTarget(entry);
                  setDeleteInput('');
                }}
                aria-label={`Delete identity ${entry.name}`}
                className="flex shrink-0 cursor-pointer items-center rounded-md border-none bg-transparent p-4 text-text-2 transition-all hover:bg-red-400/10 hover:text-red-400"
                title="Delete identity"
              >
                <svg
                  aria-hidden
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

      {deleteTarget && (
        <div className="mb-16 rounded-xl border border-red-400/30 bg-surface-2 p-16">
          <div className="mb-8 text-sm text-text">
            Type <strong className="text-red-400">{deleteTarget.name}</strong> to confirm deletion
          </div>
          <input
            type="text"
            value={deleteInput}
            onChange={(event) => setDeleteInput(event.target.value)}
            placeholder={deleteTarget.name}
            className="mb-12 w-full rounded-lg border border-border bg-surface p-8 px-12 font-mono text-sm text-text outline-none focus:border-accent/50"
            autoFocus
          />
          <div className="flex gap-8">
            <button
              onClick={handleDelete}
              disabled={deleteInput !== deleteTarget.name}
              className="rounded-lg bg-red-500 px-12 py-6 text-xs font-semibold text-white transition-all hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-30"
            >
              Delete
            </button>
            <button
              onClick={() => {
                setDeleteTarget(null);
                setDeleteInput('');
              }}
              className="rounded-lg bg-border px-12 py-6 text-xs font-semibold text-text-2 transition-all hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mb-10 flex items-center gap-12 rounded-10 border border-border bg-surface-2 p-14 px-16">
        <span className="w-48 shrink-0 text-xs font-semibold tracking-wider text-text-2 uppercase">
          npub
        </span>
        <span className="flex-1 overflow-hidden font-mono text-[12.5px] text-ellipsis whitespace-nowrap text-text">
          {copyFeedback === 'npub' ? 'Copied!' : npub}
        </span>
        <button
          onClick={() => void copyToClipboard('npub')}
          aria-label="Copy npub"
          className="flex cursor-pointer items-center rounded-md border-none bg-transparent p-4 px-6 text-text-2 transition-all hover:bg-border hover:text-text"
          title="Copy"
        >
          <svg
            aria-hidden
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

      <div className="mb-10 flex items-center gap-12 rounded-10 border border-border bg-surface-2 p-14 px-16">
        <span className="w-48 shrink-0 text-xs font-semibold tracking-wider text-text-2 uppercase">
          nsec
        </span>
        <span
          className={cn(
            'flex-1 overflow-hidden font-mono text-[12.5px] text-ellipsis whitespace-nowrap',
            nsecVisible ? 'text-text' : 'text-text-2',
          )}
        >
          {nsecValue}
        </span>
        <div className="flex shrink-0 gap-4">
          <button
            onClick={() => setNsecVisible((visible) => !visible)}
            aria-label={nsecVisible ? 'Hide nsec' : 'Show nsec'}
            className="flex cursor-pointer items-center rounded-md border-none bg-transparent p-4 px-6 text-text-2 transition-all hover:bg-border hover:text-text"
            title="Show/Hide"
          >
            <svg
              aria-hidden
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
            aria-label="Copy nsec"
            className="flex cursor-pointer items-center rounded-md border-none bg-transparent p-4 px-6 text-text-2 transition-all hover:bg-border hover:text-text"
            title="Copy"
          >
            <svg
              aria-hidden
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

      <button onClick={handleGenerate} className="mt-14 btn btn-outline">
        <svg
          aria-hidden
          width="14"
          height="14"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          className="mr-6 inline align-[-2px]"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        Generate new keypair
      </button>
      <div className="mt-12 text-xs leading-relaxed text-text-2">
        Your Nostr keys are used for agent discovery and task coordination via NIP-89/NIP-90 relays.
        Keep your nsec private.
      </div>
    </div>
  );
}
