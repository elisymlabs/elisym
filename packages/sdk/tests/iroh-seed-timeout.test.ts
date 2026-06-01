import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../src/constants';
import { createIrohTransport, type IrohModule } from '../src/transport/iroh';

// A fake addon whose add/share never resolve and never invoke their progress
// callback - exactly the native wedge the transport's seed timeout must bound.
// shutdown() resolves so resetNode can tear the wedged node down.
function makeFakeModule(shutdown: () => Promise<void>): { module: IrohModule } {
  const never = () => new Promise<never>(() => {});
  const node = {
    blobs: {
      addFromPath: never,
      addBytes: never,
      share: never,
      download: never,
      export: never,
      readToBytes: never,
      size: never,
      deleteBlob: never,
    },
    node: { shutdown },
  };
  const module = {
    Iroh: { persistent: async () => node },
    SetTagOption: { auto: () => ({}) },
    BlobTicket: {
      fromString: (s: string) => ({
        hash: s,
        format: 'Blob',
        asDownloadOptions: () => ({}),
        toString: () => s,
      }),
    },
  } as unknown as IrohModule;
  return { module };
}

describe('iroh seed timeout + node reset', () => {
  const dirs: string[] = [];

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seedPath rejects after IROH_SEED_TIMEOUT_MS and resets the wedged node', async () => {
    const storePath = mkdtempSync(join(tmpdir(), 'elisym-iroh-timeout-'));
    dirs.push(storePath);

    const shutdown = vi.fn(async () => {});
    const persistent = vi.fn();
    const loadModule = (): Promise<IrohModule> => {
      persistent();
      return Promise.resolve(makeFakeModule(shutdown).module);
    };
    const transport = createIrohTransport({ storePath, loadModule });

    // First seed hangs in the fake addon → the timeout must reject it.
    const seed = transport.seedPath('/tmp/whatever');
    const rejects = expect(seed).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(DEFAULTS.IROH_SEED_TIMEOUT_MS + 10);
    await rejects;

    // The timeout triggered a node reset (best-effort shutdown of the wedged node).
    await vi.advanceTimersByTimeAsync(10);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(persistent).toHaveBeenCalledTimes(1);

    // After the reset, the next seed loads a FRESH node (no duplicate lingered on
    // the locked store during the reset; getNode awaited it).
    const seed2 = transport.seedPath('/tmp/whatever2');
    const rejects2 = expect(seed2).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(DEFAULTS.IROH_SEED_TIMEOUT_MS + 10);
    await rejects2;
    expect(persistent).toHaveBeenCalledTimes(2);
  });
});
