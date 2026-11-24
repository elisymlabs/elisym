/**
 * One CSV cell, quoted, safe to open in a spreadsheet: a cell it would read as
 * a formula is prefixed with `'` (buyers write the email and the reference).
 * A leaf module: hosted mode's export uses it without the self-host read code.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
