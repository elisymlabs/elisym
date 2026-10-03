import type { Banner } from '../session';

interface Props {
  banner: Banner | undefined;
}

const BANNER_TEXT: Record<Banner['state'], string> = {
  paid: 'Your earlier order was paid after all. Waiting for the store to deliver it.',
  blocked: 'Your earlier payment was blocked by the recipient. Contact the store.',
  completed: 'Your earlier order was delivered:',
  refunded: 'Your earlier order was refunded by the store.',
};

/** A late answer for another order of this product, above whatever step is on screen. */
export function BannerNote({ banner }: Props) {
  if (banner === undefined) {
    return null;
  }
  return (
    <p class="banner" role="status">
      {BANNER_TEXT[banner.state]}{' '}
      {banner.link === undefined ? (
        (banner.text ?? '')
      ) : (
        <a href={banner.link} target="_blank" rel="noopener noreferrer">
          {banner.link}
        </a>
      )}
    </p>
  );
}
