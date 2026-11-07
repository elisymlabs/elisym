/** A host name as the CSP takes it: letters, digits, dots and dashes (URL has lowercased it and turned it to ASCII). */
const HOST_NAME = /^[a-z0-9.-]+$/;

/**
 * cloud-api's origin from config: https, or http on the loopback (local
 * development); never a path, and never a host a CSP reads as more than one
 * origin (`*`, `;`, quotes).
 */
export function apiOriginFrom(value: string | undefined): string {
  if (value === undefined || !URL.canParse(value)) {
    throw new Error('CLOUD_API_ORIGIN must be the origin of cloud-api');
  }
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    !HOST_NAME.test(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('CLOUD_API_ORIGIN must be an origin (no path): https, or http on the loopback');
  }
  return url.origin;
}

/**
 * The cloud-api origin the admin was built for, or none: unset, the admin runs
 * for self-hosted stores only (a malformed origin still fails loudly).
 */
export function cloudApiOriginOf(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : apiOriginFrom(value);
}

/** The terms page from config: none, or an https URL (never a script or another scheme in an href). */
export function termsUrlFrom(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!URL.canParse(value) || new URL(value).protocol !== 'https:') {
    throw new Error('VITE_TERMS_URL must be an https URL');
  }
  return new URL(value).href;
}

/** The billing page from config: none, or an https URL (the Pay Core page on the billing store's domain). */
export function billingUrlFrom(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!URL.canParse(value) || new URL(value).protocol !== 'https:') {
    throw new Error('VITE_BILLING_URL must be an https URL');
  }
  return new URL(value).href;
}
