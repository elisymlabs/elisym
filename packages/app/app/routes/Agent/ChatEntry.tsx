import { resolveKnownAsset } from '@elisym/sdk';
import type { ReactNode } from 'react';
import type { ChatThreadEntry } from '~/lib/chatThread';
import { hasBlossom } from '~/lib/fileResult';
import { compactZeros, formatDecimal } from '~/lib/formatPrice';
import { ChatBubble } from './ChatBubble';
import { FileResultCard } from './FileResultCard';
import { cleanPreviewText } from './lib/artifactPreview';

const SOL_DECIMALS = 9;

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
              className="cursor-pointer rounded-full border-0 bg-transparent px-4 py-2 opacity-70 transition-opacity hover:opacity-100"
            >
              👍
            </button>
            <button
              type="button"
              onClick={() => onRate(false)}
              title="Bad result"
              className="cursor-pointer rounded-full border-0 bg-transparent px-4 py-2 opacity-70 transition-opacity hover:opacity-100"
            >
              👎
            </button>
          </span>
        )}
        {canRate && rated && <span>Rated</span>}
      </div>
    );
    // File cards render OUTSIDE the clickable bubble - FileResultCard has its
    // own Preview/Download buttons, and buttons must never nest.
    assistantBubble = (
      <div className="flex flex-col items-start gap-4">
        <ChatBubble side="assistant" onClick={onOpen}>
          <p className="m-0 line-clamp-6 break-words whitespace-pre-wrap">
            {resultPreview || 'Result received'}
          </p>
        </ChatBubble>
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
    <div className="flex flex-col gap-4">
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
