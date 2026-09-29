/**
 * Durable writes, and whether the storage under a directory makes them durable.
 *
 * A mainnet purchase relies on this: the payment marker and its signature are
 * written before the transaction is broadcast, and a write that returned must
 * survive a host crash, or a later call could pay the same order again. So
 * mainnet runs only on storage known to honour fsync (an allowlist), checked
 * when the order store opens, before any write.
 */
import { execFile } from 'node:child_process';
import { open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Directory-fsync errors that mean "not supported here", never "failed". */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']);

/** Linux filesystems whose fsync reaches the disk (with barriers on). */
const LINUX_DURABLE_TYPES = new Set(['ext4', 'ext3', 'xfs', 'btrfs', 'f2fs']);

/** Kernels of desktop VMs, whose disks are not known to flush through to the host. */
const DESKTOP_VM_KERNELS = [/linuxkit/i, /microsoft/i, /wsl/i, /orbstack/i];

export interface StorageVerdict {
  durable: boolean;
  /** Why not, in words for the user (the filesystem, the runtime, the VM). */
  reason?: string;
}

/** fsync a directory; `false` when the platform or mount does not support it. */
export async function syncDirectory(directory: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (DIRECTORY_SYNC_UNSUPPORTED.has(code)) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Write `content` to `path` durably: a temporary with a random suffix, fsynced,
 * renamed over the target, then the directory fsynced. Returns whether the
 * directory sync happened (`false`: the rename is not made durable here). A
 * throw after the rename means "unknown" - the new content may be in place.
 */
export async function writeFileDurable(path: string, content: string): Promise<boolean> {
  const temporary = join(
    dirname(path),
    `${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return syncDirectory(dirname(path));
}

/** One mount of `/proc/self/mountinfo`: where, what type, and its options. */
interface Mount {
  point: string;
  type: string;
  options: string[];
}

/** Undo mountinfo's octal escapes (`\040` for a space). */
function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseMountinfo(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator === -1) {
      continue;
    }
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    const point = before[4];
    const type = after[0];
    if (point === undefined || type === undefined) {
      continue;
    }
    mounts.push({
      point: unescapeMount(point),
      type,
      options: [...(before[5] ?? '').split(','), ...(after[2] ?? '').split(',')],
    });
  }
  return mounts;
}

/** The mount a path is on: the longest mount point prefixing it (a later line wins a tie). */
export function mountOf<T extends { point: string }>(
  mounts: readonly T[],
  path: string,
): T | undefined {
  let found: T | undefined;
  for (const mount of mounts) {
    const prefix = mount.point.endsWith('/') ? mount.point : `${mount.point}/`;
    const covers = path === mount.point || path.startsWith(prefix) || mount.point === '/';
    if (covers && (found === undefined || mount.point.length >= found.point.length)) {
      found = mount;
    }
  }
  return found;
}

/** Whether mount options turn write barriers off (then fsync does not reach the disk). */
export function barriersOff(options: readonly string[]): boolean {
  return options.some(
    (option) => option === 'nobarrier' || option === 'barrier=0' || option.endsWith('=nobarrier'),
  );
}

/** Judge a Linux directory from its kernel string and mountinfo. */
export function judgeLinux(version: string, mountinfo: string, path: string): StorageVerdict {
  if (DESKTOP_VM_KERNELS.some((pattern) => pattern.test(version))) {
    return { durable: false, reason: 'a desktop VM (Docker Desktop, WSL2 or OrbStack)' };
  }
  const mount = mountOf(parseMountinfo(mountinfo), path);
  if (mount === undefined) {
    return { durable: false, reason: 'an unknown filesystem' };
  }
  if (!LINUX_DURABLE_TYPES.has(mount.type)) {
    return { durable: false, reason: `a ${mount.type} filesystem` };
  }
  if (barriersOff(mount.options)) {
    return { durable: false, reason: `a ${mount.type} filesystem mounted without barriers` };
  }
  return { durable: true };
}

/** Judge a macOS directory from `/sbin/mount` output: APFS or HFS, local. */
export function judgeDarwin(mountOutput: string, path: string): StorageVerdict {
  const mounts: { point: string; type: string; local: boolean }[] = [];
  for (const line of mountOutput.split('\n')) {
    // "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)"
    const match = /^.+? on (.+) \(([^)]*)\)$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const flags = match[2].split(',').map((flag) => flag.trim());
    mounts.push({ point: match[1], type: flags[0] ?? '', local: flags.includes('local') });
  }
  const mount = mountOf(mounts, path);
  if (mount === undefined) {
    return { durable: false, reason: 'an unknown filesystem' };
  }
  if ((mount.type !== 'apfs' && mount.type !== 'hfs') || !mount.local) {
    return { durable: false, reason: `a ${mount.type || 'non-local'} volume` };
  }
  return { durable: true };
}

/**
 * Whether writes under `directory` are durable, checked before any write: the
 * runtime, the platform, the filesystem (an allowlist), and a directory-fsync
 * probe. Anything not known to be durable is not.
 */
export async function judgeStorage(directory: string): Promise<StorageVerdict> {
  const path = await realpath(directory);
  let verdict: StorageVerdict;
  const os = platform();
  if (os === 'linux') {
    const [version, mountinfo] = await Promise.all([
      readFile('/proc/version', 'utf8').catch(() => ''),
      readFile('/proc/self/mountinfo', 'utf8').catch(() => ''),
    ]);
    verdict = judgeLinux(version, mountinfo, path);
  } else if (os === 'darwin') {
    if (process.versions.bun !== undefined) {
      return { durable: false, reason: 'Bun on macOS (its fsync is not a full flush)' };
    }
    const output = await run('/sbin/mount', []).then(
      (result) => result.stdout,
      () => '',
    );
    verdict = judgeDarwin(output, path);
  } else {
    return { durable: false, reason: `${os === 'win32' ? 'Windows' : os}` };
  }
  if (verdict.durable && !(await syncDirectory(path))) {
    return { durable: false, reason: 'a filesystem that cannot sync a directory' };
  }
  return verdict;
}
