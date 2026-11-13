import { ElisymLogo } from './ElisymLogo';

interface Props {
  /** A session is running: "Your purchases" opens from here (the same with or without any). */
  onPurchases?: () => void;
}

export function Footer({ onPurchases }: Props) {
  return (
    <footer class="footer">
      {onPurchases === undefined ? null : (
        <button type="button" class="link-button" data-purchases-button="" onClick={onPurchases}>
          Your purchases
        </button>
      )}
      <div class="checkout-brand">
        <span>Checkout by</span>
        <ElisymLogo />
        <span aria-hidden="true">·</span>
        <span>Payments go straight to the store</span>
      </div>
    </footer>
  );
}
