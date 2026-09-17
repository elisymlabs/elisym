/**
 * Flattening text somebody else wrote.
 *
 * A provider's refusal, a script's stderr, an upstream's error body: all of it
 * ends up on an operator's terminal, in a structured log, or in front of a
 * customer, and none of it can be trusted to be one plain line. The rules are
 * the same everywhere, so they live in one place: no C0/C1 controls, no
 * line-reversing format marks, no newline to turn one log line into two, and no
 * half of a character left behind by a cut.
 */

/** Zero-width joiner and non-joiner - see `withoutFormatMarks`. */
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);

/**
 * Safe to share despite the `g` flag because every use below goes through
 * `String.prototype.replace`, which sets `lastIndex` to 0 before and after a
 * global regex. A `.test()` or `.exec()` on it would not be safe.
 */
const FORMAT_MARKS = /\p{Cf}/gu;

/**
 * Every C0 and C1 control character, and the variant that keeps tab and
 * newline so they collapse as whitespace instead of welding words together.
 *
 * Regexes rather than a per-code-point loop: this runs on text bounded only by
 * `MAX_SCRIPT_OUTPUT`, and neither class can match half of a surrogate pair, so
 * the two forms are equivalent and only one of them walks a megabyte one
 * character at a time. The lint suppression is the same one
 * `packages/cli/src/logging.ts` carries for the identical class.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS_EXCEPT_TAB_AND_NEWLINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Every C0 and C1 control character becomes a space. */
export function withoutControlCharacters(text: string): string {
  return text.replace(CONTROLS, ' ');
}

/**
 * Strip the format characters that let a line read as something other than what
 * it says: direction overrides and isolates, the byte-order mark, the tag block
 * used to smuggle text past a human reader.
 *
 * `\p{Cf}` covers those without enumerating them, but it also covers ZWJ and
 * ZWNJ, which are load-bearing rather than deceptive: ZWNJ changes which word a
 * Persian or Urdu sentence spells, and ZWJ is what makes one family emoji out of
 * four people. Those two are kept; a refusal written in Persian should reach its
 * customer spelled the way the provider wrote it.
 *
 */
export function withoutFormatMarks(text: string): string {
  return text.replace(FORMAT_MARKS, (mark) => (mark === ZWJ || mark === ZWNJ ? mark : ''));
}

/**
 * Strip EVERY format character, joiners included.
 *
 * For text that will be COMPARED rather than read: the x402 driver masks a
 * customer's input out of an upstream's echo by matching it byte for byte, and
 * an upstream that re-emits `ja<ZWJ>ne@example.com` must collapse back to what
 * the customer sent or the mask misses it and the address reaches the log.
 */
export function withoutAnyFormatMarks(text: string): string {
  return text.replace(FORMAT_MARKS, '');
}

/**
 * Drop a high surrogate a cut separated from its pair. Half a character is not
 * something to hand a log file, a terminal or a JSON encoder: it is not valid
 * UTF-8, and what survives the encoding is a replacement character at best.
 */
export function withoutDanglingSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/**
 * One plain paragraph: controls to spaces, deceptive marks gone, runs of
 * whitespace collapsed, trimmed.
 *
 * Marks are stripped after controls and before the whitespace collapse: the
 * byte-order mark is both a mark and whitespace, and collapsing first would
 * leave it as a space nothing removes.
 */
export function flattenUntrusted(text: string): string {
  return withoutFormatMarks(withoutControlCharacters(text)).replace(/\s+/g, ' ').trim();
}

/**
 * At most `maxChars` CHARACTERS, with an ellipsis when something was cut.
 *
 * Counting characters rather than UTF-16 code units is what keeps an emoji at
 * the boundary from being halved. A budget of zero or less yields nothing:
 * arithmetic that reaches zero ("what is left of the line") must not come back
 * with the whole input.
 */
export function clipToCharacters(text: string, maxChars: number, alreadyCut = false): string {
  if (maxChars <= 0) {
    return '';
  }
  // A character is one or two code units, so the first `maxChars` of them
  // cannot begin past `maxChars * 2`. Spreading the whole string would build a
  // million-element array of single characters to keep a few hundred.
  const characters = [...text.slice(0, maxChars * 2)];
  const fits = characters.length <= maxChars && text.length <= maxChars * 2;
  if (fits && !alreadyCut) {
    return withoutDanglingSurrogate(text);
  }
  if (maxChars === 1) {
    return '…';
  }
  // `alreadyCut` says the CALLER truncated its input: a result that fits is
  // still an excerpt, and the ellipsis is the only thing that says so.
  return `${withoutDanglingSurrogate(characters.slice(0, maxChars - 1).join('')).trimEnd()}…`;
}

/**
 * Flatten text that will be COMPARED rather than read.
 *
 * Two deliberate differences from `flattenUntrusted`: control characters are
 * DELETED instead of spaced, and every format mark goes, joiners included. The
 * x402 driver masks a customer's input out of an upstream's echo by matching it
 * byte for byte, so an upstream re-emitting `ja<0x01>ne` or `ja<ZWJ>ne` has to
 * collapse back to what the customer sent or the mask misses it and the address
 * reaches the operator's log. Tab and newline survive as whitespace, so two
 * words on separate lines do not weld together before the collapse.
 */
export function flattenForComparison(text: string): string {
  return withoutAnyFormatMarks(text.replace(CONTROLS_EXCEPT_TAB_AND_NEWLINE, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether anything but whitespace remains at or after `from`. */
function hasContentAfter(text: string, from: number): boolean {
  const scan = /\S/g;
  scan.lastIndex = from;
  return scan.test(text);
}

/**
 * One bounded, single-line excerpt of text somebody else wrote.
 *
 * The only way anything in this repository should quote untrusted text, so the
 * three parts stay together: slice BEFORE flattening (the input can be a
 * megabyte and flattening walks every code point), drop a surrogate the raw
 * slice may have separated, then clip by character with an ellipsis. The 8x
 * allowance covers what whitespace collapse can shorten.
 */
export function excerptUntrusted(text: string, maxChars: number): string {
  const window = maxChars * 8;
  const windowed = flattenUntrusted(withoutDanglingSurrogate(text.slice(0, window)));
  // The window is a fast path, not a guarantee: whitespace collapses by an
  // unbounded factor, so 3200 newlines ahead of the real sentence leave the
  // window holding nothing - or, worse, its first letter. Any SHORT result from
  // a text that outran the window means the window was the limit rather than
  // the content, so pay for the whole thing once.
  const outranWindow = text.length > window;
  const flattened =
    [...windowed].length < maxChars && outranWindow ? flattenUntrusted(text) : windowed;
  // Only text that was actually dropped counts as a cut: a refusal padded with
  // trailing newlines is complete, and claiming otherwise both lies to the
  // reader and eats its last character to make room for the ellipsis.
  const droppedContent = outranWindow && flattened === windowed && hasContentAfter(text, window);
  return clipToCharacters(flattened, maxChars, droppedContent);
}
