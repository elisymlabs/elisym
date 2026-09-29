import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderStore } from '@elisym/commerce/buyer';
import { describe, expect, it } from 'vitest';
import { orderStoreContract, record } from '../../commerce/tests/buyer/order-store.contract';
import {
  barriersOff,
  judgeDarwin,
  judgeLinux,
  mountOf,
  parseMountinfo,
} from '../src/storage/durable-storage.js';
import {
  breakDeadLock,
  holderIsDead,
  processIdentity,
  withOrdersLock,
} from '../src/storage/orders-lock.js';
import {
  FileOrderBackend,
  MAX_ORDER_RECORDS,
  ORDERS_FILENAME,
  OrdersFileError,
  TooManyOrdersError,
} from '../src/storage/orders.js';

function agentDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'elisym-orders-'));
  const dir = join(root, 'agent');
  require('node:fs').mkdirSync(dir);
  return dir;
}

describe('the MCP order file', () => {
  orderStoreContract(async () => new FileOrderBackend(agentDir(), { durable: false }));

  it('refuses every operation on a file it cannot read, never treating it as empty', async () => {
    const dir = agentDir();
    writeFileSync(join(dir, ORDERS_FILENAME), '{ not json');
    const store = new OrderStore(new FileOrderBackend(dir, { durable: false }));
    await expect(store.get('x')).rejects.toBeInstanceOf(OrdersFileError);
    await expect(store.add(record('x'))).rejects.toBeInstanceOf(OrdersFileError);
    writeFileSync(
      join(dir, ORDERS_FILENAME),
      JSON.stringify({ version: 1, orders: [{}], stores: [] }),
    );
    await expect(store.forProduct('p')).rejects.toBeInstanceOf(OrdersFileError);
    // Untouched: the operator fixes it.
    expect(readFileSync(join(dir, ORDERS_FILENAME), 'utf8')).toContain('"orders"');
  });

  it('throws on durable storage when the directory could not be synced, and not elsewhere', async () => {
    const unsynced = async (path: string, content: string) => {
      writeFileSync(path, content);
      return false;
    };
    const durable = new OrderStore(
      new FileOrderBackend(agentDir(), { durable: true, write: unsynced }),
    );
    await expect(durable.add(record('x'))).rejects.toBeInstanceOf(OrdersFileError);
    const plain = new OrderStore(
      new FileOrderBackend(agentDir(), { durable: false, write: unsynced }),
    );
    await plain.add(record('x'));
    expect((await plain.get('x'))?.orderId).toBe('x');
  });

  it('prunes only records that hold nothing once full, and refuses new orders past that', async () => {
    const dir = agentDir();
    const now = 1_760_000_000;
    const backend = new FileOrderBackend(dir, { durable: false, now: () => now });
    const store = new OrderStore(backend);
    const full = Array.from({ length: MAX_ORDER_RECORDS }, (_, index) =>
      record(`delivered-${index}`, { state: 'completed', createdAt: now - 10_000 + index }),
    );
    full[0] = record('old-ended', { state: 'ended-unpaid', createdAt: now - 5 * 86_400 });
    full[1] = record('old-created', { state: 'created', createdAt: now - 2 * 86_400 });
    writeFileSync(
      join(dir, ORDERS_FILENAME),
      JSON.stringify({ version: 1, orders: full, stores: [] }),
    );
    await store.add(record('new-1', { createdAt: now - 60 }));
    await store.add(record('new-2', { createdAt: now - 59 }));
    const ids = (await backend.list()).map((each) => each.orderId);
    expect(ids).not.toContain('old-ended');
    expect(ids).not.toContain('old-created');
    expect(ids).toContain('new-2');
    expect(ids).toHaveLength(MAX_ORDER_RECORDS);
    // Only delivered records and fresh orders are left: nothing more may go.
    await expect(store.add(record('new-3', { createdAt: now - 58 }))).rejects.toBeInstanceOf(
      TooManyOrdersError,
    );
  });

  it('never prunes a created order younger than a day', async () => {
    const dir = agentDir();
    const now = 1_750_000_000;
    const backend = new FileOrderBackend(dir, { durable: false, now: () => now });
    const full = Array.from({ length: MAX_ORDER_RECORDS }, (_, index) =>
      record(`fresh-${index}`, { state: 'created', createdAt: now - 60 }),
    );
    writeFileSync(
      join(dir, ORDERS_FILENAME),
      JSON.stringify({ version: 1, orders: full, stores: [] }),
    );
    await expect(new OrderStore(backend).add(record('one-more'))).rejects.toBeInstanceOf(
      TooManyOrdersError,
    );
  });
});

