import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from './constants';

const ELEMENT_NAME = 'elisym-buy';
/** Any loader from the checkout's origin (v1, v2, v3), run or not yet. */
const ANY_LOADER_SELECTOR = 'script[src^="https://pay.elisym.network/"][src$="/embed.js"]';
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

/** Whether `<elisym-buy>` is, or is about to be, owned by a loader other than v3. */
function olderLoaderOwns(document: Document): boolean {
  const defined: unknown = document.defaultView?.customElements.get(ELEMENT_NAME);
  if (defined !== undefined) {
    return !(typeof defined === 'function' && 'loader' in defined && defined.loader === 'v3');
  }
  const loaders = [...document.querySelectorAll(ANY_LOADER_SELECTOR)];
  return loaders.some((script) => script.getAttribute('src') !== V3_LOADER_SRC);
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
