/**
 * The page's photos, generated with Higgsfield (prompts in `MEDIA.md`) and
 * served from this origin like every other asset.
 */
import beanie from './media/beanie.webp';
import bedding from './media/bedding.webp';
import cardigan from './media/cardigan.webp';
import catalog from './media/catalog.webp';
import charger from './media/charger.webp';
import closing from './media/closing.webp';
import cream from './media/cream.webp';
import earbuds from './media/earbuds.webp';
import headphonesBlack from './media/headphones-black.webp';
import headphonesSand from './media/headphones-sand.webp';
import heroBeauty from './media/hero-beauty.webp';
import heroElectronics from './media/hero-electronics.webp';
import heroHome from './media/hero-home.webp';
import heroFashion from './media/hero.webp';
import keys from './media/keys.webp';
import lamp from './media/lamp.webp';
import serum from './media/serum.webp';
import sweater from './media/sweater.webp';

export interface Photo {
  src: string;
  width: number;
  height: number;
  alt: string;
}

const WIDE = { width: 2048, height: 1152 };

export const PHOTOS = {
  heroElectronics: {
    src: heroElectronics,
    ...WIDE,
    alt: 'A bright electronics boutique with headphones on oak shelves',
  },
  heroFashion: {
    src: heroFashion,
    ...WIDE,
    alt: 'A bright boutique with folded knitwear and ceramics',
  },
  heroHome: { src: heroHome, ...WIDE, alt: 'A calm bedroom with a ceramic lamp and linen bedding' },
  heroBeauty: { src: heroBeauty, ...WIDE, alt: 'A skincare counter with glass bottles and jars' },
  closing: { src: closing, ...WIDE, alt: 'A boutique storefront at golden hour' },
  catalog: {
    src: catalog,
    width: 1400,
    height: 1050,
    alt: 'Store products laid out in a neat grid',
  },
  keys: { src: keys, width: 1100, height: 1467, alt: 'A brass key on folded linen' },
} satisfies Record<string, Photo>;

export interface Product {
  image: string;
  title: string;
  note: string;
  price: string;
}

/** Made-up products for the drawings: names and prices as a store's catalog would list them. */
export const PRODUCTS = {
  headphonesSand: {
    image: headphonesSand,
    title: 'Aria ANC headphones',
    note: 'Sand, 32 h battery',
    price: '$179.00',
  },
  headphonesBlack: {
    image: headphonesBlack,
    title: 'Pulse Pro headphones',
    note: 'Black, 40 h battery',
    price: '$199.00',
  },
  earbuds: { image: earbuds, title: 'Stride sport earbuds', note: 'White, IPX5', price: '$89.00' },
  charger: {
    image: charger,
    title: '65W USB-C charger',
    note: 'With a 2 m cable',
    price: '$39.00',
  },
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
  lamp: { image: lamp, title: 'Ceramic bedside lamp', note: 'Sage, warm bulb', price: '$96.00' },
  bedding: { image: bedding, title: 'Linen duvet set', note: 'Oat, queen', price: '$148.00' },
  serum: { image: serum, title: 'Hydrating serum', note: '30 ml, fragrance-free', price: '$32.00' },
  cream: { image: cream, title: 'Barrier cream', note: '50 ml, fragrance-free', price: '$28.00' },
} satisfies Record<string, Product>;
