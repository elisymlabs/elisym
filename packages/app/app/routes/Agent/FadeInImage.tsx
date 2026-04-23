import { useState, useEffect } from 'react';
import { cn } from '~/lib/cn';

interface Props {
  src: string;
  className?: string;
  alt?: string;
}

export function FadeInImage({ src, className, alt = '' }: Props) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
  }, [src]);

  return (
    <img
      src={src}
      alt={alt}
      onLoad={() => setLoaded(true)}
      className={cn(
        'transition-opacity duration-500',
        loaded ? 'opacity-100' : 'opacity-0',
        className,
      )}
    />
  );
}
