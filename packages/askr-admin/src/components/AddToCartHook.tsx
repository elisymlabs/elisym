import { ADD_TO_CART_SNIPPET } from '../lib/embed';
import { CopyBlock } from './CopyBlock';
import { Notice } from './Notice';

/** The add to cart hook a developer fills in, with what it does if pasted unchanged. */
export function AddToCartHook() {
  return (
    <>
      <CopyBlock label="Add to cart hook (for your developer)" text={ADD_TO_CART_SNIPPET} />
      <Notice tone="warn">
        Pasted as it is, it adds a button that does nothing: it needs your cart&apos;s own code
        where it says so.
      </Notice>
    </>
  );
}
