/** The v3 loader: the one `<elisym-buy>` that takes a customer reference. */
export const V3_LOADER_SRC = 'https://pay.elisym.network/v3/embed.js';
/** The loader's published bytes, pinned: equal to `packages/checkout/src/embed/v3.sri` (a test checks). */
export const V3_LOADER_INTEGRITY =
  'sha384-FPsJfAuhwQU0mlPKTKLwCTp1YGK6aFRh0pT+Gl1T3UML2jlIK7EkW8FW5ue2qFJX';

/** The loader script the component adds: its URL and its pinned SRI. */
export interface LoaderScript {
  /** `https://<checkout host>/vN/embed.js`, such as a white-label checkout's `/v4/embed.js`. */
  src: string;
  /** The `sha384-...` hash published for that exact file. */
  integrity: string;
}

/** The pinned v3 loader on pay.elisym.network, unless a `loader` prop names another. */
export const DEFAULT_LOADER: Readonly<LoaderScript> = Object.freeze({
  src: V3_LOADER_SRC,
  integrity: V3_LOADER_INTEGRITY,
});
