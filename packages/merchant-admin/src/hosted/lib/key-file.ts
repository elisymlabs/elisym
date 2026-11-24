const NPUB_PREFIX_LENGTH = 'npub1'.length;
const SHORT_OWNER_ID_LENGTH = 8;

/** The file name for an owner key, e.g. `paycore-owner-key-3xk9q2lm.txt`. */
export function keyFileName(npub: string): string {
  const short = npub.slice(NPUB_PREFIX_LENGTH, NPUB_PREFIX_LENGTH + SHORT_OWNER_ID_LENGTH);
  return `paycore-owner-key-${short}.txt`;
}

/** What the saved file says: the key, its Owner ID, where to sign in, and what it controls. */
export function keyFileText(nsec: string, npub: string, adminUrl: string): string {
  return [
    'PayCore owner key',
    '',
    `Owner key: ${nsec}`,
    `Owner ID: ${npub}`,
    '',
    `To sign in, open the PayCore admin at ${adminUrl} and paste the owner key.`,
    '',
    'Keep this file private. Whoever has this file controls your store: its payout addresses, products and orders. Nobody can recover the key for you if you lose it.',
    '',
  ].join('\n');
}
