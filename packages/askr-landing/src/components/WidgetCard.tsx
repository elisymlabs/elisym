import type { Product } from '../media';
import { WIDGET_TEXT } from '../widget-text';
import { WidgetIcon } from './WidgetIcon';

interface Props {
  product: Product;
  /** The line the assistant gives for this pick. */
  reason?: string;
  added?: boolean;
  className?: string;
}

/** A product card as the widget draws it: photo, title, the reason, the catalog's price, the cart. */
export function WidgetCard({ product, reason, added, className = '' }: Props) {
  return (
    <div className={`wgt-card ${className}`}>
      <div className="wgt-card-media">
        <img src={product.image} alt="" width={232} height={150} loading="lazy" decoding="async" />
      </div>
      <div className="wgt-card-body">
        <span className="wgt-card-title">{product.title}</span>
        {reason !== undefined && <span className="wgt-reason">{reason}</span>}
        <span className="wgt-price">{product.price}</span>
        <span data-demo className="wgt-cart">
          <WidgetIcon name="cart" className="size-17" />
          {added ? `${WIDGET_TEXT.added} ✓` : WIDGET_TEXT.addToCart}
        </span>
      </div>
    </div>
  );
}
