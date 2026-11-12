import { PRODUCT_NAME } from '../constants';
import { AskrMark } from './AskrMark';
import { Icon } from './Icon';

/** Made-up products for the drawing: names and prices as a store's catalog would list them. */
export const MOCK_CARDS = [
  { title: 'Merino crew sweater', note: 'Navy, sizes S to XL', price: '$72.00' },
  { title: 'Lambswool cardigan', note: 'Oat, sizes XS to L', price: '$78.00' },
];

/** A still drawing of the widget answering a visitor: nothing in it is live. */
export function ChatMock() {
  return (
    <figure
      aria-label={`The ${PRODUCT_NAME} chat on a store's page`}
      className="rounded-24 border-line-2 bg-surface w-full max-w-440 justify-self-center overflow-hidden border shadow-2xl shadow-black/20 lg:justify-self-end"
    >
      <div className="border-line flex items-center gap-10 border-b px-16 py-12">
        <AskrMark className="size-28" />
        <div className="flex min-w-0 flex-col">
          <span className="text-14 font-semibold">Harbor Knits</span>
          <span className="text-12 text-text-3">AI assistant</span>
        </div>
      </div>
      <div className="flex flex-col gap-12 p-16">
        <p className="rounded-16 bg-accent text-14 text-accent-text rounded-br-6 max-w-[85%] self-end px-14 py-10">
          A warm sweater under $80 that ships to Spain?
        </p>
        <p className="rounded-16 bg-surface-2 text-14 rounded-bl-6 max-w-[90%] self-start px-14 py-10 leading-relaxed">
          Two fit. Both ship to Spain in 3 to 5 days, as the store's shipping policy says.
        </p>
        <ul className="grid gap-8">
          {MOCK_CARDS.map((card) => (
            <li
              key={card.title}
              className="rounded-16 border-line bg-bg flex items-center gap-12 border p-12"
            >
              <span
                aria-hidden="true"
                className="rounded-12 bg-accent-soft text-accent-ink grid size-48 shrink-0 place-items-center"
              >
                <Icon name="tag" className="size-20" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-14 truncate font-medium">{card.title}</span>
                <span className="text-12 text-text-3 truncate">{card.note}</span>
              </span>
              <span className="flex flex-col items-end gap-4">
                <span className="text-14 font-semibold">{card.price}</span>
                <span className="text-12 text-accent-ink flex items-center gap-4 font-medium">
                  <Icon name="cart" className="size-14" />
                  Add to cart
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="border-line text-12 text-text-3 flex items-center justify-between gap-12 border-t px-16 py-10">
        <span className="flex items-center gap-6">
          <Icon name="shield" className="text-accent-ink size-14" />
          Prices from the store's signed catalog
        </span>
        <span>by {PRODUCT_NAME}</span>
      </figcaption>
    </figure>
  );
}
