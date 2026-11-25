/**
 * The page's link to Shopify (askr-shopify 5.1): App Bridge's session tokens, the app's client
 * id the server wrote into the page, and the shop it was opened for.
 */

const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/u;

interface AppBridge {
  idToken(): Promise<string>;
}

function bridge(): AppBridge | undefined {
  const candidate: unknown = Reflect.get(globalThis, 'shopify');
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }
  const idToken: unknown = Reflect.get(candidate, 'idToken');
  return typeof idToken === 'function'
    ? { idToken: () => Promise.resolve(Reflect.apply(idToken, candidate, [])) }
    : undefined;
}

/** A fresh session token from App Bridge; each lives one minute, so one is asked per call. */
export async function sessionToken(): Promise<string> {
  const app = bridge();
  if (app === undefined) {
    throw new Error('Open Askr from your Shopify admin: this page works only inside Shopify.');
  }
  const token = await app.idToken();
  if (typeof token !== 'string' || token === '') {
    throw new Error('Shopify gave no session. Reload the page and retry.');
  }
  return token;
}

/** The app's client id, from the `shopify-api-key` meta the server filled in. */
export function appApiKey(doc: Document = document): string {
  return doc.querySelector('meta[name="shopify-api-key"]')?.getAttribute('content') ?? '';
}

/** The shop the page was opened for (`?shop=`), when it is a myshopify host. */
export function shopOf(
  location: Pick<Location, 'search'> = globalThis.location,
): string | undefined {
  const shop = new URLSearchParams(location.search).get('shop') ?? '';
  return SHOP_RE.test(shop) ? shop : undefined;
}

/** The theme editor with Askr's app embed open, so the merchant turns it on in one step. */
export function themeEditorUrl(shop: string, apiKey: string): string {
  const handle = shop.replace(/\.myshopify\.com$/u, '');
  return `https://admin.shopify.com/store/${handle}/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(apiKey)}/app-embed`;
}
