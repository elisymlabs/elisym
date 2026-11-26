/**
 * Where hosted mode talks to, committed (not env): every build - local, CI,
 * Vercel - sees the same values, and `scripts/check-build.ts` requires the
 * hosted page's CSP `connect-src` to match them. Both empty until the
 * service's domain is chosen: `/hosted/` then says it is not available yet,
 * and its CSP connects nowhere (`'none'`).
 */

/** The PayCore server's public base (its `PAYCORE_PUBLIC_BASE`), e.g. `https://api.paycore.example`. */
export const PAYCORE_API_BASE = '';

/** The operator's DNS name (its `PAYCORE_OPERATOR`): `/v1/meta` must name this one, else the admin refuses to run. */
export const PAYCORE_OPERATOR = '';
