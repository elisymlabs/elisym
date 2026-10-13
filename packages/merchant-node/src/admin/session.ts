/**
 * The admin's read session, DOM-free: the local page and the hosted admin both
 * drive it. It holds the store key (zeroed by `close()`), reads the store and
 * its order messages from the relays, and hands back a `Snapshot` to render.
 */
import { type UnwrappedOrderMessage, unwrapOrderMessage } from '@elisym/commerce';
import type { RelayClient } from '@elisym/commerce/buyer';
import type { NostrEvent } from 'nostr-tools';
import { type EventTemplate, finalizeEvent } from 'nostr-tools/pure';
import { type History, buildHistory } from './history';
import type { StoreKey } from './key';
import { type LoadResult, type WrapPool, WrapReader } from './reader';
import {
  type KeptListings,
  type ProductLine,
  type StoreView,
  adminStoreOf,
  hiddenOrders,
  keepWhatWasRead,
  mergeNewestListings,
  namedProducts,
  productLines,
  readAllListings,
  readListings,
  readStore,
  storeRelays,
} from './store';

/** What a session reads through: `pool` must not share connections with `client`. */
export interface SessionDeps {
  client: RelayClient;
  pool: WrapPool;
  now: () => number;
  unwrap?: (wrap: NostrEvent, secretKey: Uint8Array) => UnwrappedOrderMessage | undefined;
}

export interface SessionOptions {
  /** Read every listing of the store too (the hosted admin), not only the ordered ones. */
  readAllListings: boolean;
}

export interface Snapshot {
  storePubkey: string;
  store: StoreView;
  history: History;
  /** The products the loaded orders name. */
  products: ProductLine[];
  /** Every product read so far: only with `readAllListings`. */
  allProducts?: { lines: ProductLine[]; incomplete: boolean };
  warnings: string[];
  /** More history can be loaded. */
  more: boolean;
}

export type Outcome = { ok: true; snapshot: Snapshot } | { ok: false } | 'busy';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameRelays(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((relay) => second.includes(relay));
}

/** What to tell the merchant about the store's own events. */
function storeWarnings(view: StoreView, stale: boolean): string[] {
  return [
    ...(view.noInboxList
      ? [
          'No inbox list (kind 10050) found, or the relays did not answer: reading the default relays instead.',
        ]
      : []),
    ...(stale
      ? [
          'The relays did not answer for the store this time: its inbox relays and payout list are the ones read before.',
        ]
      : []),
  ];
}

interface Opened {
  loaded: StoreView;
  reader: WrapReader;
}

export class AdminSession {
  private busy = false;
  private closed = false;
  private opened: Opened | undefined;
  /** Kept from an earlier read, because the relays did not answer this one. */
  private stale = false;
  /** Every claim-check listing read so far, by product address: never dropped once read. */
  private listings: KeptListings = new Map();
  /** Every listing read so far for the full product list: never dropped once read. */
  private allListings: KeptListings = new Map();
  private allIncomplete = false;

  constructor(
    private readonly deps: SessionDeps,
    private readonly key: StoreKey,
    private readonly options: SessionOptions,
    private readonly onStatus: (text: string) => void,
    private readonly onStore: (view: StoreView) => void,
  ) {}

  /** Read the store and the first page of its order messages. */
  open(): Promise<Outcome> {
    return this.run(() => this.openTask());
  }

  /** Read the store again and the newest order messages; opens when not open yet. */
  refresh(): Promise<Outcome> {
    return this.run(() => (this.opened === undefined ? this.openTask() : this.refreshTask()));
  }

  /** Load older order messages; opens when not open yet. */
  more(): Promise<Outcome> {
    return this.run(() => (this.opened === undefined ? this.openTask() : this.moreTask()));
  }

  /** Zero the key: every later call answers `'busy'`. */
  close(): void {
    this.closed = true;
    this.key.secretKey.fill(0);
  }

  private async run(task: () => Promise<Snapshot>): Promise<Outcome> {
    if (this.busy || this.closed) {
      return 'busy';
    }
    this.busy = true;
    try {
      return { ok: true, snapshot: await task() };
    } catch (error) {
      this.onStatus(`Could not read: ${errorText(error)}`);
      return { ok: false };
    } finally {
      this.busy = false;
    }
  }

  private newReader(relays: readonly string[]): WrapReader {
    const unwrap = this.deps.unwrap ?? unwrapOrderMessage;
    const { secretKey } = this.key;
    return new WrapReader({
      pool: this.deps.pool,
      relays,
      storePubkey: this.key.pubkey,
      auth: async (template: EventTemplate) => finalizeEvent(template, secretKey),
      unwrap: (wrap) => unwrap(wrap, secretKey),
      now: this.deps.now,
    });
  }

  private readView(): Promise<StoreView> {
    this.onStatus('Reading the store...');
    return readStore(this.deps.client, this.key.pubkey, this.deps.now());
  }

