/**
 * Customer-side contacts: a per-agent local list of providers the user wants
 * to keep handy. Populated explicitly via `add_contact` (MCP) - no auto-add.
 * Used by `search_agents contacts_only=true` to filter discovery to known
 * providers before the capability/online filter runs.
 *
 * Lives in `packages/mcp/src/storage/` rather than the SDK because today
 * MCP is the only consumer. If a second consumer appears (ElizaOS plugin,
 * future web-app server, etc.), promote this module into `@elisym/sdk/agent-store`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@elisym/sdk/agent-store';
import { z } from 'zod';

export const CONTACTS_FILENAME = '.contacts.json';

export const ContactSchema = z
  .object({
    pubkey: z.string().regex(/^[a-f0-9]{64}$/),
    npub: z.string().min(1).max(80),
    name: z.string().max(200).optional(),
    addedAt: z.number().int().nonnegative(),
    lastJobAt: z.number().int().nonnegative().optional(),
    jobCount: z.number().int().nonnegative(),
    lastCapability: z.string().max(200).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const ContactsSchema = z
  .object({
    version: z.literal(1),
    contacts: z.array(ContactSchema),
  })
  .strict();

export type Contact = z.infer<typeof ContactSchema>;
export type Contacts = z.infer<typeof ContactsSchema>;

const EMPTY: Contacts = { version: 1, contacts: [] };

const writeLocks = new Map<string, Promise<unknown>>();

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeLocks.set(
    path,
    next.finally(() => {
      if (writeLocks.get(path) === next) {
        writeLocks.delete(path);
      }
    }),
  );
  return next;
}

function pathFor(agentDir: string): string {
  return join(agentDir, CONTACTS_FILENAME);
}

async function readRaw(path: string): Promise<Contacts> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return { ...EMPTY, contacts: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    const result = ContactsSchema.safeParse(parsed);
    return result.success ? result.data : { ...EMPTY, contacts: [] };
  } catch {
    return { ...EMPTY, contacts: [] };
  }
}

async function writeRaw(path: string, contacts: Contacts): Promise<void> {
  const body = JSON.stringify(contacts, null, 2) + '\n';
  await writeFileAtomic(path, body, 0o600);
}

/** Read .contacts.json. Returns an empty list if missing or corrupt. */
export async function readContacts(agentDir: string): Promise<Contacts> {
  return readRaw(pathFor(agentDir));
}

export interface UpsertContactInput {
  pubkey: string;
  npub: string;
  name?: string;
  note?: string;
  lastJobAt?: number;
  lastCapability?: string;
  /**
   * Override `jobCount` directly (e.g. when seeding from history). When
   * omitted, the existing count is incremented by 1 on each call.
   */
  jobCount?: number;
}

/**
 * Insert or update a contact, keyed by `pubkey`. On a repeat call:
 *  - jobCount: replaced if `input.jobCount` is set, otherwise incremented by 1.
 *  - lastJobAt / lastCapability / name / note: replaced when present in input,
 *    preserved when absent.
 */
export async function upsertContact(agentDir: string, input: UpsertContactInput): Promise<Contact> {
  const path = pathFor(agentDir);
  return withLock(path, async () => {
    const data = await readRaw(path);
    const index = data.contacts.findIndex((existing) => existing.pubkey === input.pubkey);
    let merged: Contact;
    if (index >= 0) {
      const existing = data.contacts[index]!;
      merged = ContactSchema.parse({
        ...existing,
        npub: input.npub,
        name: input.name ?? existing.name,
        note: input.note ?? existing.note,
        lastJobAt: input.lastJobAt ?? existing.lastJobAt,
        lastCapability: input.lastCapability ?? existing.lastCapability,
        jobCount: input.jobCount ?? existing.jobCount + 1,
      });
      data.contacts[index] = merged;
    } else {
      merged = ContactSchema.parse({
        pubkey: input.pubkey,
        npub: input.npub,
        name: input.name,
        note: input.note,
        addedAt: Date.now(),
        lastJobAt: input.lastJobAt,
        lastCapability: input.lastCapability,
        jobCount: input.jobCount ?? 0,
      });
      data.contacts.push(merged);
    }
    await writeRaw(path, data);
    return merged;
  });
}

/** Remove a contact by pubkey. Returns true if a contact was removed. */
export async function removeContact(agentDir: string, pubkey: string): Promise<boolean> {
  const path = pathFor(agentDir);
  return withLock(path, async () => {
    const data = await readRaw(path);
    const before = data.contacts.length;
    data.contacts = data.contacts.filter((existing) => existing.pubkey !== pubkey);
    if (data.contacts.length === before) {
      return false;
    }
    await writeRaw(path, data);
    return true;
  });
}

/** Find a contact by pubkey. */
export async function findContact(agentDir: string, pubkey: string): Promise<Contact | undefined> {
  const data = await readContacts(agentDir);
  return data.contacts.find((existing) => existing.pubkey === pubkey);
}
