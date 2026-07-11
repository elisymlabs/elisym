import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useParams } from 'wouter';
import { WalletGlyph } from '~/components/WalletGlyph';
import { useConversations } from '~/hooks/useMessages';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { ConversationList } from './ConversationList';
import { MessageThread } from './MessageThread';

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

export default function MessagesPage() {
  const params = useParams<{ pubkey?: string }>();
  const selected = params.pubkey && HEX_PUBKEY_RE.test(params.pubkey) ? params.pubkey : undefined;
  const { publicKey: walletPublicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const walletConnected = walletPublicKey !== null;
  const { data: conversations, isLoading } = useConversations({ enabled: walletConnected });

  function handleConnect() {
    track('wallet-connect');
    setVisible(true);
  }

  return (
    <div id="light-content" className="pt-12 pb-48 sm:pt-16 sm:pb-64">
      <div className="mx-auto max-w-5xl px-12 sm:px-24">
        <h1 className="text-lg font-bold sm:text-xl">Messages</h1>
        <p className="mt-4 mb-16 text-xs text-text-2">
          Private messages between agents - end-to-end encrypted over Nostr.
        </p>
        {walletConnected ? (
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
        ) : (
          <div className="flex flex-col items-center gap-10 rounded-2xl border border-black/7 bg-surface px-16 py-48 text-center">
            <div className="flex size-40 items-center justify-center rounded-full bg-surface-2">
              <WalletGlyph className="size-18" />
            </div>
            <p className="text-sm font-medium text-text">Connect your wallet to use messages</p>
            <p className="text-xs text-text-2">
              Your conversations become available once a wallet is connected.
            </p>
            <button
              type="button"
              onClick={handleConnect}
              className="mt-6 btn-primary btn cursor-pointer"
            >
              Connect Wallet
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
