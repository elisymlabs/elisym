/**
 * Reading the refusal a script wrote.
 *
 * Split from `refusal.ts` because this half touches `node:fs`, and the other
 * half - the contract, the error and its guard - is imported by the SDK's root
 * entry, which browsers load. A bare `import 'node:fs/promises'` in that bundle
 * is an unhandled scheme in webpack and a throwing stub in Vite.
 */
import { open, stat } from 'node:fs/promises';
import { SCRIPT_REFUSAL_FILE_MAX_BYTES } from './refusal';

/**
 * Read what a script wrote to `ELISYM_REFUSAL_FILE`, or `undefined` for "it did
 * not refuse".
 *
 * Adoption rule as elsewhere in this package: the path must exist, be a regular
 * file and be non-empty. Anything unreadable is treated as no refusal rather
 * than as an empty one - a refusal the runtime invented would be worse than a
 * job that simply failed.
 */
export async function readRefusalFile(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile() || info.size === 0) {
    return undefined;
  }
  // Read a bounded prefix rather than the file: a script that redirects a
  // gigabyte here (`yes refused > "$ELISYM_REFUSAL_FILE"`) must not be able to
  // pull it into the agent. Bytes, not code units - the cap is about memory.
  const handle = await open(path, 'r').catch(() => null);
  if (handle === null) {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(Math.min(info.size, SCRIPT_REFUSAL_FILE_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
