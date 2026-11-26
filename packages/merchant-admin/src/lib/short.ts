/**
 * A key or transaction shortened to its two ends, as the self-host labels
 * shorten it (`merchant-node/src/admin/labels.ts`, a test pins the two). A
 * leaf module: `TxLink` uses it on both pages without the relay read code.
 */

/** Characters kept at each end. */
const SHORT_EDGE = 8;

export function short(value: string): string {
  return value.length <= SHORT_EDGE * 2 + 1
    ? value
    : `${value.slice(0, SHORT_EDGE)}...${value.slice(-SHORT_EDGE)}`;
}
