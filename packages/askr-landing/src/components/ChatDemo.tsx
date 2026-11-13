import { PRODUCT_NAME } from '../constants';
import { AskrMark } from './AskrMark';
import { Icon } from './Icon';
import { ProductCard } from './ProductCard';

/** Made-up products for the drawing: names and prices as a store's catalog would list them. */
export const DEMO_CARDS = [
  { title: 'Merino crew sweater', note: 'Navy, sizes S to XL', price: '$72.00' },
  { title: 'Lambswool cardigan', note: 'Oat, sizes XS to L', price: '$78.00' },
];

/** The widget answering a visitor, played once as an animation: nothing in it is live. */
export function ChatDemo() {
  return (
    <figure
      aria-label={`The ${PRODUCT_NAME} chat on a store's page`}
      className="rounded-24 border-line-2 bg-surface/95 w-full max-w-420 overflow-hidden border shadow-2xl shadow-black/30 backdrop-blur"
    >
      <div className="border-line flex items-center gap-10 border-b px-16 py-12">
        <AskrMark className="size-28" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-14 font-semibold">Harbor Knits</span>
          <span className="text-12 text-text-3">AI assistant</span>
        </div>
        <Icon name="close" className="text-text-3 size-18" />
      </div>
      <div className="flex flex-col gap-12 p-16">
        <p className="chat-step chat-step-1 rounded-16 bg-accent text-14 text-accent-text rounded-br-6 max-w-[85%] self-end px-14 py-10">
          A warm sweater under $80 that ships to Spain?
        </p>
        <p
          aria-hidden="true"
          className="chat-typing rounded-16 bg-surface-2 rounded-bl-6 flex gap-4 self-start px-14 py-12"
        >
          <span className="typing-dot bg-text-3 size-6 rounded-full" />
          <span className="typing-dot bg-text-3 size-6 rounded-full" />
          <span className="typing-dot bg-text-3 size-6 rounded-full" />
        </p>
        <p className="chat-step chat-step-2 rounded-16 bg-surface-2 text-14 rounded-bl-6 max-w-[90%] self-start px-14 py-10 leading-relaxed">
          Two fit. Both ship to Spain in 3 to 5 days, as the store's shipping policy says.
        </p>
        <ul className="grid gap-8">
          {DEMO_CARDS.map((card, index) => (
            <li key={card.title} className={`chat-step chat-step-${index + 3}`}>
              <ProductCard {...card} />
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="border-line text-12 text-text-3 flex items-center justify-between gap-12 border-t px-16 py-10">
        <span className="flex items-center gap-6">
          <Icon name="shield" className="text-accent-ink size-14" />
          Prices from the store's catalog
        </span>
        <span>by {PRODUCT_NAME}</span>
      </figcaption>
    </figure>
  );
}
