/**
 * The lock that makes one read-judge-write of the order file atomic across
 * processes (two MCP clients on one agent). Held for milliseconds, never across
 * network I/O. A lock is broken only when its holder is provably dead on this
 * very host, boot and pid namespace; everything else waits, then fails with a
 * message naming the file.
 */
import { randomBytes } from 'node:crypto';
import { readFile, readlink, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname, uptime } from 'node:os';

/** How long a call waits for a live holder before it gives up. */
export const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
/** A break guard older than this was left by a breaker that died. */
export const BREAK_GUARD_STALE_MS = 30_000;

export interface LockIdentity {
  token: string;
  pid: number;
  host: string;
  bootId: string;
  pidNs: string;
}

export class OrdersLockedError extends Error {}

async function linuxBootId(): Promise<string | undefined> {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    return undefined;
  }
}

async function pidNamespace(): Promise<string> {
  try {
    return await readlink('/proc/self/ns/pid');
  } catch {
    return '';
  }
}

/**
 * This process's identity. Where no boot id exists, the boot time to the
 * minute stands in: two processes may round differently, which only means a
 * lock is not broken (safe), never that a live one is.
 */
export async function processIdentity(): Promise<Omit<LockIdentity, 'token'>> {
  const boot = (await linuxBootId()) ?? String(Math.round((Date.now() - uptime() * 1000) / 60_000));
  return { pid: process.pid, host: hostname(), bootId: boot, pidNs: await pidNamespace() };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, owned by someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Whether the lock `held` belongs to a process that is gone, judged by `me`:
 * only on the same host, boot and pid namespace; there, a pid that no longer
 * exists, or this very pid under a token this process does not hold (a
 * restarted container reusing pid 1).
 */
export function holderIsDead(
  held: LockIdentity,
  me: Omit<LockIdentity, 'token'>,
  heldByMe: ReadonlySet<string>,
): boolean {
  if (held.host !== me.host || held.bootId !== me.bootId || held.pidNs !== me.pidNs) {
    return false;
  }
  if (held.pid === me.pid) {
    return !heldByMe.has(held.token);
  }
  return !isAlive(held.pid);
}

function parseIdentity(text: string): LockIdentity | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockIdentity>;
    if (
      typeof value.token === 'string' &&
      typeof value.pid === 'number' &&
      typeof value.host === 'string' &&
      typeof value.bootId === 'string' &&
      typeof value.pidNs === 'string'
    ) {
      return value as LockIdentity;
    }
  } catch {
    // Not a lock this build wrote: it cannot be judged.
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/** Tokens this process holds, per lock path (the in-process mutex keeps it at one). */
const held = new Map<string, Set<string>>();
/** The in-process queue per lock path. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` holding the lock at `path` (`<agent dir>/.orders.lock`). Calls in one
 * process queue; another process's live lock is waited for, up to
 * `LOCK_WAIT_MS`; a dead one is broken under the break guard.
 */
export function withOrdersLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.then(
    () => lockAndRun(path, fn),
    () => lockAndRun(path, fn),
  );
  const settled = next.catch(() => undefined);
  queues.set(path, settled);
  void settled.then(() => {
    if (queues.get(path) === settled) {
      queues.delete(path);
    }
  });
  return next;
}

async function lockAndRun<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const me = await processIdentity();
  const token = randomBytes(16).toString('hex');
  const identity: LockIdentity = { token, ...me };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(path, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!isExists(error)) {
        throw error;
      }
    }
    const current = parseIdentity(await readFile(path, 'utf8').catch(() => ''));
    const mine = held.get(path) ?? new Set<string>();
    if (current !== undefined && holderIsDead(current, me, mine)) {
      await breakDeadLock(path, current.token, deadline);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new OrdersLockedError(
        current === undefined
          ? `the order file is locked (${path}); if no elisym MCP is running, remove that file`
          : `the order file is locked by process ${current.pid} on ${current.host} (${path}); if no elisym MCP is running there, remove that file`,
      );
    }
    await sleep(LOCK_POLL_MS);
  }
  const mine = held.get(path) ?? new Set<string>();
  mine.add(token);
  held.set(path, mine);
  try {
    return await fn();
  } finally {
    mine.delete(token);
    const current = parseIdentity(await readFile(path, 'utf8').catch(() => ''));
    if (current?.token === token) {
      await unlink(path).catch(() => undefined);
    }
  }
}

/**
 * Remove the lock at `path` if it still holds `deadToken`, one breaker at a
 * time: the break guard is taken with `wx`, the lock is re-read under it, and
 * only that exact dead lock is unlinked - a lock is never moved or renamed.
 */
export async function breakDeadLock(
  path: string,
  deadToken: string,
  deadline: number,
): Promise<void> {
  const guard = `${path}.break`;
  for (;;) {
    try {
      await writeFile(guard, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!isExists(error)) {
        throw error;
      }
    }
    const age = await stat(guard).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    if (age > BREAK_GUARD_STALE_MS) {
      throw new OrdersLockedError(
        `a stale lock guard blocks the order file (${guard}); if no elisym MCP is running, remove that file`,
      );
    }
    if (Date.now() >= deadline) {
      throw new OrdersLockedError(`the order file is being unlocked by another process (${guard})`);
    }
    await sleep(LOCK_POLL_MS);
  }
  try {
    const current = parseIdentity(await readFile(path, 'utf8').catch(() => ''));
    if (current?.token === deadToken) {
      await unlink(path);
    }
  } finally {
    await unlink(guard).catch(() => undefined);
  }
}
