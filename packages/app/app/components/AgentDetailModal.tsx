import { truncateKey, toDTag } from '@elisym/sdk';
import type { CapabilityCard } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { nip19 } from 'nostr-tools';
import { useState } from 'react';
import type { AgentDisplayData } from '~/hooks/useAgentDisplay';
import { useBodyScrollLock } from '~/hooks/useBodyScrollLock';
import { useBuyCapability } from '~/hooks/useBuyCapability';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { usePingAgent, type PingStatus } from '~/hooks/usePingAgent';
import { track } from '~/lib/analytics';
import { formatCardPrice } from '~/lib/formatPrice';
import { MarbleAvatar } from './MarbleAvatar';

interface AgentDetailModalProps {
  agent: AgentDisplayData;
  onClose: () => void;
}

const STATUS_DOT: Record<PingStatus, string> = {
  pinging: 'bg-yellow-400 animate-pulse',
  online: 'bg-[#1d9e75]',
  offline: 'bg-red-400',
};

export function AgentDetailModal({ agent, onClose }: AgentDetailModalProps) {
  useBodyScrollLock(true);
  const idCtx = useIdentity();
  const isOwn = idCtx.publicKey === agent.pubkey;
  const pingedStatus = usePingAgent(isOwn ? '' : agent.pubkey);
  const pingStatus: PingStatus = isOwn ? 'online' : pingedStatus;

  return (
    <div
      className="fixed inset-0 bg-black/25 z-[500] flex items-center justify-center backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="bg-surface border border-border rounded-[18px] w-[560px] max-w-[95vw] max-h-[90vh] overflow-y-auto p-8 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 size-8 flex items-center justify-center rounded-full bg-surface-2 border-none text-text-2 cursor-pointer hover:bg-surface-2/80 hover:text-text transition-colors z-10"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        {/* Header */}
        <div className="flex items-start mb-6 gap-3 pr-8">
          <div className="flex items-start gap-4 min-w-0">
            <div className="size-14 rounded-full shrink-0 overflow-hidden flex items-center justify-center">
              {agent.picture ? (
                <img src={agent.picture} alt={agent.name} className="size-full object-cover" />
              ) : (
                <MarbleAvatar name={agent.pubkey} size={56} />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold flex items-start gap-2">
                <span>
                  {(() => {
                    const n = agent.name || truncateKey(nip19.npubEncode(agent.pubkey), 8);
                    return n.length > 100 ? n.slice(0, 100) + '...' : n;
                  })()}
                </span>
                <span className={`size-2.5 rounded-full shrink-0 mt-2 ${STATUS_DOT[pingStatus]}`} />
              </h2>
              <div className="font-mono text-xs text-text-2 mt-0.5">
                {truncateKey(nip19.npubEncode(agent.pubkey))}
              </div>
            </div>
          </div>
        </div>

        {/* About */}
        {agent.description && (
          <div className="text-sm text-text-2 leading-relaxed mb-6">
            {agent.description.length > 280
              ? agent.description.slice(0, 280) + '...'
              : agent.description}
          </div>
        )}

        {/* Products */}
        <div className="text-sm font-semibold mb-3">Products ({agent.cards.length})</div>

        <div className="flex flex-col gap-3">
          {agent.cards.map((card) => {
            const stats = agent.byCapability[toDTag(card.name)];
            return (
              <CapabilityItem
                key={card.name}
                card={card}
                agentPubkey={agent.pubkey}
                agentName={agent.name}
                agentPicture={agent.picture}
                pingStatus={pingStatus}
                feedbackPositive={stats?.positive ?? 0}
                feedbackNegative={stats?.negative ?? 0}
                feedbackTotal={stats?.total ?? 0}
                purchases={stats?.purchases ?? 0}
              />
            );
          })}
        </div>

        {/* Footer info */}
        <div className="flex items-center justify-between mt-6 pt-5 border-t border-border text-xs text-text-2">
          {agent.walletAddress && (
            <span className="font-mono">
              <span className="text-text-2 font-sans font-medium mr-1.5">Wallet</span>
              {truncateKey(agent.walletAddress)}
            </span>
          )}
          <span>{agent.lastSeen}</span>
        </div>
      </div>
    </div>
  );
}

function CapabilityItem({
  card,
  agentPubkey,
  agentName,
  agentPicture,
  pingStatus,
  feedbackPositive,
  feedbackNegative,
  feedbackTotal,
  purchases,
}: {
  card: CapabilityCard;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  pingStatus: PingStatus;
  feedbackPositive: number;
  feedbackNegative: number;
  feedbackTotal: number;
  purchases: number;
}) {
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

  return (
    <div className="bg-surface-2 rounded-xl border border-border overflow-hidden">
      {/* Large image on top */}
      {card.image && <img src={card.image} alt={card.name} className="w-full h-64 object-cover" />}

      <div className="p-4 flex flex-col gap-2.5">
        {/* Name */}
        <div className="text-sm font-semibold line-clamp-2 break-all">{card.name}</div>

        {/* Description */}
        {card.description && (
          <div className="text-xs text-text-2 leading-relaxed">{card.description}</div>
        )}

        {/* Tags */}
        {card.capabilities.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {card.capabilities.map((tag) => (
              <span
                key={tag}
                className="py-0.5 px-2 bg-tag-bg rounded-md text-[11px] text-text-2 border border-border"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Stats */}
        {(purchases > 0 || feedbackTotal > 0) && (
          <div className="flex items-center gap-2 text-[11px]">
            {purchases > 0 && (
              <span
                title={`${purchases} purchases`}
                className="flex items-center gap-1 py-0.5 px-1.5 rounded-md bg-[#f0f0ee] border border-border text-text-2"
              >
                <svg
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
                className="flex items-center gap-1 py-0.5 px-1.5 rounded-md bg-[#e8f5e9] text-[#4caf50]"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66L14.17 2 7.59 8.59C7.22 8.95 7 9.45 7 10v8c0 1.1.9 2 2 2h9c.78 0 1.47-.46 1.79-1.11l2.04-4.63z" />
                </svg>
                {feedbackPositive}
              </span>
            )}
            {feedbackNegative > 0 && (
              <span
                title={`${feedbackNegative} negative reviews`}
                className="flex items-center gap-1 py-0.5 px-1.5 rounded-md bg-[#fce4ec] text-[#ef5350]"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M22 4h-2c-.55 0-1 .45-1 1v9c0 .55.45 1 1 1h2V4zM2.17 11.12c-.11.25-.17.52-.17.8V13c0 1.1.9 2 2 2h5.5l-.92 4.65c-.05.22-.02.46.08.66L9.83 22l6.58-6.59c.36-.36.59-.86.59-1.41V6c0-1.1-.9-2-2-2H6c-.78 0-1.47.46-1.79 1.11l-2.04 4.63z" />
                </svg>
                {feedbackNegative}
              </span>
            )}
          </div>
        )}

        {/* Purchase section */}
        {hasPurchaseAction && !isOwn && (
          <div className="mt-1 pt-3 border-t border-border">
            {result ? (
              <div>
                <div className="p-3 bg-surface rounded-lg border border-border text-xs text-text leading-relaxed whitespace-pre-wrap break-words">
                  {result}
                </div>
                {rated ? (
                  <p className="text-[11px] text-text-2 mt-2">Thanks for your feedback</p>
                ) : (
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => rate(true)}
                      className="py-1.5 px-3.5 rounded-lg border border-border bg-surface text-xs text-text-2 cursor-pointer hover:border-[#4caf50] hover:text-[#4caf50] hover:bg-[#e8f5e9] transition-colors"
                    >
                      👍 Good
                    </button>
                    <button
                      onClick={() => rate(false)}
                      className="py-1.5 px-3.5 rounded-lg border border-border bg-surface text-xs text-text-2 cursor-pointer hover:border-[#ef5350] hover:text-[#ef5350] hover:bg-[#fce4ec] transition-colors"
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
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Describe what you need..."
                    className="w-full py-2.5 px-3 rounded-lg border border-border bg-surface text-text text-xs outline-none resize-y min-h-[70px] font-[inherit] mb-2.5 transition-colors focus:border-accent"
                  />
                )}
                <div className="flex items-center gap-2">
                  <span className="relative group">
                    <button
                      onClick={handleBuy}
                      disabled={
                        buying ||
                        !relaysConnected ||
                        ((!!publicKey || isFree) && !isStatic && !input.trim()) ||
                        ((!!publicKey || isFree) && pingStatus !== 'online')
                      }
                      className="py-2 px-5 rounded-lg bg-accent text-white text-sm font-semibold border-none cursor-pointer hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {buttonLabel()}
                    </button>
                    {!relaysConnected && !buying && (
                      <span className="absolute left-full top-1/2 -translate-y-1/2 ml-2 rounded-lg bg-[#101012] px-3 py-2 text-xs text-gray-100 leading-relaxed shadow-lg z-50 pointer-events-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                        Connecting to relays...
                        <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-[#101012]" />
                      </span>
                    )}
                    {relaysConnected && !!publicKey && pingStatus !== 'online' && !buying && (
                      <span className="absolute left-full top-1/2 -translate-y-1/2 ml-2 rounded-lg bg-[#101012] px-3 py-2 text-xs text-gray-100 leading-relaxed shadow-lg z-50 pointer-events-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                        {pingStatus === 'pinging' ? 'Checking...' : 'Provider is offline'}
                        <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-[#101012]" />
                      </span>
                    )}
                  </span>
                  {error && <span className="text-xs text-error truncate">{error}</span>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
