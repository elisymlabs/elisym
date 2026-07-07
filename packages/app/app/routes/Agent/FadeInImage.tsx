import { useEffect, useState } from 'react';
import { cn } from '~/lib/cn';

interface Props {
  src: string;
  className?: string;
  alt?: string;
}

const LOADED_URLS = new Set<string>();

export function FadeInImage({ src, className, alt = '' }: Props) {
  const [loaded, setLoaded] = useState(() => LOADED_URLS.has(src));

  useEffect(() => {
    setLoaded(LOADED_URLS.has(src));
  }, [src]);

  function handleLoad() {
    LOADED_URLS.add(src);
    setLoaded(true);
  }

  return (
    <img
      src={src}
      alt={alt}
      onLoad={handleLoad}
      // Remote, often provider-controlled URL - don't leak the referrer (which can
      // encode the inspected agent's pubkey) to the image host.
      referrerPolicy="no-referrer"
      className={cn(
        'transition-opacity duration-500',
        loaded ? 'opacity-100' : 'opacity-0',
        className,
      )}
    />
  );
}
