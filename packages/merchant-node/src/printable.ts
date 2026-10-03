/** The last C0 control character, DEL, and the C1 range: none reaches a terminal from a buyer. */
const C0_LAST = 0x1f;
const DEL = 0x7f;
const C1_LAST = 0x9f;

/**
 * `text` with every control character replaced by `?`: a buyer-supplied value
 * (an email) printed to the operator's terminal can carry no escape sequence
 * that rewrites the screen or the window title.
 */
export function printable(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= C0_LAST || (code >= DEL && code <= C1_LAST) ? '?' : character;
    })
    .join('');
}
