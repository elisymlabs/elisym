/**
 * Reading the refusal a script wrote.
 *
 * Split from `refusal.ts` because this half touches `node:fs`, and the other
 * half - the contract, the error and its guard - is imported by the SDK's root
 * entry, which browsers load. A bare `import 'node:fs/promises'` in that bundle
 * is an unhandled scheme in webpack and a throwing stub in Vite.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { SCRIPT_REFUSAL_FILE_MAX_BYTES } from './refusal';

/**
 * What the refusal channel held after a job.
 *
 * `unreadable` is its own answer rather than folded into `absent`: a script
 * that wrote the file and left it mode 000 did keep the contract, and telling
 * its operator to go looking for a typo would be a wild goose chase.
 */
/**
 * Read the path itself, and only if it is still what it looked like.
 *
 * `O_NOFOLLOW` refuses a symlink at the moment of opening, which is the check
 * that cannot be raced. `O_NONBLOCK` is for the other shape a script can leave
 * behind: opening a FIFO for reading waits for a writer, and the writer here
 * would be a process that has already exited - the job would hang until its
 * timeout. Both are guarded with `?? 0`, since Windows defines neither.
 */
const READ_ONLY_NO_SYMLINK =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

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
 *
 * Never through a SYMLINK. This is the one channel allowed to carry a
 * subprocess's own bytes to a remote customer, and the whole design rests on
 * the script having written them on purpose; a script that instead points the
 * path at the agent's config (`ln -sf ~/.elisym/agent.json
 * "$ELISYM_REFUSAL_FILE"`) would otherwise have its first 8 KB published as the
 * reason. `O_NOFOLLOW` is what enforces that, and the size comes from the OPEN
 * HANDLE rather than a prior `lstat`: checking a path and then opening it are
 * two operations, and a script racing a background `ln -sf` between them would
 * win some of the time. The `lstat` that remains only separates "no file" from
 * "something else here" for the operator's message.
 */
export async function readRefusalFile(path: string): Promise<RefusalFileRead> {
  const seen = await lstat(path).catch(() => null);
  if (seen === null) {
    return { state: 'absent' };
  }
  if (!seen.isFile()) {
    return { state: 'unreadable' };
  }
  const handle = await open(path, READ_ONLY_NO_SYMLINK).catch(() => null);
  if (handle === null) {
    return { state: 'unreadable' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return { state: 'unreadable' };
    }
    if (info.size === 0) {
      return { state: 'read', reason: '' };
    }
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
