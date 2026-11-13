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
  cards: readonly [Product, Product];
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
    cards: [PRODUCTS.headphonesSand, PRODUCTS.headphonesBlack],
  },
  {
    id: 'fashion',
    label: 'Fashion',
    store: 'Harbor Knits',
    photo: PHOTOS.heroFashion,
    question: 'A warm sweater under $80 that ships to Spain?',
    answer: "Two fit. Both ship to Spain in 3 to 5 days, as the store's shipping policy says.",
    cards: [PRODUCTS.sweater, PRODUCTS.cardigan],
  },
  {
    id: 'home',
    label: 'Home',
    store: 'Linden Home',
    photo: PHOTOS.heroHome,
    question: 'A lamp and linen bedding for a calm guest room?',
    answer:
      'Here are two. The lamp comes with a warm 2700K bulb, and the linen set is in stock in queen.',
    cards: [PRODUCTS.lamp, PRODUCTS.bedding],
  },
  {
    id: 'beauty',
    label: 'Beauty',
    store: 'Clearwater Skin',
    photo: PHOTOS.heroBeauty,
    question: 'Something for dry skin, fragrance-free, under $40?',
    answer: 'Two fit. Both are fragrance-free, and unopened items can be returned within 30 days.',
    cards: [PRODUCTS.serum, PRODUCTS.cream],
  },
];
