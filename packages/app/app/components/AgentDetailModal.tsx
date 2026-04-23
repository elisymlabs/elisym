import { truncateKey, toDTag } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import type { AgentDisplayData } from '~/hooks/useAgentDisplay';
import { useBodyScrollLock } from '~/hooks/useBodyScrollLock';
import { useIdentity } from '~/hooks/useIdentity';
import { usePingAgent, type PingStatus } from '~/hooks/usePingAgent';
import { cn } from '~/lib/cn';
import { CapabilityItem } from './CapabilityItem';
import { MarbleAvatar } from './MarbleAvatar';

interface Props {
  agent: AgentDisplayData;
  onClose: () => void;
}

const STATUS_DOT: Record<PingStatus, string> = {
  pinging: 'bg-yellow-400 animate-pulse',
  online: 'bg-green',
  offline: 'bg-red-400',
};

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 280;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function AgentDetailModal({ agent, onClose }: Props) {
  useBodyScrollLock(true);
  const idCtx = useIdentity();
  const isOwn = idCtx.publicKey === agent.pubkey;
  const pingedStatus = usePingAgent(isOwn ? '' : agent.pubkey);
  const pingStatus: PingStatus = isOwn ? 'online' : pingedStatus;

  const rawName = agent.name || truncateKey(nip19.npubEncode(agent.pubkey), 8);
  const displayName = clamp(rawName, MAX_NAME_LENGTH);

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/25 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="relative max-h-[90vh] w-560 max-w-[95vw] overflow-y-auto rounded-18 border border-border bg-surface p-32">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-16 right-16 z-10 flex size-32 cursor-pointer items-center justify-center rounded-full border-none bg-surface-2 text-text-2 transition-colors hover:bg-surface-2/80 hover:text-text"
        >
          <svg
            aria-hidden
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

        <div className="mb-24 flex items-start gap-12 pr-32">
          <div className="flex min-w-0 items-start gap-16">
            <div className="flex size-56 shrink-0 items-center justify-center overflow-hidden rounded-full">
              {agent.picture ? (
                <img src={agent.picture} alt={agent.name} className="size-full object-cover" />
              ) : (
                <MarbleAvatar name={agent.pubkey} size={56} />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="flex items-start gap-8 text-xl font-bold">
                <span>{displayName}</span>
                <span
                  className={cn('mt-8 size-10 shrink-0 rounded-full', STATUS_DOT[pingStatus])}
                />
              </h2>
              <div className="mt-2 font-mono text-xs text-text-2">
                {truncateKey(nip19.npubEncode(agent.pubkey))}
              </div>
            </div>
          </div>
        </div>

        {agent.description && (
          <div className="mb-24 text-sm leading-relaxed text-text-2">
            {clamp(agent.description, MAX_DESCRIPTION_LENGTH)}
          </div>
        )}

        <div className="mb-12 text-sm font-semibold">Products ({agent.cards.length})</div>

        <div className="flex flex-col gap-12">
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

        <div className="mt-24 flex items-center justify-between border-t border-border pt-20 text-xs text-text-2">
          {agent.walletAddress && (
            <span className="font-mono">
              <span className="mr-6 font-sans font-medium text-text-2">Wallet</span>
              {truncateKey(agent.walletAddress)}
            </span>
          )}
          <span>{agent.lastSeen}</span>
        </div>
      </div>
    </div>
  );
}
