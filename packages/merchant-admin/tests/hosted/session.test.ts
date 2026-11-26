import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/hosted/lib/api';
import {
  OTHER_OPERATOR,
  OTHER_SERVER,
  type SessionApi,
  loadSession,
} from '../../src/hosted/lib/session';
import type { Meta, StoreView } from '../../src/hosted/lib/types';
import { CONFIG, META, storeView } from './fakes';

function fakeApi(meta: () => Promise<Meta>, store: () => Promise<StoreView>) {
  return { meta: vi.fn(meta), store: vi.fn(store) } satisfies SessionApi;
}

describe('opening a session', () => {
  it('reads meta, then the store, and is ready', async () => {
    const view = storeView();
    const api = fakeApi(
      async () => META,
      async () => view,
    );
    expect(await loadSession(api, CONFIG)).toEqual({ kind: 'ready', meta: META, store: view });
  });

  it('refuses a server naming another operator, and signs nothing for it', async () => {
    const api = fakeApi(
      async () => ({ ...META, operator: 'other.example' }),
      async () => storeView(),
    );
    expect(await loadSession(api, CONFIG)).toEqual({ kind: 'refused', message: OTHER_OPERATOR });
    expect(api.store).not.toHaveBeenCalled();
  });

  it('refuses a server with another public base, even one differing by a trailing slash', async () => {
    for (const publicBase of [`${CONFIG.apiBase}/`, 'https://other.example', '']) {
      const api = fakeApi(
        async () => ({ ...META, publicBase }),
        async () => storeView(),
      );
      expect(await loadSession(api, CONFIG)).toEqual({ kind: 'refused', message: OTHER_SERVER });
      expect(api.store).not.toHaveBeenCalled();
    }
  });

  it('says there is no store yet on no_store', async () => {
    const api = fakeApi(
      async () => META,
      async () => {
        throw new ApiError(404, 'no_store');
      },
    );
    expect(await loadSession(api, CONFIG)).toEqual({ kind: 'no_store', meta: META });
  });

  it('says the store moved when the owner key was moved away from (409 moved)', async () => {
    const api = fakeApi(
      async () => META,
      async () => {
        throw new ApiError(409, 'moved');
      },
    );
    expect(await loadSession(api, CONFIG)).toEqual({ kind: 'moved' });
  });

  it('fails, in a fixed sentence, when meta or the store cannot be read', async () => {
    const noMeta = fakeApi(
      async () => {
        throw new ApiError(0, 'network');
      },
      async () => storeView(),
    );
    expect(await loadSession(noMeta, CONFIG)).toEqual({
      kind: 'failed',
      message: expect.stringContaining('could not be reached'),
    });
    expect(noMeta.store).not.toHaveBeenCalled();
    const noStore = fakeApi(
      async () => META,
      async () => {
        throw new ApiError(401, 'unauthorized', { reason: 'stale' });
      },
    );
    expect(await loadSession(noStore, CONFIG)).toEqual({
      kind: 'failed',
      message: expect.stringContaining('clock'),
    });
  });
});
