import { useEffect, useState } from 'react';
import { useElisymClient } from './useElisymClient';

/**
 * Fetches the `banner` field from an agent's Nostr kind:0 profile event.
 * Returns undefined while loading or if no banner is set.
 */
export function useAgentBanner(pubkey: string): string | undefined {
  const { client } = useElisymClient();
  const [banner, setBanner] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;

    client.pool
      .querySync({ kinds: [0], authors: [pubkey], limit: 1 })
      .then((events) => {
        if (cancelled || events.length === 0) return;
        try {
          const content = JSON.parse(events[0]!.content) as Record<string, unknown>;
          const url = typeof content.banner === 'string' ? content.banner : undefined;
          if (url) setBanner(url);
        } catch {
          // malformed content — ignore
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [pubkey, client]);

  return banner;
}
