const PHONE_RE = /Android|iPhone|iPad|iPod|Mobile/i;

/** A phone or tablet: wallets there live in their own app's browser, not in an extension. */
export function isPhone(userAgent: string): boolean {
  return PHONE_RE.test(userAgent);
}

/** No keyboard to copy with: a phone, or an iPad that says it is a Mac but has a touch screen. */
export function isTouchOnly(userAgent: string, maxTouchPoints: number): boolean {
  return isPhone(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Only a wallet's own image, inlined: the checkout loads nothing from elsewhere. */
export function usableIcon(icon: string | undefined): string | undefined {
  return icon !== undefined && icon.startsWith('data:image/') ? icon : undefined;
}
