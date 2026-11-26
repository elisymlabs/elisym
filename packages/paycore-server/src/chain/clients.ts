/**
 * The chain clients every store of the process shares: one per operator RPC
 * URL, each behind that URL's rate limiter. A limiter queues a request until
 * the RPC's budget allows it and never fails one. The EVM client's request
 * timeout starts only once the request leaves the queue (the Solana transport
 * has none of its own), but a caller's deadline set around the whole call
 * covers the queue wait too: merchant-node `TreasuryReader.refresh` races
 * `FEE_CONFIG_READ_TIMEOUT_MS` from before the genesis and config reads take
 * their tokens, so a long queue would make a fee config read `unreachable`:
 * the fee config is read through `fee(url)`, a client with a bucket of its
 * own (`FEE_RPC_RATE_LIMIT`), so the stores' sweeps never hold it (load test,
 * sub-plan step 20). A URL thus carries its own limit plus the fee bucket's.
 */
import { type Eip1193Client, createJsonRpcClient } from '@elisym/pay-core/evm';
import {
  type Rpc,
  type RpcResponse,
  type RpcTransport,
  type SolanaRpcApi,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
} from '@solana/kit';

export interface RateLimit {
  requestsPerSecond: number;
  /** Requests that may go at once after a quiet spell. Default: `requestsPerSecond`. */
  burst?: number;
}

export const DEFAULT_RPC_RATE_LIMIT: RateLimit = { requestsPerSecond: 10 };
/**
 * The fee config bucket of a URL, whatever the URL's own limit: a read is two
 * calls (genesis, config account) about once a minute per network, so 2/s
 * lets a read through at once and adds little to what the URL carries.
 */
export const FEE_RPC_RATE_LIMIT: RateLimit = { requestsPerSecond: 2 };

/**
 * A token bucket that queues: `take` resolves, in call order, once a token is
 * free. The waiting queue has no bound and no deadline.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private readonly waiting: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly ratePerMs: number;
  private readonly burst: number;

  constructor(
    limit: RateLimit,
    private readonly clock: () => number = Date.now,
  ) {
    if (!(limit.requestsPerSecond > 0)) {
      throw new Error(
        `a rate limit needs requestsPerSecond above 0, got ${limit.requestsPerSecond}`,
      );
    }
    this.ratePerMs = limit.requestsPerSecond / 1000;
    this.burst = Math.max(1, limit.burst ?? limit.requestsPerSecond);
    this.tokens = this.burst;
    this.updatedAt = clock();
  }

  /** Requests waiting for a token now. */
  get queued(): number {
    return this.waiting.length;
  }

  take(): Promise<void> {
    this.refill();
    if (this.waiting.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.schedule();
    });
  }

  private refill(): void {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerMs);
    this.updatedAt = now;
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      return;
    }
    const waitMs = Math.max(0, Math.ceil((1 - this.tokens) / this.ratePerMs));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.release();
    }, waitMs);
    this.timer.unref();
  }

  private release(): void {
    this.refill();
    while (this.tokens >= 1) {
      const next = this.waiting.shift();
      if (next === undefined) {
        break;
      }
      this.tokens -= 1;
      next();
    }
    if (this.waiting.length > 0) {
      this.schedule();
    }
  }
}

export interface ChainClientsOptions {
  /** The limit of an RPC URL without its own entry in `limits`. */
  defaultLimit?: RateLimit;
  /** Per RPC URL limits (the operator's plan with that provider). */
  limits?: ReadonlyMap<string, RateLimit>;
  clock?: () => number;
  /** Builds the raw transports (tests pass fakes). */
  solanaTransportFor?: (url: string) => RpcTransport;
  evmClientFor?: (url: string) => Eip1193Client;
}

/**
 * One client per operator RPC URL and kind, made on first use. The limiter is
 * per URL: a URL serving several kinds (or several stores) shares one budget.
 */
export class ChainClients {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly solanaClients = new Map<string, Rpc<SolanaRpcApi>>();
  private readonly feeClients = new Map<string, Rpc<SolanaRpcApi>>();
  private readonly tempoClients = new Map<string, Eip1193Client>();
  private readonly evmClients = new Map<string, Eip1193Client>();

  constructor(private readonly options: ChainClientsOptions = {}) {}

  /** The Solana RPC client of `url` (the rail's RPC, or a fee config RPC). */
  solana(url: string): Rpc<SolanaRpcApi> {
    return this.solanaClient(this.solanaClients, url, this.bucketFor(url));
  }

  /**
   * The fee config's client of `url`: behind a bucket of its own
   * (`FEE_RPC_RATE_LIMIT`), apart from the stores' traffic even when `url` is
   * also a Solana rail's RPC. Its reads are about one per network a minute,
   * inside `FEE_CONFIG_READ_TIMEOUT_MS`.
   */
  fee(url: string): Rpc<SolanaRpcApi> {
    return this.solanaClient(this.feeClients, url, this.feeBucketFor(url));
  }

  /** The Tempo client of `url`, for `StoreNodeDeps.tempoClient`. */
  tempo(url: string): Eip1193Client {
    return this.eip1193(this.tempoClients, url);
  }

  /** The Ethereum / Arbitrum / Base client of `url`, for `eip3009ContextsFor`'s `clientFor`. */
  evm(url: string): Eip1193Client {
    return this.eip1193(this.evmClients, url);
  }

  /** The limiter of `url` (made on first use). */
  bucketFor(url: string): TokenBucket {
    return this.bucket(
      `rpc:${url}`,
      this.options.limits?.get(url) ?? this.options.defaultLimit ?? DEFAULT_RPC_RATE_LIMIT,
    );
  }

  /** The fee config's own limiter of `url` (made on first use): `FEE_RPC_RATE_LIMIT`. */
  feeBucketFor(url: string): TokenBucket {
    return this.bucket(`fee:${url}`, FEE_RPC_RATE_LIMIT);
  }

  private bucket(key: string, limit: RateLimit): TokenBucket {
    const known = this.buckets.get(key);
    if (known !== undefined) {
      return known;
    }
    const bucket = new TokenBucket(limit, this.options.clock);
    this.buckets.set(key, bucket);
    return bucket;
  }

  private solanaClient(
    cache: Map<string, Rpc<SolanaRpcApi>>,
    url: string,
    bucket: TokenBucket,
  ): Rpc<SolanaRpcApi> {
    const known = cache.get(url);
    if (known !== undefined) {
      return known;
    }
    const inner = this.options.solanaTransportFor?.(url) ?? createDefaultRpcTransport({ url });
    const client = createSolanaRpcFromTransport(limitedTransport(inner, bucket));
    cache.set(url, client);
    return client;
  }

  private eip1193(cache: Map<string, Eip1193Client>, url: string): Eip1193Client {
    const known = cache.get(url);
    if (known !== undefined) {
      return known;
    }
    const inner = this.options.evmClientFor?.(url) ?? createJsonRpcClient(url);
    const client = limitedClient(inner, this.bucketFor(url));
    cache.set(url, client);
    return client;
  }
}

function limitedTransport(inner: RpcTransport, bucket: TokenBucket): RpcTransport {
  return async <TResponse>(
    request: Parameters<RpcTransport>[0],
  ): Promise<RpcResponse<TResponse>> => {
    await bucket.take();
    return await inner<TResponse>(request);
  };
}

function limitedClient(inner: Eip1193Client, bucket: TokenBucket): Eip1193Client {
  return {
    request: async (args) => {
      await bucket.take();
      return await inner.request(args);
    },
  };
}
