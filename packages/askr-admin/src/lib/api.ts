import type { CatalogItemInput, ConnectorPlatform, SyncDiff } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { apiBase } from '../constants';
import { nip98Header } from './nip98';
import type { Signer } from './signer';
import type { ConnectorRecord, ConnectorSyncResult, StoreView } from './types';

/** An admin API refusal (`packages/askr-server/src/admin/api.ts`), or `network` when no answer came. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | undefined;
  readonly detail: Record<string, unknown>;

  constructor(status: number, code: string, detail: Record<string, unknown> = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.reason = typeof detail.reason === 'string' ? detail.reason : undefined;
  }
}

export interface ConnectorSettingsInput {
  platform: ConnectorPlatform;
  url: string;
  currency?: string;
  importPolicies: boolean;
}

export interface AdminApiOptions {
  signer: Signer;
  base?: string;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * The server's admin API (7.3). Every call, reads included, carries a fresh
 * NIP-98 authorization by O over the exact body string sent.
 */
export class AdminApi {
  private readonly signer: Signer;
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(options: AdminApiOptions) {
    this.signer = options.signer;
    this.base = options.base ?? apiBase();
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** One call; the server's JSON in its documented shape (the server this admin ships with). */
  async call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers: Record<string, string> = {
      authorization: await nip98Header({ signer: this.signer, url, method, body }),
    };
    if (body !== '') {
      headers['content-type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        ...(body === '' ? {} : { body }),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(0, 'network');
    }
    if (!response.ok) {
      const parsed = await readJson(response);
      const detail = isRecord(parsed) ? parsed : {};
      const code = typeof detail.error === 'string' ? detail.error : 'unexpected';
      throw new ApiError(response.status, code, detail);
    }
    try {
      const parsed: T = await response.json();
      return parsed;
    } catch {
      throw new ApiError(response.status, 'unexpected');
    }
  }

  createStore(): Promise<StoreView> {
    return this.call<StoreView>('POST', '/v1/admin/store');
  }

  store(): Promise<StoreView> {
    return this.call<StoreView>('GET', '/v1/admin/store');
  }

  storeEvents(events: NostrEvent[]): Promise<{ stored: string[] }> {
    return this.call('POST', '/v1/admin/store/events', { events });
  }

  catalog(
    items: readonly CatalogItemInput[],
    dryRun: boolean,
  ): Promise<{ diff: SyncDiff; started?: boolean }> {
    return this.call('POST', '/v1/admin/catalog', { items, dryRun });
  }

  putPolicy(slug: string, policy: { title: string; body: string }): Promise<{ id: string }> {
    return this.call('PUT', `/v1/admin/policies/${encodeURIComponent(slug)}`, policy);
  }

  deletePolicy(slug: string): Promise<{ id: string }> {
    return this.call('DELETE', `/v1/admin/policies/${encodeURIComponent(slug)}`);
  }

  putConnector(settings: ConnectorSettingsInput): Promise<{ connector: ConnectorRecord | null }> {
    return this.call('PUT', '/v1/admin/connector', settings);
  }

  deleteConnector(): Promise<{ connector: null }> {
    return this.call('DELETE', '/v1/admin/connector');
  }

  previewConnector(): Promise<{ result: ConnectorSyncResult }> {
    return this.call('POST', '/v1/admin/connector/preview');
  }

  enableConnector(): Promise<{ connector: ConnectorRecord | null }> {
    return this.call('POST', '/v1/admin/connector/enable');
  }

  rotateAssistant(): Promise<{ nextAssistant: string }> {
    return this.call('POST', '/v1/admin/store/assistant/rotate');
  }
}
