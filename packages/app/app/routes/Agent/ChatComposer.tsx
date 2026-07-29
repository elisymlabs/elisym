import { encodeJobPayload, LIMITS, utf8ByteLength, type CapabilityCard } from '@elisym/sdk';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useDelegatedBuyMode } from '~/hooks/useDelegationStatus';
import type { PingStatus } from '~/hooks/usePingAgent';
import { track } from '~/lib/analytics';
import {
  chatSessionsVersion,
  readChatSession,
  SESSION_LIVENESS_MS,
  subscribeChatSessions,
} from '~/lib/chatSession';
import type { ChatThreadEntry } from '~/lib/chatThread';
import { cn } from '~/lib/cn';
import { formatBytes } from '~/lib/fileResult';
import { BuyErrorNote } from './BuyErrorNote';
import { CapabilityDropdown } from './CapabilityDropdown';
import type { BuyState } from './types';
import type { ChatSend } from './useChatSend';
import { useJobGating } from './useJobGating';

interface Props {
  card: CapabilityCard;
  allCards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  agentPubkey: string;
  agentName: string;
  identityPubkey: string;
  pingStatus: PingStatus;
  buyState: BuyState;
  /** Identity-scoped, ts-sorted thread entries (send-path adoption source). */
  entries: ChatThreadEntry[];
  send: ChatSend;
}

/**
 * A UUID is fixed-length, so probing the envelope with any well-formed id
 * makes the composer-side size check exact regardless of which id the
 * lock-held resolution later picks (design round 9).
 */
const SIZE_PROBE_SESSION_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The Chat tab's composer: bound to the currently selected capability card,
 * driving the same `buy()` flow as the Products-tab JobInput and inheriting
 * its FULL disable/tip gating (shared `useJobGating` - never forked). This
 * surface carries the ACTIVE session id (JobInput mints a fresh one per
 * send instead); context-off cards send marked one-shots.
 */
