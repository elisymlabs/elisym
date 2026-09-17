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
 * Read what a script wrote to `ELISYM_REFUSAL_FILE`, or `undefined` for "it did
 * not refuse".
 *
 * The path must exist and be a regular file; an empty one is a refusal with
 * nothing said. Anything unreadable is treated as no refusal at all - a refusal
 * the runtime invented would be worse than a job that simply failed.
 */
export async function readRefusalFile(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) {
    return undefined;
  }
  // An EMPTY file is still a refusal: the script created it deliberately and
  // then had nothing to say, which the customer hears as "no reason was given".
  // Only the absence of the file means "this was not a refusal".
  if (info.size === 0) {
    return '';
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
    // `StringDecoder.write` and never `end`: the cap can land in the middle of
    // a multi-byte character, and the decoder holds that fragment back instead
    // of turning it into a replacement character in a Persian or Chinese
    // refusal. The same helper `runScript` uses for its own chunk boundaries.
    return new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
