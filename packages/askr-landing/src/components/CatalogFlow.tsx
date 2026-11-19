import { useEffect, useRef, useState } from 'react';
import { PRODUCTS } from '../media';
import { AskrMark } from './AskrMark';

const SOURCES = ['Backend', 'CI/CD', 'WooCommerce', 'Google feed', 'CSV'];

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
interface Lines {
  width: number;
  height: number;
  paths: string[];
}

const NO_LINES: Lines = { width: 0, height: 0, paths: [] };

/** A soft curve from (x1, y1) down to (x2, y2). */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const middle = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`;
}

export function CatalogFlow() {
  const figureRef = useRef<HTMLElement>(null);
  const chipRefs = useRef<(HTMLLIElement | null)[]>([]);
  const markRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Lines>(NO_LINES);

  // The lines are drawn from where the chips and the mark really are, so they meet them however
  // the chips wrap at this width.
  useEffect(() => {
    const figure = figureRef.current;
    const mark = markRef.current;
    const list = listRef.current;
    if (figure === null || mark === null || list === null) {
      return undefined;
    }
    const measure = () => {
      const box = figure.getBoundingClientRect();
      const markBox = mark.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      const markX = markBox.left + markBox.width / 2 - box.left;
      const markTop = markBox.top - box.top;
      const paths = chipRefs.current.flatMap((chip) => {
        if (chip === null) {
          return [];
        }
        const chipBox = chip.getBoundingClientRect();
        return [
          curve(
            chipBox.left + chipBox.width / 2 - box.left,
            chipBox.bottom - box.top,
            markX,
            markTop,
          ),
        ];
      });
      paths.push(curve(markX, markBox.bottom - box.top, markX, listBox.top - box.top));
      setLines({ width: box.width, height: box.height, paths });
    };
    measure();
    if (typeof ResizeObserver !== 'function') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(figure);
    return () => observer.disconnect();
  }, []);

  return (
    <figure
      ref={figureRef}
      aria-label="Products from your backend or CI/CD, WooCommerce, a Google product feed or a CSV file flow into Askr and show up in its product list."
      className="rounded-32 sm:rounded-40 bg-surface-2 relative flex h-full min-h-520 flex-col items-center justify-center overflow-hidden px-16 py-40 sm:px-40"
    >
      <svg
        aria-hidden="true"
        width={lines.width}
        height={lines.height}
        viewBox={`0 0 ${lines.width} ${lines.height}`}
        className="pointer-events-none absolute inset-0 text-[var(--line-2)]"
        fill="none"
        stroke="currentColor"
      >
        {lines.paths.map((path) => (
          <path key={path} d={path} strokeWidth="1.5" className="flow-line" />
        ))}
      </svg>
      <ul aria-hidden="true" className="relative flex flex-wrap justify-center gap-8">
        {SOURCES.map((source, index) => (
          <li
            key={source}
            ref={(chip) => {
              chipRefs.current[index] = chip;
            }}
            className="border-line bg-surface text-13 text-text-2 flex items-center gap-8 rounded-full border px-14 py-8 font-medium shadow-[0_6px_16px_-10px_rgb(18_19_22/0.3)]"
          >
            <span className="bg-text size-6 rounded-full" />
            {source}
          </li>
        ))}
      </ul>
      <div
        ref={markRef}
        aria-hidden="true"
        className="bg-surface border-line relative mt-64 grid size-56 place-items-center rounded-full border shadow-[0_10px_30px_-12px_rgb(18_19_22/0.35)] [--mark-paper:var(--surface)]"
      >
        <AskrMark className="size-32" />
      </div>
      <div
        ref={listRef}
        aria-hidden="true"
        className="rounded-16 border-line relative mt-40 w-full max-w-460 overflow-hidden border bg-white text-[#0d0d0d] shadow-[0_24px_60px_-24px_rgb(18_19_22/0.35)]"
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
