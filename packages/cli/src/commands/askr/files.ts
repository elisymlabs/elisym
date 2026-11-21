import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { nip19 } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { PROFILE_RE } from './constants';
import { AskrExit, EXIT } from './errors';
import { keyDirOf, readOwnerKey } from './owner-key';

const KEY_FILE_SUFFIX = '.json';

function notFound(path: string, flag: string): AskrExit {
  return new AskrExit(EXIT.BAD_INPUT, 'file_not_found', {
    hint: `${flag}: no readable file at this path`,
    fields: { file: path },
  });
}

function secretFile(flag: string): AskrExit {
  return new AskrExit(EXIT.KEY, 'secret_in_file', {
    hint: `${flag}: this file is or holds an Askr owner key, which is never sent anywhere: name another file`,
  });
}

/** The owner keys this computer keeps (every profile's), to keep them out of what a flag file sends. */
async function localKeys(home: string): Promise<Uint8Array[]> {
  let names: string[];
  try {
    names = await readdir(keyDirOf(home));
  } catch {
    return [];
  }
  const keys = await Promise.all(
    names
      .filter((name) => name.endsWith(KEY_FILE_SUFFIX))
      .map((name) => name.slice(0, -KEY_FILE_SUFFIX.length))
      .filter((profile) => PROFILE_RE.test(profile))
      .map((profile) => readOwnerKey(home, profile).catch(() => undefined)),
  );
  return keys.flatMap((key) => (key === undefined ? [] : [key.secretKey]));
}

async function realKeyDir(home: string): Promise<string> {
  try {
    return await realpath(keyDirOf(home));
  } catch {
    return resolve(keyDirOf(home));
  }
}

/**
 * A file named by a flag, as text; a missing or unreadable one is exit 1
 * (`file_not_found`). Its content is sent (a policy is public; voice and
 * instructions go to the model), so a file inside the owner key directory, by
 * its real path, or one holding an owner key in hex or as an nsec, is refused
 * (exit 2) without a word of its content.
 */
export async function readFlagFile(
  path: string,
  flag: string,
  home: string,
  extraKeys: readonly Uint8Array[] = [],
): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isFile()) {
      throw new Error('not a file');
    }
  } catch {
    throw notFound(path, flag);
  }
  const keyDir = await realKeyDir(home);
  if (real === keyDir || real.startsWith(`${keyDir}${sep}`)) {
    throw secretFile(flag);
  }
  let text: string;
  try {
    text = await readFile(real, 'utf-8');
  } catch {
    throw notFound(path, flag);
  }
  const lower = text.toLowerCase();
  for (const secretKey of [...(await localKeys(home)), ...extraKeys]) {
    // bech32 allows an all-uppercase nsec too; both forms are lowercase once lowered.
    if (lower.includes(bytesToHex(secretKey)) || lower.includes(nip19.nsecEncode(secretKey))) {
      throw secretFile(flag);
    }
  }
  return text;
}

/** A file's size in bytes, before it is read; a missing one is exit 1 (`file_not_found`). */
export async function fileSize(path: string, flag: string): Promise<number> {
  try {
    const info = await stat(path);
    if (info.isFile()) {
      return info.size;
    }
  } catch {
    // Reported below.
  }
  throw new AskrExit(EXIT.BAD_INPUT, 'file_not_found', {
    hint: `${flag}: no readable file at this path`,
    fields: { file: path },
  });
}

export function invalidFlag(flag: string, hint: string): AskrExit {
  return new AskrExit(EXIT.BAD_INPUT, 'invalid_flag', { hint: `${flag}: ${hint}` });
}
