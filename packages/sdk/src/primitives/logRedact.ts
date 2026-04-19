/**
 * Canonical pino redact paths for the elisym stack. Plugin, CLI, MCP, and
 * any downstream integrator should consume these arrays directly - one
 * source of truth for "fields that carry user input or secrets".
 *
 * Wire them into a pino instance like:
 *
 *   import pino from 'pino';
 *   import { DEFAULT_REDACT_PATHS, makeCensor } from '@elisym/sdk';
 *   const logger = pino({
 *     redact: { paths: DEFAULT_REDACT_PATHS, censor: makeCensor() },
 *   });
 */

/**
 * Field paths that carry Nostr / Solana secret keys or operator secrets.
 * Censored as `[REDACTED]`.
 */
export const SECRET_REDACT_PATHS: string[] = [
  '*.ELISYM_NOSTR_PRIVATE_KEY',
  '*.ELISYM_SOLANA_PRIVATE_KEY',
  '*.nostrPrivateKeyHex',
  '*.solanaPrivateKeyBase58',
  '*.secretKey',
  '*.secret',
  'ELISYM_NOSTR_PRIVATE_KEY',
  'ELISYM_SOLANA_PRIVATE_KEY',
];

/**
 * Field paths that carry customer-confidential text (LLM prompts, raw
 * event content, job input). Censored as `[INPUT REDACTED]` so log
 * readers can distinguish redacted input from redacted secrets.
 */
export const INPUT_REDACT_PATHS: string[] = [
  'content',
  'input',
  'prompt',
  '*.content',
  '*.input',
  '*.prompt',
  'event.content',
  '*.event.content',
];

/**
 * Union of the two arrays, in the order pino's redact engine should
 * visit them. Prefer this when wiring a new logger so no downstream
 * consumer forgets half the set.
 */
export const DEFAULT_REDACT_PATHS: string[] = [...SECRET_REDACT_PATHS, ...INPUT_REDACT_PATHS];

/**
 * pino `redact.censor` callback. Returns the appropriate marker string
 * based on the final segment of the redacted path.
 *
 * pino calls `censor(value, path)` where `path` is `string[]`. Plugin's
 * historical signature accepted `(_value, path)` with that shape; we
 * preserve that. Pino types vary across versions, so we accept unknown
 * and narrow.
 */
export function makeCensor(): (value: unknown, path: string[]) => string {
  return (_value, path) => {
    const last = path[path.length - 1];
    if (last === 'content' || last === 'input' || last === 'prompt') {
      return '[INPUT REDACTED]';
    }
    return '[REDACTED]';
  };
}