describe('which storage makes writes durable', () => {
  const INFO = [
    '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro',
    '40 22 0:40 / /mnt/share rw,relatime shared:2 - nfs4 server:/share rw,vers=4.2',
    '41 22 0:41 / /mnt/my\\040disk rw shared:3 - xfs /dev/sdb1 rw,nobarrier',
    '42 22 0:42 / /data rw shared:4 - f2fs /dev/sdc1 rw,fsync_mode=nobarrier',
    '43 22 0:43 / /home rw shared:5 - btrfs /dev/sdd1 rw',
  ].join('\n');

  it('reads mountinfo, escapes included, and picks the longest mount point', () => {
    const mounts = parseMountinfo(INFO);
    expect(mountOf(mounts, '/mnt/my disk/agent')?.type).toBe('xfs');
    expect(mountOf(mounts, '/home/me/.elisym/agent')?.type).toBe('btrfs');
    expect(mountOf(mounts, '/var/lib/elisym')?.type).toBe('ext4');
    expect(mountOf(mounts, '/mnt/shared')?.type).toBe('ext4');
  });

  it('allows only listed local filesystems with barriers on', () => {
    expect(judgeLinux('Linux version 6.8.0-generic', INFO, '/home/me/.elisym/a').durable).toBe(
      true,
    );
    expect(judgeLinux('Linux version 6.8.0-generic', INFO, '/root/.elisym/a').durable).toBe(true);
    expect(judgeLinux('Linux version 6.8.0-generic', INFO, '/mnt/share/a')).toMatchObject({
      durable: false,
    });
    expect(judgeLinux('Linux version 6.8.0-generic', INFO, '/mnt/my disk/a')).toMatchObject({
      durable: false,
    });
    expect(judgeLinux('Linux version 6.8.0-generic', INFO, '/data/a')).toMatchObject({
      durable: false,
    });
    expect(barriersOff(['rw', 'barrier=0'])).toBe(true);
    expect(barriersOff(['rw', 'barrier=1'])).toBe(false);
  });

  it('refuses desktop VMs whatever their filesystem', () => {
    for (const kernel of [
      'Linux version 6.10.14-linuxkit',
      'Linux version 5.15.153.1-microsoft-standard-WSL2',
      'Linux version 6.7.12-orbstack-00202',
    ]) {
      expect(judgeLinux(kernel, INFO, '/home/me/a')).toMatchObject({ durable: false });
    }
  });

  it('allows only local APFS or HFS volumes on macOS', () => {
    const mount = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
      '//me@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)',
      '/dev/disk4s1 on /Volumes/USB (exfat, local, nodev, nosuid)',
    ].join('\n');
    expect(judgeDarwin(mount, '/System/Volumes/Data/Users/me/.elisym/a').durable).toBe(true);
    expect(judgeDarwin(mount, '/Volumes/share/a')).toMatchObject({ durable: false });
    expect(judgeDarwin(mount, '/Volumes/USB/a')).toMatchObject({ durable: false });
    const remote = '/dev/disk9s1 on /Volumes/Remote (apfs, nodev, nosuid)';
    expect(judgeDarwin(remote, '/Volumes/Remote/a')).toMatchObject({ durable: false });
  });
});

