import type { Comparison } from '../niches';
import { WIDGET_TEXT } from '../widget-text';

/** The row the store adds to every comparison, from its catalog, never from the model. */
const PRICE_DIMENSION = 'Price';

interface Props {
  comparison: Comparison;
  className?: string;
}

/**
 * A comparison's table as the widget draws it: a rounded box with the products' titles on top
 * (the one it recommends labelled), the price row first, then the rows the assistant gave. The
 * widget also puts the compared products' cards above the table; the drawings leave that row out,
 * as the conversation has just shown those cards. Prices are written as on the cards.
 */
export function WidgetComparison({ comparison, className = '' }: Props) {
  const { products, rows, recommended } = comparison;
  return (
    <div className={`wgt-table-scroll ${className}`}>
      <table className="wgt-table">
        <thead>
          <tr>
            <th />
            {products.map((product) => (
              <th key={product.title}>
                {product.title}
                {product === recommended && (
                  <span className="wgt-label">{WIDGET_TEXT.recommended}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>{PRICE_DIMENSION}</th>
            {products.map((product) => (
              <td key={product.title}>{product.price}</td>
            ))}
          </tr>
          {rows.map((row) => (
            <tr key={row.dimension}>
              <th>{row.dimension}</th>
              {products.map((product, index) => (
                <td key={product.title}>{row.cells[index] ?? '-'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
