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
function withoutControlCharacters(text: string): string {
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
function withoutFormatMarks(text: string): string {
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
function withoutAnyFormatMarks(text: string): string {
  return text.replace(FORMAT_MARKS, '');
}

/**
 * Half a character is not something to hand a log file, a terminal or a JSON
 * encoder: it is not valid UTF-8, and what survives the encoding is a
 * replacement character at best. A cut leaves one at each end - a LOW surrogate
 * orphaned at the start of what follows it, a HIGH one at the end of what
 * precedes it - so there is a function for each.
 */
function withoutLeadingDanglingSurrogate(text: string): string {
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

function withoutDanglingSurrogate(text: string): string {
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
  return clip(text, maxChars, alreadyCut, false);
}

/**
 * The same budget from the other end: at most `maxChars` characters of the
 * TAIL, with a LEADING ellipsis when something was cut.
 */
export function clipTailToCharacters(text: string, maxChars: number, alreadyCut = false): string {
  return clip(text, maxChars, alreadyCut, true);
}

function clip(text: string, maxChars: number, alreadyCut: boolean, keepEnd: boolean): string {
  if (maxChars <= 0) {
    return '';
  }
  // A character is one or two code units, so the `maxChars` nearest this end
  // cannot reach past `maxChars * 2` of it. Spreading the whole string would
  // build a million-element array of single characters to keep a few hundred.
  const near = keepEnd
    ? text.slice(Math.max(0, text.length - maxChars * 2))
    : text.slice(0, maxChars * 2);
  const characters = [...trimDanglingSurrogates(near)];
  const fits = characters.length <= maxChars && text.length <= maxChars * 2;
  if (fits && !alreadyCut) {
    return trimDanglingSurrogates(text);
  }
  if (maxChars === 1) {
    return '…';
  }
  // `alreadyCut` says the CALLER truncated its input: a result that fits is
  // still an excerpt, and the ellipsis is the only thing that says so.
  // `Math.max`, because a text SHORTER than the budget makes that offset
  // negative and `slice(-7)` would silently eat the front of a line that fit.
  const kept = keepEnd
    ? characters.slice(Math.max(0, characters.length - (maxChars - 1)))
    : characters.slice(0, maxChars - 1);
  const joined = trimDanglingSurrogates(kept.join(''));
  return keepEnd ? `…${joined.trimStart()}` : `${joined.trimEnd()}…`;
}

/** Neither end left holding half of a character a cut separated from its pair. */
function trimDanglingSurrogates(text: string): string {
  return withoutDanglingSurrogate(withoutLeadingDanglingSurrogate(text));
}

/**
 * The first `maxUnits` UTF-16 CODE UNITS, never half a character, and with no
 * marker of its own.
 *
 * The other budget in this module counts characters, because there it is a
 * sentence a customer reads. This one counts code units, because there it is
 * how much of a LINE an operator's terminal gets - and it returns the bare
 * prefix because the x402 driver has to know exactly which characters will be
 * printed before it can decide whether its cut landed inside a masked echo.
 */
export function clipToCodeUnits(text: string, maxUnits: number): string {
  if (maxUnits <= 0) {
    return '';
  }
  return text.length <= maxUnits ? text : withoutDanglingSurrogate(text.slice(0, maxUnits));
}

/**
 * Every C0 and C1 control character DELETED, except tab and newline, which stay
 * as whitespace for the collapse to handle.
 */
export function deleteControlCharacters(text: string): string {
  return text.replace(CONTROLS_EXCEPT_TAB_AND_NEWLINE, '');
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
  return withoutAnyFormatMarks(deleteControlCharacters(text)).replace(/\s+/g, ' ').trim();
}

/**
 * Whether anything that SURVIVES flattening remains at or after `from`.
 *
 * Not `\S`: control characters and zero-width marks match that and are then
 * dropped, so a refusal padded with NULs or bidi marks would be reported as
 * truncated when nothing readable was lost.
 */
// eslint-disable-next-line no-control-regex
const SURVIVES_FLATTENING = /[^\s\u0000-\u001f\u007f-\u009f\p{Cf}]/gu;

/** The index of the first character that survives flattening, or -1. */
function firstSurvivingIndex(text: string): number {
  SURVIVES_FLATTENING.lastIndex = 0;
  const match = SURVIVES_FLATTENING.exec(text);
  SURVIVES_FLATTENING.lastIndex = 0;
  return match?.index ?? -1;
}

function hasContentBefore(text: string, before: number): boolean {
  // Where the first one IS, not whether a copy of the prefix holds one: `before`
  // is typically the whole input minus a window, and slicing it would copy the
  // megabyte this module exists to avoid walking twice.
  const first = firstSurvivingIndex(text);
  return first !== -1 && first < before;
}

function hasContentAfter(text: string, from: number): boolean {
  SURVIVES_FLATTENING.lastIndex = from;
  const found = SURVIVES_FLATTENING.test(text);
  SURVIVES_FLATTENING.lastIndex = 0;
  return found;
}

/**
 * Flatten one end of an over-long text and say whether anything readable was
 * dropped to do it.
 *
 * Slicing BEFORE flattening is the point: the input can be a megabyte and
 * flattening walks every code point. The 8x allowance covers what whitespace
 * collapse can shorten - but it is a fast path, not a guarantee, since
 * whitespace collapses by an unbounded factor: 3200 newlines ahead of the real
 * sentence (or a curl progress meter's 4000 trailing carriage returns behind
 * it) leave the window holding nothing at all. Any SHORT result from a text
 * that outran the window means the window was the limit rather than the
 * content, so pay for the whole thing once.
 */
/**
 * An offset that is not the middle of a character.
 *
 * The content tests below run a `u`-flagged regex from a raw code-unit offset;
 * landing on the low half of a pair makes the orphan match as surviving text,
 * and the excerpt then announces a truncation that dropped nothing.
 */
function onCharacterBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return index;
  }
  const before = text.charCodeAt(index - 1);
  return before >= 0xd800 && before <= 0xdbff ? index - 1 : index;
}

function excerptWindow(
  text: string,
  maxChars: number,
  keepEnd: boolean,
): { flattened: string; cut: boolean } {
  const window = onCharacterBoundary(text, maxChars * 8);
  const outranWindow = text.length > window;
  const from = keepEnd ? onCharacterBoundary(text, Math.max(0, text.length - window)) : 0;
  const sliced = keepEnd ? text.slice(from) : text.slice(0, window);
  const windowed = flattenUntrusted(trimDanglingSurrogates(sliced));
  const flattened =
    [...windowed].length < maxChars && outranWindow ? flattenUntrusted(text) : windowed;
  // Only text that was actually dropped counts as a cut: a refusal padded with
  // trailing newlines is complete, and claiming otherwise both lies to the
  // reader and eats one of its characters to make room for the ellipsis. The
  // length-based cut is the clip's business, not this one's.
  const cut =
    outranWindow &&
    flattened === windowed &&
    (keepEnd ? hasContentBefore(text, from) : hasContentAfter(text, window));
  return { flattened, cut };
}

/**
 * Whether the text holds anything a reader would SEE.
 *
 * Controls AND format marks, not just marks: a "sentence" of NULs, of bells, or
 * of zero-width joiners is a non-empty string nobody can read, and a caller
 * asking this question is deciding whether to print it or say nothing instead.
 * Takes raw text, so it cannot be got wrong by asking before flattening.
 */
export function hasVisibleText(text: string): boolean {
  return withoutAnyFormatMarks(withoutControlCharacters(text)).trim() !== '';
}

/**
 * One bounded, single-line excerpt of text somebody else wrote.
 *
 * The only way anything in this repository should quote untrusted text, so the
 * three parts stay together: slice before flattening, drop a surrogate the raw
 * slice may have separated, then clip by character with an ellipsis.
 */
export function excerptUntrusted(text: string, maxChars: number): string {
  const { flattened, cut } = excerptWindow(text, maxChars, false);
  return clipToCharacters(flattened, maxChars, cut);
}

/**
 * The same, from the other end - the excerpt for text whose point is at the
 * end.
 *
 * A script's diagnostic lands after whatever progress meter its curl printed,
 * so a head excerpt records the meter. The leading ellipsis says something came
 * before it.
 */
export function excerptUntrustedTail(text: string, maxChars: number): string {
  const { flattened, cut } = excerptWindow(text, maxChars, true);
  return clipTailToCharacters(flattened, maxChars, cut);
}
