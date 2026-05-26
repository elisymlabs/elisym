import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createIrohTransport, type IrohBlobTransport } from '../src/transport/iroh';

// Gate on the optional native addon: skip cleanly where it is not installed.
// Mirror the transport's bare -> /index.js fallback (the addon has a non-standard
// package entry that vite-node's loader rejects on the bare specifier).
async function irohAvailable(): Promise<boolean> {
  for (const moduleId of ['@number0/iroh', '@number0/iroh/index.js']) {
    try {
      await import(moduleId);
      return true;
    } catch {
      /* try the next specifier */
    }
  }
  return false;
}
const addonAvailable = await irohAvailable();

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const maybe = addonAvailable ? describe : describe.skip;

maybe('iroh transport (integration)', () => {
  const dirs: string[] = [];
  const transports: IrohBlobTransport[] = [];

  const newStore = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'elisym-iroh-test-'));
    dirs.push(dir);
    return dir;
  };
  const newTransport = (): IrohBlobTransport => {
    const transport = createIrohTransport({ storePath: newStore() });
    transports.push(transport);
    return transport;
  };

  afterAll(async () => {
    // Shut down in parallel: with several tests each spinning up two nodes, a
    // sequential teardown can exceed the default 10s hook timeout.
    await Promise.all(transports.map((transport) => transport.shutdown().catch(() => {})));
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('seeds a file and fetches it by ticket with matching bytes', async () => {
    const seeder = newTransport();
    const getter = newTransport();

    const payload = randomBytes(256 * 1024);
    const srcFile = join(newStore(), 'payload.bin');
    writeFileSync(srcFile, payload);

    const { ticket, size } = await seeder.seedPath(srcFile);
    expect(typeof ticket).toBe('string');
    expect(size).toBe(payload.length);

    const dest = join(newStore(), 'out.bin');
    await getter.fetchToPath(ticket, dest);
    expect(sha256(readFileSync(dest))).toBe(sha256(payload));
  }, 60_000);

  it('re-shares a stored blob into a fresh, fetchable ticket', async () => {
    const seeder = newTransport();
    const getter = newTransport();

    const payload = randomBytes(8 * 1024);
    const srcFile = join(newStore(), 'reshare.bin');
    writeFileSync(srcFile, payload);

    const { ticket } = await seeder.seedPath(srcFile);
    const fresh = await seeder.reShare(ticket);
    expect(typeof fresh).toBe('string');

    const dest = join(newStore(), 'reshare-out.bin');
    await getter.fetchToPath(fresh, dest);
    expect(sha256(readFileSync(dest))).toBe(sha256(payload));
  }, 60_000);

  it('rejects a fetch when the blob exceeds maxBytes', async () => {
    const seeder = newTransport();
    const getter = newTransport();

    const payload = randomBytes(64 * 1024);
    const srcFile = join(newStore(), 'big.bin');
    writeFileSync(srcFile, payload);

    const { ticket } = await seeder.seedPath(srcFile);
    const dest = join(newStore(), 'big-out.bin');
    await expect(getter.fetchToPath(ticket, dest, { maxBytes: 1024 })).rejects.toThrow(
      /MAX_FILE_SIZE/,
    );
  }, 60_000);

  it('round-trips an in-memory buffer via seedBytes -> fetchToBytes', async () => {
    const seeder = newTransport();
    const getter = newTransport();

    const payload = randomBytes(256 * 1024);
    const { ticket, size } = await seeder.seedBytes(payload);
    expect(typeof ticket).toBe('string');
    expect(size).toBe(payload.length);

    const fetched = await getter.fetchToBytes(ticket);
    expect(sha256(Buffer.from(fetched))).toBe(sha256(payload));
  }, 60_000);

  it('round-trips ~1 MiB of UTF-8 text via seedBytes -> fetchToBytes', async () => {
    const seeder = newTransport();
    const getter = newTransport();

    const text = `unicode-é-${'x'.repeat(1024 * 1024)}`;
    const { ticket } = await seeder.seedBytes(Buffer.from(text, 'utf8'));
    const fetched = await getter.fetchToBytes(ticket, { maxBytes: 4 * 1024 * 1024 });
    expect(Buffer.from(fetched).toString('utf8')).toBe(text);
  }, 60_000);

  it('fetchToBytes rejects a blob exceeding maxBytes (before reading into memory)', async () => {
    const seeder = newTransport();
    const getter = newTransport();

    const { ticket } = await seeder.seedBytes(randomBytes(64 * 1024));
    await expect(getter.fetchToBytes(ticket, { maxBytes: 1024 })).rejects.toThrow(/MAX_FILE_SIZE/);
  }, 60_000);
});
