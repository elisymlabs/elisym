/**
 * Node-only iroh blob transport: seed a file as a content-addressed blob and
 * fetch one by ticket, streaming to/from disk. Import from `@elisym/sdk/node`.
 *
 * `@number0/iroh` is an OPTIONAL native (napi) dependency, loaded via dynamic
 * `import()` only on first use, so the SDK installs and runs without it (file
 * transfer is simply unavailable). To stay decoupled from the optional addon's
 * type surface (and its `const enum`s), the binding is accessed through the
 * minimal local interface below; enum parameters are passed as their runtime
 * string values, which is what the napi layer expects.
 */
import { LIMITS, DEFAULTS } from '../constants';

/** Streamed add-progress (subset). `found` carries the byte size; `allDone` the hash. */
interface IrohAddProgress {
  found?: { size: bigint };
  allDone?: { hash: string; format: string };
}

/** Streamed download-progress (subset). `found.size` is the BLAKE3-verified total. */
interface IrohDownloadProgress {
  found?: { size: bigint };
  progress?: { offset: bigint };
  allDone?: { bytesWritten: bigint };
}

interface IrohTicket {
  hash: string;
  format: string;
  asDownloadOptions(): unknown;
  toString(): string;
}

interface IrohBlobs {
  addFromPath(
    path: string,
    inPlace: boolean,
    tag: unknown,
    wrap: { wrap: boolean },
    cb: (err: Error | null, progress: IrohAddProgress) => void,
  ): Promise<void>;
  addBytes(bytes: number[]): Promise<{ hash: string; format: string; size: bigint }>;
  share(hash: string, blobFormat: string, addrInfoOptions: string): Promise<IrohTicket>;
  download(
    hash: string,
    opts: unknown,
    cb: (err: Error | null, progress: IrohDownloadProgress) => void,
  ): Promise<void>;
  export(hash: string, destination: string, format: string, mode: string): Promise<void>;
  readToBytes(hash: string): Promise<number[]>;
  size(hash: string): Promise<bigint>;
  deleteBlob(hash: string): Promise<void>;
}

interface IrohNode {
  blobs: IrohBlobs;
  node: { shutdown(): Promise<void> };
}

export interface IrohModule {
  Iroh: { persistent(path: string): Promise<IrohNode> };
  SetTagOption: { auto(): unknown };
  BlobTicket: { fromString(ticket: string): IrohTicket };
}

/** Outcome of seeding a file: a shareable ticket plus the blob's byte size. */
export interface SeedResult {
  ticket: string;
  size: number;
}

export interface FetchOptions {
  /** Hard cap on the BLAKE3-verified blob size; defaults to `LIMITS.MAX_FILE_SIZE`. */
  maxBytes?: number;
  /** Per-fetch timeout; defaults to `DEFAULTS.IROH_FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Abort the JS wait early (e.g. on shutdown). NOTE: the napi binding has no mid-transfer
   * cancel, so this abandons the await - freeing the caller - while the native transfer
   * self-terminates in the background, exactly like the `timeoutMs` path.
   */
  signal?: AbortSignal;
}

/**
 * Node-to-node blob transport. Files move path-based (streamed to/from disk),
 * never buffered whole in memory.
 */
export interface IrohBlobTransport {
  /** Add a file to the local store and return a shareable ticket + its byte size. */
  seedPath(path: string): Promise<SeedResult>;
  /** Add an in-memory buffer to the local store (e.g. large inline text). */
  seedBytes(bytes: Uint8Array): Promise<SeedResult>;
  /** Download a blob by ticket and export it to `dest`, bounded by size + timeout. */
  fetchToPath(ticket: string, dest: string, options?: FetchOptions): Promise<void>;
  /**
   * Download a blob by ticket and return it as bytes, bounded by size + timeout.
   * The whole blob is held in memory, so callers MUST pass a tight `maxBytes`
   * (e.g. `LIMITS.MAX_REINLINE_TEXT_BYTES`) - the cap is enforced on the
   * BLAKE3-verified size BEFORE the blob is read into memory.
   */
  fetchToBytes(ticket: string, options?: FetchOptions): Promise<Uint8Array>;
  /** Re-share an already-stored blob to mint a fresh ticket (e.g. after a restart). */
  reShare(ticket: string): Promise<string>;
  /** Shut the node down, releasing the fs-store lock. Safe if the node was never created. */
  shutdown(): Promise<void>;
}

