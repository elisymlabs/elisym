import type { ReactNode } from 'react';
import { PRODUCTS } from '../media';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { ProductCard } from './ProductCard';
import { Reveal } from './Reveal';

const COMPARED = [PRODUCTS.headphonesSand, PRODUCTS.headphonesBlack];

const COMPARE_ROWS = [
  ['Price', PRODUCTS.headphonesSand.price, PRODUCTS.headphonesBlack.price],
  ['Battery', '32 h', '40 h'],
  ['Weight', '250 g', '280 g'],
  ['Warranty', '2 years', '2 years'],
];

interface TileProps {
  number: string;
  title: string;
  body: string;
  className: string;
  children: ReactNode;
}

function Tile({ number, title, body, className, children }: TileProps) {
  return (
    <li
      className={`rounded-32 border-line bg-surface flex flex-col gap-24 overflow-hidden border p-24 sm:p-32 ${className}`}
    >
      <div className="flex flex-col gap-8">
        <span className="text-14 text-accent-ink font-serif italic">{number}</span>
        <h3 className="text-28 sm:text-32 font-serif leading-tight">{title}</h3>
        <p className="text-15 text-text-2 max-w-440 leading-relaxed">{body}</p>
      </div>
      <div className="bg-bg rounded-20 border-line mt-auto flex flex-col gap-10 border p-14">
        {children}
      </div>
    </li>
  );
}

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-1200 px-16 pb-96 sm:px-24 sm:pb-160">
      <Reveal className="flex flex-col gap-16">
        <Eyebrow>What it does</Eyebrow>
        <h2 className="text-40 sm:text-64 max-w-800 font-serif leading-[1.02]">
          The help a great shop assistant gives, on every page.
        </h2>
      </Reveal>
      <Reveal delay={1}>
        <ul className="mt-48 grid gap-16 lg:grid-cols-6">
          <Tile
            number="01"
            title="Answers like your best salesperson"
            body="Shipping, returns, warranty, sizes, materials: it quotes the policies and listings you published, in your voice."
            className="lg:col-span-3"
          >
            <p className="bg-ink text-14 text-on-ink rounded-br-6 max-w-[80%] self-end rounded-[18px] px-14 py-10">
              Does the warranty cover a cracked case?
            </p>
            <p className="bg-surface-2 text-14 rounded-bl-6 max-w-[92%] self-start rounded-[18px] px-14 py-10 leading-relaxed">
              The 2-year warranty covers defects. A cracked case is accidental damage, which it does
              not cover.
            </p>
            <span className="border-line-2 text-12 text-text-2 flex items-center gap-6 self-start rounded-full border px-10 py-4">
              <Icon name="shield" className="text-accent-ink size-12" />
              Quoted from: Warranty policy
            </span>
          </Tile>
          <Tile
            number="02"
            title="Finds the right product"
            body="A visitor says what they need and what they want to spend. It searches your catalog and shows what fits."
            className="lg:col-span-3"
          >
            <p className="bg-ink text-14 text-on-ink rounded-br-6 max-w-[80%] self-end rounded-[18px] px-14 py-10">
              Earbuds for running, under $100
            </p>
            <ProductCard product={PRODUCTS.earbuds} />
            <p className="text-12 text-text-3 px-4">
              Rated IPX5 for sweat and rain, and under the budget.
            </p>
          </Tile>
          <Tile
            number="03"
            title="Compares side by side"
            body="Two headphones or five laptops, row by row. The price row comes straight from your catalog."
            className="lg:col-span-3"
          >
            <table className="text-13 w-full border-collapse text-left">
              <thead>
                <tr className="text-text-3">
                  <th className="py-6 pr-8 font-normal" />
                  {COMPARED.map((product) => (
                    <th key={product.title} className="text-text py-6 pr-8 font-medium">
                      <span className="flex items-center gap-8">
                        <img
                          src={product.image}
                          alt=""
                          width={28}
                          height={28}
                          className="rounded-6 size-28 object-cover"
                        />
                        {product.title}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map(([label, first, second]) => (
                  <tr key={label} className="border-line border-t">
                    <th className="text-text-3 py-8 pr-8 font-normal">{label}</th>
                    <td className="py-8 pr-8 tabular-nums">{first}</td>
                    <td className="py-8 pr-8 tabular-nums">{second}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Tile>
          <Tile
            number="04"
            title="Sends buyers to your cart"
            body="Every card opens the product page. With your cart hook, or on Shopify and WooCommerce, it adds the pick to your cart."
            className="lg:col-span-3"
          >
            <ProductCard product={PRODUCTS.charger} />
            <p className="bg-accent text-13 text-accent-text flex items-center gap-8 self-start rounded-full px-12 py-6 font-medium">
              <Icon name="check" className="size-14" />
              Added to your cart
            </p>
          </Tile>
        </ul>
      </Reveal>
    </section>
  );
}
