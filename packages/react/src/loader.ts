import { DEFAULT_LOADER, type LoaderScript } from './constants';

const ELEMENT_NAME = 'elisym-buy';
/** A loader's path on its checkout origin: `/v1/embed.js`, `/v3/embed.js`, ... */
const LOADER_PATH = /^\/v(\d+)\/embed\.js$/;
/** A loader's own marker (`static loader = 'v3'`). */
const LOADER_MARKER = /^v(\d+)$/;
/** The first loader that honours `customer-ref`; every later one does too. */
const FIRST_REF_LOADER = 3;
/** A pinned SRI: one or more `sha256|384|512-<base64>` hashes (anything else would load unpinned). */
const INTEGRITY =
  /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}(?: sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})*$/;
const OLDER_LOADER_ERROR =
  'elisym: customer-ref needs the v3 or v4 loader; another loader defined <elisym-buy> first';
const BAD_LOADER_ERROR =
  'elisym: loader must be { src: https://<checkout host>/vN/embed.js, integrity: sha384-... }';

let toldOlderLoader = false;
let toldBadLoader = false;
/**
 * The documents whose loader is settled: added here, found on the page, or an
 * element already defined. Settled once, so a later or changed `loader` (or a
 * second component's) never adds a second loader to race the first.
 */
let settled = new WeakSet<Document>();

/** Whether a loader version honours `customer-ref` (v3 and every later one). */
function takesCustomerRef(version: string | undefined): boolean {
  return version !== undefined && Number(version) >= FIRST_REF_LOADER;
}

/** The loader's URL when it is one: `https:`, a `/vN/embed.js` path, nothing else. */
function loaderUrl(src: string, base?: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(src, base);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !LOADER_PATH.test(url.pathname)
  ) {
    return undefined;
  }
  return url;
}

/** Every loader script from `origin` (any version, run or not yet). */
function loadersFrom(document: Document, origin: string): URL[] {
  return [...document.querySelectorAll('script[src]')].flatMap((script) => {
    const url = loaderUrl(script.getAttribute('src') ?? '', document.baseURI);
    return url !== undefined && url.origin === origin ? [url] : [];
  });
}

/**
 * Adds the loader's pinned `<script>` once per document (the pinned v3 on
 * pay.elisym.network unless `loader` names another), decided once per
 * document: nothing is added when the page already loads a loader from that
 * checkout (any version, run or not yet) or another loader already defined
 * `<elisym-buy>`, and after the first decision nothing more is ever added (the
 * first loader to run owns every element). A `loader` that is not a pinned
 * `https://<host>/vN/embed.js` adds nothing, decides nothing, and is said once.
 */
export function ensureLoader(
  document: Document,
  loader: Readonly<LoaderScript> = DEFAULT_LOADER,
): void {
  const url = loaderUrl(loader.src);
  if (url === undefined || !INTEGRITY.test(loader.integrity)) {
    if (!toldBadLoader) {
      toldBadLoader = true;
      console.error(BAD_LOADER_ERROR);
    }
    return;
  }
  if (settled.has(document)) {
    return;
  }
  settled.add(document);
  const registry = document.defaultView?.customElements;
  if (registry?.get(ELEMENT_NAME) !== undefined) {
    return;
  }
  if (loadersFrom(document, url.origin).length > 0) {
    return;
  }
  const script = document.createElement('script');
  script.async = true;
  script.setAttribute('integrity', loader.integrity);
  script.setAttribute('crossorigin', 'anonymous');
  // Last: the integrity and CORS mode are in place before the fetch can start.
  script.setAttribute('src', url.href);
  document.head.append(script);
}

/** Whether `<elisym-buy>` is, or is about to be, owned by a loader before v3. */
function olderLoaderOwns(document: Document, loader: Readonly<LoaderScript>): boolean {
  const defined: unknown = document.defaultView?.customElements.get(ELEMENT_NAME);
  if (defined !== undefined) {
    const marker =
      typeof defined === 'function' && 'loader' in defined && typeof defined.loader === 'string'
        ? defined.loader
        : '';
    return !takesCustomerRef(LOADER_MARKER.exec(marker)?.[1]);
  }
  const url = loaderUrl(loader.src);
  if (url === undefined) {
    return false;
  }
  return loadersFrom(document, url.origin).some(
    (script) => !takesCustomerRef(LOADER_PATH.exec(script.pathname)?.[1]),
  );
}

/**
 * Says once, as the loader does, that an older loader owns `<elisym-buy>`
 * while this component passes a customer reference: an older loader ignores
 * it, so payments made there credit no account.
 */
export function warnIfOlderLoader(
  document: Document,
  loader: Readonly<LoaderScript> = DEFAULT_LOADER,
): void {
  if (toldOlderLoader || !olderLoaderOwns(document, loader)) {
    return;
  }
  toldOlderLoader = true;
  console.error(OLDER_LOADER_ERROR);
}

/** Resolves once `<elisym-buy>` is defined in this document, by whichever loader. */
export function whenLoaderDefined(document: Document): Promise<unknown> | undefined {
  return document.defaultView?.customElements.whenDefined(ELEMENT_NAME);
}

/** For tests: the "told once" flags are per module, like the loader's. */
export function resetLoaderWarnings(): void {
  toldOlderLoader = false;
  toldBadLoader = false;
  settled = new WeakSet<Document>();
}
