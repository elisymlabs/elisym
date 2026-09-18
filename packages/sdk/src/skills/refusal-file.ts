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
 * Read the path itself, and only if it is still what it looked like.
 *
 * `O_NOFOLLOW` refuses a symlink at the moment of opening, which is the check
 * that cannot be raced. `O_NONBLOCK` is for the other shape a script can leave
 * behind: opening a FIFO for reading waits for a writer, and the writer here
 * would be a process that has already exited - the job would hang until its
 * timeout.
 *
 * Both are guarded with `?? 0`, since Windows defines neither - so on Windows
 * the half of this that cannot be raced is simply absent, and what remains is the `lstat`
 * check plus an unguessable per-job path. `nlink` is not a dependable link count
 * there either. The channel is POSIX-hardened; on Windows it is as good as the
 * path being unguessable, which is what the rest of the job channels already
 * rely on.
 */
const READ_ONLY_NO_SYMLINK =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

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
 *
 * Never through a link of either kind. This is the one channel allowed to carry a
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
    // A HARD link is not a symlink, so `O_NOFOLLOW` does not stop one: `ln
    // ~/.elisym/agent.json "$ELISYM_REFUSAL_FILE"` passes every other check
    // here, and on a host whose tmpdir shares a volume with the agent's home
    // (macOS by default) that would publish the first 8 KB of the target to a
    // relay as the provider's own refusal. A file the script wrote where the
    // runtime put it has one name.
    //
    // A REFUSAL WITH NO REASON, not `unreadable`: the script did exit 43 on
    // purpose, and `unreadable` makes the runtime treat that as a crash - which
    // gates the operator's capability. Some network and FUSE mounts report a
    // link count this check cannot trust, and a correct skill on one of those
    // must not take itself offline on every job.
    if (info.nlink !== 1) {
      return { state: 'read', reason: '' };
    }
    if (info.size === 0) {
      return { state: 'read', reason: '' };
    }
    const buffer = Buffer.alloc(Math.min(info.size, SCRIPT_REFUSAL_FILE_MAX_BYTES));
    // Until the buffer is full or the file ends: one `read` is one system call, and
    // a network- or FUSE-backed tmpdir may hand back fewer bytes than asked
    // for. Trusting the first count would cut a customer's reason mid-sentence,
    // or - on a transient zero - tell them no reason was given at all.
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return {
      state: 'read',
      reason: new StringDecoder('utf8').write(buffer.subarray(0, filled)),
    };
  } catch {
    return { state: 'unreadable' };
  } finally {
    await handle.close().catch(() => {});
  }
}
