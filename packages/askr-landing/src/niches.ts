/**
 * The stores the hero demo can show, one per niche. Everything here is made
 * up for the drawings: store names, products and prices, as a store's catalog
 * would list them. Each answer only states what the cards and a store policy
 * could back.
 */
import { PHOTOS, PRODUCTS, type Photo, type Product } from './media';

export interface Niche {
  id: string;
  label: string;
  store: string;
  photo: Photo;
  question: string;
  answer: string;
  /** The two picks, each with the line the assistant gives for it. */
  cards: readonly [Pick, Pick];
  /** The follow-up questions the widget offers under the answer. */
  chips: readonly string[];
}

export interface Pick {
  product: Product;
  reason: string;
}

export const NICHES: readonly Niche[] = [
  {
    id: 'electronics',
    label: 'Electronics',
    store: 'Northwind Audio',
    photo: PHOTOS.heroElectronics,
    question: 'Noise-cancelling headphones under $200 for long flights?',
    answer:
      "Two fit. Both last over 30 hours on a charge, and the store's warranty covers them for 2 years.",
    cards: [
      { product: PRODUCTS.headphonesSand, reason: 'Lighter, 32 h battery' },
      { product: PRODUCTS.headphonesBlack, reason: 'Longest battery, 40 h' },
    ],
    chips: ['Compare them', 'Anything cheaper?'],
  },
  {
    id: 'fashion',
    label: 'Fashion',
    store: 'Harbor Knits',
    photo: PHOTOS.heroFashion,
    question: 'A warm sweater under $80 that ships to Spain?',
    answer: "Two fit. Both ship to Spain in 3 to 5 days, as the store's shipping policy says.",
    cards: [
      { product: PRODUCTS.sweater, reason: 'Merino, navy, sizes S to XL' },
      { product: PRODUCTS.cardigan, reason: 'Lambswool, oat, sizes XS to L' },
    ],
    chips: ['Which is warmer?', 'Size help'],
  },
  {
    id: 'home',
    label: 'Home',
    store: 'Linden Home',
    photo: PHOTOS.heroHome,
    question: 'A lamp and linen bedding for a calm guest room?',
    answer:
      'Here are two. The lamp comes with a warm 2700K bulb, and the linen set is in stock in queen.',
    cards: [
      { product: PRODUCTS.lamp, reason: 'Sage ceramic, warm bulb included' },
      { product: PRODUCTS.bedding, reason: 'Oat linen, queen in stock' },
    ],
    chips: ['Other colors?', 'Shipping time'],
  },
  {
    id: 'beauty',
    label: 'Beauty',
    store: 'Clearwater Skin',
    photo: PHOTOS.heroBeauty,
    question: 'Something for dry skin, fragrance-free, under $40?',
    answer: 'Two fit. Both are fragrance-free, and unopened items can be returned within 30 days.',
    cards: [
      { product: PRODUCTS.serum, reason: 'Hydrating, 30 ml' },
      { product: PRODUCTS.cream, reason: 'Barrier repair, 50 ml' },
    ],
    chips: ['Use them together?', 'Return policy'],
  },
];
