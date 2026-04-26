import { truncateKey } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import { useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import type { AgentDisplayData } from '~/hooks/useAgentDisplay';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { MarbleAvatar } from './MarbleAvatar';
import { VerifiedBadge } from './VerifiedBadge';

const STAGGER_STEP_SECONDS = 0.05;

interface Props {
  agent: AgentDisplayData;
  isVerified?: boolean;
  index?: number;
}

export function AgentCard({ agent, isVerified, index = 0 }: Props) {
  const displayName = agent.name || truncateKey(nip19.npubEncode(agent.pubkey), 8);
  const href = `/agent/${agent.pubkey}`;
  const [imgError, setImgError] = useState(false);

  async function copyWallet(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!agent.walletAddress) {
      return;
    }
    await navigator.clipboard.writeText(agent.walletAddress);
    toast.success('Wallet address copied');
  }

  const feedbackPct =
    agent.feedbackTotal > 0 ? Math.round((agent.feedbackPositive / agent.feedbackTotal) * 100) : 0;
  const hasFeedback = agent.feedbackPositive > 0;

  return (
    <Link
      to={href}
      onClick={() => track('agent-details', { agent: agent.name })}
      style={{ animationDelay: `${index * STAGGER_STEP_SECONDS}s` }}
      className="appear flex flex-col rounded-3xl border border-black/7 bg-surface no-underline shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-all [contain-intrinsic-size:auto_300px] [content-visibility:auto] hover:-translate-y-2 hover:shadow-lg"
    >
      <div className="flex flex-1 flex-col gap-14 p-16 sm:gap-16 sm:p-20">
        <div className="flex items-start justify-between gap-12">
          <div className="flex min-w-0 items-center gap-12">
            <div className="flex size-40 shrink-0 items-center justify-center overflow-hidden rounded-full">
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
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="line-clamp-1 text-sm font-bold">{displayName}</div>
                {isVerified && <VerifiedBadge />}
              </div>
              {agent.wallet && (
                <button
                  type="button"
                  onClick={copyWallet}
                  className="inline-flex cursor-pointer items-center gap-4 truncate border-0 bg-transparent p-0 font-mono text-[11px] text-text-2 opacity-60 transition-opacity hover:opacity-100"
                  title="Copy wallet address"
                >
                  <span className="truncate">{agent.wallet}</span>
                  <svg
                    aria-hidden
                    className="size-12 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          {agent.lastPaidJobLabel && (
            <span className="mt-2 shrink-0 text-[11px] text-text-2" title="Last paid job">
              {agent.lastPaidJobLabel}
            </span>
          )}
        </div>

        {agent.description && (
          <p className="m-0 line-clamp-2 text-[13px] leading-relaxed text-text-2">
            {agent.description}
          </p>
        )}

        {agent.tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-6">
            {agent.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex h-24 items-center rounded-full bg-tag-bg px-10 font-mono text-[11px] leading-none font-medium tracking-wide text-text-2 uppercase"
              >
                {tag}
              </span>
            ))}
            {agent.tags.length > 3 && (
              <span className="text-[11px] text-text-2 opacity-50">+{agent.tags.length - 3}</span>
            )}
          </div>
        )}

        {agent.cards.length > 0 && (
          <div className="flex items-center gap-8 text-[13px] text-text-2">
            <svg
              aria-hidden
              className="size-14 shrink-0 opacity-50"
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
            {hasFeedback && (
              <>
                <span className="mx-4 opacity-30">·</span>
                <svg
                  aria-hidden
                  className={cn(
                    'size-14 shrink-0',
                    feedbackPct >= 50 ? 'text-green' : 'opacity-50',
                  )}
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
                {feedbackPct}% positive
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-12 px-16 pb-16 sm:px-20 sm:pb-20">
        {agent.price !== 'N/A' && (
          <div className="flex-1 text-sm font-bold">
            {agent.price}
            <span className="ml-4 text-[11px] font-normal text-text-2">/ task</span>
          </div>
        )}
        <span className="rounded-xl bg-surface-dark px-28 py-8 text-center text-[13px] font-medium text-white transition-colors hover:bg-[#2a2a2e]">
          Hire
        </span>
      </div>
    </Link>
  );
}
