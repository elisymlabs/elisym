/**
 * `askr export-key` (5.8): the owner key as the admin's downloaded key file,
 * for the human's password manager. Never overwrites, mode 0600. The prompt
 * tells the agent never to run it.
 */
import { writeFile } from 'node:fs/promises';
import { nip19 } from 'nostr-tools';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import type { Session } from './session';
import { useOwnerKey } from './store';

const FILE_MODE = 0o600;

/** The admin's key file text (`packages/askr-admin/src/lib/key-file.ts`), with the CLI's API base. */
export function keyFileText(nsec: string, npub: string, apiBase: string): string {
  return [
    'Askr secret key',
    '',
    `Secret key: ${nsec}`,
    `Store ID: ${npub}`,
    '',
    `To sign in, open the Askr admin at ${apiBase}/admin/ and paste the secret key.`,
    '',
    'Keep this file private. Whoever has this file controls your store: its settings, products and policies. Nobody can recover the key for you if you lose it.',
    '',
  ].join('\n');
}

export async function runExportKey(session: Session, out: string): Promise<CommandOutcome> {
  const key = await useOwnerKey(session);
  const text = keyFileText(nip19.nsecEncode(key.secretKey), key.storeId, session.apiBase);
  try {
    await writeFile(out, text, { encoding: 'utf-8', mode: FILE_MODE, flag: 'wx' });
  } catch (error) {
    const exists =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
    throw new AskrExit(EXIT.BAD_INPUT, exists ? 'file_exists' : 'file_not_writable', {
      hint: exists ? '--out: a file is already there; name a new one' : '--out: cannot write there',
    });
  }
  return { exitCode: EXIT.OK, output: { ok: true, path: out } };
}
