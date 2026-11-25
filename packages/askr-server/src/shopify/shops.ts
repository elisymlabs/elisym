import {
  KIND_CATALOG_AUTH,
  KIND_CONFIG_DELEGATION,
  isCatalogKey,
  readConfigDelegates,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { type Db, type Queryable, STORES_CHANNEL } from '../db/db';
import type { KeyVault } from '../db/keys';
import { noteOriginsLocked } from '../state/origins';
import { deleteStoreRows, insertStore } from '../state/stores';
import { ShopifyRefused, type ShopTokens } from './client';
import { type DelegateSettings, signDelegateConfig } from './delegate-config';

/** An unfinished onboarding is kept this long, then deleted (plan 3.1). */
export const ONBOARDING_TTL_SECS = 24 * 60 * 60;
/** An access token this close to its expiry is refreshed first. */
export const TOKEN_REFRESH_MARGIN_SECS = 5 * 60;
/** `onboardingEventsRefusal`'s answer for genuine events of an onboarding a later begin replaced. */
export const REPLACED = 'replaced';
/** A grant or authorization from onboarding may be dated at most this far ahead (as intake). */
const MAX_AHEAD_SECS = 10 * 60;

export interface ShopRecord {
  shop: string;
  owner: string | null;
  onboarded: boolean;
  needsReauth: boolean;
  needsRelink: boolean;
  shopId: string | null;
  primaryOrigin: string | null;
  installedAt: number | null;
  uninstalledAt: number | null;
  hasTokens: boolean;
}

interface ShopRow extends Record<string, unknown> {
  shop: string;
  owner: string | null;
  onboarded: boolean;
  needs_reauth: boolean;
  needs_relink: boolean;
  shop_id: string | null;
  primary_origin: string | null;
  installed_at: number | null;
  uninstalled_at: number | null;
  has_tokens: boolean;
}

const SHOP_COLUMNS = `shop, owner, onboarded, needs_reauth, needs_relink, shop_id, primary_origin,
  installed_at, uninstalled_at, (access_token is not null) as has_tokens`;

function shopOf(row: ShopRow): ShopRecord {
  return {
    shop: row.shop,
    owner: row.owner,
    onboarded: row.onboarded,
    needsReauth: row.needs_reauth,
    needsRelink: row.needs_relink,
    shopId: row.shop_id,
    primaryOrigin: row.primary_origin,
    installedAt: row.installed_at,
    uninstalledAt: row.uninstalled_at,
    hasTokens: row.has_tokens,
  };
}

export type BeginResult =
  | { ok: true; catalogKey: string; delegate: string }
  | { ok: false; reason: 'onboarded' | 'owner_taken' };

export type FinishResult =
  | { ok: true; owner: string }
  | {
      ok: false;
      reason: 'onboarded' | 'not_onboarding' | 'expired' | 'replaced' | 'bad_events';
      detail?: string;
    };

/** What the server read about the shop for its first config (plan 3.3). */
export interface ShopInfo {
  /** `https://<primary domain>`. */
  primaryOrigin: string;
  /** `https://<shop>.myshopify.com`. */
  myshopifyOrigin: string;
  name: string;
  currency: string;
  language: string;
  shopId: string;
}

function tagOf(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * Why the two events onboarding's `finish` carries do not authorize exactly K and D (plan 3.3),
 * or undefined when they do: a 30497 for K (`mode hosted`, no expiration) and a 30498 for D, both
 * signed by O, genuine and not dated too far ahead.
 */
export function onboardingEventsRefusal(
  events: readonly NostrEvent[],
  owner: string,
  catalogKey: string,
  delegate: string,
  now: number,
): string | undefined {
  if (events.length !== 2) {
    return 'two events expected';
  }
  for (const event of events) {
    if (!verifyEvent(structuredClone(event))) {
      return 'signature';
    }
  }
  // Genuine, but by another key: a later `begin` replaced this onboarding (plan 3.3).
  if (events.some((event) => event.pubkey !== owner)) {
    return REPLACED;
  }
  for (const event of events) {
    if (event.created_at > now + MAX_AHEAD_SECS) {
      return 'future';
    }
    if (tagOf(event, 'mode') !== 'hosted' || tagOf(event, 'expiration') !== undefined) {
      return 'mode';
    }
  }
  const auth = events.find((event) => event.kind === KIND_CATALOG_AUTH);
  const grant = events.find((event) => event.kind === KIND_CONFIG_DELEGATION);
  if (auth === undefined || tagOf(auth, 'd') !== catalogKey) {
    return 'catalog_auth';
  }
  if (grant === undefined || tagOf(grant, 'd') !== delegate) {
    return 'delegation';
  }
  if (!isCatalogKey([auth], owner, catalogKey, now)) {
    return 'catalog_auth';
  }
  if (!readConfigDelegates([grant], owner, now).includes(delegate)) {
    return 'delegation';
  }
  return undefined;
}

async function insertEvent(tx: Queryable, owner: string, event: NostrEvent): Promise<void> {
  await tx.query(
    'insert into store_events (id, owner, event) values ($1, $2, ($3::text)::jsonb) on conflict do nothing',
    [event.id, owner, JSON.stringify(event)],
  );
}

/**
 * The Shopify side of stores (askr-shopify plan 3): shops, their sealed tokens, onboarding and
 * webhook deliveries. Every change to a store is made here in one transaction with the shop row
 * it belongs to.
 */
export class ShopDirectory {
  constructor(
    private readonly db: Db,
    private readonly vault: KeyVault,
  ) {}

  async shop(shop: string): Promise<ShopRecord | undefined> {
    const [row] = await this.db.query<ShopRow>(
      `select ${SHOP_COLUMNS} from shopify_shops where shop = $1`,
      [shop],
    );
    return row === undefined ? undefined : shopOf(row);
  }

  /** The shop linked to a store, if any. */
  async shopOfOwner(owner: string): Promise<ShopRecord | undefined> {
    const [row] = await this.db.query<ShopRow>(
      `select ${SHOP_COLUMNS} from shopify_shops where owner = $1`,
      [owner],
    );
    return row === undefined ? undefined : shopOf(row);
  }

  /**
   * Store tokens from a token exchange. A shop that had been uninstalled is installed again
   * (plan 3.7): its `via` connector is enabled again; keys and the store stay as they were.
   * Returns whether this was such a reinstall.
   */
  async saveTokens(
    shop: string,
    tokens: ShopTokens,
    now: number,
  ): Promise<{ reinstalled: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.query('insert into shopify_shops (shop) values ($1) on conflict (shop) do nothing', [
        shop,
      ]);
      const [row] = await tx.query<{ owner: string | null; uninstalled_at: number | null }>(
        'select owner, uninstalled_at from shopify_shops where shop = $1 for update',
        [shop],
      );
      await tx.query(
        `update shopify_shops set access_token = $2, refresh_token = $3, token_expires_at = $4,
           scopes = $5, needs_reauth = false, installed_at = coalesce(installed_at, $6),
           uninstalled_at = null
         where shop = $1`,
        [
          shop,
          this.vault.sealText(tokens.accessToken, shop, 'shopify-access'),
          this.vault.sealText(tokens.refreshToken, shop, 'shopify-refresh'),
          tokens.expiresAt,
          tokens.scopes,
          now,
        ],
      );
      const reinstalled = row?.uninstalled_at !== null && row?.uninstalled_at !== undefined;
      if (reinstalled && row?.owner !== null && row?.owner !== undefined) {
        await tx.query(
          `update connectors set enabled = true where owner = $1 and via = 'shopify_app'`,
          [row.owner],
        );
        await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, row.owner]);
      }
      return { reinstalled };
    });
  }

  /**
   * A usable access token for the shop, refreshed under the shop row's lock when it is about to
   * expire (one refresher across instances, plan 3.2). Undefined when the shop has no tokens or
   * needs a new token exchange; a refresh Shopify refuses sets `needs_reauth`. Any other refresh
   * failure throws and is retried later.
   */
  async accessToken(
    shop: string,
    now: number,
    refresh: (refreshToken: string) => Promise<ShopTokens>,
  ): Promise<string | undefined> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<{
        access_token: Uint8Array | null;
        refresh_token: Uint8Array | null;
        token_expires_at: number | null;
        needs_reauth: boolean;
      }>(
        `select access_token, refresh_token, token_expires_at, needs_reauth from shopify_shops
         where shop = $1 for update`,
        [shop],
      );
      if (
        row === undefined ||
        row.needs_reauth ||
        row.access_token === null ||
        row.refresh_token === null
      ) {
        return undefined;
      }
      if ((row.token_expires_at ?? 0) > now + TOKEN_REFRESH_MARGIN_SECS) {
        return this.vault.openText(row.access_token, shop, 'shopify-access');
      }
      let tokens: ShopTokens;
      try {
        tokens = await refresh(this.vault.openText(row.refresh_token, shop, 'shopify-refresh'));
      } catch (error) {
        if (error instanceof ShopifyRefused) {
          await tx.query('update shopify_shops set needs_reauth = true where shop = $1', [shop]);
          return undefined;
        }
        throw error;
      }
      await tx.query(
        `update shopify_shops set access_token = $2, refresh_token = $3, token_expires_at = $4
         where shop = $1`,
        [
          shop,
          this.vault.sealText(tokens.accessToken, shop, 'shopify-access'),
          this.vault.sealText(tokens.refreshToken, shop, 'shopify-refresh'),
          tokens.expiresAt,
        ],
      );
      return tokens.accessToken;
    });
  }

  /**
   * Onboarding's first call (plan 3.3), once O proved itself: a new pending store for O marked
   * as onboarding, with D sealed under O, linked to the shop. The shop's earlier unfinished
   * store is deleted; its tokens stay. Refused when O already is or was a store, or the shop is
   * onboarded.
   */
  async begin(shop: string, owner: string, now: number): Promise<BeginResult> {
    return this.db.transaction(async (tx) => {
      await tx.query('insert into shopify_shops (shop) values ($1) on conflict (shop) do nothing', [
        shop,
      ]);
      const [row] = await tx.query<{ owner: string | null; onboarded: boolean }>(
        'select owner, onboarded from shopify_shops where shop = $1 for update',
        [shop],
      );
      if (row === undefined || row.onboarded) {
        return { ok: false, reason: 'onboarded' };
      }
      const taken = await tx.query(
        `select 1 from stores where owner = $1
         union all select 1 from store_moves where from_owner = $1`,
        [owner],
      );
      if (taken.length > 0) {
        return { ok: false, reason: 'owner_taken' };
      }
      await tx.query('update shopify_shops set owner = null where shop = $1', [shop]);
      if (row.owner !== null) {
        const [earlier] = await tx.query<{ until: number | null }>(
          'select shopify_onboarding_until as until from stores where owner = $1 for update',
          [row.owner],
        );
        if (earlier !== undefined && earlier.until !== null) {
          await deleteStoreRows(tx, row.owner);
        }
      }
      // O was checked above; another request creating it meanwhile rolls this one back.
      if (!(await insertStore(tx, this.vault, owner, now, now + ONBOARDING_TTL_SECS))) {
        throw new Error('the owner key was taken meanwhile');
      }
      const delegateSecret = generateSecretKey();
      const delegate = getPublicKey(delegateSecret);
      const [store] = await tx.query<{ catalog_key: string }>(
        `update stores set config_delegate = $2, config_delegate_secret = $3 where owner = $1
         returning catalog_key`,
        [owner, delegate, this.vault.seal(delegateSecret, owner, 'delegate')],
      );
      await tx.query('update shopify_shops set owner = $2 where shop = $1', [shop, owner]);
      if (store === undefined) {
        throw new Error('the onboarding store was not created');
      }
      return { ok: true, catalogKey: store.catalog_key, delegate };
    });
  }

  /**
   * Onboarding's last call (plan 3.3): O's 30497 for K and 30498 for D are stored, the store
   * leaves onboarding with D active, D signs the first config (the shop's origins, name,
   * currency, language; the shop as connector source) and the `via` connector is created,
   * enabled. All in one transaction with the shop row.
   */
  async finish(
    shop: string,
    events: readonly NostrEvent[],
    info: ShopInfo,
    now: number,
  ): Promise<FinishResult> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<{ owner: string | null; onboarded: boolean }>(
        'select owner, onboarded from shopify_shops where shop = $1 for update',
        [shop],
      );
      if (row === undefined || row.owner === null) {
        return { ok: false, reason: 'not_onboarding' };
      }
      if (row.onboarded) {
        return { ok: false, reason: 'onboarded' };
      }
      const owner = row.owner;
      const [store] = await tx.query<{
        until: number | null;
        assistant: string;
        next_assistant: string | null;
        catalog_key: string;
        config_delegate: string | null;
        config_delegate_secret: Uint8Array | null;
      }>(
        `select shopify_onboarding_until as until, assistant, next_assistant, catalog_key,
           config_delegate, config_delegate_secret
         from stores where owner = $1 for update`,
        [owner],
      );
      if (
        store === undefined ||
        store.until === null ||
        store.config_delegate === null ||
        store.config_delegate_secret === null
      ) {
        return { ok: false, reason: 'not_onboarding' };
      }
      if (store.until < now) {
        return { ok: false, reason: 'expired' };
      }
      const refused = onboardingEventsRefusal(
        events,
        owner,
        store.catalog_key,
        store.config_delegate,
        now,
      );
      if (refused === REPLACED) {
        return { ok: false, reason: 'replaced' };
      }
      if (refused !== undefined) {
        return { ok: false, reason: 'bad_events', detail: refused };
      }
      const origins = [...new Set([info.primaryOrigin, info.myshopifyOrigin])];
      const settings: DelegateSettings = {
        origins,
        linkOrigins: [],
        name: info.name,
        language: info.language,
        currency: info.currency,
      };
      const config = signDelegateConfig({
        settings,
        keys: { assistant: store.next_assistant ?? store.assistant, catalogKey: store.catalog_key },
        shopUrl: info.primaryOrigin,
        createdAt: now,
        delegateSecret: this.vault.open(store.config_delegate_secret, owner, 'delegate'),
      });
      for (const event of [...events, config]) {
        await insertEvent(tx, owner, event);
      }
      // The shop's own origins, read from Shopify by the server, are the store's sites (1.5).
      await noteOriginsLocked(tx, owner, origins, now);
      await tx.query(
        `update stores set delegate_active = true, shopify_onboarding_until = null
         where owner = $1`,
        [owner],
      );
      await tx.query(
        `update shopify_shops set onboarded = true, shop_id = $2, primary_origin = $3
         where shop = $1`,
        [shop, info.shopId, info.primaryOrigin],
      );
      // Not `setConnector`: its upsert starts a connector disabled until a preview.
      await tx.query(
        `insert into connectors (owner, platform, url, currency, import_policies, enabled, via)
         values ($1, 'shopify', $2, $3, true, true, 'shopify_app')`,
        [owner, info.primaryOrigin, info.currency],
      );
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
      return { ok: true, owner };
    });
  }

  /** The sealed D of a store, opened; undefined when it has none. */
  async delegateSecret(owner: string): Promise<Uint8Array | undefined> {
    const [row] = await this.db.query<{ config_delegate_secret: Uint8Array | null }>(
      'select config_delegate_secret from stores where owner = $1',
      [owner],
    );
    const sealed = row?.config_delegate_secret ?? null;
    return sealed === null ? undefined : this.vault.open(sealed, owner, 'delegate');
  }

  /** A store's delegate state: D, whether it is active, and whether onboarding is unfinished. */
  async delegation(owner: string): Promise<
    | {
        delegate: string | null;
        active: boolean;
        onboarding: boolean;
      }
    | undefined
  > {
    const [row] = await this.db.query<{
      config_delegate: string | null;
      delegate_active: boolean;
      shopify_onboarding_until: number | null;
    }>(
      `select config_delegate, delegate_active, shopify_onboarding_until from stores
       where owner = $1`,
      [owner],
    );
    return row === undefined
      ? undefined
      : {
          delegate: row.config_delegate,
          active: row.delegate_active,
          onboarding: row.shopify_onboarding_until !== null,
        };
  }

  /** Whether a store is still in an unfinished Shopify onboarding (refused by the admin API). */
  async onboarding(owner: string): Promise<boolean> {
    const rows = await this.db.query(
      'select 1 from stores where owner = $1 and shopify_onboarding_until is not null',
      [owner],
    );
    return rows.length > 0;
  }

  /**
   * Delete expired unfinished onboardings (plan 3.1): one conditional statement per store, so
   * one that `finish` completes meanwhile is never deleted.
   */
  async expireOnboardings(now: number): Promise<number> {
    const candidates = await this.db.query<{ owner: string }>(
      `select owner from stores
       where shopify_onboarding_until < $1 and status = 'pending' and tier is null`,
      [now],
    );
    let deleted = 0;
    for (const { owner } of candidates) {
      // The shop row first, then the store, as `begin` and `finish` take them: no deadlock.
      const done = await this.db.transaction(async (tx) => {
        await tx.query('select 1 from shopify_shops where owner = $1 for update', [owner]);
        const [expired] = await tx.query<{ owner: string }>(
          `select owner from stores
           where owner = $1 and shopify_onboarding_until < $2 and status = 'pending'
             and tier is null
           for update`,
          [owner, now],
        );
        if (expired === undefined) {
          return false;
        }
        await deleteStoreRows(tx, owner);
        return true;
      });
      deleted += done ? 1 : 0;
    }
    return deleted;
  }

  /** Record a webhook delivery; false when this delivery id was recorded before. */
  async recordWebhook(
    id: string,
    shop: string,
    topic: string,
    payload: unknown,
    now: number,
  ): Promise<boolean> {
    const rows = await this.db.query(
      `insert into shopify_webhooks (id, shop, topic, payload, received_at)
       values ($1, $2, $3, ($4::text)::jsonb, $5) on conflict (id) do nothing returning 1`,
      [id, shop, topic, JSON.stringify(payload ?? null), now],
    );
    return rows.length > 0;
  }

  /**
   * Take the oldest webhook delivery not worked off and not held by another instance, for
   * `holdSecs`; undefined when there is none.
   */
  async claimWebhook(
    now: number,
    holdSecs: number,
  ): Promise<{ id: string; shop: string; topic: string; payload: unknown } | undefined> {
    const [row] = await this.db.query<{
      id: string;
      shop: string;
      topic: string;
      payload: unknown;
    }>(
      `update shopify_webhooks set claimed_until = $1::bigint + $2::bigint
       where id = (select id from shopify_webhooks where done_at is null and claimed_until <= $1
                   order by received_at, id limit 1 for update skip locked)
       returning id, shop, topic, payload`,
      [now, holdSecs],
    );
    return row;
  }

  /** Forget deliveries worked off before `before` (their ids only dedupe redeliveries). */
  async pruneWebhooks(before: number): Promise<void> {
    await this.db.query('delete from shopify_webhooks where done_at < $1', [before]);
  }

  async webhookDone(id: string, now: number): Promise<void> {
    await this.db.query('update shopify_webhooks set done_at = $2 where id = $1', [id, now]);
  }
}
