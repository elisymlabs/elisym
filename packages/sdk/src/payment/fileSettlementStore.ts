import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
    // Read once here so an unreadable index fails LOUDLY, at construction,
    // rather than at the first claim - and deliberately without a `catch` that
    // would replace it. An index that cannot be read is not an empty one: every
    // signature would come back unclaimed, and one transfer carrying several
    // jobs' references would settle them all again. That is the exact failure
    // this file exists to prevent, so refusing to start is the safe direction.
    // A file that is merely ABSENT is a different case and does not throw -
    // `read` answers with an empty index for ENOENT alone.
    this.read();
  }

  private read(): StoreFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf-8');
    } catch (error) {
      // ENOENT is the ONLY absence. Everything else - a permission error, a
      // directory in the way - is a file we could not read, and answering
      // "nothing is claimed" to that frees every settlement at once.
      if ((error as { code?: string }).code === 'ENOENT') {
        return emptyFile();
      }
      throw error;
    }
    let parsed: Partial<StoreFile> | null;
    try {
      parsed = JSON.parse(raw) as Partial<StoreFile> | null;
    } catch (error) {
      throw new Error(
        `Settlement index at ${this.path} is not readable JSON ` +
          `(${error instanceof Error ? error.message : String(error)}). Refusing to treat it as ` +
          `empty: that would free every settlement it records and let one transfer settle a ` +
          `second job. Move the file aside to start a fresh index.`,
      );
    }
    // `typeof null` and `typeof []` are both `'object'`, so neither the
    // container nor the map can be checked by `typeof` alone. The per-record
    // guard below already spells this out; the top level has to as well, or
    // `settlements: null` and `settlements: []` read as "nothing is claimed"
    // about a file that holds real claims.
    const settlements: unknown = parsed === null ? undefined : parsed.settlements;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      settlements === null ||
      typeof settlements !== 'object' ||
      Array.isArray(settlements)
    ) {
      throw new Error(
        `Settlement index at ${this.path} is JSON but not a settlement index. Refusing to treat ` +
          `it as empty - move the file aside to start a fresh one.`,
      );
    }
    // A future version may key or shape these differently, and reading it with
    // today's rules would silently report its settlements as unclaimed.
    // No `!== undefined` escape: this store always writes `version`, so a file
    // without one was written by something else.
    if (parsed.version !== FORMAT_VERSION) {
      throw new Error(
        `Settlement index at ${this.path} is format version ${String(parsed.version)}, and this ` +
          `build reads version ${FORMAT_VERSION}. Refusing to read it as empty.`,
      );
    }
    // `Object.create(null)`, not `{}`: a signature literally named `__proto__`
    // would otherwise replace the prototype instead of becoming a key, and both
    // the claim scan and `claimedSignature` would look straight past it.
    const collected: Record<string, SettlementRecord> = Object.create(null);
    for (const [signature, record] of Object.entries(settlements)) {
      // A hand-edited file can carry anything here. Reading a property off a
      // non-object throws, and this index is what decides whether a settlement
      // was already spent - an unguarded entry is a money bug, not a tidiness
      // one.
      //
      // Skipping is deliberately NOT what the file level does, and the asymmetry
      // is the point: an unreadable FILE is refused, because reading it as empty
      // frees every settlement at once. One unreadable RECORD frees only itself,
      // and refusing the whole index over it would strand a provider whose file
      // is otherwise intact. Both directions are named so neither is mistaken
      // for an oversight.
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        continue;
      }
      const candidate = record as SettlementRecord;
      if (typeof candidate.job !== 'string' || candidate.job.length === 0) {
        continue;
      }
      collected[signature] = {
        job: candidate.job,
        // An unreadable timestamp becomes NOW, never 0: `0 < cutoff` is always
        // true, so zero would hand the next `prune` a reason to release a
        // settlement that is still binding. Holding one too long costs nothing;
        // releasing one early is the whole failure.
        at: typeof candidate.at === 'number' ? candidate.at : Date.now(),
      };
    }
    return { version: FORMAT_VERSION, settlements: collected };
  }

  /**
   * `rename` last, so a reader never sees a half-written index.
   *
   * No `fsync`, matching the ledger and session stores in this repository:
   * `rename` buys atomic VISIBILITY, not durability, so a power loss can still
   * leave a truncated file. That case is handled by refusing to read it rather
   * than by replacing it - see the constructor.
   */
  private write(file: StoreFile): void {
    // Named after the target file, not just the pid: two stores in one process
    // writing sibling indexes would otherwise share one temporary path.
    const tmp = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.tmp`);
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
    // Written as a positive test so everything that is not a number at or above
    // the floor is rejected - `NaN`, `undefined` and a string all fail it, while
    // `Infinity` passes deliberately: "never release anything" is the safest
    // retention there is, and a `Number.isFinite` check would reject exactly
    // that one.
    if (!(retentionMs >= MIN_SETTLEMENT_RETENTION_MS)) {
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
