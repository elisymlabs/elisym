import { truncateKey } from '@elisym/sdk';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import { getCachedImage, cacheImage } from '~/lib/localCache';
import { MarbleAvatar } from './MarbleAvatar';

interface NostrProfile {
  name?: string;
  about?: string;
  picture?: string;
}

interface Props {
  npub: string;
  pubkey: string;
  keyName?: string;
}

const MAX_ABOUT_LENGTH = 280;

export function ProfileCard({ npub, pubkey, keyName }: Props) {
  const { client } = useElisymClient();

  const { data: profile, isLoading } = useLocalQuery<NostrProfile | null>({
    queryKey: ['nostr-profile', pubkey],
    queryFn: async () => {
      const events = await client.pool.querySync({
        kinds: [0],
        authors: [pubkey],
      });
      const sorted = events.sort((a, b) => b.created_at - a.created_at);
      const latest = sorted[0];
      if (latest) {
        try {
          return JSON.parse(latest.content) as NostrProfile;
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

  let avatar: ReactNode;
  if (isLoading) {
    avatar = <div className="h-80 w-80 animate-pulse rounded-full bg-border" />;
  } else if (showImg) {
    avatar = <img src={imgSrc} alt={displayName} className="h-full w-full object-cover" />;
  } else {
    avatar = <MarbleAvatar name={pubkey} size={80} />;
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-32">
      <div className="relative flex items-center gap-20 max-sm:flex-col max-sm:text-center">
        <div className="flex h-80 w-80 shrink-0 items-center justify-center overflow-hidden rounded-full">
          {avatar}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-12">
            {isLoading ? (
              <div className="mb-4 h-28 w-160 animate-pulse rounded bg-border" />
            ) : (
              <h1 className="mb-4 line-clamp-1 min-w-0 text-2xl font-bold break-all">
                {displayName}
              </h1>
            )}
          </div>
          <div className="mb-4 font-mono text-[13px] text-text-2">{npubDisplay}</div>
          {!isLoading && profile?.about && (
            <div className="mt-8 text-sm leading-relaxed text-text-2">
              {profile.about.length > MAX_ABOUT_LENGTH
                ? `${profile.about.slice(0, MAX_ABOUT_LENGTH)}...`
                : profile.about}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
