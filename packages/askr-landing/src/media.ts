/**
 * The page's photos, generated with Higgsfield (prompts in `MEDIA.md`) and
 * served from this origin like every other asset.
 */
import beanie from './media/beanie.webp';
import cardigan from './media/cardigan.webp';
import catalog from './media/catalog.webp';
import closing from './media/closing.webp';
import hero from './media/hero.webp';
import keys from './media/keys.webp';
import sweater from './media/sweater.webp';

export const PHOTOS = {
  hero: {
    src: hero,
    width: 2048,
    height: 1152,
    alt: 'A bright boutique with folded knitwear and ceramics',
  },
  closing: { src: closing, width: 2048, height: 1152, alt: 'A boutique storefront at golden hour' },
  catalog: {
    src: catalog,
    width: 1400,
    height: 1050,
    alt: 'Store products laid out in a neat grid',
  },
  keys: { src: keys, width: 1100, height: 1467, alt: 'A brass key on folded linen' },
};

/** Made-up products for the drawings: names and prices as a store's catalog would list them. */
export const PRODUCTS = {
  sweater: {
    image: sweater,
    title: 'Merino crew sweater',
    note: 'Navy, sizes S to XL',
    price: '$72.00',
  },
  cardigan: {
    image: cardigan,
    title: 'Lambswool cardigan',
    note: 'Oat, sizes XS to L',
    price: '$78.00',
  },
  beanie: { image: beanie, title: 'Ribbed wool beanie', note: 'Rust, one size', price: '$34.00' },
};

export type Product = (typeof PRODUCTS)[keyof typeof PRODUCTS];
