import { useQuery } from '@tanstack/react-query';
import { useElisymClient } from './useElisymClient';

const BANNER_STALE_MS = 1000 * 60 * 5;
const BANNER_GC_MS = 1000 * 60 * 30;

/**
 * Fetches the `banner` field from an agent's Nostr kind:0 profile event.
 * Cached via TanStack Query so navigating away and back does not refire the
 * relay query (which previously made the banner re-fade on every visit).
 */
export function useAgentBanner(pubkey: string): string | undefined {
  const { client } = useElisymClient();

  const { data } = useQuery<string | null>({
    queryKey: ['agent-banner', pubkey],
    enabled: Boolean(pubkey),
    staleTime: BANNER_STALE_MS,
    gcTime: BANNER_GC_MS,
    queryFn: async () => {
      const events = await client.pool.querySync({
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      });
      const [firstEvent] = events;
      if (!firstEvent) {
        return null;
      }
      try {
        const content = JSON.parse(firstEvent.content) as Record<string, unknown>;
        return typeof content.banner === 'string' ? content.banner : null;
      } catch {
        return null;
      }
    },
  });

  return data ?? undefined;
}
