import type { CapabilityCard } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useState } from 'react';
import { useBuyCapability } from '~/hooks/useBuyCapability';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import type { PingStatus } from '~/hooks/usePingAgent';
import { track } from '~/lib/analytics';
import { formatCardPrice } from '~/lib/formatPrice';

interface Props {
  card: CapabilityCard;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  pingStatus: PingStatus;
  feedbackPositive: number;
  feedbackNegative: number;
  feedbackTotal: number;
  purchases: number;
}

export function CapabilityItem({
  card,
  agentPubkey,
  agentName,
  agentPicture,
  pingStatus,
  feedbackPositive,
  feedbackNegative,
  feedbackTotal,
  purchases,
}: Props) {
  const price = card.payment?.job_price;
  const isStatic = card.static === true;
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { relaysConnected } = useElisymClient();
  const idCtx = useIdentity();
  const isOwn = idCtx.publicKey === agentPubkey;
  const { buy, buying, result, error, rate, rated } = useBuyCapability({
    agentPubkey,
    agentName,
    agentPicture,
    card,
  });
  const [input, setInput] = useState('');

  const hasPurchaseAction = price !== null && price !== undefined;
  const isFree = price === 0;

  function handleBuy() {
    if (!isFree && !publicKey) {
      track('wallet-connect', { source: 'agent-modal' });
      setVisible(true);
      return;
    }
    track('buy', {
      agent: agentName,
      price: price ? formatCardPrice(card.payment, price) : 'free',
    });
    if (isStatic) {
      buy(card.name);
    } else {
      buy(input);
    }
  }

  function buttonLabel() {
    if (buying) {
      return 'Processing...';
    }
    if (!isFree && !publicKey) {
      return 'Connect Wallet';
    }
    if (price !== null && price !== undefined) {
      return price === 0 ? 'Get for Free' : `Buy for ${formatCardPrice(card.payment, price)}`;
    }
    return 'Submit';
  }

  const buyDisabled =
    buying ||
    !relaysConnected ||
    ((!!publicKey || isFree) && !isStatic && !input.trim()) ||
    ((!!publicKey || isFree) && pingStatus !== 'online');

  const showConnectingTip = !relaysConnected && !buying;
  const showProviderTip = relaysConnected && !!publicKey && pingStatus !== 'online' && !buying;
  const providerTipText = pingStatus === 'pinging' ? 'Checking...' : 'Provider is offline';

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
      {card.image && <img src={card.image} alt={card.name} className="h-256 w-full object-cover" />}

      <div className="flex flex-col gap-10 p-16">
        <div className="line-clamp-2 text-sm font-semibold break-all">{card.name}</div>

        {card.description && (
          <div className="text-xs leading-relaxed text-text-2">{card.description}</div>
        )}

        {card.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-6">
            {card.capabilities.map((tag) => (
              <span
                key={tag}
                className="rounded-md border border-border bg-tag-bg px-8 py-2 text-[11px] text-text-2"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {(purchases > 0 || feedbackTotal > 0) && (
          <div className="flex items-center gap-8 text-[11px]">
            {purchases > 0 && (
              <span
                title={`${purchases} purchases`}
                className="flex items-center gap-4 rounded-md border border-border bg-[#f0f0ee] px-6 py-2 text-text-2"
              >
                <svg
                  aria-hidden
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <path d="M16 10a4 4 0 01-8 0" />
                </svg>
                {purchases}
              </span>
            )}
            {feedbackPositive > 0 && (
              <span
                title={`${feedbackPositive} positive reviews`}
                className="flex items-center gap-4 rounded-md bg-feedback-positive-bg px-6 py-2 text-feedback-positive"
              >
                <svg aria-hidden width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66L14.17 2 7.59 8.59C7.22 8.95 7 9.45 7 10v8c0 1.1.9 2 2 2h9c.78 0 1.47-.46 1.79-1.11l2.04-4.63z" />
                </svg>
                {feedbackPositive}
              </span>
            )}
            {feedbackNegative > 0 && (
              <span
                title={`${feedbackNegative} negative reviews`}
                className="flex items-center gap-4 rounded-md bg-feedback-negative-bg px-6 py-2 text-feedback-negative"
              >
                <svg aria-hidden width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M22 4h-2c-.55 0-1 .45-1 1v9c0 .55.45 1 1 1h2V4zM2.17 11.12c-.11.25-.17.52-.17.8V13c0 1.1.9 2 2 2h5.5l-.92 4.65c-.05.22-.02.46.08.66L9.83 22l6.58-6.59c.36-.36.59-.86.59-1.41V6c0-1.1-.9-2-2-2H6c-.78 0-1.47.46-1.79 1.11l-2.04 4.63z" />
                </svg>
                {feedbackNegative}
              </span>
            )}
          </div>
        )}

        {hasPurchaseAction && !isOwn && (
          <div className="mt-4 border-t border-border pt-12">
            {result ? (
              <div>
                <div className="rounded-lg border border-border bg-surface p-12 text-xs leading-relaxed break-words whitespace-pre-wrap text-text">
                  {result}
                </div>
                {rated ? (
                  <p className="mt-8 text-[11px] text-text-2">Thanks for your feedback</p>
                ) : (
                  <div className="mt-8 flex gap-8">
                    <button
                      onClick={() => rate(true)}
                      className="cursor-pointer rounded-lg border border-border bg-surface px-14 py-6 text-xs text-text-2 transition-colors hover:border-feedback-positive hover:bg-feedback-positive-bg hover:text-feedback-positive"
                    >
                      👍 Good
                    </button>
                    <button
                      onClick={() => rate(false)}
                      className="cursor-pointer rounded-lg border border-border bg-surface px-14 py-6 text-xs text-text-2 transition-colors hover:border-feedback-negative hover:bg-feedback-negative-bg hover:text-feedback-negative"
                    >
                      👎 Bad
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                {!isStatic && (
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="Describe what you need..."
                    className="mb-10 min-h-[70px] w-full resize-y rounded-lg border border-border bg-surface px-12 py-10 font-[inherit] text-xs text-text transition-colors outline-none focus:border-accent"
                  />
                )}
                <div className="flex items-center gap-8">
                  <span className="group relative">
                    <button
                      onClick={handleBuy}
                      disabled={buyDisabled}
                      className="cursor-pointer rounded-lg border-none bg-accent px-20 py-8 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {buttonLabel()}
                    </button>
                    {(showConnectingTip || showProviderTip) && (
                      <span className="pointer-events-none absolute top-1/2 left-full z-50 ml-8 -translate-y-1/2 rounded-lg bg-surface-dark px-12 py-8 text-xs leading-relaxed whitespace-nowrap text-gray-100 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                        {showConnectingTip ? 'Connecting to relays...' : providerTipText}
                        <span className="absolute top-1/2 right-full -translate-y-1/2 border-4 border-transparent border-r-surface-dark" />
                      </span>
                    )}
                  </span>
                  {error && <span className="truncate text-xs text-error">{error}</span>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
