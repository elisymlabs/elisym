/**
 * The buyer's order records for one agent: `<agent dir>/.orders.json`, the
 * MCP's backend for `@elisym/commerce/buyer`'s order store. Every money rule is
 * judged by the core; this file makes each read-judge-write atomic across
 * processes (the lock) and durable (fsync of the file and its directory).
 *
 * A file that cannot be read or validated refuses every operation: it is never
 * treated as empty, and no record is ever dropped silently.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OrderBackend, OrderRecord, StorePinsRecord } from '@elisym/commerce/buyer';
import { ensureGitignoreHasPrivateStateEntries } from '@elisym/sdk/agent-store';
import { z } from 'zod';
import { writeFileDurable } from './durable-storage.js';
import { migrateGitignoreBestEffort } from './gitignore-migration.js';
import { withOrdersLock } from './orders-lock.js';

export const ORDERS_FILENAME = '.orders.json';
export const ORDERS_LOCK_FILENAME = '.orders.lock';
/** Records kept at most; past it only settled records that hold nothing are pruned. */
export const MAX_ORDER_RECORDS = 500;
/** A never-acknowledged order is pruned only once older than this (none still being placed). */
const CREATED_PRUNE_AGE_SECS = 24 * 60 * 60;

const ORDER_STATES = [
  'created',
  'ordered',
  'paying',
  'paid',
  'ended-unpaid',
  'blocked',
  'completed',
  'refunded',
] as const;

/**
 * The fields the store and its rules rely on are checked; the rest of a record
 * (the verified offer, wraps, the marker's details) is kept as written.
 */
const OrderRecordSchema = z
  .object({
    orderId: z.string().min(1).max(200),
    productAddress: z.string().min(1).max(400),
    storePubkey: z.string().regex(/^[0-9a-f]{64}$/),
    buyerSecretKey: z.string().regex(/^[0-9a-f]{64}$/),
    buyerPubkey: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    state: z.enum(ORDER_STATES),
    payout: z.object({ caip19: z.string(), address: z.string() }).passthrough(),
    amount: z.string().regex(/^\d+$/),
    reference: z.string(),
    inboxRelays: z.array(z.string()),
    acknowledgedRelays: z.array(z.string()),
  })
  .passthrough();

const PinsSchema = z
  .object({
    storePubkey: z.string(),
    pinnedOwnerPubkey: z.string(),
    knownPayouts: z.array(z.object({ caip19: z.string(), address: z.string() })),
  })
  .strict();

const OrdersFileSchema = z
  .object({
    version: z.literal(1),
    orders: z.array(OrderRecordSchema),
    stores: z.array(PinsSchema),
  })
  .strict();

interface OrdersFile {
  version: 1;
  orders: OrderRecord[];
  stores: StorePinsRecord[];
}

/** The order file exists but cannot be used: every operation refuses, naming it. */
export class OrdersFileError extends Error {}

export class TooManyOrdersError extends Error {}

export interface FileOrderBackendOptions {
  /**
   * The store opened on storage that makes writes durable (see
   * `judgeStorage`). Then a write whose directory sync is skipped throws: its
   * durability is unknown, and nothing may be broadcast on it.
   */
  durable: boolean;
  /** Seconds, for pruning. */
  now?: () => number;
  /** The durable write (tests replace it). */
  write?: (path: string, content: string) => Promise<boolean>;
}

export class FileOrderBackend implements OrderBackend {
  readonly path: string;
  private readonly lockPath: string;
  private gitignoreDone = false;

  constructor(
    private readonly agentDir: string,
    private readonly options: FileOrderBackendOptions,
  ) {
    this.path = join(agentDir, ORDERS_FILENAME);
    this.lockPath = join(agentDir, ORDERS_LOCK_FILENAME);
  }

