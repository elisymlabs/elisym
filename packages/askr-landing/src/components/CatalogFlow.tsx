import { PRODUCTS } from '../media';
import { AskrMark } from './AskrMark';

const SOURCES = ['Shopify', 'WooCommerce', 'Google feed', 'CSV'];

/** Made-up rows for the drawing, written the way the admin's product list writes them. */
const ROWS = [
  { product: PRODUCTS.headphonesSand, d: 'aria-anc' },
  { product: PRODUCTS.headphonesBlack, d: 'pulse-pro' },
  { product: PRODUCTS.earbuds, d: 'stride-sport' },
  { product: PRODUCTS.charger, d: 'usb-c-65w' },
];

/**
 * The catalog arriving: the sources a store already has at the top, flowing into Askr, and the
 * products as the admin lists them below (its table, its badge, the price as amount and
 * currency). A drawing: nothing in it is live.
 */
export function CatalogFlow() {
  return (
    <figure
      aria-label="Products from Shopify, WooCommerce, a Google product feed or a CSV file flow into Askr and show up in its product list."
      className="rounded-32 sm:rounded-40 bg-surface-2 relative flex h-full min-h-520 flex-col items-center justify-center gap-0 overflow-hidden px-16 py-40 sm:px-40"
    >
      <ul aria-hidden="true" className="flex flex-wrap justify-center gap-8">
        {SOURCES.map((source) => (
          <li
            key={source}
            className="border-line bg-surface text-13 text-text-2 flex items-center gap-8 rounded-full border px-14 py-8 font-medium shadow-[0_6px_16px_-10px_rgb(18_19_22/0.3)]"
          >
            <span className="bg-text size-6 rounded-full" />
            {source}
          </li>
        ))}
      </ul>
      <svg
        aria-hidden="true"
        viewBox="0 0 240 72"
        className="h-72 w-240 text-[var(--line-2)]"
        fill="none"
        stroke="currentColor"
      >
        {[30, 90, 150, 210].map((x) => (
          <path
            key={x}
            d={`M${x} 0 C${x} 40 120 30 120 72`}
            strokeWidth="1.5"
            className="flow-line"
          />
        ))}
      </svg>
      <div
        aria-hidden="true"
        className="bg-surface border-line grid size-56 place-items-center rounded-full border shadow-[0_10px_30px_-12px_rgb(18_19_22/0.35)] [--mark-paper:var(--surface)]"
      >
        <AskrMark className="size-32" />
      </div>
      <svg
        aria-hidden="true"
        viewBox="0 0 2 40"
        className="h-40 w-2 text-[var(--line-2)]"
        stroke="currentColor"
      >
        <path d="M1 0 V40" strokeWidth="1.5" className="flow-line" />
      </svg>
      <div
        aria-hidden="true"
        className="rounded-16 border-line w-full max-w-460 overflow-hidden border bg-white text-[#0d0d0d] shadow-[0_24px_60px_-24px_rgb(18_19_22/0.35)]"
      >
        <div className="flex items-center justify-between gap-12 border-b border-[#ebebeb] px-20 py-12">
          <span className="text-14 font-semibold">Products</span>
          <span className="adm-badge">Synced</span>
        </div>
        <ul>
          {ROWS.map(({ product, d }) => (
            <li
              key={d}
              className="text-14 flex items-center gap-12 border-t border-[#ebebeb] px-20 py-10 first:border-t-0"
            >
              <img
                src={product.image}
                alt=""
                width={36}
                height={36}
                loading="lazy"
                decoding="async"
                className="rounded-8 size-36 flex-none object-cover"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{product.title}</span>
                <span className="text-12 truncate font-mono text-[#8f8f8f]">{d}</span>
              </span>
              <span className="whitespace-nowrap tabular-nums">
                {product.price.replace(' USD', '')} <span className="text-[#5d5d5d]">USD</span>
              </span>
              <span className="adm-badge hidden sm:inline-flex">on sale</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}
