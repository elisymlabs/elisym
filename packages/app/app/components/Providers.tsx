import '@solana/wallet-adapter-react-ui/styles.css';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { PageHeaderProvider } from '~/contexts/PageHeaderContext';
import { UIProvider } from '~/contexts/UIContext';
import { ElisymProvider } from '~/hooks/useElisymClient';
import { IdentityProvider } from '~/hooks/useIdentity';
import { SOLANA_RPC_URL } from '~/lib/cluster';

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={SOLANA_RPC_URL}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <ElisymProvider>
              <IdentityProvider>
                <UIProvider>
                  <PageHeaderProvider>{children}</PageHeaderProvider>
                </UIProvider>
              </IdentityProvider>
            </ElisymProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
