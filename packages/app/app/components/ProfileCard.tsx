import { truncateKey } from '@elisym/sdk';
import type { Filter } from 'nostr-tools';
import { useState, useEffect, useRef } from 'react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import { getCachedImage, cacheImage } from '~/lib/localCache';
import { MarbleAvatar } from './MarbleAvatar';

interface NostrProfile {
  name?: string;
  about?: string;
  picture?: string;
}

interface ProfileCardProps {
  npub: string;
  pubkey: string;
  keyName?: string;
}

export function ProfileCard({ npub, pubkey, keyName }: ProfileCardProps) {
  const { client } = useElisymClient();

  const { data: profile, isLoading } = useLocalQuery<NostrProfile | null>({
    queryKey: ['nostr-profile', pubkey],
    queryFn: async () => {
      const events = await client.pool.querySync({
        kinds: [0],
        authors: [pubkey],
      } as Filter);
      const sorted = events.sort((a, b) => b.created_at - a.created_at);
      const latest = sorted[0];
      if (latest) {
        try {
          return JSON.parse(latest.content);
        } catch {
          // malformed
        }
      }
      return null;
    },
    enabled: !!pubkey,
    staleTime: 1000 * 60 * 5,
  });

  const pictureUrl = profile?.picture;
  const [imgSrc, setImgSrc] = useState<string | undefined>(undefined);
  const [imgLoaded, setImgLoaded] = useState(false);
  const objectUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!pictureUrl) {
      setImgSrc(undefined);
      setImgLoaded(false);
      return;
    }

    let cancelled = false;

    const revokeOld = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }
    };

    revokeOld();

    getCachedImage(pictureUrl).then((cachedUrl) => {
      if (cancelled) {
        return;
      }
      if (cachedUrl) {
        objectUrlRef.current = cachedUrl;
        setImgSrc(cachedUrl);
        setImgLoaded(true);
        return;
      }
      // Not cached — preload from network, then cache the blob
      const img = new Image();
      img.src = pictureUrl;
      const onLoad = () => {
        if (cancelled) {
          return;
        }
        cacheImage(pictureUrl).then((blobUrl) => {
          if (cancelled) {
            if (blobUrl) {
              URL.revokeObjectURL(blobUrl);
            }
            return;
          }
          if (blobUrl) {
            objectUrlRef.current = blobUrl;
            setImgSrc(blobUrl);
          } else {
            setImgSrc(pictureUrl);
          }
          setImgLoaded(true);
        });
      };
      if (img.complete) {
        onLoad();
      } else {
        img.onload = onLoad;
        img.onerror = () => {
          if (!cancelled) {
            setImgLoaded(false);
          }
        };
      }
    });

    return () => {
      cancelled = true;
      revokeOld();
    };
  }, [pictureUrl]);

  const displayName = profile?.name || keyName || 'Your Profile';
  const npubDisplay = truncateKey(npub);
  const showImg = imgSrc && imgLoaded;

  return (
    <div className="bg-surface border border-border rounded-2xl p-8">
      <div className="flex items-center gap-5 max-sm:flex-col max-sm:text-center relative">
        <div className="w-20 h-20 rounded-full overflow-hidden shrink-0 flex items-center justify-center">
          {(() => {
            if (isLoading) {
              return <div className="w-20 h-20 rounded-full bg-border animate-pulse" />;
            }
            if (showImg) {
              return <img src={imgSrc} alt={displayName} className="w-full h-full object-cover" />;
            }
            return <MarbleAvatar name={pubkey} size={80} />;
          })()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            {isLoading ? (
              <div className="h-7 w-40 bg-border rounded animate-pulse mb-1" />
            ) : (
              <h1 className="text-2xl font-bold mb-1 line-clamp-1 break-all min-w-0">
                {displayName}
              </h1>
            )}
          </div>
          <div className="font-mono text-[13px] text-text-2 mb-1">{npubDisplay}</div>
          {!isLoading && profile?.about && (
            <div className="text-sm text-text-2 leading-relaxed mt-2">
              {profile.about.length > 280 ? profile.about.slice(0, 280) + '...' : profile.about}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
