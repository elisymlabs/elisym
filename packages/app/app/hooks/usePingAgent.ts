import { useState, useEffect } from 'react';
import { useElisymClient } from './useElisymClient';

export type PingStatus = 'pinging' | 'online' | 'offline';

/**
 * Pings an agent on mount with automatic retry.
 * - Starts as "pinging" (yellow)
 * - Up to 3 attempts with 1.5s between retries
 * - If pong arrives → "online" (green)
 */
export function usePingAgent(agentPubkey: string) {
  const { client } = useElisymClient();
  const [status, setStatus] = useState<PingStatus>('pinging');

  useEffect(() => {
    if (!agentPubkey) {
      return;
    }
    setStatus('pinging');

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const ping = (attempt: number) => {
      if (cancelled) {
        return;
      }
      client.ping
        .pingAgent(agentPubkey, 15_000)
        .then(({ online }) => {
          if (cancelled) {
            return;
          }
          if (online) {
            setStatus('online');
          } else if (attempt < 2) {
            retryTimer = setTimeout(() => {
              if (!cancelled) {
                ping(attempt + 1);
              }
            }, 1500);
          } else {
            setStatus('offline');
          }
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          if (attempt < 2) {
            retryTimer = setTimeout(() => {
              if (!cancelled) {
                ping(attempt + 1);
              }
            }, 1500);
          } else {
            setStatus('offline');
          }
        });
    };

    ping(1);

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [agentPubkey, client]);

  return status;
}
