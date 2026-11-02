import { type ReactNode, useState } from 'react';

interface Props {
  /** The product's picture link, already checked to be one the node takes. */
  src: string;
  className: string;
  /** Shown instead when the picture does not load; nothing by default. */
  fallback?: ReactNode;
}

/**
 * A product's picture, decorative (its title is next to it): no referrer is
 * sent to its host, and a link that does not load shows `fallback` rather than
 * a broken picture.
 */
export function ProductPicture({ src, className, fallback = null }: Props) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  if (failed === src) {
    return fallback;
  }
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      decoding="async"
      onError={() => setFailed(src)}
      className={className}
    />
  );
}
