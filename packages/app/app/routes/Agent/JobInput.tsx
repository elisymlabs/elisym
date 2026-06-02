import { classifyJobError, LIMITS, utf8ByteLength, type CapabilityCard } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import Decimal from 'decimal.js-light';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import type { PingStatus } from '~/hooks/usePingAgent';
import { useSolGasFeeEstimate } from '~/hooks/useSolGasFeeEstimate';
import { useWalletBalances } from '~/hooks/useWalletBalances';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { formatBytes } from '~/lib/fileResult';
import { formatCardPrice } from '~/lib/formatPrice';
import { CapabilityDropdown } from './CapabilityDropdown';
import { checkBuyAffordability, checkSelfPayment } from './lib/balanceCheck';
import { SolIcon } from './SolIcon';
import type { BuyState } from './types';

interface Props {
  agentPubkey: string;
  agentName: string;
  pingStatus: PingStatus;
  cards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  buyState: BuyState | null;
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
}: InnerProps) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { relaysConnected } = useElisymClient();
  const idCtx = useIdentity();
  const isOwn = idCtx.publicKey === agentPubkey;

  const { buy, buying, error, paid } = buyState;

  const [input, setInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const isStatic = card.static === true;
  // Capabilities that take a file input declare `inputMime`. We gate on presence
  // only and never trust/render the (untrusted) value - the file picker uses it as
  // a soft `accept` hint at most, and the provider content-sniffs the actual file.
  const needsFileInput = typeof card.inputMime === 'string' && card.inputMime.length > 0;
  // `input_text` says how a file skill treats the text prompt: 'none' = file only
  // (hide the text box), 'required' = file + text both required, 'optional' = the
  // FILE is optional and the instruction is required (a generate-or-edit skill:
  // text alone generates, text + photo edits), else (incl. undefined) = file
  // required + optional note. Only meaningful with `needsFileInput`.
  const fileOnly = needsFileInput && card.inputText === 'none';
  const textRequiredForFile = needsFileInput && card.inputText === 'required';
  // `optional` inverts the usual file-input gate: the instruction is required and
  // the file is an optional augmentation, so a file-capable card can still run
  // text-only (e.g. image generation without a photo to edit).
  const fileOptional = needsFileInput && card.inputText === 'optional';
  // The prompt textarea shows for any non-static card that isn't file-only. When
  // it's hidden the file dropzone becomes the card's first element and needs full
  // top padding to breathe from the card edge, not the tight inter-field gap.
  const showsTextarea = !isStatic && !fileOnly;
  // For a file-only card the text box is hidden, so any `input` is stale text left
  // over from a prior capability - never send/record it.
  const effectiveInput = fileOnly ? '' : input;
  const price = card.payment?.job_price ?? 0;
  const isFree = price === 0;
  // The provider rejects a file input on a zero-price skill before payment, so a
  // free + file-input card is unusable from the web - block it (gate on presence).
  const freeFileBlocked = isFree && needsFileInput;
  // Whole-buffer encrypt + upload is bounded to the encrypted-Blossom cap (100 MiB).
  const fileTooLarge = !!file && file.size > LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES;
  const gasFeeLamports = useSolGasFeeEstimate(card);
  const priceLabel = isFree ? null : formatCardPrice(card.payment, price);
  const { solLamports, usdcRaw } = useWalletBalances();
  const selfPayment =
    !isFree && !!publicKey && !buying
      ? checkSelfPayment({ card, buyerWallet: publicKey.toBase58() })
      : { ok: true as const };
  const affordability =
    !isFree && !!publicKey && !buying && selfPayment.ok
      ? checkBuyAffordability({ card, solLamports, usdcRaw, gasLamports: gasFeeLamports })
      : { ok: true as const };

  function handleBuy() {
    if (!isFree && !publicKey) {
      track('wallet-connect', { source: 'agent-page' });
      setVisible(true);
      return;
    }
    track('buy', {
      agent: agentName,
      price: priceLabel ?? 'free',
    });
    buy(isStatic ? card.name : effectiveInput, file ?? undefined);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd+Enter (macOS) / Ctrl+Enter (Windows/Linux) submits, mirroring the
    // Buy button. Skip when the action is disabled so the shortcut never does
    // something the button itself wouldn't.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isDisabled) {
      event.preventDefault();
      handleBuy();
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
    return isFree ? 'Get' : 'Buy';
  }

  // The browser submits encrypted jobs and cannot spill large input to iroh
  // (node-only transport), so cap the input at the NIP-44 inline byte budget and
  // point large inputs at the CLI. Measured in BYTES - the cap is a byte cap.
  const inputTooLarge =
    !isStatic && utf8ByteLength(effectiveInput) > LIMITS.MAX_ENCRYPTED_INLINE_BYTES;

  const isDisabled =
    buying ||
    freeFileBlocked ||
    !relaysConnected ||
    // Text cards require text; file cards require a file (text is an optional note,
    // unless `input_text: required`, which needs both). A `fileOptional` card
    // inverts this: the file is optional and the instruction is required instead.
    ((!!publicKey || isFree) && !isStatic && !needsFileInput && !input.trim()) ||
    ((!!publicKey || isFree) && needsFileInput && !fileOptional && !file) ||
    ((!!publicKey || isFree) && textRequiredForFile && !input.trim()) ||
    ((!!publicKey || isFree) && fileOptional && !input.trim()) ||
    ((!!publicKey || isFree) && pingStatus !== 'online') ||
    inputTooLarge ||
    fileTooLarge ||
    !selfPayment.ok ||
    !affordability.ok;

  let tip: string | null = null;
  if (!buying) {
    if (freeFileBlocked) {
      tip = 'File inputs require a paid capability - this one is free.';
    } else if (!relaysConnected) {
      tip = 'Connecting to relays…';
    } else if ((!!publicKey || isFree) && pingStatus === 'pinging') {
      tip = 'Checking if the agent is available…';
    } else if ((!!publicKey || isFree) && pingStatus !== 'online') {
      tip = "This agent is offline right now, so you can't place an order. Try again later.";
    } else if (inputTooLarge) {
      tip = 'Input is too large for the web app - use the elisym CLI for large inputs.';
    } else if (fileTooLarge) {
      tip = 'File is too large for the web app (max 100 MiB) - use the elisym CLI.';
    } else if (!selfPayment.ok) {
      tip = selfPayment.tooltip;
    } else if (!affordability.ok) {
      tip = affordability.tooltip;
    }
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
          {!isFree && <NetworkFeeRow lamports={gasFeeLamports} />}
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
          {!isOwn && !isFree && (
            <NetworkFeeRow lamports={gasFeeLamports} className="hidden sm:inline-flex" />
          )}
          {!isOwn && (
            <span className="group relative shrink-0">
              <button
                onClick={handleBuy}
                disabled={isDisabled}
                className="inline-flex h-32 min-w-64 cursor-pointer items-center justify-center gap-8 rounded-xl border-none bg-surface-dark px-14 text-xs leading-none font-semibold whitespace-nowrap text-white transition-colors hover:bg-[#2a2a2e] disabled:cursor-not-allowed disabled:opacity-25 sm:h-36 sm:min-w-72 sm:px-16"
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
      {error && <ErrorMessage error={error} paid={paid} />}
    </div>
  );
}

function ErrorMessage({ error, paid }: { error: string; paid: boolean }) {
  const isAgentUnavailable = classifyJobError(error) === 'agent-unavailable';
  if (isAgentUnavailable) {
    return (
      <div className="px-20 pb-12 text-xs text-red-500">
        <div>Agent unavailable. Try again later.</div>
        {paid && (
          <div className="mt-4 text-text-2">
            Your payment is held. Once the agent is back online, the job will be retried
            automatically and the result delivered.
          </div>
        )}
      </div>
    );
  }
  return <div className="px-20 pb-12 text-xs text-red-500">{error}</div>;
}

export function JobInput({
  agentPubkey,
  agentName,
  pingStatus,
  cards,
  selectedIndex,
  onSelectIndex,
  buyState,
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
    />
  );
}
