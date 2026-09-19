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
import { dirname, join } from 'node:path';
import {
  isBlockingNode,
  ensureGitignoreHasPrivateStateEntries,
  writeFileAtomic,
} from '@elisym/sdk/agent-store';
import { z } from 'zod';

export const CONTACTS_FILENAME = '.contacts.json';

// Non-strict on purpose: legacy entries on disk may carry retired fields
// (e.g. `jobCount`) that we now drop silently on read.
export const ContactSchema = z.object({
  pubkey: z.string().regex(/^[a-f0-9]{64}$/),
  npub: z.string().min(1).max(80),
  name: z.string().max(200).optional(),
  addedAt: z.number().int().nonnegative(),
  lastJobAt: z.number().int().nonnegative().optional(),
  lastCapability: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});

export const ContactsSchema = z.object({
  version: z.literal(1),
  contacts: z.array(ContactSchema),
});

export type Contact = z.infer<typeof ContactSchema>;
export type Contacts = z.infer<typeof ContactsSchema>;

const EMPTY: Contacts = { version: 1, contacts: [] };

const writeLocks = new Map<string, Promise<unknown>>();

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  // What keeps one failed write from jamming every later write to this path is
  // the ABSORPTION below, not this line: the promise put in the map settles
  // rejected-free, so the next caller always chains onto something that runs.
  // The rejection handler here is therefore UNREACHABLE as the code stands and
  // is kept as the reserve that takes over the moment somebody removes the
  // absorption. Both are measured on `customer-history`, whose rows this is a
  // copy of; the serialization itself is measured on THIS store, by the
  // concurrent-upsert row in `contacts.test.ts`.
  const next = previous.then(fn, fn);
  // The map stores `wrapped`, so the cleanup must compare against `wrapped` too -
  // comparing against `next` (the inner promise) never matched the stored value,
  // so entries were never deleted and the map grew without bound.
  //
  // And the stored promise absorbs the rejection. `finally` re-throws, so
  // without the `catch` every failed write left an unhandled rejection even
  // though the caller handled its own - noise in a server that only logs it,
  // and a process exit anywhere that does not. `X402JobStore.runExclusive`
  // stores an absorbed promise for the same reason.
  const wrapped: Promise<unknown> = next
    .finally(() => {
      if (writeLocks.get(path) === wrapped) {
        writeLocks.delete(path);
      }
    })
    .catch(() => undefined);
  writeLocks.set(path, wrapped);
  return next;
}

function pathFor(agentDir: string): string {
  return join(agentDir, CONTACTS_FILENAME);
}

async function readRaw(path: string): Promise<Contacts> {
  // A blocking node here does not fail the read - it never settles, and this
  // read runs INSIDE the per-path write lock, so one of them jams every later
  // write to this file for the life of the process (measured). Same answer the
  // `catch` below gives: this is client-side bookkeeping, not an index that
  // decides money, and the atomic writer renames its own file over the node.
  if (await isBlockingNode(path)) {
    return { ...EMPTY, contacts: [] };
  }
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
  // Before the write, like the other stores beside it: `writeFileAtomic` goes
  // through a temporary whose suffix is random, and an agent created by an
  // older build has a `.gitignore` line that cannot match one. Two directories
  // up from the file is the `.elisym` root.
  await ensureGitignoreHasPrivateStateEntries(dirname(dirname(path)));
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
}

/**
 * Insert or update a contact, keyed by `pubkey`. On a repeat call,
 * `lastJobAt` / `lastCapability` / `name` / `note` are replaced when present
 * in the input and preserved when absent.
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
