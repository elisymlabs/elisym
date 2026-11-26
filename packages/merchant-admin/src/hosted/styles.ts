/** Hosted mode's recurring class lists, in the self-host page's look. */
export const CARD = 'rounded-20 border-line bg-surface w-full border p-24 shadow-sm sm:p-32';
export const BUTTON_PRIMARY =
  'rounded-10 bg-ink text-15 text-ink-text w-full py-12 font-semibold transition hover:opacity-90 disabled:opacity-45';
export const BUTTON_SECONDARY =
  'rounded-10 border-line-2 text-14 hover:bg-surface-2 border px-14 py-8 font-medium disabled:opacity-45';
export const BUTTON_TEXT =
  'text-13 text-text-2 hover:text-text underline underline-offset-2 disabled:opacity-45';
/** A monospace field shown as typed (addresses, ids, names). */
export const INPUT =
  'placeholder:text-text-3 rounded-10 border-line-2 bg-bg text-14 focus:border-accent-ink focus:ring-accent-soft min-w-0 border px-12 py-10 font-mono outline-none focus:ring-4';
/** The owner key field only: masked without being a password field (`.masked` in app.css). */
export const KEY_INPUT = `masked ${INPUT}`;
export const LINK = 'text-text-2 hover:text-text underline underline-offset-2';
/** A plain text field in the body font: product texts. */
export const TEXT_INPUT =
  'placeholder:text-text-3 rounded-10 border-line-2 bg-bg text-14 focus:border-accent-ink focus:ring-accent-soft min-w-0 border px-12 py-10 outline-none focus:ring-4';
