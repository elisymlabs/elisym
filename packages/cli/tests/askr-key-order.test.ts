import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgent } from '@elisym/sdk/agent-store';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { runAskrKey } from '../src/commands/askr-key';

const failing = vi.hoisted(() => ({ yaml: false }));

vi.mock('@elisym/sdk/agent-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@elisym/sdk/agent-store')>();
  return {
    ...original,
    writeYaml: async (...args: Parameters<typeof original.writeYaml>) => {
      if (failing.yaml) {
        throw new Error('disk full');
      }
      return original.writeYaml(...args);
    },
  };
});

const NAME = 'askr-agent';
const OWNER = getPublicKey(generateSecretKey());
const OTHER_OWNER = getPublicKey(generateSecretKey());
const cleanupDirs: string[] = [];

afterEach(async () => {
  failing.yaml = false;
  while (cleanupDirs.length > 0) {
    const dirPath = cleanupDirs.pop();
    if (dirPath !== undefined) {
      await rm(dirPath, { recursive: true, force: true });
    }
  }
});

describe('elisym askr-key write order', () => {
  it('writes the new key before the store: a rotation stopped between them never shows the old key on the new store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elisym-askr-key-order-'));
    cleanupDirs.push(root);
    const dir = join(root, '.elisym', NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '.secrets.json'),
      JSON.stringify({ nostr_secret_key: bytesToHex(generateSecretKey()) }),
      'utf-8',
    );
    await writeFile(join(dir, 'elisym.yaml'), YAML.stringify({ description: 'test' }), 'utf-8');
    const created = await runAskrKey(NAME, root, undefined, { store: OWNER });
    failing.yaml = true;
    await expect(
      runAskrKey(NAME, root, undefined, { rotate: true, store: OTHER_OWNER }),
    ).rejects.toThrow('disk full');
    failing.yaml = false;
    const loaded = await loadAgent(NAME, root);
    // The new key on the old store, which never authorized it.
    expect(loaded.yaml.askr_store).toBe(OWNER);
    const shown = await runAskrKey(NAME, root, undefined, { show: true });
    expect(shown.store).toBe(OWNER);
    expect(shown.pubkey).not.toBe(created.pubkey);
  });
});
