import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgent } from '@elisym/sdk/agent-store';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { parseStoreOwner, runAskrKey } from '../src/commands/askr-key';

const NAME = 'askr-agent';
const OWNER = getPublicKey(generateSecretKey());
const OTHER_OWNER = getPublicKey(generateSecretKey());
const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dirPath = cleanupDirs.pop();
    if (dirPath !== undefined) {
      await rm(dirPath, { recursive: true, force: true });
    }
  }
});

async function makeAgent(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'elisym-askr-key-'));
  cleanupDirs.push(root);
  const dir = join(root, '.elisym', NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, '.secrets.json'),
    JSON.stringify({ nostr_secret_key: bytesToHex(generateSecretKey()) }),
    'utf-8',
  );
  await writeFile(join(dir, 'elisym.yaml'), YAML.stringify({ description: 'test' }), 'utf-8');
  return { root, dir };
}

describe('elisym askr-key', () => {
  it('takes the store owner as an npub or hex, and refuses anything else', () => {
    expect(parseStoreOwner(nip19.npubEncode(OWNER))).toBe(OWNER);
    expect(parseStoreOwner(` ${OWNER} `)).toBe(OWNER);
    const secret = generateSecretKey();
    for (const value of ['', 'npub1nope', OWNER.toUpperCase(), nip19.nsecEncode(secret)]) {
      expect(() => parseStoreOwner(value)).toThrow(/--store/);
    }
  });

  it('creates a key for the store, keeps it on a second run, and prints only the pubkey', async () => {
    const { root, dir } = await makeAgent();
    const created = await runAskrKey(NAME, root, undefined, { store: nip19.npubEncode(OWNER) });
    expect(created.status).toBe('created');
    expect(created.store).toBe(OWNER);
    const loaded = await loadAgent(NAME, root);
    const secret = loaded.secrets.askr_catalog_secret_key;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicKey(hexToBytes(secret ?? ''))).toBe(created.pubkey);
    expect(loaded.yaml.askr_store).toBe(OWNER);
    // The agent's own keys are kept.
    expect(loaded.secrets.nostr_secret_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(created)).not.toContain(secret);

    const again = await runAskrKey(NAME, root, undefined, { store: OWNER });
    expect(again).toEqual({ status: 'existing', pubkey: created.pubkey, store: OWNER });
    const shown = await runAskrKey(NAME, root, undefined, { show: true });
    expect(shown).toEqual(again);
    const raw = await readFile(join(dir, '.secrets.json'), 'utf-8');
    expect(JSON.parse(raw).askr_catalog_secret_key).toBe(secret);
  });

  it('never replaces a key or its store without --rotate', async () => {
    const { root } = await makeAgent();
    const created = await runAskrKey(NAME, root, undefined, { store: OWNER });
    await expect(runAskrKey(NAME, root, undefined, { store: OTHER_OWNER })).rejects.toThrow(
      /--rotate/,
    );
    expect((await loadAgent(NAME, root)).yaml.askr_store).toBe(OWNER);

    const rotated = await runAskrKey(NAME, root, undefined, { rotate: true });
    expect(rotated.status).toBe('rotated');
    expect(rotated.store).toBe(OWNER);
    expect(rotated.pubkey).not.toBe(created.pubkey);

    const moved = await runAskrKey(NAME, root, undefined, { rotate: true, store: OTHER_OWNER });
    expect(moved.store).toBe(OTHER_OWNER);
    expect((await loadAgent(NAME, root)).yaml.askr_store).toBe(OTHER_OWNER);
  });

  it('needs a store to create a key, and has nothing to show before one', async () => {
    const { root } = await makeAgent();
    await expect(runAskrKey(NAME, root, undefined, {})).rejects.toThrow(/--store/);
    await expect(runAskrKey(NAME, root, undefined, { show: true })).rejects.toThrow(
      /no Askr catalog key/,
    );
    expect((await loadAgent(NAME, root)).secrets.askr_catalog_secret_key).toBeUndefined();
  });

  it('stores the key encrypted under the passphrase', async () => {
    const { root, dir } = await makeAgent();
    const created = await runAskrKey(NAME, root, 'pass phrase', { store: OWNER });
    const raw = JSON.parse(await readFile(join(dir, '.secrets.json'), 'utf-8'));
    expect(raw.askr_catalog_secret_key).toMatch(/^encrypted:v1:/);
    const shown = await runAskrKey(NAME, root, 'pass phrase', { show: true });
    expect(shown.pubkey).toBe(created.pubkey);
  }, 60_000); // scrypt per field takes seconds on a shared CI runner.
});
