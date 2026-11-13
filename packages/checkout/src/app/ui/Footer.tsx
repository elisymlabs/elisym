import { type Brand, footerText } from '../brand';

interface Props {
  brand: Brand;
  /** A session is running: "Your purchases" opens from here (the same with or without any). */
  onPurchases?: () => void;
}

export function Footer({ brand, onPurchases }: Props) {
  return (
    <footer class="footer">
      {onPurchases === undefined ? null : (
        <button type="button" class="link-button" data-purchases-button="" onClick={onPurchases}>
          Your purchases
        </button>
      )}
      <span>{footerText(brand)}</span>
    </footer>
  );
}