  private async load(): Promise<OrdersFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, orders: [], stores: [] };
      }
      throw new OrdersFileError(`cannot read ${this.path}: ${String(error)}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new OrdersFileError(
        `${this.path} is not valid JSON; no order is paid until it is fixed`,
      );
    }
    const parsed = OrdersFileSchema.safeParse(value);
    if (!parsed.success) {
      throw new OrdersFileError(
        `${this.path} does not match the order schema; no order is paid until it is fixed`,
      );
    }
    return parsed.data as unknown as OrdersFile;
  }

  private async save(file: OrdersFile): Promise<void> {
    if (!this.gitignoreDone) {
      // Two directories up from the file is the `.elisym` root, as for the other stores.
      await migrateGitignoreBestEffort('orders', () =>
        ensureGitignoreHasPrivateStateEntries(dirname(this.agentDir)),
      );
      this.gitignoreDone = true;
    }
    const write = this.options.write ?? writeFileDurable;
    const synced = await write(this.path, `${JSON.stringify(file, null, 2)}\n`);
    if (!synced && this.options.durable) {
      throw new OrdersFileError(
        `the directory of ${this.path} could not be synced: whether this write survives a crash is unknown`,
      );
    }
  }

  async read(orderId: string): Promise<OrderRecord | undefined> {
    return (await this.load()).orders.find((record) => record.orderId === orderId);
  }

  async forProduct(productAddress: string): Promise<OrderRecord[]> {
    return (await this.load()).orders.filter((record) => record.productAddress === productAddress);
  }

  /** Every record, for listing. */
  async list(): Promise<OrderRecord[]> {
    return (await this.load()).orders;
  }

  transactProduct<T>(
    productAddress: string,
    fn: (records: readonly OrderRecord[]) => { write?: readonly OrderRecord[]; result: T },
  ): Promise<T> {
    return withOrdersLock(this.lockPath, async () => {
      const file = await this.load();
      const { write, result } = fn(
        file.orders.filter((record) => record.productAddress === productAddress),
      );
      if (write === undefined || write.length === 0) {
        return result;
      }
      const orders = [...file.orders];
      for (const record of write) {
        const index = orders.findIndex((existing) => existing.orderId === record.orderId);
        if (index === -1) {
          orders.push(record);
        } else {
          orders[index] = record;
        }
      }
      await this.save({ ...file, orders: this.capped(orders) });
      return result;
    });
  }

  /**
   * At most `MAX_ORDER_RECORDS`. Past it, only records that hold nothing are
   * pruned, oldest first: `ended-unpaid` ones (settled, excluding nothing) and
   * never-acknowledged `created` ones older than a day. A delivered or
   * refunded record (its delivery, its buyer key) or anything with a live
   * attempt or a payment is never pruned; with nothing to prune, new orders
   * are refused.
   */
  private capped(orders: OrderRecord[]): OrderRecord[] {
    if (orders.length <= MAX_ORDER_RECORDS) {
      return orders;
    }
    const now = (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
    const prunable = orders
      .filter(
        (record) =>
          (record.state === 'ended-unpaid' && record.paidTx === undefined) ||
          (record.state === 'created' && now - record.createdAt > CREATED_PRUNE_AGE_SECS),
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    const excess = orders.length - MAX_ORDER_RECORDS;
    if (prunable.length < excess) {
      throw new TooManyOrdersError(
        `too many orders are open for this agent (${orders.length}); settle some before placing another`,
      );
    }
    const dropped = new Set(prunable.slice(0, excess).map((record) => record.orderId));
    return orders.filter((record) => !dropped.has(record.orderId));
  }

  async readPins(storePubkey: string): Promise<StorePinsRecord | undefined> {
    return (await this.load()).stores.find((pins) => pins.storePubkey === storePubkey);
  }

  transactPins<T>(
    storePubkey: string,
    fn: (pins: StorePinsRecord | undefined) => { write?: StorePinsRecord; result: T },
  ): Promise<T> {
    return withOrdersLock(this.lockPath, async () => {
      const file = await this.load();
      const { write, result } = fn(file.stores.find((pins) => pins.storePubkey === storePubkey));
      if (write === undefined) {
        return result;
      }
      const stores = file.stores.filter((pins) => pins.storePubkey !== storePubkey);
      stores.push(write);
      await this.save({ ...file, stores });
      return result;
    });
  }
}
