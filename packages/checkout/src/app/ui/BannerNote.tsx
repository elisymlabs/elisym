import type { Banner } from '../session';

interface Props {
  banner: Banner | undefined;
}

const BANNER_TEXT: Record<Banner['state'], string> = {
  paid: 'A payment from earlier went through. Wait for the store before paying again.',
  blocked: 'A payment from earlier is held by the store’s account. Contact the store.',
  completed: 'A purchase from earlier is complete.',
  refunded: 'A purchase from earlier was refunded by the store.',
};

/** A late answer for another order of this product, above whatever step is on screen. */
export function BannerNote({ banner }: Props) {
  if (banner === undefined) {
    return null;
  }
  return (
    <p class="banner" role="status">
      {BANNER_TEXT[banner.state]}
    </p>
  );
}
