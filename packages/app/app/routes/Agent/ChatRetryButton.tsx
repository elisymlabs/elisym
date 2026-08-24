import { toDTag, type CapabilityCard } from '@elisym/sdk';
import { useDelegatedBuyMode } from '~/hooks/useDelegationStatus';
import type { PingStatus } from '~/hooks/usePingAgent';
import type { ChatThreadEntry } from '~/lib/chatThread';
import { recallJobFile } from '~/lib/retryFiles';
import type { ChatSend } from './useChatSend';
import { useJobGating } from './useJobGating';

interface Props {
  entry: ChatThreadEntry;
  cards: CapabilityCard[];
  agentPubkey: string;
  pingStatus: PingStatus;
  buying: boolean;
  entries: ChatThreadEntry[];
  onSelectCardIndex: (index: number) => void;
  send: ChatSend;
}

interface InnerProps extends Props {
  card: CapabilityCard;
  cardIndex: number;
  file: File | undefined;
}

function ChatRetryButtonInner({
  entry,
  card,
  cardIndex,
  file,
  agentPubkey,
  pingStatus,
  buying,
  entries,
  onSelectCardIndex,
  send,
}: InnerProps) {
  // Full JobInput-style gating, recomputed at render and re-checked at click.
  // `static` cards submit `card.name`, like a normal send.
  const retryInput = card.static === true ? card.name : entry.prompt;
  // Same delegated-coverage bypass as the composer: a retry that will settle
  // from the allowance needs no per-job SOL.
  const buyMode = useDelegatedBuyMode(card);
  const gate = useJobGating({
    card,
    agentPubkey,
    pingStatus,
    input: retryInput,
    file: file ?? null,
    buying,
    delegatedCovers: buyMode === 'use',
  });

  async function handleRetry() {
    if (gate.isDisabled || gate.needsWalletConnect) {
      return;
    }
    // Retry switches the selection to the entry's recorded capability and
    // re-sends through the normal path. The recorded null-vs-UUID choice is
    // preserved: a `null` (or absent) entry retries as a one-shot; a UUID entry
    // retries under the CURRENT active session id (and a now-context-off card
    // falls out to a marked one-shot inside the send path).
    onSelectCardIndex(cardIndex);
    await send(card, card.static === true ? card.name : gate.effectiveInput, file, entries, {
      forceOneShot: typeof entry.sessionId !== 'string',
      gasLamports: gate.gasFeeLamports,
    });
  }

  const disabled = gate.isDisabled || gate.needsWalletConnect;
  const title = gate.needsWalletConnect ? 'Connect your wallet to retry.' : (gate.tip ?? undefined);

  return (
    <button
      type="button"
      onClick={() => void handleRetry()}
      disabled={disabled}
      title={title}
      className="cursor-pointer rounded-full border border-black/10 bg-surface px-12 py-4 text-[11px] font-medium text-text transition-colors hover:bg-black/4 disabled:cursor-not-allowed disabled:opacity-40"
    >
      Retry
    </button>
  );
}

/**
 * Retry on a failed bubble - a fresh send through the normal path, never a
 * replay of the recorded session id. Disabled with a note when the provider
 * no longer offers the recorded capability; file-input entries whose `File`
 * did not survive the reload get a re-attach hint instead of a button.
 */
export function ChatRetryButton(props: Props) {
  const { entry, cards } = props;
  const cardIndex = cards.findIndex((card) => toDTag(card.name) === entry.capability);
  const card = cardIndex === -1 ? undefined : cards[cardIndex];

  if (!card) {
    return <span className="text-[11px] text-text-2/70">Product no longer offered</span>;
  }

  const file = recallJobFile(entry.jobEventId);
  if (entry.promptAttachment !== undefined && file === undefined) {
    return <span className="text-[11px] text-text-2/70">Re-attach the file to retry</span>;
  }

  return <ChatRetryButtonInner {...props} card={card} cardIndex={cardIndex} file={file} />;
}
