import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isBlockingNodeSync } from '../agent-store/node-type';
import {
  MIN_SETTLEMENT_RETENTION_MS,
  type SettlementClaim,
  type SettlementStore,
  isUsableSignature,
} from './acceptor';

/**
 * How stale a temporary must be before the sweep removes it. Long enough that
 * a live writer's file is never in question, short enough that a fragment is
 * not a permanent copy of the index.
 */
const STRANDED_TEMP_MIN_AGE_MS = 60 * 60 * 1000;

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
  // `Object.create(null)` here too, not only on the read path: this is what a
  // first run gets, and with a plain literal a signature named `__proto__` or
  // `toString` resolves to an inherited member and reads back as somebody
  // else's claim on an index that holds nothing at all.
  return { version: FORMAT_VERSION, settlements: Object.create(null) };
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
    // AFTER the read, so a refusal to read the index is reported before
    // anything beside it is deleted.
    this.sweepStrandedTemporaries();
  }

  /**
   * Remove `.<name>.<pid>.<hex>.tmp` fragments a dead process left beside the
   * index.
   *
   * The `try` in `write` covers a failure that THROWS; a process killed
   * outright between the write and the rename leaves the fragment, and the
   * suffix is random, so nothing reuses it and - until this - nothing removed
   * it. What it holds is a full copy of the index: which transaction paid for
   * which job. The path is the SDK consumer's to choose, and the documented
   * example puts it in a repository working directory, so there is no
   * `.gitignore` of ours standing behind it either.
   *
   * The age guard is what keeps a second process's LIVE temporary safe. Two
   * writers on one index is already unsupported - there is no cross-process
   * lock, as the class docstring says - but a sweep is no place to make that
   * worse.
   */
  private sweepStrandedTemporaries(): void {
    // The EXACT shape `write` produces, not a prefix: a store named
    // `settlements.json.backup` in the same directory writes
    // `.settlements.json.backup.<pid>.<hex>.tmp`, which a prefix match on
    // `.settlements.json.` would take - and it may be mid-rename. Measured.
    const escapedName = basename(this.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const temporary = new RegExp(`^\\.${escapedName}\\.\\d+\\.[0-9a-f]+\\.tmp$`);
    const cutoff = Date.now() - STRANDED_TEMP_MIN_AGE_MS;
    let names: string[];
    try {
      names = readdirSync(dirname(this.path));
    } catch {
      return; // the directory may not exist yet; nothing to sweep
    }
    for (const name of names) {
      if (!temporary.test(name)) {
        continue;
      }
      const candidate = join(dirname(this.path), name);
      try {
        if (statSync(candidate).mtimeMs < cutoff) {
          unlinkSync(candidate);
        }
      } catch {
        /* raced deletion, or somebody else's node - leave it */
      }
    }
  }

  private read(): StoreFile {
    // Ahead of the read, not inside its `catch`: a FIFO here does not fail,
    // it takes the whole event loop with it. And refused rather than treated as
    // absent, for the reason the ENOENT branch below spells out.
    if (isBlockingNodeSync(this.path)) {
      throw new Error(
        `Settlement index at ${this.path} is a pipe, socket or device, not a file. Refusing to ` +
          `read it: an index that cannot be read is not an empty one.`,
      );
    }
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
      // The three top-level disjuncts are PROVABLY REDUNDANT and kept as a
      // mirror: a `null`, a number or an array at the top level all give an
      // `undefined` or non-object `settlements`, which the second half catches.
      // They are written out because the pair reads as one rule, and a mirror
      // with a line missing is a mirror somebody has to re-derive. No mutation
      // can kill them - measured. (The TERNARY above is not redundant: without
      // it, a bare `null` document throws a raw property access instead of the
      // sentence, and a row holds that.)
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
      // `Array.isArray(record)` is redundant here for the same reason - an array
      // has no string `job`, so the next guard drops it either way - and kept
      // for the same one. NOT KILLED BY ANY TEST.
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
        //
        // `typeof` alone did NOT say that, and the comment above outran it for
        // two rounds: zero IS a number, so it went through untouched, and so
        // did a negative one. Neither needs a hand-edited file to appear - a
        // machine whose clock has not reached NTP yet writes a small `at`
        // itself, and the prune after the clock jumps forward sweeps it.
        at: typeof candidate.at === 'number' && candidate.at > 0 ? candidate.at : Date.now(),
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
    // Named after the target file AND randomly: two stores in one process
    // writing sibling indexes would otherwise share one temporary path, and a
    // predictable one can be replaced by a FIFO from outside - `writeFileSync`
    // onto one never returns, taking the event loop with it. The read side is
    // gated by node type; the write side is protected by there being nothing to
    // plant.
    const tmp = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      writeFileSync(tmp, JSON.stringify(file), { encoding: 'utf-8', mode: STORE_FILE_MODE });
      chmodSync(tmp, STORE_FILE_MODE);
      renameSync(tmp, this.path);
    } catch (error) {
      // Best effort, and it only became worth doing once the name became
      // random: with one fixed name the next write reused the leftover, so the
      // garbage bounded itself. Now every failure between the write and the
      // rename would leave a unique file holding a full copy of the index.
      try {
        unlinkSync(tmp);
      } catch {
        /* the caller's error is the one worth reporting */
      }
      throw error;
    }
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
    //
    // What the release costs is worth naming rather than leaving to be
    // rediscovered. The freed signature is no longer spoken for, so any second
    // job whose window can contain it may now take it. Two shapes do: two jobs
    // sharing one reference - nothing here enforces that they do not, and
    // surviving that reuse is half of why this index exists - and one
    // transaction carrying the references of two jobs at once, which is the
    // shape `ProviderPaymentAcceptor`'s own docstring opens with. Getting there takes a pass that failed to
    // verify its OWN signature transiently and then settled a different one, so
    // it is a stated cost and not a guard: the alternative is a job holding two
    // settlements, and then nothing can say which one paid for the delivery.
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
    // The `typeof` half is not redundant: a relational test COERCES, so
    // `'2592000000' >= MIN` is true and a string would otherwise be accepted as
    // a retention. The positive form of the second half is what rejects `NaN`
    // and `undefined` while letting `Infinity` through deliberately - "never
    // release anything" is the safest retention there is, and `Number.isFinite`
    // would reject exactly that one.
    if (typeof retentionMs !== 'number' || !(retentionMs >= MIN_SETTLEMENT_RETENTION_MS)) {
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
      // `<`, not `<=`, and NOT KILLED BY ANY TEST: the two differ only for a
      // record whose timestamp equals the cutoff to the millisecond, which
      // needs a frozen clock to reach. Same class as the `>=` in the acceptor's
      // deadline, named there for the same reason.
      if (record.at < cutoff) {
        delete file.settlements[signature];
        deleted += 1;
      }
    }
    // Writing nothing when nothing was deleted narrows the window in which this
    // prune can erase a claim another process made after the read above. It
    // does not close it: a prune that DOES delete still writes by a snapshot
    // taken moments earlier. NO TEST KILLS THIS - the interleaving it guards
    // needs two processes and a hook between the read and the write, and it is
    // kept on diff review rather than on measurement.
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
