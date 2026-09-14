import { encodeJobPayload, LIMITS, utf8ByteLength, type CapabilityCard } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import Decimal from 'decimal.js-light';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useDelegatedBuyMode } from '~/hooks/useDelegationStatus';
import { useIdentity } from '~/hooks/useIdentity';
import type { PingStatus } from '~/hooks/usePingAgent';
import { track } from '~/lib/analytics';
import { resolveSessionForSend, rotateSession } from '~/lib/chatSession';
import { cn } from '~/lib/cn';
import { formatBytes } from '~/lib/fileResult';
import { BuyErrorNote } from './BuyErrorNote';
import { CapabilityDropdown } from './CapabilityDropdown';
import { OnchainPromiseNote } from './OnchainPromiseNote';
import { SolIcon } from './SolIcon';
import type { BuyState } from './types';
import { useJobGating } from './useJobGating';

/**
 * A UUID is fixed-length, so probing the envelope with any well-formed id
 * makes the composer-side size check exact regardless of which id the
 * lock-held resolution later picks (mirrors ChatComposer).
 */
const SIZE_PROBE_SESSION_ID = '00000000-0000-4000-8000-000000000000';

interface Props {
  agentPubkey: string;
  agentName: string;
  pingStatus: PingStatus;
  cards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  buyState: BuyState | null;
  /** Opens the Delegation tab (the 'delegate' buy-mode action). */
  onOpenDelegation: () => void;
}

interface InnerProps {
  card: CapabilityCard;
  agentPubkey: string;
  agentName: string;
  pingStatus: PingStatus;
  allCards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  buyState: BuyState;
  onOpenDelegation: () => void;
}

const NETWORK_FEE_DISPLAY_DECIMALS = 4;

function NetworkFeeRow({ lamports, className }: { lamports: number; className?: string }) {
  const sol = new Decimal(lamports)
    .div(new Decimal(10).pow(9))
    .toDecimalPlaces(NETWORK_FEE_DISPLAY_DECIMALS, Decimal.ROUND_UP)
    .toString();
  return (
    <span
      className={cn('flex items-center gap-6 text-[11px] whitespace-nowrap text-text-2', className)}
    >
      <SolIcon />
      <span className="tabular-nums">~{sol} network fee</span>
    </span>
  );
}

