import { useState, useEffect } from 'react';
import { cn } from '~/lib/cn';

interface Props {
  src: string;
  className?: string;
  alt?: string;
  onLoadedChange?: (loaded: boolean) => void;
}

const LOADED_URLS = new Set<string>();

export function FadeInImage({ src, className, alt = '', onLoadedChange }: Props) {
  const [loaded, setLoaded] = useState(() => LOADED_URLS.has(src));

  useEffect(() => {
    const cached = LOADED_URLS.has(src);
    setLoaded(cached);
    onLoadedChange?.(cached);
  }, [src, onLoadedChange]);

  function handleLoad() {
    LOADED_URLS.add(src);
    setLoaded(true);
    onLoadedChange?.(true);
  }

  return (
    <img
      src={src}
      alt={alt}
      onLoad={handleLoad}
      className={cn(
        'transition-opacity duration-500',
        loaded ? 'opacity-100' : 'opacity-0',
        className,
      )}
    />
  );
}
