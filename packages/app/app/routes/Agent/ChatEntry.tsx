import { resolveKnownAsset, type CapabilityCard, type OnchainDescriptor } from '@elisym/sdk';
import type { ReactNode } from 'react';
import type { ChatThreadEntry } from '~/lib/chatThread';
import { hasBlossom } from '~/lib/fileResult';
import { compactZeros, formatDecimal } from '~/lib/formatPrice';
import { isCallEnvelope } from '~/lib/onchainCall';
import { ChatBubble } from './ChatBubble';
import { FileResultCard } from './FileResultCard';
import { cleanPreviewText } from './lib/artifactPreview';
import { OnchainCallCard } from './OnchainCallCard';

const SOL_DECIMALS = 9;

/**
 * Shown when a result IS a call envelope but no published promise resolves for
 * it. The same thing MCP says, because the customer's position is the same:
 * there is nothing to check the call against, so nothing will be offered to
 * sign. The raw envelope stays reachable by opening the result.
 *
 * Phrased as "has not matched" rather than "cannot tell", because one of the
 * ways to get here is transient: `useAgent` seeds its cards synchronously from
 * cache, and a profile cached by an older build carries no `onchain` field
 * until the relay result merges. A definite sentence would be briefly false.
 */
const UNMATCHED_CALL_NOTICE =
  'This capability returned a Solana call, but elisym has not matched it to a promise this agent ' +
  'publishes, so it will not offer to sign it.';

interface Props {
  entry: ChatThreadEntry;
  agentPubkey: string;
  /** Live status line for the in-flight entry (from ActiveBuySession), if any. */
  liveStatus: string | null;
  rated: boolean;
  canRate: boolean;
  onRate: (positive: boolean) => void;
  /** Opens the full-result view; only completed entries are expandable. */
  onOpen: () => void;
  /** Retry affordance for failed entries, composed by the thread. */
  retryNode?: ReactNode;
  /**
   * The capability card behind this entry, when it publishes an on-chain
   * promise. Present only for `mode: onchain` capabilities: the result is then
   * a call to verify and sign rather than text to read.
   */
  onchainCard?: CapabilityCard & { onchain: OnchainDescriptor };
}

function formatEntryTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function priceLabelOf(entry: ChatThreadEntry): string | null {
  if (entry.priceLamports === undefined) {
    return null;
  }
  if (entry.priceLamports === 0) {
    return 'Free';
  }
  const asset = entry.asset;
  const known = asset ? resolveKnownAsset(asset.chain, asset.token, asset.mint) : undefined;
  const decimals = asset?.decimals ?? SOL_DECIMALS;
  const symbol = known?.symbol ?? asset?.token.toUpperCase() ?? 'SOL';
  return `${compactZeros(formatDecimal(entry.priceLamports, decimals))} ${symbol}`;
}

/**
 * One thread entry rendered as a chat exchange: the prompt as a user bubble
 * (right) and the result / pending / failed state as an assistant-side bubble
 * (left). Long texts are clamped previews - expanding opens the detail modal.
 */
