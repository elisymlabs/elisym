import { useState, useEffect } from 'react';
import { useElisymClient } from './useElisymClient';

export type PingStatus = 'pinging' | 'online' | 'offline';

const FAST_OFFLINE_TIMEOUT_MS = 5000;

/**
 * Pings an agent on mount with automatic retry.
 * - Starts as "pinging" (yellow)
 * - After 5s without a pong → "offline" (grey), but keeps pinging in the background
 * - If a pong arrives at any point → "online" (green) — even after we visually
 *   gave up, so a slow agent still gets to flip the dot.
 * - Up to 3 attempts with 1.5s between retries
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
    const fastOfflineTimer = setTimeout(() => {
      if (cancelled) {
        return;
      }
      setStatus((current) => (current === 'pinging' ? 'offline' : current));
    }, FAST_OFFLINE_TIMEOUT_MS);

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
      clearTimeout(fastOfflineTimer);
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [agentPubkey, client]);

  return status;
}
