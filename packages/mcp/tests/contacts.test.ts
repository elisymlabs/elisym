import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTACTS_FILENAME,
  findContact,
  readContacts,
  removeContact,
  upsertContact,
} from '../src/storage/contacts';

let sandbox: string;
let agentDir: string;

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const NPUB_A = 'npub1aaaaaaa';
const NPUB_B = 'npub1bbbbbbb';

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-contacts-'));
  agentDir = join(sandbox, 'agent');
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('contacts', () => {
  it('returns empty contacts when file is missing', async () => {
    const data = await readContacts(agentDir);
    expect(data).toEqual({ version: 1, contacts: [] });
  });

  it('round-trips a contact through upsert + read', async () => {
    await upsertContact(agentDir, { pubkey: PUBKEY_A, npub: NPUB_A, name: 'Alice', note: 'hi' });
    const data = await readContacts(agentDir);
    expect(data.contacts).toHaveLength(1);
    expect(data.contacts[0]).toMatchObject({
      pubkey: PUBKEY_A,
      npub: NPUB_A,
      name: 'Alice',
      note: 'hi',
    });
    expect(data.contacts[0]).not.toHaveProperty('jobCount');
  });

  it('preserves existing fields when omitted on update', async () => {
    await upsertContact(agentDir, {
      pubkey: PUBKEY_A,
      npub: NPUB_A,
      name: 'Alice',
      note: 'original',
    });
    await upsertContact(agentDir, { pubkey: PUBKEY_A, npub: NPUB_A });
    const found = await findContact(agentDir, PUBKEY_A);
    expect(found?.name).toBe('Alice');
    expect(found?.note).toBe('original');
  });

  it('updates lastJobAt and lastCapability when provided', async () => {
    await upsertContact(agentDir, { pubkey: PUBKEY_A, npub: NPUB_A });
    await upsertContact(agentDir, {
      pubkey: PUBKEY_A,
      npub: NPUB_A,
      lastJobAt: 1_700_000_000_000,
      lastCapability: 'translate',
    });
    const found = await findContact(agentDir, PUBKEY_A);
    expect(found?.lastJobAt).toBe(1_700_000_000_000);
    expect(found?.lastCapability).toBe('translate');
  });

  it('removeContact returns false for missing contact', async () => {
    const removed = await removeContact(agentDir, PUBKEY_A);
    expect(removed).toBe(false);
  });

  it('removeContact returns true and removes the entry', async () => {
    await upsertContact(agentDir, { pubkey: PUBKEY_A, npub: NPUB_A });
    await upsertContact(agentDir, { pubkey: PUBKEY_B, npub: NPUB_B });
    const removed = await removeContact(agentDir, PUBKEY_A);
    expect(removed).toBe(true);
    const data = await readContacts(agentDir);
    expect(data.contacts).toHaveLength(1);
    expect(data.contacts[0]?.pubkey).toBe(PUBKEY_B);
  });

  it('writes the file at the expected path', async () => {
    await upsertContact(agentDir, { pubkey: PUBKEY_A, npub: NPUB_A });
    const path = join(agentDir, CONTACTS_FILENAME);
    expect(path.endsWith('.contacts.json')).toBe(true);
  });

  it('silently drops legacy jobCount field from on-disk contacts', async () => {
    const legacy = {
      version: 1,
      contacts: [
        {
          pubkey: PUBKEY_A,
          npub: NPUB_A,
          addedAt: 1_700_000_000_000,
          jobCount: 5,
        },
      ],
    };
    writeFileSync(join(agentDir, CONTACTS_FILENAME), JSON.stringify(legacy));
    const data = await readContacts(agentDir);
    expect(data.contacts).toHaveLength(1);
    expect(data.contacts[0]).not.toHaveProperty('jobCount');
    expect(data.contacts[0]?.pubkey).toBe(PUBKEY_A);
  });

  it('preserves all contacts under concurrent upserts of distinct pubkeys', async () => {
    const total = 20;
    await Promise.all(
      Array.from({ length: total }, (_, index) => {
        const pubkey = index.toString(16).padStart(64, '0');
        return upsertContact(agentDir, { pubkey, npub: `npub-${index}` });
      }),
    );
    const data = await readContacts(agentDir);
    expect(data.contacts).toHaveLength(total);
  });
});