describe('the order file lock', () => {
  it('judges a holder dead only on the same host, boot and pid namespace', async () => {
    const me = await processIdentity();
    const base = { token: 't', ...me };
    expect(holderIsDead({ ...base, pid: 2 ** 22 }, me, new Set())).toBe(true);
    expect(holderIsDead({ ...base, pid: 2 ** 22, host: 'other' }, me, new Set())).toBe(false);
    expect(holderIsDead({ ...base, pid: 2 ** 22, bootId: 'other' }, me, new Set())).toBe(false);
    expect(holderIsDead({ ...base, pid: 2 ** 22, pidNs: 'other' }, me, new Set())).toBe(false);
    expect(holderIsDead({ ...base, pid: process.ppid }, me, new Set())).toBe(false);
    // This very pid, under a token this process does not hold: a restarted container.
    expect(holderIsDead({ ...base, pid: process.pid }, me, new Set())).toBe(true);
    expect(holderIsDead({ ...base, pid: process.pid }, me, new Set(['t']))).toBe(false);
  });

  it('breaks only the lock it judged dead, never one taken since', async () => {
    const dir = agentDir();
    const lock = join(dir, '.orders.lock');
    const me = await processIdentity();
    // Another breaker got there first: the lock now holds a new, live token.
    writeFileSync(lock, JSON.stringify({ token: 'taken-since', ...me }));
    await breakDeadLock(lock, 'dead', Date.now() + 1_000);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('taken-since');
    expect(existsSync(`${lock}.break`)).toBe(false);
  });

  it('queues calls in one process', async () => {
    const lock = join(agentDir(), '.orders.lock');
    const events: string[] = [];
    await Promise.all(
      [1, 2, 3].map((index) =>
        withOrdersLock(lock, async () => {
          events.push(`in-${index}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push(`out-${index}`);
        }),
      ),
    );
    expect(events).toEqual(['in-1', 'out-1', 'in-2', 'out-2', 'in-3', 'out-3']);
  });

  it("breaks a dead holder's lock once, and never a live one", async () => {
    const dir = agentDir();
    const lock = join(dir, '.orders.lock');
    const me = await processIdentity();
    writeFileSync(lock, JSON.stringify({ token: 'dead', ...me, pid: 2 ** 22 }));
    expect(await withOrdersLock(lock, async () => 'ran')).toBe('ran');
    writeFileSync(lock, JSON.stringify({ token: 'live', ...me, pid: process.ppid }));
    const started = Date.now();
    await expect(withOrdersLock(lock, async () => 'ran')).rejects.toThrow('locked by process');
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('live');
  }, 15_000);

  it('fails closed on a stale break guard, and waits out a fresh one', async () => {
    const dir = agentDir();
    const lock = join(dir, '.orders.lock');
    const me = await processIdentity();
    writeFileSync(lock, JSON.stringify({ token: 'dead', ...me, pid: 2 ** 22 }));
    const guard = `${lock}.break`;
    writeFileSync(guard, '1');
    const old = new Date(Date.now() - 60_000);
    require('node:fs').utimesSync(guard, old, old);
    await expect(withOrdersLock(lock, async () => 'ran')).rejects.toThrow('stale lock guard');
    // A fresh guard (another breaker at work) is waited for.
    writeFileSync(guard, '1');
    setTimeout(() => require('node:fs').unlinkSync(guard), 200);
    expect(await withOrdersLock(lock, async () => 'ran')).toBe('ran');
  }, 15_000);

  it('gives one winner when two processes race to mark one order', async () => {
    const dir = agentDir();
    const script = join(__dirname, 'fixtures', 'orders-race-child.ts');
    const orders = join(dir, ORDERS_FILENAME);
    writeFileSync(
      orders,
      JSON.stringify({
        version: 1,
        orders: [record('race', { state: 'ordered', version: 2, paymentRequest: '{}' })],
        stores: [],
      }),
    );
    const runOne = (attempt: string) =>
      new Promise<{ ok: boolean; reason?: string }>((resolve, reject) => {
        const child = spawn('bun', [script, dir, attempt], { cwd: join(__dirname, '..') });
        let out = '';
        child.stdout.on('data', (chunk) => (out += String(chunk)));
        child.on('error', reject);
        let err = '';
        child.stderr.on('data', (chunk) => (err += String(chunk)));
        child.on('close', () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(new Error(`child failed: ${err}`));
          }
        });
      });
    const results = await Promise.all([runOne('a'), runOne('b')]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)[0]?.reason).toBe('conflict');
    const stored = JSON.parse(readFileSync(orders, 'utf8')).orders[0];
    expect(stored.state).toBe('paying');
    expect(stored.version).toBe(3);
  }, 30_000);
});