export interface CreateIrohTransportOptions {
  /** Directory for the persistent fs-store (e.g. `<agent-dir>/.iroh/`). */
  storePath: string;
  /**
   * Test seam: override how the native addon is loaded. Defaults to the real
   * dynamic `import('@number0/iroh')`. Production code never sets this.
   */
  loadModule?: () => Promise<IrohModule>;
}

const ADDR_INFO_RELAY_AND_ADDRESSES = 'RelayAndAddresses';
const EXPORT_FORMAT_BLOB = 'Blob';
const EXPORT_MODE_COPY = 'Copy';

// Specifiers are passed through variables so bundlers (Vite/esbuild) leave the
// dynamic import for the Node loader at runtime - we never want the native addon
// bundled. The published `package.json` has a non-standard `main`: Node's CJS
// loader falls back to `index.js`, but stricter loaders (e.g. vite-node under the
// test runner) do not, so we fall back to the explicit `/index.js` subpath.
const IROH_MODULE_IDS = ['@number0/iroh', '@number0/iroh/index.js'];

async function loadIrohModule(): Promise<IrohModule> {
  let lastError: unknown;
  for (const moduleId of IROH_MODULE_IDS) {
    try {
      return (await import(moduleId)) as unknown as IrohModule;
    } catch (cause) {
      lastError = cause;
    }
  }
  throw new Error(
    'iroh file transfer is unavailable: the optional @number0/iroh native addon is not installed.',
    { cause: lastError },
  );
}

/** Thrown when a bounded iroh op exceeds its deadline (distinct so callers can react). */
export class IrohTimeoutError extends Error {}

