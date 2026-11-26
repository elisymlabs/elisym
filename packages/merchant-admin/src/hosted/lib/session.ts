import { ApiError, type HostedApi } from './api';
import { errorMessage } from './errors';
import type { HostedConfig } from './hosted-config';
import type { Meta, StoreView } from './types';

/** What opening a session reads. */
export type SessionApi = Pick<HostedApi, 'meta' | 'store'>;

export type SessionLoad =
  /** This admin must not run against that server: nothing is signed for it. */
  | { kind: 'refused'; message: string }
  /** Nothing usable came back: a retry may work. */
  | { kind: 'failed'; message: string }
  | { kind: 'no_store'; meta: Meta }
  | { kind: 'ready'; meta: Meta; store: StoreView };

export const OTHER_OPERATOR =
  'This admin is set up for another PayCore operator than the server it reached, so it stops here. Nothing was signed.';
export const OTHER_SERVER =
  'This admin points at another server than the one that answered, so it stops here. Nothing was signed.';

/**
 * Open a session: the server's `/v1/meta` first (unsigned), which must name
 * the committed operator and API base, and only then the store (signed).
 */
export async function loadSession(api: SessionApi, config: HostedConfig): Promise<SessionLoad> {
  let meta: Meta;
  try {
    meta = await api.meta();
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) };
  }
  if (meta.operator !== config.operator) {
    return { kind: 'refused', message: OTHER_OPERATOR };
  }
  if (meta.publicBase !== config.apiBase) {
    return { kind: 'refused', message: OTHER_SERVER };
  }
  try {
    return { kind: 'ready', meta, store: await api.store() };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'no_store') {
      return { kind: 'no_store', meta };
    }
    return { kind: 'failed', message: errorMessage(error) };
  }
}
