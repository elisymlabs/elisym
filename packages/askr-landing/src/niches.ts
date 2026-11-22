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
  /**
   * The conversation, turn by turn. The visitor types the first question; each later question is
   * one of the chips the turn before it offered, tapped.
   */
  turns: readonly [Turn, ...Turn[]];
}

export interface Turn {
  question: string;
  answer: string;
  /** The picks shown under the answer, each with the line the assistant gives for it. */
  cards?: readonly Pick[];
  comparison?: Comparison;
  /** The follow-up questions the widget offers under the answer. */
  chips: readonly string[];
}

export interface Pick {
  product: Product;
  reason: string;
}

/**
 * A comparison as the widget draws it: one column per product, the price row from the catalog
 * first, then a cell per product in each row, in the order of `products`.
 */
export interface Comparison {
  products: readonly Product[];
  rows: readonly ComparisonRow[];
  recommended?: Product;
}

export interface ComparisonRow {
  dimension: string;
  cells: readonly string[];
}

/** The comparison the features section draws, under "Compares side by side". */
export const FEATURES_COMPARISON: Comparison = {
  products: [PRODUCTS.headphonesSand, PRODUCTS.headphonesBlack],
  rows: [
    { dimension: 'Battery', cells: ['32 h', '40 h'] },
    { dimension: 'Weight', cells: ['250 g', '290 g'] },
    { dimension: 'Warranty', cells: ['2 years', '2 years'] },
  ],
  recommended: PRODUCTS.headphonesBlack,
};

export const NICHES: readonly Niche[] = [
  {
    id: 'electronics',
    label: 'Electronics',
    store: 'Northwind Audio',
    photo: PHOTOS.heroElectronics,
    turns: [
      {
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
        question: 'Anything cheaper?',
        answer:
          'Not with noise cancelling: those two are the cheapest that have it. The Stride earbuds cost less, but they do not cancel noise.',
        cards: [{ product: PRODUCTS.earbuds, reason: 'IPX5, no noise cancelling' }],
        chips: ['Compare them', 'Shipping time'],
      },
      {
        question: 'Compare them',
        answer:
          'For long flights, the Pulse Pro: noise cancelling and the longest battery. The Stride suits the gym.',
        comparison: {
          products: [PRODUCTS.headphonesSand, PRODUCTS.headphonesBlack, PRODUCTS.earbuds],
          rows: [
            { dimension: 'Noise cancelling', cells: ['Yes', 'Yes', 'No'] },
            { dimension: 'Battery', cells: ['32 h', '40 h', '6 h'] },
            { dimension: 'Fit', cells: ['Over-ear', 'Over-ear', 'In-ear'] },
          ],
          recommended: PRODUCTS.headphonesBlack,
        },
        chips: ['Shipping time', 'Warranty details'],
      },
    ],
  },
  {
    id: 'fashion',
    label: 'Fashion',
    store: 'Harbor Knits',
    photo: PHOTOS.heroFashion,
    turns: [
      {
        question: 'A warm sweater under $80 that ships to Spain?',
        answer: "Two fit. Both ship to Spain in 3 to 5 days, as the store's shipping policy says.",
        cards: [
          { product: PRODUCTS.sweater, reason: 'Merino, navy, sizes S to XL' },
          { product: PRODUCTS.cardigan, reason: 'Lambswool, oat, sizes XS to L' },
        ],
        chips: ['Size help', 'Which is warmer?'],
      },
      {
        question: 'Size help',
        answer:
          "The merino crew runs true to size. The cardigan runs large, so the store's size guide suggests one size down.",
        chips: ['Which is warmer?', 'Return policy'],
      },
      {
        question: 'Which is warmer?',
        answer: 'The lambswool cardigan: a thicker knit. The merino is lighter, for layering.',
        comparison: {
          products: [PRODUCTS.sweater, PRODUCTS.cardigan],
          rows: [
            { dimension: 'Wool', cells: ['Merino', 'Lambswool'] },
            { dimension: 'Knit', cells: ['Fine, light', 'Thick, warmer'] },
            { dimension: 'Fit', cells: ['True to size', 'Runs large'] },
          ],
          recommended: PRODUCTS.cardigan,
        },
        chips: ['Return policy', 'Other colors?'],
      },
    ],
  },
  {
    id: 'home',
    label: 'Home',
    store: 'Linden Home',
    photo: PHOTOS.heroHome,
    turns: [
      {
        question: 'A lamp and linen bedding for a calm guest room?',
        answer:
          'Here are two. The lamp comes with a warm 2700K bulb, and the linen set is in stock in queen.',
        cards: [
          { product: PRODUCTS.lamp, reason: 'Sage ceramic, warm bulb included' },
          { product: PRODUCTS.bedding, reason: 'Oat linen, queen in stock' },
        ],
        chips: ['Shipping time', 'Other colors?'],
      },
      {
        question: 'Shipping time',
        answer: "2 to 4 business days for both, as the store's shipping policy says.",
        chips: ['Return policy', 'Other colors?'],
      },
      {
        question: 'Return policy',
        answer:
          "Unused items can be returned within 30 days. The store's return policy asks that bedding stay in its original packaging.",
        chips: ['Other colors?', 'Care instructions'],
      },
    ],
  },
  {
    id: 'beauty',
    label: 'Beauty',
    store: 'Clearwater Skin',
    photo: PHOTOS.heroBeauty,
    turns: [
      {
        question: 'Something for dry skin, fragrance-free, under $40?',
        answer:
          'Two fit. Both are fragrance-free, and unopened items can be returned within 30 days.',
        cards: [
          { product: PRODUCTS.serum, reason: 'Hydrating, 30 ml' },
          { product: PRODUCTS.cream, reason: 'Barrier repair, 50 ml' },
        ],
        chips: ['Use them together?', 'Compare them'],
      },
      {
        question: 'Use them together?',
        answer: 'Yes: the serum first on damp skin, then the cream on top to seal it in.',
        chips: ['Compare them', 'Return policy'],
      },
      {
        question: 'Compare them',
        answer: 'For very dry skin, the Barrier cream. Add the serum under it for extra hydration.',
        comparison: {
          products: [PRODUCTS.serum, PRODUCTS.cream],
          rows: [
            { dimension: 'Texture', cells: ['Light gel', 'Rich cream'] },
            { dimension: 'Best for', cells: ['Daily hydration', 'Very dry skin'] },
            { dimension: 'Size', cells: ['30 ml', '50 ml'] },
          ],
          recommended: PRODUCTS.cream,
        },
        chips: ['Return policy', 'How long does it last?'],
      },
    ],
  },
];
