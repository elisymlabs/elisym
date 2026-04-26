import type { CapabilityCard } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useState } from 'react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import type { PingStatus } from '~/hooks/usePingAgent';
import { useSolGasFeeEstimate } from '~/hooks/useSolGasFeeEstimate';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { compactZeros, formatCardPrice, formatDecimal } from '~/lib/formatPrice';
import { CapabilityDropdown } from './CapabilityDropdown';
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

function NetworkFeeRow({ lamports, className }: { lamports: number; className?: string }) {
  return (
    <span
      className={cn('flex items-center gap-6 text-[11px] whitespace-nowrap text-text-2', className)}
    >
      <SolIcon />
      <span className="tabular-nums">
        ~{compactZeros(formatDecimal(lamports, 9))} SOL network fee
      </span>
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

  const { buy, buying, error } = buyState;

  const [input, setInput] = useState('');
  const isStatic = card.static === true;
  const price = card.payment?.job_price ?? 0;
  const isFree = price === 0;
  const gasFeeLamports = useSolGasFeeEstimate(card);
  const priceLabel = isFree ? null : formatCardPrice(card.payment, price);

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
    buy(isStatic ? card.name : input);
  }

  function buttonLabel() {
    if (buying) {
      return 'Processing...';
    }
    if (!isFree && !publicKey) {
      return 'Connect Wallet';
    }
    return isFree ? 'Get' : 'Buy';
  }

  const isDisabled =
    buying ||
    !relaysConnected ||
    ((!!publicKey || isFree) && !isStatic && !input.trim()) ||
    ((!!publicKey || isFree) && pingStatus !== 'online');

  let tip: string | null = null;
  if (!buying) {
    if (!relaysConnected) {
      tip = 'Connecting to relays…';
    } else if ((!!publicKey || isFree) && pingStatus === 'pinging') {
      tip = 'Checking if the agent is available…';
    } else if ((!!publicKey || isFree) && pingStatus !== 'online') {
      tip = "This agent is offline right now, so you can't place an order. Try again later.";
    }
  }

  return (
    <div className="rounded-3xl border border-black/7 bg-surface shadow-[0_1px_8px_rgba(0,0,0,0.05)]">
      {!isStatic && (
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={`Ask ${agentName || 'agent'}…`}
          className="min-h-[40px] w-full resize-none bg-transparent px-14 pt-16 pb-8 font-[inherit] text-sm text-text outline-none placeholder:text-text-2/40 sm:px-20 sm:pt-20"
        />
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
        <div className="flex min-h-24 items-center px-12 pt-4 sm:hidden">
          {!isFree && <NetworkFeeRow lamports={gasFeeLamports} />}
        </div>
      )}
      <div className="flex items-center justify-between gap-8 px-12 py-10 sm:px-16 sm:py-12">
        <div className="flex min-w-0 items-center gap-8">
          <CapabilityDropdown
            cards={allCards}
            selectedIndex={selectedIndex}
            onSelectIndex={onSelectIndex}
          />

          {isFree ? (
            <span className="inline-flex h-28 shrink-0 items-center rounded-full bg-stat-sky-bg px-10 font-mono text-xs font-medium tracking-wider whitespace-nowrap text-stat-sky uppercase">
              Free
            </span>
          ) : (
            <span className="inline-flex h-28 shrink-0 items-center rounded-full bg-stat-emerald-bg px-10 font-mono text-xs font-medium whitespace-nowrap text-stat-emerald tabular-nums">
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
                className="inline-flex h-36 min-w-[72px] cursor-pointer items-center justify-center gap-8 rounded-xl border-none bg-surface-dark px-14 text-xs font-semibold whitespace-nowrap text-white transition-colors hover:bg-[#2a2a2e] disabled:cursor-not-allowed disabled:opacity-25 sm:min-w-[92px] sm:px-16"
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
      {error && <div className="px-20 pb-12 text-xs text-red-500">{error}</div>}
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
      key={card.name}
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
