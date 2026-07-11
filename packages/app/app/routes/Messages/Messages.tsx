import { useParams } from 'wouter';
import { useConversations } from '~/hooks/useMessages';
import { cn } from '~/lib/cn';
import { ConversationList } from './ConversationList';
import { MessageThread } from './MessageThread';

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

export default function MessagesPage() {
  const params = useParams<{ pubkey?: string }>();
  const selected = params.pubkey && HEX_PUBKEY_RE.test(params.pubkey) ? params.pubkey : undefined;
  const { data: conversations, isLoading } = useConversations();

  return (
    <div id="light-content" className="pt-12 pb-48 sm:pt-16 sm:pb-64">
      <div className="mx-auto max-w-5xl px-12 sm:px-24">
        <h1 className="mb-16 text-lg font-bold sm:text-xl">Messages</h1>
        <div className="grid items-start gap-16 md:grid-cols-[320px_1fr]">
          <ConversationList
            conversations={conversations ?? []}
            activePubkey={selected}
            loading={isLoading}
            className={cn(selected && 'max-md:hidden')}
          />
          {selected ? (
            <MessageThread key={selected} counterpartPubkey={selected} />
          ) : (
            <div className="hidden min-h-480 items-center justify-center rounded-2xl border border-black/7 bg-surface md:flex">
              <p className="px-24 text-center text-sm text-text-2">
                Select a conversation, or open an agent page and hit Message.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