function rejectAfter(
  timeoutMs: number,
  label: string,
): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new IrohTimeoutError(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Thrown when a bounded iroh op is abandoned via an AbortSignal (distinct from timeout). */
class IrohAbortError extends Error {}

/**
 * Race partner that rejects when `signal` aborts. Returns `promise: undefined` when no
 * signal is given (caller omits it from the race - no dangling promise). `cancel()`
 * detaches the listener and is safe to call when none was attached.
 */
function rejectOnAbort(signal: AbortSignal | undefined): {
  promise: Promise<never> | undefined;
  cancel: () => void;
} {
  if (signal === undefined) {
    return { promise: undefined, cancel: () => {} };
  }
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new IrohAbortError('iroh fetch aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, cancel: () => signal.removeEventListener('abort', onAbort) };
}

/**
 * Create a lazily-initialized iroh transport bound to a persistent fs-store.
 * The node (and the native addon import) is created on first use and shared
 * single-flight across concurrent callers.
 */
export function createIrohTransport(options: CreateIrohTransportOptions): IrohBlobTransport {
  let nodePromise: Promise<{ module: IrohModule; node: IrohNode }> | null = null;
  // Set while a node teardown-and-recreate is in flight. `getNode` awaits it so no
  // caller spins up a SECOND `Iroh.persistent` on the still-locked fs-store mid-reset.
  let resetPromise: Promise<void> | null = null;

  // Tear the shared node down so the next `getNode` recreates a fresh one - the
  // automatic equivalent of a manual agent restart when a native call wedges the
  // node. Single-flight; `nodePromise` is nulled SYNCHRONOUSLY (no await before
  // `resetPromise` is assigned) so a concurrent `getNode` either awaits the reset or
  // sees a fresh node, never a null+no-reset gap that would create a duplicate node.
  const resetNode = (): Promise<void> => {
    if (resetPromise) {
      return resetPromise;
    }
    const pending = nodePromise;
    nodePromise = null;
    const running = (async () => {
      if (!pending) {
        return;
      }
      const loaded = await pending.catch(() => null);
      if (!loaded) {
        return;
      }
      // A wedged node's shutdown may itself hang, so bound it; recreate regardless.
      const timeout = rejectAfter(DEFAULTS.IROH_SEED_TIMEOUT_MS, 'iroh node shutdown');
      try {
        await Promise.race([loaded.node.node.shutdown(), timeout.promise]);
      } catch {
        // ignore - we proceed to recreate on the next getNode either way
      } finally {
        timeout.cancel();
      }
    })();
    resetPromise = running.finally(() => {
      resetPromise = null;
    });
    return resetPromise;
  };

  const getNode = async (): Promise<{ module: IrohModule; node: IrohNode }> => {
    // Wait out any in-flight reset before checking/creating the node.
    if (resetPromise) {
      await resetPromise;
    }
    if (!nodePromise) {
      const pending = (async () => {
        const module = await (options.loadModule ?? loadIrohModule)();
        const node = await module.Iroh.persistent(options.storePath);
        return { module, node };
      })();
      nodePromise = pending;
      // Never cache a rejection: a failed node creation (e.g. another process is
      // briefly holding the fs-store lock) must not permanently disable the
      // transport. Clear it so the next call retries; concurrent in-flight callers
      // still share this single attempt.
      pending.catch(() => {
        if (nodePromise === pending) {
          nodePromise = null;
        }
      });
    }
    return nodePromise;
  };

  // Bound a seed/share op so a wedged native call surfaces as a thrown error
  // instead of an indefinite hang. On TIMEOUT (only - not ordinary errors, which
  // would thrash the node) reset the node so the next op gets a fresh one.
  const withSeedTimeout = async <T>(label: string, op: () => Promise<T>): Promise<T> => {
    const timeout = rejectAfter(DEFAULTS.IROH_SEED_TIMEOUT_MS, label);
    try {
      return await Promise.race([op(), timeout.promise]);
    } catch (error) {
      if (error instanceof IrohTimeoutError) {
        void resetNode();
      }
      throw error;
    } finally {
      timeout.cancel();
    }
  };

  const seedPath = (path: string): Promise<SeedResult> =>
    withSeedTimeout('iroh seed (path)', async () => {
      const { module, node } = await getNode();
      let size = 0;
      const outcome = await new Promise<{ hash: string; format: string }>((resolve, reject) => {
        node.blobs
          .addFromPath(
            path,
            false,
            module.SetTagOption.auto(),
            { wrap: false },
            (err, progress) => {
              if (err !== null) {
                reject(err);
                return;
              }
              if (progress.found !== undefined) {
                size = Number(progress.found.size);
              }
              if (progress.allDone !== undefined) {
                resolve(progress.allDone);
              }
            },
          )
          .catch(reject);
      });
      const ticket = await node.blobs.share(
        outcome.hash,
        outcome.format,
        ADDR_INFO_RELAY_AND_ADDRESSES,
      );
      return { ticket: ticket.toString(), size };
    });

  const seedBytes = (bytes: Uint8Array): Promise<SeedResult> =>
    withSeedTimeout('iroh seed (bytes)', async () => {
      const { node } = await getNode();
      const outcome = await node.blobs.addBytes(Array.from(bytes));
      const ticket = await node.blobs.share(
        outcome.hash,
        outcome.format,
        ADDR_INFO_RELAY_AND_ADDRESSES,
      );
      return { ticket: ticket.toString(), size: Number(outcome.size) };
    });

  // Download a blob by ticket, enforcing the size cap on the BLAKE3-verified
  // total and a per-fetch timeout, deleting any (partial) blob on failure.
  // Returns the node + hash so the caller can export to disk or read to memory.
  const downloadBounded = async (
    ticketStr: string,
    fetchOptions: FetchOptions | undefined,
  ): Promise<{ node: IrohNode; hash: string }> => {
    const { module, node } = await getNode();
    const maxBytes = fetchOptions?.maxBytes ?? LIMITS.MAX_FILE_SIZE;
    const timeoutMs = fetchOptions?.timeoutMs ?? DEFAULTS.IROH_FETCH_TIMEOUT_MS;
    const ticket = module.BlobTicket.fromString(ticketStr);
    const hash = ticket.hash;

    const timeout = rejectAfter(timeoutMs, 'iroh fetch');
    const abort = rejectOnAbort(fetchOptions?.signal);
    try {
      const downloadPromise = new Promise<void>((resolve, reject) => {
        node.blobs
          .download(hash, ticket.asDownloadOptions(), (err, progress) => {
            if (err !== null) {
              reject(err);
              return;
            }
            // Enforce on the BLAKE3-verified size, never the descriptor's claim.
            if (progress.found !== undefined && Number(progress.found.size) > maxBytes) {
              reject(
                new Error(`file exceeds MAX_FILE_SIZE: ${progress.found.size} > ${maxBytes} bytes`),
              );
              return;
            }
            if (progress.progress !== undefined && Number(progress.progress.offset) > maxBytes) {
              reject(new Error(`file exceeds MAX_FILE_SIZE during transfer (> ${maxBytes} bytes)`));
              return;
            }
            if (progress.allDone !== undefined) {
              resolve();
            }
          })
          .catch(reject);
      });
      // The abort racer is only added when a signal was supplied, so the common
      // (no-signal) path never allocates a dangling promise.
      const racers: Promise<unknown>[] = [timeout.promise, downloadPromise];
      if (abort.promise !== undefined) {
        racers.push(abort.promise);
      }
      await Promise.race(racers);
    } catch (error) {
      // Best-effort reclaim of any (partial) data for the rejected blob. The napi
      // binding exposes no mid-transfer cancel, so an oversized (or aborted) transfer may
      // finish in the background before this runs; the cap still prevents the caller from
      // exporting/using it, and this keeps the store from retaining it.
      await node.blobs.deleteBlob(hash).catch(() => {});
      throw error;
    } finally {
      timeout.cancel();
      abort.cancel();
    }
    // Re-check the verified size against the cap. The progress-callback guard
    // above only fires while bytes transfer; a blob ALREADY resident in the local
    // store completes via `allDone` alone (no `found`/`progress`), so without this
    // an oversized resident blob would slip past the cap before `readToBytes`
    // pulls it into memory. `blobs.size` reports the BLAKE3-verified total.
    const verifiedSize = Number(await node.blobs.size(hash));
    if (verifiedSize > maxBytes) {
      await node.blobs.deleteBlob(hash).catch(() => {});
      throw new Error(`file exceeds MAX_FILE_SIZE: ${verifiedSize} > ${maxBytes} bytes`);
    }
    return { node, hash };
  };

  const fetchToPath = async (
    ticketStr: string,
    dest: string,
    fetchOptions?: FetchOptions,
  ): Promise<void> => {
    const { node, hash } = await downloadBounded(ticketStr, fetchOptions);
    await node.blobs.export(hash, dest, EXPORT_FORMAT_BLOB, EXPORT_MODE_COPY);
  };

  const fetchToBytes = async (
    ticketStr: string,
    fetchOptions?: FetchOptions,
  ): Promise<Uint8Array> => {
    const { node, hash } = await downloadBounded(ticketStr, fetchOptions);
    // The cap was enforced on the verified size during download, so reading the
    // whole blob into memory here is bounded by the caller's maxBytes.
    const bytes = await node.blobs.readToBytes(hash);
    return Uint8Array.from(bytes);
  };

  const reShare = (ticketStr: string): Promise<string> =>
    withSeedTimeout('iroh re-share', async () => {
      const { module, node } = await getNode();
      const ticket = module.BlobTicket.fromString(ticketStr);
      const fresh = await node.blobs.share(
        ticket.hash,
        ticket.format,
        ADDR_INFO_RELAY_AND_ADDRESSES,
      );
      return fresh.toString();
    });

  const shutdown = async (): Promise<void> => {
    if (!nodePromise) {
      return;
    }
    const pending = nodePromise;
    nodePromise = null;
    const loaded = await pending.catch(() => null);
    if (loaded) {
      await loaded.node.node.shutdown();
    }
  };

  return { seedPath, seedBytes, fetchToPath, fetchToBytes, reShare, shutdown };
}
