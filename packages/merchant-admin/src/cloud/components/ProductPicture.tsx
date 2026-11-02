import { useState } from 'react';

interface Props {
  /** The product's picture link, already checked to be one the node takes. */
  src: string;
  className: string;
}

/**
 * A product's picture, decorative (its title is next to it): no referrer is
 * sent to its host, and a link that does not load shows nothing rather than a
 * broken picture.
 */
export function ProductPicture({ src, className }: Props) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  if (failed === src) {
    return null;
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
