const PHONE_RE = /Android|iPhone|iPad|iPod|Mobile/i;

/** A phone or tablet: wallets there live in their own app's browser, not in an extension. */
export function isPhone(userAgent: string): boolean {
  return PHONE_RE.test(userAgent);
}

/** Only a wallet's own image, inlined: the checkout loads nothing from elsewhere. */
export function usableIcon(icon: string | undefined): string | undefined {
  return icon !== undefined && icon.startsWith('data:image/') ? icon : undefined;
}
