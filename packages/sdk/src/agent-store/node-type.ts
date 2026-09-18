import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * Refuse to OPEN a path whose node type can block forever.
 *
 * A FIFO left where an agent's `elisym.yaml` belongs does not make the read
 * fail - it makes it never return. The synchronous form hangs the event loop
 * outright; the asynchronous one is no better, because the promise simply never
 * settles, `catch` never runs, and one such read burns a libuv worker for the
 * life of the process. Four of them and the whole `fs.promises` API, `dns`
 * lookups and `crypto.scrypt` stop working with it.
 *
 * By BLOCKING TYPE, never by "not a regular file": a directory in that position
 * answers EISDIR immediately, and callers rely on telling that case apart. The
 * set is kept whole rather than trimmed to FIFOs - a character device like
 * `/dev/zero` does not block but streams without end, which is worse.
 *
 * `stat`, not `lstat`: the check has to follow the link, or a symlink pointing
 * at a FIFO walks straight past it.
 *
 * ADVISORY, not a lock: between this `stat` and the open that follows, the same
 * hand that plants a node could swap a regular file for one. It closes the
 * accident and the node left lying there, which is what actually happens; the
 * WRITE side of this class is closed properly instead, by writing through a
 * temporary whose name nobody can guess.
 *
 * The gate only ever NARROWS. It is entirely inside this try/catch, so any
 * throw - ENOENT for a directory with no yaml, ENOTDIR for a plain file where a
 * directory was expected - means "the gate did not fire", and the read that
 * follows fails exactly as it does today.
 */
export async function isBlockingNode(path: string): Promise<boolean> {
  try {
    return blocks(await stat(path));
  } catch {
    return false;
  }
}

/**
 * The same gate for the synchronous readers.
 *
 * There are several, and they are the worse half: `readFileSync` on a FIFO
 * takes the whole event loop with it, so the process does not hang a worker -
 * it stops entirely, before any timeout anyone set can fire.
 */
export function isBlockingNodeSync(path: string): boolean {
  try {
    return blocks(statSync(path));
  } catch {
    return false;
  }
}

/** Only the socket case is covered by a test; the device cases need root. */
function blocks(stats: {
  isFIFO(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
}): boolean {
  return stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice();
}
