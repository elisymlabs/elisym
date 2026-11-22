import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as askr from '@elisym/askr';
import { listAgents } from '@elisym/sdk/agent-store';
import { nip19 } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { secretKeySigner } from '../../askr-admin/src/lib/signer';
import { EMPTY_FORM, signStoreEvents } from '../../askr-admin/src/lib/store-form';
import { keyDirOf, keyFileOf, readOwnerKey, saveOwnerKey } from '../src/commands/askr/owner-key';
import { configInputOf, signSettings } from '../src/commands/askr/signing';
import { INIT_ARGS, cleanupHomes, harness, initInvocation, tempDir } from './askr-fake';

// Each case runs whole commands (key files, signing, many calls): slower than a unit under a loaded `bun qa`.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanupHomes();
});

describe('the owner key file', () => {
  it('two concurrent first runs end with one key file, both use it', async () => {
    const home = await tempDir();
    const [left, right] = await Promise.all([
      saveOwnerKey(home, 'default', generateSecretKey(), 1),
      saveOwnerKey(home, 'default', generateSecretKey(), 1),
    ]);
    expect(left.owner).toBe(right.owner);
    expect((await readOwnerKey(home, 'default'))?.owner).toBe(left.owner);
    expect((await readdir(keyDirOf(home))).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('link failing with EPERM falls back to an exclusive write', async () => {
    const home = await tempDir();
    const denied = Object.assign(new Error('no hard links'), { code: 'EPERM' });
    const saved = await saveOwnerKey(home, 'default', generateSecretKey(), 1, {
      link: async () => {
        throw denied;
      },
    });
    expect((await readOwnerKey(home, 'default'))?.owner).toBe(saved.owner);
    expect((await stat(keyFileOf(home, 'default'))).mode & 0o777).toBe(0o600);
  });

  it('an existing 0755 directory is tightened to 0700, ~/.elisym is left as it is', async () => {
    const home = await tempDir();
    await mkdir(keyDirOf(home), { recursive: true, mode: 0o755 });
    await chmod(keyDirOf(home), 0o755);
    await chmod(join(home, '.elisym'), 0o755);
    await saveOwnerKey(home, 'default', generateSecretKey(), 1);
    expect((await stat(keyDirOf(home))).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, '.elisym'))).mode & 0o777).toBe(0o755);
  });

  it('--owner-key-file adopts an admin key file; a different key on the profile is profile_has_other_key', async () => {
    const setup = await harness();
    const dir = await tempDir();
    const secret = generateSecretKey();
    const adminFile = join(dir, 'askr-secret-key.txt');
    await writeFile(
      adminFile,
      `Askr secret key\n\nSecret key: ${nip19.nsecEncode(secret)}\nStore ID: x\n`,
    );
    // A store made in the admin with this key.
    setup.fake.owner = getPublicKey(secret);
    const adopted = await setup.run(initInvocation({ ownerKeyFile: adminFile }), INIT_ARGS);
    expect(adopted.exitCode).toBe(0);
    expect(adopted.output.storeId).toBe(nip19.npubEncode(getPublicKey(secret)));
    const otherFile = join(dir, 'other.txt');
    await writeFile(otherFile, bytesToHex(generateSecretKey()));
    const refused = await setup.run(initInvocation({ ownerKeyFile: otherFile }), INIT_ARGS);
    expect(refused).toMatchObject({
      exitCode: 2,
      output: { error: { code: 'profile_has_other_key' } },
    });
  });

  it('no key for the profile is exit 2', async () => {
    const setup = await harness();
    const outcome = await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free']);
    expect(outcome).toMatchObject({ exitCode: 2, output: { error: { code: 'no_key' } } });
  });

  it('leaves the MCP default agent as it is: discovery skips ~/.elisym/.askr', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const previous = process.env.HOME;
    process.env.HOME = setup.home;
    try {
      expect(await listAgents(setup.home)).toEqual([]);
      const agentDir = join(setup.home, '.elisym', 'zeta');
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'elisym.yaml'), YAML.stringify({ description: 'test' }));
      const names = (await listAgents(setup.home)).map((agent) => agent.name).sort();
      // The MCP server picks the first name (packages/mcp/src/index.ts).
      expect(names).toEqual(['zeta']);
      expect(await readFile(keyFileOf(setup.home, 'default'), 'utf-8')).toContain('"storeId"');
    } finally {
      process.env.HOME = previous;
    }
  });
});

describe('signing parity with the admin', () => {
  it('the CLI core and the admin sign the same config and authorization templates', async () => {
    const owner = generateSecretKey();
    const assistantSecret = generateSecretKey();
    const assistant = getPublicKey(assistantSecret);
    const serverKey = getPublicKey(generateSecretKey());
    const now = 1_800_000_000;
    const form = {
      ...EMPTY_FORM,
      name: 'Example Shop',
      origins: 'https://shop.example\nhttps://www.shop.example',
      language: 'de',
      currency: 'EUR',
      displayName: 'Ava',
      greeting: 'Hi there',
      launcherText: 'Ask Ava',
      contact: 'https://shop.example/contact',
      source: 'connector' as const,
      platform: 'shopify' as const,
      shopUrl: 'https://shop.example',
      voice: 'Warm.',
      instructions: 'Never promise delivery dates.',
    };
    const admin = await signStoreEvents({
      form,
      keys: { assistant, serverKey },
      signer: secretKeySigner(owner),
      now,
    });
    const cli = signSettings({
      askr,
      secretKey: owner,
      config: configInputOf(
        {
          name: 'Example Shop',
          origins: ['https://shop.example', 'https://www.shop.example'],
          linkOrigins: [],
          language: 'de',
          currency: 'EUR',
          source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://shop.example' },
          catalogKey: serverKey,
          policyKey: serverKey,
          displayName: 'Ava',
          greeting: 'Hi there',
          launcherText: 'Ask Ava',
          contact: 'https://shop.example/contact',
          private: { voice: 'Warm.', instructions: 'Never promise delivery dates.', notes: '' },
        },
        assistant,
        now,
      ),
      authorize: { key: serverKey, createdAt: now },
    });
    expect(cli).toHaveLength(admin.length);
    expect(cli[0]?.tags).toContainEqual(['launcher-text', 'Ask Ava']);
    const open = (content: string, pubkey: string) =>
      JSON.parse(
        nip44.v2.decrypt(content, nip44.v2.utils.getConversationKey(assistantSecret, pubkey)),
      );
    admin.forEach((adminEvent, index) => {
      const cliEvent = cli[index];
      expect(cliEvent?.kind).toBe(adminEvent.kind);
      expect(cliEvent?.created_at).toBe(adminEvent.created_at);
      expect(cliEvent?.tags).toEqual(adminEvent.tags);
      if (adminEvent.kind === askr.KIND_CONFIG) {
        expect(open(cliEvent?.content ?? '', getPublicKey(owner))).toEqual(
          open(adminEvent.content, getPublicKey(owner)),
        );
      } else {
        expect(cliEvent?.content).toBe(adminEvent.content);
      }
    });
  });
});
