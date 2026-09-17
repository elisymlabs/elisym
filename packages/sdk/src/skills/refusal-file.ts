/**
 * Reading the refusal a script wrote.
 *
 * Split from `refusal.ts` because this half touches `node:fs`, and the other
 * half - the contract, the error and its guard - is imported by the SDK's root
 * entry, which browsers load. A bare `import 'node:fs/promises'` in that bundle
 * is an unhandled scheme in webpack and a throwing stub in Vite.
 */
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { SCRIPT_REFUSAL_FILE_MAX_BYTES } from './refusal';

/**
 * What the refusal channel held after a job.
 *
 * `unreadable` is its own answer rather than folded into `absent`: a script
 * that wrote the file and left it mode 000 did keep the contract, and telling
 * its operator to go looking for a typo would be a wild goose chase.
 */
export type RefusalFileRead =
  | { state: 'absent' }
  | { state: 'unreadable' }
  | { state: 'read'; reason: string };

/**
 * Read what a script wrote to `ELISYM_REFUSAL_FILE`.
 *
 * The path must exist and be a regular file; an empty one is a refusal with
 * nothing said. A bounded prefix is read rather than the file, so a script that
 * redirects a gigabyte here cannot pull it into the agent, and the decoder is
 * given the bytes without `end()` so a cap landing inside a multi-byte
 * character drops the fragment instead of turning it into a replacement one.
 */
export async function readRefusalFile(path: string): Promise<RefusalFileRead> {
  const info = await stat(path).catch(() => null);
  if (info === null) {
    return { state: 'absent' };
  }
  if (!info.isFile()) {
    return { state: 'unreadable' };
  }
  if (info.size === 0) {
    return { state: 'read', reason: '' };
  }
  const handle = await open(path, 'r').catch(() => null);
  if (handle === null) {
    return { state: 'unreadable' };
  }
  try {
    const buffer = Buffer.alloc(Math.min(info.size, SCRIPT_REFUSAL_FILE_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      state: 'read',
      reason: new StringDecoder('utf8').write(buffer.subarray(0, bytesRead)),
    };
  } catch {
    return { state: 'unreadable' };
  } finally {
    await handle.close().catch(() => {});
  }
}
