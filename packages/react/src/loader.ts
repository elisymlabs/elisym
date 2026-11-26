import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from './constants';

const ELEMENT_NAME = 'elisym-buy';
/** Any loader from the checkout's origin (v1 to v4), run or not yet. */
const ANY_LOADER_SELECTOR = 'script[src^="https://pay.elisym.network/"][src$="/embed.js"]';
/** Loaders that take a customer reference, by their class's `loader` marker. */
const CURRENT_LOADERS: readonly unknown[] = ['v3', 'v4'];
/** Their scripts: v4 is served next to v3, on the same origin. */
const CURRENT_LOADER_URLS: readonly (string | null)[] = [
  V3_LOADER_SRC,
  new URL('/v4/embed.js', V3_LOADER_SRC).href,
];
const OLDER_LOADER_ERROR =
  'elisym: customer-ref needs the v3 loader; another loader defined <elisym-buy> first';

let toldOlderLoader = false;

/**
 * Adds the pinned v3 `<script>` once per document. Nothing is added when the
 * page already loads a loader (any version, run or not yet), or when another
 * loader already defined `<elisym-buy>`: the first loader owns every element.
 */
export function ensureLoader(document: Document): void {
  const registry = document.defaultView?.customElements;
  if (registry?.get(ELEMENT_NAME) !== undefined) {
    return;
  }
  if (document.querySelector(ANY_LOADER_SELECTOR) !== null) {
    return;
  }
  const script = document.createElement('script');
  script.async = true;
  script.setAttribute('integrity', V3_LOADER_INTEGRITY);
  script.setAttribute('crossorigin', 'anonymous');
  // Last: the integrity and CORS mode are in place before the fetch can start.
  script.setAttribute('src', V3_LOADER_SRC);
  document.head.append(script);
}

/** Whether `<elisym-buy>` is, or is about to be, owned by a loader older than v3 (or unknown). */
function olderLoaderOwns(document: Document): boolean {
  const defined: unknown = document.defaultView?.customElements.get(ELEMENT_NAME);
  if (defined !== undefined) {
    return !(
      typeof defined === 'function' &&
      'loader' in defined &&
      CURRENT_LOADERS.includes(defined.loader)
    );
  }
  const loaders = [...document.querySelectorAll(ANY_LOADER_SELECTOR)];
  return loaders.some((script) => !CURRENT_LOADER_URLS.includes(script.getAttribute('src')));
}

/**
 * Says once, as the loader does, that an older loader owns `<elisym-buy>`
 * while this component passes a customer reference: an older loader ignores
 * it, so payments made there credit no account.
 */
export function warnIfOlderLoader(document: Document): void {
  if (toldOlderLoader || !olderLoaderOwns(document)) {
    return;
  }
  toldOlderLoader = true;
  console.error(OLDER_LOADER_ERROR);
}

/** Resolves once `<elisym-buy>` is defined in this document, by whichever loader. */
export function whenLoaderDefined(document: Document): Promise<unknown> | undefined {
  return document.defaultView?.customElements.whenDefined(ELEMENT_NAME);
}

/** For tests: the "told once" flag is per module, like the loader's. */
export function resetLoaderWarnings(): void {
  toldOlderLoader = false;
}
