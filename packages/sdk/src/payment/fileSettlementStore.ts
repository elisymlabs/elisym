import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MIN_SETTLEMENT_RETENTION_MS,
  type SettlementClaim,
  type SettlementStore,
  isUsableSignature,
} from './acceptor';

/** Owner-only: the file names which job a transfer paid for. */
const STORE_FILE_MODE = 0o600;
const STORE_DIR_MODE = 0o700;
const FORMAT_VERSION = 1;

interface SettlementRecord {
  job: string;
  /** Unix milliseconds of the claim, refreshed on re-claim. Drives retention. */
  at: number;
}

interface StoreFile {
  version: number;
  settlements: Record<string, SettlementRecord>;
}

function emptyFile(): StoreFile {
  return { version: FORMAT_VERSION, settlements: {} };
}

/**
 * A settlement index on one file, read on every operation.
 *
 * No in-memory state, deliberately: several acceptors in one process may share
 * the file without sharing an instance, and each operation therefore sees what
 * the others wrote. There is NO cross-process lock - two processes racing on
 * one file can both believe they claimed a signature. Providers running several
 * processes against one file are outside what this can promise.
 */
export class FileSettlementStore implements SettlementStore {
  constructor(private readonly path: string) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: STORE_DIR_MODE });
    // A path that does not resolve gets a VALID empty index rather than being
    // left absent: `renameSync` works by path, so if the path were a symlink the
    // first write would replace it with a regular file and two instances would
    // silently diverge onto different inodes.
    try {
      this.read();
    } catch {
      this.write(emptyFile());
    }
  }

  private read(): StoreFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf-8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return emptyFile();
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<StoreFile> | null;
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.settlements !== 'object') {
      return emptyFile();
    }
    const settlements: Record<string, SettlementRecord> = {};
    for (const [signature, record] of Object.entries(parsed.settlements ?? {})) {
      // A hand-edited file can carry anything here. Reading a property off a
      // non-object throws, and this index is what decides whether a settlement
      // was already spent - an unguarded entry is a money bug, not a tidiness
      // one.
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        continue;
      }
      const candidate = record as SettlementRecord;
      if (typeof candidate.job !== 'string' || candidate.job.length === 0) {
        continue;
      }
      settlements[signature] = {
        job: candidate.job,
        at: typeof candidate.at === 'number' ? candidate.at : 0,
      };
    }
    return { version: FORMAT_VERSION, settlements };
  }

  /** `rename` last, so a reader never sees a half-written index. */
  private write(file: StoreFile): void {
    const tmp = join(dirname(this.path), `.${FORMAT_VERSION}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(file), { encoding: 'utf-8', mode: STORE_FILE_MODE });
    chmodSync(tmp, STORE_FILE_MODE);
    renameSync(tmp, this.path);
  }

  claim(signature: string, jobIdentity: string): SettlementClaim {
    if (!isUsableSignature(jobIdentity)) {
      throw new Error('jobIdentity must be a non-empty string unique to this job');
    }
    if (!isUsableSignature(signature)) {
      throw new Error('signature must be a non-empty string - an empty claim owns nothing');
    }
    const file = this.read();
    const existing = file.settlements[signature];
    if (existing !== undefined && existing.job !== jobIdentity) {
      return 'consumed-by-other';
    }
    // A job holds at most one settlement: a second one releases the first, so
    // the reverse view stays derivable from the forward index rather than
    // being a second source that can disagree with it.
    for (const [previous, record] of Object.entries(file.settlements)) {
      if (record.job === jobIdentity && previous !== signature) {
        delete file.settlements[previous];
      }
    }
    file.settlements[signature] = { job: jobIdentity, at: Date.now() };
    try {
      this.write(file);
    } catch {
      return 'not-persisted';
    }
    return 'claimed';
  }

  owner(signature: string): string | undefined {
    return this.read().settlements[signature]?.job;
  }

  claimedSignature(jobIdentity: string): string | undefined {
    const file = this.read();
    for (const [signature, record] of Object.entries(file.settlements)) {
      if (record.job === jobIdentity) {
        return signature;
      }
    }
    return undefined;
  }

  prune(retentionMs: number): number {
    if (!Number.isFinite(retentionMs) || retentionMs < MIN_SETTLEMENT_RETENTION_MS) {
      throw new Error(
        `retentionMs must be at least ${MIN_SETTLEMENT_RETENTION_MS}ms: a signature dropped from ` +
          `this index has to be unverifiable on-chain by then, or it settles a second job`,
      );
    }
    // Re-read, and write by what was re-read: writing by an earlier snapshot
    // erases a claim another process made in between.
    const file = this.read();
    const cutoff = Date.now() - retentionMs;
    let deleted = 0;
    for (const [signature, record] of Object.entries(file.settlements)) {
      if (record.at < cutoff) {
        delete file.settlements[signature];
        deleted += 1;
      }
    }
    // Writing nothing when nothing was deleted is contract, not liberty: the
    // test for "another process's prune does not erase a claim" depends on it.
    if (deleted > 0) {
      this.write(file);
    }
    return deleted;
  }
}

/** The file-backed {@link SettlementStore}. Node only - it touches the disk. */
export function createFileSettlementStore(path: string): SettlementStore {
  return new FileSettlementStore(path);
}
