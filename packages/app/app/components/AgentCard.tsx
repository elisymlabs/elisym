import { truncateKey } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Link } from 'wouter';
import type { AgentDisplayData } from '~/hooks/useAgentDisplay';
import { track } from '~/lib/analytics';
import { MarbleAvatar } from './MarbleAvatar';

export function VerifiedBadge({ className = 'size-[15px]' }: { className?: string } = {}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <span
      className="shrink-0 cursor-default relative left-[2px]"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top });
      }}
      onMouseLeave={() => setPos(null)}
      onClick={(e) => e.stopPropagation()}
    >
      <svg className={className} viewBox="0 0 24 24" fill="none">
        <path
          d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.88 9.33 2 10.57 2 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.33-2.19c1.4.46 2.91.2 3.92-.81s1.26-2.52.8-3.91C21.36 14.67 22.25 13.43 22.25 12z"
          fill="#1d9eea"
        />
        <path
          d="M9 12.5l2 2 4-4.5"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {pos &&
        createPortal(
          <span
            style={{
              position: 'fixed',
              left: pos.x,
              top: pos.y - 8,
              transform: 'translate(-50%, -100%)',
            }}
            className="z-[9999] px-3 py-1.5 rounded-xl bg-[#101012] text-white text-xs whitespace-nowrap pointer-events-none relative"
          >
            Verified agent
            <svg
              className="absolute top-full left-1/2 -translate-x-1/2 -mt-px"
              width="14"
              height="8"
              viewBox="0 0 14 8"
              fill="#101012"
            >
              <path d="M0 0 L5.5 6.4 Q7 7.8 8.5 6.4 L14 0 Z" />
            </svg>
          </span>,
          document.body,
        )}
    </span>
  );
}

interface AgentCardProps {
  agent: AgentDisplayData;
  isVerified?: boolean;
  index?: number;
}

export function AgentCard({ agent, isVerified, index = 0 }: AgentCardProps) {
  const displayName = agent.name || truncateKey(nip19.npubEncode(agent.pubkey), 8);
  const isOnline = Math.floor(Date.now() / 1000) - agent.lastSeenTs < 10 * 60;
  const href = `/agent/${agent.pubkey}`;
  const [imgError, setImgError] = useState(false);

  return (
    <Link
      to={href}
      onClick={() => track('agent-details', { agent: agent.name })}
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 300px',
        border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        animationDelay: `${index * 0.05}s`,
      }}
      className="appear bg-surface rounded-3xl hover:shadow-lg hover:-translate-y-0.5 transition-all flex flex-col no-underline"
    >
      <div className="p-5 flex flex-col gap-4 flex-1">
        {/* Avatar + name + wallet + time */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative size-10 shrink-0">
              <div className="size-10 rounded-full overflow-hidden flex items-center justify-center">
                {agent.picture && !imgError ? (
                  <img
                    src={agent.picture}
                    alt={displayName}
                    loading="lazy"
                    className="size-full object-cover"
                    onError={() => setImgError(true)}
                  />
                ) : (
                  <MarbleAvatar name={agent.pubkey} size={40} />
                )}
              </div>
              <span
                className={`absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-surface ${
                  isOnline ? 'bg-[#1d9e75]' : 'bg-[#ccc]'
                }`}
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-0.5">
                <div className="text-sm font-bold line-clamp-1">{displayName}</div>
                {isVerified && <VerifiedBadge />}
              </div>
              {agent.wallet && (
                <button
                  type="button"
                  onClick={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!agent.walletAddress) return;
                    await navigator.clipboard.writeText(agent.walletAddress);
                    toast.success('Wallet address copied');
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-text-2 font-mono opacity-60 hover:opacity-100 transition-opacity bg-transparent border-0 p-0 cursor-pointer truncate"
                  title="Copy wallet address"
                >
                  <span className="truncate">{agent.wallet}</span>
                  <svg
                    className="size-3 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <span className="text-[11px] text-text-2 shrink-0 mt-0.5">{agent.lastSeen}</span>
        </div>

        {/* Description */}
        {agent.description && (
          <p className="text-text-2 text-[13px] leading-relaxed line-clamp-2 m-0">
            {agent.description}
          </p>
        )}

        {/* Category tags */}
        {agent.tags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {agent.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="py-1 px-2.5 rounded-full text-[11px] font-semibold uppercase tracking-wide bg-tag-bg text-text-2"
              >
                {tag}
              </span>
            ))}
            {agent.tags.length > 3 && (
              <span className="text-[11px] text-text-2 opacity-50">+{agent.tags.length - 3}</span>
            )}
          </div>
        )}

        {/* Info row */}
        {agent.cards.length > 0 && (
          <div className="flex items-center gap-2 text-[13px] text-text-2">
            <svg
              className="size-3.5 shrink-0 opacity-50"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M9 21V9" />
            </svg>
            {agent.cards.length} {agent.cards.length === 1 ? 'product' : 'products'}
            {agent.feedbackPositive > 0 &&
              (() => {
                const pct = Math.round((agent.feedbackPositive / agent.feedbackTotal) * 100);
                return (
                  <>
                    <span className="opacity-30 mx-1">·</span>
                    <svg
                      className={`size-3.5 shrink-0 ${pct >= 50 ? 'text-[#1d9e75]' : 'opacity-50'}`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                    {pct}% positive
                  </>
                );
              })()}
          </div>
        )}
      </div>

      {/* Price + CTA */}
      <div className="px-5 pb-5 flex items-center gap-3">
        {agent.price !== 'N/A' && (
          <div className="flex-1 text-sm font-bold">
            {agent.price}
            <span className="text-[11px] font-normal text-text-2 ml-1">/ task</span>
          </div>
        )}
        <span
          className="py-2 px-7 rounded-xl text-white text-[13px] font-medium text-center"
          style={{ background: '#101012', transition: 'background 0.15s ease' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#2a2a2e';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#101012';
          }}
        >
          Hire
        </span>
      </div>
    </Link>
  );
}
