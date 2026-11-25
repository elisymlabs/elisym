/**
 * The `llms.txt` a merchant puts at their site's root, so an AI agent visiting
 * the site learns the store's assistant is Askr and where its products and
 * policies are, read without a chat. The text is the admin's
 * (`packages/askr-admin/src/lib/llms-txt.ts`), kept here; a test keeps the two
 * equal.
 */
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, open, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ASKR_SITE_URL, STORE_FILES_BASE } from './constants';
import { AskrExit, EXIT } from './errors';

/** The heading the Askr part starts with: what is appended to a site's own llms.txt. */
export const LLMS_SECTION_HEADING = '## Shopping assistant';
const LLMS_FILE_NAME = 'llms.txt';

export function storeLlmsTxtUrl(npub: string): string {
  return `${STORE_FILES_BASE}/${npub}/llms.txt`;
}

export function storeCatalogJsonUrl(npub: string): string {
  return `${STORE_FILES_BASE}/${npub}/catalog.json`;
}

/** The store name as one line of a heading. */
function headingName(name: string): string {
  const line = name
    .replace(/\s+/gu, ' ')
    .replace(/^[#\s]+/u, '')
    .trim();
  return line === '' ? 'This store' : line;
}

/** The Askr part alone, from its heading on: appended to a site's own llms.txt. */
export function siteLlmsTxtSection(npub: string): string {
  return [
    LLMS_SECTION_HEADING,
    '',
    `- [Products and policies for AI agents](${storeLlmsTxtUrl(npub)}): every product with its price and page, and the store's policies, read-only`,
    `- [Catalog as JSON](${storeCatalogJsonUrl(npub)}): the same, machine-readable`,
    `- [Askr](${ASKR_SITE_URL}): the shopping assistant this store uses. Purchases happen on this site.`,
    '',
  ].join('\n');
}

/** The whole file, for a site that has no llms.txt yet. */
export function siteLlmsTxt(npub: string, storeName: string): string {
  const name = headingName(storeName);
  return [
    `# ${name}`,
    '',
    `> ${name} has a shopping assistant, Askr: the chat on every page of this site answers questions about products, prices and policies.`,
    '',
    siteLlmsTxtSection(npub),
  ].join('\n');
}

export type LlmsTxtWrite = 'created' | 'appended' | 'unchanged';

/** A site's own llms.txt is appended to only up to this size: a bigger one is not an llms.txt. */
export const MAX_EXISTING_LLMS_BYTES = 1024 * 1024;
/** Opens never follow a final symlink (0 where the platform has no such flag). */
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function notWritable(hint: string): AskrExit {
  return new AskrExit(EXIT.BAD_INPUT, 'file_not_writable', { hint: `--llms-txt: ${hint}` });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** A new file, never through a link: `wx` fails on any entry there, a dangling link included. */
async function create(path: string, text: string): Promise<LlmsTxtWrite> {
  try {
    await writeFile(path, text, { encoding: 'utf-8', flag: 'wx' });
    return 'created';
  } catch (error) {
    throw notWritable(
      codeOf(error) === 'EEXIST' ? 'something else is at that path' : 'cannot write there',
    );
  }
}

/** Append the Askr part through one handle opened without following a link, unless it is there. */
async function appendTo(handle: FileHandle, npub: string): Promise<LlmsTxtWrite> {
  const info = await handle.stat();
  if (!info.isFile()) {
    throw notWritable('not a regular file');
  }
  if (info.size > MAX_EXISTING_LLMS_BYTES) {
    throw notWritable('the file there is over 1 MiB: not an llms.txt');
  }
  const existing = await handle.readFile({ encoding: 'utf-8' });
  if (existing.includes('\u0000')) {
    throw notWritable('the file there is not text');
  }
  if (existing.includes(storeLlmsTxtUrl(npub))) {
    return 'unchanged';
  }
  let separator = '\n\n';
  if (existing === '' || existing.endsWith('\n\n') || existing.endsWith('\r\n\r\n')) {
    separator = '';
  } else if (existing.endsWith('\r\n')) {
    separator = '\r\n';
  } else if (existing.endsWith('\n')) {
    separator = '\n';
  }
  await handle.appendFile(`${separator}${siteLlmsTxtSection(npub)}`, { encoding: 'utf-8' });
  return 'appended';
}

/**
 * `askr embed --llms-txt <path>`: write the file, or append the Askr part to
 * a site's own llms.txt; one that already links this store's file is left as
 * it is. Only a regular file named `llms.txt` is written, never through a
 * link, and never a file over 1 MiB or holding NUL bytes.
 */
export async function writeSiteLlmsTxt(
  path: string,
  npub: string,
  storeName: string,
): Promise<LlmsTxtWrite> {
  if (basename(path) !== LLMS_FILE_NAME) {
    throw notWritable('name a file called llms.txt (at your site root)');
  }
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDWR | fsConstants.O_APPEND | NO_FOLLOW);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') {
      return create(path, siteLlmsTxt(npub, storeName));
    }
    throw notWritable(
      code === 'ELOOP' ? 'a link, not a regular file' : 'cannot open the file there',
    );
  }
  try {
    return await appendTo(handle, npub);
  } catch (error) {
    throw error instanceof AskrExit ? error : notWritable('cannot write there');
  } finally {
    await handle.close();
  }
}
