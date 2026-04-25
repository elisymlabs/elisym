import { ElisymClient, type ElisymClientFullConfig } from '@elisym/sdk';
import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useCallback,
  useState,
  type ReactNode,
} from 'react';

interface ElisymClientContextValue {
  client: ElisymClient;
  relaysConnected: boolean;
  resetPool: () => void;
}

const ElisymClientContext = createContext<ElisymClientContextValue | null>(null);

export function ElisymProvider({
  config,
  children,
}: {
  config?: ElisymClientFullConfig;
  children: ReactNode;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- config is only used on initial mount
  const client = useMemo(() => new ElisymClient(config), []);
  const [relaysConnected, setRelaysConnected] = useState(false);

  const resetPool = useCallback(() => {
    client.pool.reset();
  }, [client]);

  useEffect(() => {
    client.pool
      .querySync({ kinds: [0], limit: 1 })
      .catch(() => {
        // Probe can reject if every relay errors; surface the UI as
        // connected anyway so downstream calls aren't blocked - real
        // failures will surface on subsequent queries.
      })
      .finally(() => {
        setRelaysConnected(true);
      });
    return () => client.close();
  }, [client]);

  // Recover pool when tab returns to foreground
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        client.pool.probe(3_000).catch(() => {
          client.pool.reset();
        });
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [client]);

  return (
    <ElisymClientContext.Provider value={{ client, relaysConnected, resetPool }}>
      {children}
    </ElisymClientContext.Provider>
  );
}

export function useElisymClient() {
  const ctx = useContext(ElisymClientContext);
  if (!ctx) {
    throw new Error('useElisymClient must be used within ElisymProvider');
  }
  return ctx;
}
