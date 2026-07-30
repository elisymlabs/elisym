import { assetByKey, timeAgo, truncateKey } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import { useState } from 'react';
import { Link } from 'wouter';
import { MarbleAvatar } from '~/components/MarbleAvatar';
import { useCachedAgentProfile } from '~/hooks/useCachedAgentProfile';
import { cn } from '~/lib/cn';
import { explorerTxUrl } from '~/lib/explorer';
import { formatDecimal } from '~/lib/formatPrice';
import { JobStatusChip } from './JobStatusChip';
import type { JobRowData } from './lib/rows';

interface Props {
  row: JobRowData;
  /** "Landed while you were away" tint, held by the page for the visit (the
   * store's `unseen` flag itself is cleared right after first paint). */
  highlighted: boolean;
}

/**
 * A compact index row: status and metadata only. The whole card is a
 * stretched link to the agent's Chat tab (which hydrates and reconciles the
 * result in conversation context); the tx link stacks above the overlay so
 * it stays independently clickable. A relay-only row without a provider
 * pubkey gets no link at all - `/agent/` resolves to the not-found page.
 */
export function JobRow({ row, highlighted }: Props) {
  const agentPubkey = row.agentPubkey ?? '';
  const profile = useCachedAgentProfile(agentPubkey);
  const [imgError, setImgError] = useState(false);

  const chatPath = `/agent/${agentPubkey}?tab=history&job=${row.jobEventId}`;
  const displayName =
    row.agentName?.trim() ||
    profile?.name?.trim() ||
    (agentPubkey ? truncateKey(nip19.npubEncode(agentPubkey), 6) : 'Unknown provider');
  const picture = row.agentPicture ?? profile?.picture;

  let amountLabel: string | undefined;
  if (row.assetKey && row.paymentAmount) {
    const asset = assetByKey(row.assetKey);
    if (asset) {
      amountLabel = `${formatDecimal(row.paymentAmount, asset.decimals)} ${asset.symbol}`;
    }
  }

  return (
    <li
      className={cn(
        'relative flex items-center gap-12 border-b border-black/5 px-14 py-12 transition-colors last:border-b-0',
        agentPubkey && 'hover:bg-black/3',
        highlighted && 'bg-accent/4',
      )}
    >
      {agentPubkey && (
        <Link
          to={chatPath}
          aria-label={`Open chat with ${displayName}`}
          className="absolute inset-0"
        />
      )}
      <div className="flex size-36 shrink-0 items-center justify-center overflow-hidden rounded-full">
        {picture && !imgError ? (
          <img
            src={picture}
            alt={displayName}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <MarbleAvatar name={agentPubkey || row.jobEventId} size={36} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-8">
          <span
            className={cn(
              'truncate text-xs font-medium text-text',
              row.agentName || profile?.name ? 'font-sans' : 'font-mono',
            )}
          >
            {displayName}
          </span>
          <JobStatusChip status={row.status} />
          {row.source === 'nostr-only' && (
            <span className="shrink-0 rounded-8 border border-black/8 px-6 py-1 text-[10px] text-text-2">
              from relays
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10px] text-text-2 opacity-60">
            {timeAgo(row.timestampSecs)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-8 text-xs text-text-2">
          {row.capability && <span className="truncate">{row.capability}</span>}
          {amountLabel && <span className="shrink-0 font-medium">{amountLabel}</span>}
          {row.txHash && (
            <a
              href={explorerTxUrl(row.txHash)}
              target="_blank"
              rel="noreferrer noopener"
              className="relative z-10 shrink-0 font-mono text-[10px] text-accent no-underline hover:underline"
            >
              tx:{row.txHash.slice(0, 8)}…
            </a>
          )}
        </div>
      </div>
      {agentPubkey && (
        <span aria-hidden className="flex size-28 shrink-0 items-center justify-center text-text-2">
          <svg
            className="size-14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      )}
    </li>
  );
}
