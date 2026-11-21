import {
  type CatalogItemInput,
  type ConnectorPlatform,
  type SyncDiff,
  nip98Header,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { apiBase } from '../constants';
import type { Signer } from './signer';
import type {
  Activation,
  ConnectorRecord,
  ConnectorSyncResult,
  PinnedWidget,
  MovedSettings,
  StoreView,
  StoredEventsRead,
} from './types';

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

/** The server's pinned widget path and SRI value (`packages/askr-server/src/gateway/widget.ts`). */
const PINNED_PATH_RE = /^\/widget\/[0-9a-f]{32}\.js$/;
const INTEGRITY_RE = /^sha384-[A-Za-z0-9+/]{64}$/;

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
      authorization: await nip98Header({
        signEvent: (template) => this.signer.signEvent(template),
        url,
        method,
        body,
      }),
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

  /** Create the store (or open it), with the owner's contact email when given. */
  createStore(email?: string): Promise<StoreView> {
    return email === undefined
      ? this.call<StoreView>('POST', '/v1/admin/store')
      : this.call<StoreView>('POST', '/v1/admin/store', { email });
  }

  /** Set the owner's contact email, or clear it with null. */
  setContactEmail(email: string | null): Promise<StoreView> {
    return this.call<StoreView>('PUT', '/v1/admin/store/contact', { email });
  }

  store(): Promise<StoreView> {
    return this.call<StoreView>('GET', '/v1/admin/store');
  }

  /** Store O-signed events: storing settings never activates a store (6.2). */
  storeEvents(events: NostrEvent[]): Promise<{ stored: string[] }> {
    return this.call('POST', '/v1/admin/store/events', { events });
  }

  /**
   * The owner chooses a plan (6.1): only Free is self-serve. The view after it,
   * active on Free (`activated`), or already active before (`already_active`).
   */
  choosePlan(plan: 'free'): Promise<StoreView & { activation: Activation }> {
    return this.call('POST', '/v1/admin/store/plan', { plan });
  }

  /** What O signed and the server holds for the relay: a store that is not active shows it (7.3). */
  storedEvents(): Promise<StoredEventsRead> {
    return this.call('GET', '/v1/admin/store/events');
  }

  /**
   * The widget bundle's pinned address and integrity. Public, so not signed.
   * The path is checked strictly, as it ends up
   * in an HTML attribute the merchant pastes.
   */
  async pinnedWidget(): Promise<PinnedWidget> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}/v1/widget`, { cache: 'no-store' });
    } catch {
      throw new ApiError(0, 'network');
    }
    const parsed = response.ok ? await readJson(response) : undefined;
    if (
      !isRecord(parsed) ||
      typeof parsed.path !== 'string' ||
      !PINNED_PATH_RE.test(parsed.path) ||
      typeof parsed.integrity !== 'string' ||
      !INTEGRITY_RE.test(parsed.integrity)
    ) {
      throw new ApiError(response.status, 'unexpected');
    }
    // The host it was read from, so the snippet names the server that has this bundle.
    return { src: `${this.base}${parsed.path}`, integrity: parsed.integrity };
  }

  /**
   * Publish only what changed: new and changed products, and the IDs of removed ones. A real
   * write answers 202 with the `syncId` its sync shows under in `GET /store` (`catalogSync`).
   */
  catalog(
    change: { items: readonly CatalogItemInput[]; hide: readonly string[] },
    dryRun: boolean,
  ): Promise<{ diff: SyncDiff; started?: boolean; syncId?: string }> {
    return this.call('POST', '/v1/admin/catalog', {
      mode: 'upsert',
      items: change.items,
      hide: change.hide,
      dryRun,
    });
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

  /** Pause syncing; the connector stays as set up. */
  disableConnector(): Promise<{ connector: ConnectorRecord | null }> {
    return this.call('POST', '/v1/admin/connector/disable');
  }

  rotateAssistant(): Promise<{ nextAssistant: string }> {
    return this.call('POST', '/v1/admin/store/assistant/rotate');
  }

  /**
   * Move the store with owner key `from` to this signer's key (K21): one of
   * the store's sites must name this key. `dryRun` checks all but the site.
   */
  recover(from: string, dryRun = false): Promise<StoreView> {
    return this.call('POST', '/v1/admin/store/recover', { from, ...(dryRun ? { dryRun } : {}) });
  }

  /** The settings the store's previous owner key signed, private part read by the server (K21). */
  movedSettings(): Promise<MovedSettings> {
    return this.call('GET', '/v1/admin/store/moved-settings');
  }
}
