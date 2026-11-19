import { apiBase } from '../constants';

/** How long a saved file's object URL lives: long enough for every browser to start the save. */
const REVOKE_AFTER_MS = 1_000;
const NPUB_PREFIX_LENGTH = 'npub1'.length;
const SHORT_STORE_ID_LENGTH = 8;

/** The file name for a store's secret key, e.g. `askr-secret-key-3xk9q2lm.txt`. */
export function keyFileName(npub: string): string {
  const short = npub.slice(NPUB_PREFIX_LENGTH, NPUB_PREFIX_LENGTH + SHORT_STORE_ID_LENGTH);
  return `askr-secret-key-${short}.txt`;
}

/** What the saved file says: the key, the Store ID, how to sign in, and who it gives control. */
export function keyFileText(nsec: string, npub: string): string {
  return [
    'Askr secret key',
    '',
    `Secret key: ${nsec}`,
    `Store ID: ${npub}`,
    '',
    `To sign in, open the Askr admin at ${apiBase()}/admin/ and paste the secret key.`,
    '',
    'Keep this file private. Whoever has this file controls your store: its settings, products and policies. Nobody can recover the key for you if you lose it.',
    '',
  ].join('\n');
}

/** Save `text` as a file on this device, made here: nothing is sent anywhere. */
export function saveTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