export function ChatComposer({
  card,
  allCards,
  selectedIndex,
  onSelectIndex,
  agentPubkey,
  agentName,
  identityPubkey,
  pingStatus,
  buyState,
  entries,
  send,
}: Props) {
  const { setVisible } = useWalletModal();
  const [input, setInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { buying, error, paid, jobId } = buyState;
  // Chat sends resolve their rail at click time, and a covering allowance
  // means the send needs no per-job SOL - so the wallet-balance gate must not
  // block (or mis-tooltip) it, same as the Products-tab Use button.
  const buyMode = useDelegatedBuyMode(card);
  const gate = useJobGating({
    card,
    agentPubkey,
    pingStatus,
    input,
    file,
    buying,
    delegatedCovers: buyMode === 'use',
  });

  // Clear the draft only once this composer's send has produced a job id
  // (submit success); a pre-submit failure keeps the text for correction.
  const awaitingSubmitRef = useRef(false);
  useEffect(() => {
    if (awaitingSubmitRef.current && jobId !== null && buying) {
      awaitingSubmitRef.current = false;
      setInput('');
      setFile(null);
    }
  }, [jobId, buying]);
  useEffect(() => {
    if (error) {
      awaitingSubmitRef.current = false;
    }
  }, [error]);

  // Exact composer-side envelope check for text+session: with a session id
  // every text message is enveloped, and JSON escaping can inflate an input
  // that passes the raw-byte check past the inline cap at submit.
  const sessionEnvelopeTooLarge =
    card.context === true &&
    !gate.isStatic &&
    utf8ByteLength(
      encodeJobPayload({
        text: gate.effectiveInput || undefined,
        session: { id: SIZE_PROBE_SESSION_ID },
      }),
    ) > LIMITS.MAX_ENCRYPTED_INLINE_BYTES;

  const isDisabled = gate.isDisabled || sessionEnvelopeTooLarge;
  const tip = sessionEnvelopeTooLarge
    ? 'Message is too large for a conversation send - shorten it or use the elisym CLI.'
    : gate.tip;

  // Stale hint: the only remaining active-session surface here. The old
  // divergence note ("a newer conversation exists - join it") is gone: the
  // chat sidebar shows every conversation and clicking one IS the switch.
  const sessionsVersion = useSyncExternalStore(subscribeChatSessions, chatSessionsVersion);
  const currentSession = useMemo(
    () => readChatSession(identityPubkey, agentPubkey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionsVersion re-reads the persisted entry
    [identityPubkey, agentPubkey, sessionsVersion],
  );
  const showStaleHint =
    card.context === true &&
    currentSession !== undefined &&
    Date.now() - currentSession.lastUsedAt > SESSION_LIVENESS_MS;

  async function handleSend() {
    if (gate.needsWalletConnect) {
      track('wallet-connect', { source: 'agent-page' });
      setVisible(true);
      return;
    }
    if (isDisabled) {
      return;
    }
    track('buy', { agent: agentName, price: gate.priceLabel ?? 'free' });
    const text = gate.isStatic ? card.name : gate.effectiveInput;
    awaitingSubmitRef.current = true;
    await send(card, text, file ?? undefined, entries);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter submits, mirroring JobInput - a bare Enter must never
    // fire a (possibly paid) job from muscle memory.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isDisabled) {
      event.preventDefault();
      void handleSend();
    }
  }

  function sendButtonLabel(): ReactNode {
    if (buying) {
      return 'Sending...';
    }
    if (gate.needsWalletConnect) {
      return 'Connect';
    }
    return 'Send';
  }

  let inputPlaceholder = `Message ${agentName || 'agent'}…`;
  if (gate.textRequiredForFile) {
    inputPlaceholder = 'Describe what to do with the file…';
  } else if (gate.fileOptional) {
    inputPlaceholder = 'Describe the image, or attach a photo to edit…';
  } else if (gate.needsFileInput) {
    inputPlaceholder = 'Add an optional note…';
  }
  const fileDropLabel = gate.fileOptional
    ? 'Attach a photo to edit (optional)'
    : 'Choose a file to send';

  return (
    <div className="mt-12 flex flex-col gap-8">
      {showStaleHint && (
        <div className="rounded-12 bg-surface-2/70 px-12 py-8 text-xs text-text-2">
          The provider may have forgotten this conversation - consider starting a new one.
        </div>
      )}

      <div className="flex items-center justify-between gap-8 px-2">
        <span className="flex items-center gap-6 text-[11px] text-text-2">
          {card.context === true ? (
            <>
              <svg
                aria-hidden
                className="size-12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Remembers the conversation
            </>
          ) : (
            'Each message is independent - it will open as its own chat'
          )}
        </span>
      </div>

      <div className="rounded-3xl border border-black/7 bg-surface shadow-[0_1px_8px_rgba(0,0,0,0.05)]">
        {gate.showsTextarea && (
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={inputPlaceholder}
            className="min-h-[40px] w-full resize-none bg-transparent px-14 pt-14 pb-6 font-[inherit] text-sm text-text outline-none placeholder:text-text-2/40 sm:px-16 sm:pt-16"
          />
        )}
        {gate.needsFileInput && !gate.freeFileBlocked && (
          <div className={cn('px-14 sm:px-16', gate.showsTextarea ? 'pt-4' : 'pt-14 sm:pt-16')}>
            <label className="flex cursor-pointer items-center justify-center gap-10 rounded-2xl border border-dashed border-black/15 bg-black/[0.015] px-16 py-12 text-sm transition-colors hover:border-black/30 hover:bg-black/[0.03]">
              <input
                type="file"
                className="hidden"
                aria-label="Choose a file to send"
                accept={card.inputMime}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <span className={cn('min-w-0 truncate', file ? 'text-text' : 'text-text-2')}>
                {file ? file.name : fileDropLabel}
              </span>
              {file && (
                <span className="shrink-0 text-xs text-text-2 tabular-nums">
                  {formatBytes(file.size)}
                </span>
              )}
            </label>
          </div>
        )}
        <div className="flex items-center justify-between gap-12 px-10 py-8 sm:px-12 sm:py-10">
          <div className="flex min-w-0 items-center gap-8">
            <CapabilityDropdown
              cards={allCards}
              selectedIndex={selectedIndex}
              onSelectIndex={onSelectIndex}
            />
            {gate.isFree ? (
              <span className="inline-flex h-28 shrink-0 items-center rounded-full bg-stat-sky-bg px-10 font-mono text-xs leading-none font-medium tracking-wider whitespace-nowrap text-stat-sky uppercase">
                Free
              </span>
            ) : (
              <span className="inline-flex h-28 shrink-0 items-center rounded-full bg-stat-emerald-bg px-10 font-mono text-xs leading-none font-medium whitespace-nowrap text-stat-emerald tabular-nums">
                {gate.priceLabel}
              </span>
            )}
          </div>
          {!gate.isOwn && (
            <span className="group relative shrink-0">
              <button
                onClick={() => void handleSend()}
                disabled={isDisabled && !gate.needsWalletConnect}
                className="inline-flex h-32 min-w-64 cursor-pointer items-center justify-center gap-8 rounded-xl border-none bg-surface-dark px-14 text-xs leading-none font-semibold whitespace-nowrap text-white transition-colors hover:bg-[#2a2a2e] disabled:cursor-not-allowed disabled:opacity-25"
              >
                {buying && (
                  <svg aria-hidden className="size-14 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="2"
                      opacity="0.3"
                    />
                    <path
                      d="M12 2a10 10 0 0 1 10 10"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
                <span>{sendButtonLabel()}</span>
              </button>
              {tip && (
                <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-10 hidden w-240 -translate-x-1/2 rounded-2xl bg-surface-dark px-16 py-12 text-xs leading-relaxed text-white/70 opacity-0 shadow-[0_4px_16px_rgba(0,0,0,0.3)] transition-opacity group-hover:opacity-100 sm:inline-block">
                  {tip}
                  <svg
                    aria-hidden
                    className="absolute top-full left-1/2 -mt-px -translate-x-1/2 fill-surface-dark"
                    width="14"
                    height="8"
                    viewBox="0 0 14 8"
                  >
                    <path d="M0 0 L5.5 6.4 Q7 7.8 8.5 6.4 L14 0 Z" />
                  </svg>
                </span>
              )}
            </span>
          )}
        </div>
        {gate.freeFileBlocked && (
          <div className="px-16 pb-12 text-xs text-text-2">
            File inputs require a paid capability - this one is free.
          </div>
        )}
        {error && <BuyErrorNote error={error} paid={paid} />}
      </div>
    </div>
  );
}