export function ChatEntry({
  entry,
  agentPubkey,
  liveStatus,
  rated,
  canRate,
  onRate,
  onOpen,
  retryNode,
  onchainCard,
}: Props) {
  const completed = entry.status === undefined;
  const priceLabel = priceLabelOf(entry);

  // The customer's own input file decrypts against the agent it was sent to
  // (NIP-44 is symmetric); this thread is agent-keyed, so that is agentPubkey.
  const promptFileChip = entry.promptAttachment ? (
    <div className="mt-4 text-xs break-words opacity-80">📎 {entry.promptAttachment.name}</div>
  ) : null;

  const fetchableAttachments = (entry.resultAttachments ?? []).filter(hasBlossom);
  const resultPreview = entry.result ? cleanPreviewText(entry.result) : '';
  // A call is signed, not read: when the capability published an on-chain
  // promise and the result carries an envelope, the bubble gives way to the
  // confirm sheet that verifies it.
  const signableCall =
    onchainCard && entry.result && isCallEnvelope(entry.result) ? entry.result : undefined;
  // An envelope with no published promise to check it against: the provider
  // dropped the descriptor, republished on the other network, or two of its
  // capabilities answer to this job's tag. MCP says so plainly; without this
  // the browser rendered the raw base64 envelope and left the customer with
  // no idea why nothing was offered to sign.
  const unmatchedCall = !signableCall && isCallEnvelope(entry.result);

  let assistantBubble: ReactNode;
  if (completed) {
    const footerNode = (
      <div className="flex items-center gap-8 text-[10px] text-text-2 opacity-80">
        <span>{formatEntryTime(entry.ts)}</span>
        {priceLabel && <span className="font-medium tabular-nums">{priceLabel}</span>}
        {canRate && !rated && (
          <span className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => onRate(true)}
              title="Good result"
              className="cursor-pointer rounded-full border border-black/10 bg-surface px-8 py-3 text-[11px] leading-none transition-colors hover:bg-black/4"
            >
              👍
            </button>
            <button
              type="button"
              onClick={() => onRate(false)}
              title="Bad result"
              className="cursor-pointer rounded-full border border-black/10 bg-surface px-8 py-3 text-[11px] leading-none transition-colors hover:bg-black/4"
            >
              👎
            </button>
          </span>
        )}
        {canRate && rated && <span>Rated</span>}
      </div>
    );
    // File cards render OUTSIDE the clickable bubble - FileResultCard has its
    // own Preview/Download buttons, and buttons must never nest. The wrapper
    // must STRETCH (no items-start): a shrink-to-fit parent makes the bubble's
    // max-w-[85%] resolve against its own content width, collapsing short
    // results into a one-word-per-line sliver.
    assistantBubble = (
      <div className="flex flex-col gap-8">
        {signableCall && onchainCard ? (
          <OnchainCallCard
            card={onchainCard}
            envelope={signableCall}
            agentPubkey={agentPubkey}
            jobEventId={entry.jobEventId}
            signedAlready={entry.callSignature}
            signedStatus={entry.callStatus}
          />
        ) : (
          <ChatBubble side="assistant" onClick={onOpen}>
            <p className="m-0 line-clamp-6 break-words whitespace-pre-wrap">
              {unmatchedCall ? UNMATCHED_CALL_NOTICE : resultPreview || 'Result received'}
            </p>
          </ChatBubble>
        )}
        {fetchableAttachments.length > 0 && (
          <div className="flex w-full max-w-[85%] flex-col gap-8 sm:max-w-[70%]">
            {fetchableAttachments.map((attachment, index) => (
              <FileResultCard
                key={`${index}-${attachment.name}`}
                attachment={attachment}
                providerPubkey={agentPubkey}
              />
            ))}
          </div>
        )}
        {footerNode}
      </div>
    );
  } else if (entry.status === 'pending') {
    assistantBubble = (
      <ChatBubble side="assistant" tone="status">
        <span className="flex items-center gap-8">
          <svg aria-hidden className="size-12 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
            <path
              d="M12 2a10 10 0 0 1 10 10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          {liveStatus ??
            (entry.txHash ? 'Paid - waiting for the result…' : 'Waiting for the result…')}
        </span>
      </ChatBubble>
    );
  } else {
    assistantBubble = (
      <ChatBubble
        side="assistant"
        tone="failed"
        footer={
          <div className="flex items-center gap-8 text-[10px] text-text-2 opacity-80">
            <span>{formatEntryTime(entry.ts)}</span>
            {retryNode}
          </div>
        }
      >
        No result was delivered for this message.
      </ChatBubble>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {(entry.prompt || promptFileChip) && (
        <ChatBubble side="user" onClick={completed ? onOpen : undefined}>
          {entry.prompt && (
            <p className="m-0 line-clamp-4 break-words whitespace-pre-wrap">{entry.prompt}</p>
          )}
          {promptFileChip}
        </ChatBubble>
      )}
      {assistantBubble}
    </div>
  );
}
