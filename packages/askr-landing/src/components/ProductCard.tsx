import { Icon } from './Icon';

interface Props {
  title: string;
  note: string;
  price: string;
}

/** A product card as the widget draws it: the price comes from the store's catalog. */
export function ProductCard({ title, note, price }: Props) {
  return (
    <div className="rounded-16 border-line bg-bg flex items-center gap-12 border p-12">
      <span
        aria-hidden="true"
        className="rounded-12 bg-accent-soft text-accent-ink grid size-48 shrink-0 place-items-center"
      >
        <Icon name="tag" className="size-20" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-14 truncate font-medium">{title}</span>
        <span className="text-12 text-text-3 truncate">{note}</span>
      </span>
      <span className="flex flex-col items-end gap-4">
        <span className="text-14 font-semibold">{price}</span>
        <span className="text-12 text-accent-ink flex items-center gap-4 font-medium">
          <Icon name="cart" className="size-14" />
          Add to cart
        </span>
      </span>
    </div>
  );
}
