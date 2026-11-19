import { KIND_CATALOG_AUTH, buildCatalogAuth } from '@elisym/askr';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { SignedJournal } from '../src/lib/journal';
import { NOW, OWNER_KEY, SERVER_KEY } from './fakes';

function auth(createdAt: number) {
  return finalizeEvent(
    { ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), created_at: createdAt },
    OWNER_KEY,
  );
}

describe('the journal', () => {
  it('keeps the newer event of an address, whichever order they are noted in', () => {
    const journal = new SignedJournal();
    const newer = auth(NOW + 10);
    journal.note([newer]);
    journal.note([auth(NOW)]);
    expect(journal.latest(KIND_CATALOG_AUTH, SERVER_KEY)?.id).toBe(newer.id);
    const newest = auth(NOW + 20);
    journal.note([newest]);
    expect(journal.latest(KIND_CATALOG_AUTH, SERVER_KEY)?.id).toBe(newest.id);
  });
});