function JobInputInner({
  card,
  agentPubkey,
  agentName,
  pingStatus,
  allCards,
  selectedIndex,
  onSelectIndex,
  buyState,
  onOpenDelegation,
}: InnerProps) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const idCtx = useIdentity();

  const { buy, buying, error, paid } = buyState;

  const [input, setInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // Delegated-capable cards split the action explicitly: 'use' spends the
  // active allowance, 'delegate' routes to the Delegation tab to grant one -
  // no silent per-job/delegated switching behind a generic Buy.
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
  const {
    isFree,
    isStatic,
    isOwn,
    needsFileInput,
    textRequiredForFile,
    fileOptional,
    showsTextarea,
    effectiveInput,
    freeFileBlocked,
    priceLabel,
    gasFeeLamports,
  } = gate;

  // Context sends envelope the text with a session id; JSON escaping can
  // inflate an input past the inline cap at submit (mirrors ChatComposer).
  const sessionEnvelopeTooLarge =
    card.context === true &&
    !isStatic &&
    utf8ByteLength(
      encodeJobPayload({
        text: effectiveInput || undefined,
        session: { id: SIZE_PROBE_SESSION_ID },
      }),
    ) > LIMITS.MAX_ENCRYPTED_INLINE_BYTES;
  // 'Delegate' only navigates to the Delegation tab, so none of the job-send
  // gates (input presence, agent online, balances, size caps) apply to it.
  // 'loading' pins the button to a disabled spinner until the allowance read
  // resolves - no Buy flash that flips to Use/Delegate a beat later.
  let isDisabled = gate.isDisabled || sessionEnvelopeTooLarge;
  if (buyMode === 'delegate') {
    isDisabled = buying;
  } else if (buyMode === 'loading') {
    isDisabled = true;
  }
  let tip = sessionEnvelopeTooLarge
    ? 'Message is too large for a conversation send - shorten it or use the elisym CLI.'
    : gate.tip;
  if (buyMode === 'delegate') {
    tip = null;
  } else if (buyMode === 'loading') {
    tip = 'Checking the delegated allowance…';
  }
  // The Products button always states its rail explicitly: 'use' submits from
  // the allowance, anything else pays per-job - even if a delegation would be
  // discovered at click time, because the label promised a per-job payment.
  // ('delegate'/'loading' never reach buy().)
  const paymentIntent = buyMode === 'use' ? ('delegated' as const) : ('per-job' as const);

  async function handleBuy() {
    if (!isFree && !publicKey) {
      track('wallet-connect', { source: 'agent-page' });
      setVisible(true);
      return;
    }
    if (buyMode === 'loading') {
      return;
    }
    if (buyMode === 'delegate') {
      track('delegate-open', { agent: agentName });
      onOpenDelegation();
      return;
    }
    track('buy', {
      agent: agentName,
      price: priceLabel ?? 'free',
    });
    if (card.context === true) {
      // A Products send on a context card opens a NEW conversation: rotate the
      // active session, then resolve on the fresh id (stamps the inFlight
      // token). The page jumps to the Chat tab, where the dialog continues.
      // The rotation is not undone if buy() then refuses (an unaffordable
      // wallet being the likeliest cause): the previous conversation stays in
      // the sidebar and re-selecting it makes it active again.
      await rotateSession(idCtx.publicKey, agentPubkey);
      const resolved = await resolveSessionForSend(idCtx.publicKey, agentPubkey, []);
      await buy(isStatic ? card.name : effectiveInput, file ?? undefined, {
        sessionId: resolved.sessionId,
        token: resolved.token,
        payment: paymentIntent,
        gasLamports: gasFeeLamports,
      });
      return;
    }
    // Context-off cards send deliberate one-shots.
    await buy(isStatic ? card.name : effectiveInput, file ?? undefined, {
      sessionId: null,
      payment: paymentIntent,
      gasLamports: gasFeeLamports,
    });
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd+Enter (macOS) / Ctrl+Enter (Windows/Linux) submits, mirroring the
    // Buy button. Skip when the action is disabled so the shortcut never does
    // something the button itself wouldn't - and never treat it as the
    // 'Delegate' navigation, which is a button-only action.
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !isDisabled &&
      buyMode !== 'delegate'
    ) {
      event.preventDefault();
      void handleBuy();
    }
  }

  function buttonLabel(): ReactNode {
    if (buying) {
      return 'Processing...';
    }
    if (!isFree && !publicKey) {
      return (
        <>
          <span className="sm:hidden">Connect</span>
          <span className="hidden sm:inline">Connect Wallet</span>
        </>
      );
    }
    if (buyMode === 'loading') {
      // The spinner (rendered next to the label) is the whole content while
      // the allowance read resolves.
      return null;
    }
    if (buyMode === 'use') {
      return 'Use';
    }
    if (buyMode === 'delegate') {
      return 'Delegate';
    }
    return isFree ? 'Get' : 'Buy';
  }

  let inputPlaceholder = `Ask ${agentName || 'agent'}…`;
  if (textRequiredForFile) {
    inputPlaceholder = 'Describe what to do with the file…';
  } else if (fileOptional) {
    // The instruction is required here; the file is the optional part.
    inputPlaceholder = 'Describe the image, or attach a photo to edit…';
  } else if (needsFileInput) {
    inputPlaceholder = 'Add an optional note…';
  }

  // Empty-state label for the file dropzone (a real filename replaces it once chosen).
  const fileDropLabel = fileOptional
    ? 'Attach a photo to edit (optional)'
    : 'Choose a file to send';

  return (
    <div className="rounded-3xl border border-black/7 bg-surface shadow-[0_1px_8px_rgba(0,0,0,0.05)]">
      {card.onchain && <OnchainPromiseNote descriptor={card.onchain} />}
      {showsTextarea && (
        <textarea
          autoFocus
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={inputPlaceholder}
          className="min-h-[40px] w-full resize-none bg-transparent px-14 pt-16 pb-8 font-[inherit] text-sm text-text outline-none placeholder:text-text-2/40 sm:px-20 sm:pt-20"
        />
      )}
      {needsFileInput && !freeFileBlocked && (
        <div className={cn('px-14 sm:px-20', showsTextarea ? 'pt-4' : 'pt-16 sm:pt-20')}>
          <label className="flex cursor-pointer items-center justify-center gap-10 rounded-2xl border border-dashed border-black/15 bg-black/[0.015] px-16 py-16 text-sm transition-colors hover:border-black/30 hover:bg-black/[0.03]">
            <input
              type="file"
              className="hidden"
              aria-label="Choose a file to send"
              accept={card.inputMime}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <svg
              aria-hidden
              className="size-18 shrink-0 text-text-2"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M17 8l-5-5-5 5" />
              <path d="M12 3v12" />
            </svg>
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
      {/*
        Mobile-only gas fee row slot. For non-static cards (with textarea) the
        slot is always reserved so height stays identical when switching
        capabilities mid-typing. For static cards (no textarea) we skip the
        empty slot - otherwise free + static would have visible empty space
        above the action row but none below. On sm+ the fee renders inline
        next to the Buy button.
      */}
      {!isOwn && (!isStatic || !isFree) && (
        <div className="flex min-h-24 items-center px-14 pt-4 sm:hidden">
          {/* Delegated modes carry no per-job customer gas: 'use' settles via
              the provider's pull, 'delegate' only navigates to the tab. */}
          {!isFree && buyMode === 'per-job' && <NetworkFeeRow lamports={gasFeeLamports} />}
        </div>
      )}
      <div className="flex items-center justify-between gap-12 px-14 py-10 sm:px-20 sm:py-12">
        <div className="flex min-w-0 items-center gap-8">
          <CapabilityDropdown
            cards={allCards}
            selectedIndex={selectedIndex}
            onSelectIndex={onSelectIndex}
          />

          {isFree ? (
            <span className="inline-flex h-28 shrink-0 items-center rounded-full bg-stat-sky-bg px-10 font-mono text-xs leading-none font-medium tracking-wider whitespace-nowrap text-stat-sky uppercase">
              Free
            </span>
          ) : (
            <span className="inline-flex h-28 shrink-0 items-center rounded-full bg-stat-emerald-bg px-10 font-mono text-xs leading-none font-medium whitespace-nowrap text-stat-emerald tabular-nums">
              {priceLabel}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-12">
          {!isOwn && !isFree && buyMode === 'per-job' && (
            <NetworkFeeRow lamports={gasFeeLamports} className="hidden sm:inline-flex" />
          )}
          {!isOwn && (
            <span className="group relative shrink-0">
              <button
                onClick={() => void handleBuy()}
                disabled={isDisabled}
                aria-label={buyMode === 'loading' ? 'Checking the delegated allowance' : undefined}
                aria-busy={buying || buyMode === 'loading'}
                className="inline-flex h-32 min-w-64 cursor-pointer items-center justify-center gap-8 rounded-xl border-none bg-surface-dark px-14 text-xs leading-none font-semibold whitespace-nowrap text-white transition-colors hover:bg-[#2a2a2e] disabled:cursor-not-allowed disabled:opacity-25 sm:h-36 sm:min-w-72 sm:px-16"
              >
                {(buying || buyMode === 'loading') && (
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
                <span>{buttonLabel()}</span>
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
      </div>
      {freeFileBlocked && (
        <div className="px-20 pb-12 text-xs text-text-2">
          File inputs require a paid capability - this one is free.
        </div>
      )}
      {error && <BuyErrorNote error={error} paid={paid} />}
    </div>
  );
}

export function JobInput({
  agentPubkey,
  agentName,
  pingStatus,
  cards,
  selectedIndex,
  onSelectIndex,
  buyState,
  onOpenDelegation,
}: Props) {
  if (cards.length === 0 || !buyState) {
    return null;
  }
  const card = cards[selectedIndex] ?? cards[0];
  if (!card) {
    return null;
  }

  return (
    <JobInputInner
      card={card}
      agentPubkey={agentPubkey}
      agentName={agentName}
      pingStatus={pingStatus}
      allCards={cards}
      selectedIndex={selectedIndex}
      onSelectIndex={onSelectIndex}
      buyState={buyState}
      onOpenDelegation={onOpenDelegation}
    />
  );
}