  /**
   * The wraps read, alongside the all-listings read when asked: the wraps go
   * through `pool`, the listings through `client`, so they never compete for
   * one relay's subscriptions. The all-listings read is done before the
   * claim-check listings start, which take all of `client`'s subscriptions.
   */
  private async loadWith(loaded: StoreView, load: () => Promise<LoadResult>): Promise<LoadResult> {
    if (!this.options.readAllListings) {
      return load();
    }
    // Both settle before anything else reads through `client`, even when the wraps read fails.
    const [loadOutcome, allOutcome] = await Promise.allSettled([
      load(),
      readAllListings(this.deps.client, storeRelays(loaded), this.key.pubkey),
    ]);
    if (loadOutcome.status === 'rejected') {
      throw loadOutcome.reason;
    }
    if (allOutcome.status === 'rejected') {
      throw allOutcome.reason;
    }
    const result = loadOutcome.value;
    const all = allOutcome.value;
    this.allListings = mergeNewestListings(
      this.allListings,
      all.events,
      this.key.pubkey,
      this.deps.now(),
    );
    this.allIncomplete = all.incomplete;
    return result;
  }

  /**
   * Read the listings the loaded orders name: the ones not read yet, or on
   * Refresh every one (a reprice or a stop must reach the claim check).
   */
  private async readNamed(opened: Opened, everything: boolean): Promise<void> {
    const named = [...namedProducts(opened.reader.messages, this.key.pubkey).keys()];
    const addresses = everything
      ? [...new Set([...this.listings.keys(), ...named])]
      : named.filter((address) => !this.listings.has(address));
    if (addresses.length > 0) {
      this.listings = await readListings(
        this.deps.client,
        storeRelays(opened.loaded),
        this.key.pubkey,
        addresses,
        this.listings,
        this.deps.now(),
      );
    }
  }

  private async openTask(): Promise<Snapshot> {
    const loaded = await this.readView();
    this.onStore(loaded);
    const opened: Opened = { loaded, reader: this.newReader(loaded.relays) };
    this.opened = opened;
    this.onStatus('Reading orders...');
    const result = await this.loadWith(loaded, () => opened.reader.load());
    await this.readNamed(opened, false);
    return this.snapshot(opened, result);
  }

  private async refreshTask(): Promise<Snapshot> {
    const previous = this.opened;
    if (previous === undefined) {
      return this.openTask();
    }
    // Refresh reads the store again too: its listings, payout list or inbox
    // relays may have changed, or not have answered the first time.
    const kept = keepWhatWasRead(previous.loaded, await this.readView());
    this.stale = kept.stale;
    const fresh = kept.view;
    this.onStore(fresh);
    let opened: Opened;
    let result: LoadResult;
    if (sameRelays(fresh.relays, previous.loaded.relays)) {
      opened = { loaded: fresh, reader: previous.reader };
      this.opened = opened;
      result = await this.loadWith(fresh, () => opened.reader.refresh());
    } else {
      opened = { loaded: fresh, reader: this.newReader(fresh.relays) };
      this.opened = opened;
      result = await this.loadWith(fresh, () => opened.reader.load());
    }
    await this.readNamed(opened, true);
    return this.snapshot(opened, result);
  }

  private async moreTask(): Promise<Snapshot> {
    const opened = this.opened;
    if (opened === undefined) {
      return this.openTask();
    }
    const result = await opened.reader.load();
    await this.readNamed(opened, false);
    return this.snapshot(opened, result);
  }

  /** The snapshot of what was read; the final status is its last step, with no await after. */
  private snapshot(opened: Opened, result: LoadResult): Snapshot {
    const { loaded, reader } = opened;
    const storePubkey = this.key.pubkey;
    const hidden = hiddenOrders(namedProducts(reader.messages, storePubkey), this.listings);
    const warnings = [
      ...storeWarnings(loaded, this.stale),
      ...(hidden === 0
        ? []
        : [
            `${hidden} orders name products with no listing found (an unknown product, or the relays did not answer): they are hidden.`,
          ]),
      ...(result.partial.length === 0
        ? []
        : [
            `Partial: these relays were not read through (no answer in time, or a broken relay): ${result.partial.join(', ')}.`,
          ]),
    ];
    let allProducts: Snapshot['allProducts'];
    if (this.options.readAllListings) {
      this.allListings = mergeNewestListings(
        this.allListings,
        [...this.listings.values()],
        storePubkey,
        this.deps.now(),
      );
      allProducts = { lines: productLines(this.allListings), incomplete: this.allIncomplete };
    }
    const snapshot: Snapshot = {
      storePubkey,
      store: loaded,
      history: buildHistory(reader.messages, adminStoreOf(storePubkey, loaded, this.listings)),
      products: productLines(this.listings),
      ...(allProducts === undefined ? {} : { allProducts }),
      warnings,
      more: result.more,
    };
    this.onStatus(
      `Read ${reader.messages.length} order messages from ${loaded.relays.length} relays.`,
    );
    return snapshot;
  }
}
