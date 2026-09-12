import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCRIPT_EXIT_BILLING_EXHAUSTED } from '../llm-health/constants';
import { ScriptBillingExhaustedError, ScriptExecutionError } from '../llm-health/types';
import type { Asset } from '../payment/assets';
import { runScript, scopedToolEnv } from './scriptSkill';
import type {
  Skill,
  SkillContext,
  SkillInput,
  SkillLlmOverride,
  SkillMode,
  SkillOutput,
} from './types';

/**
 * Upper bound on the charge file we are willing to read. Twenty digits plus
 * whitespace is generous for a u64; anything bigger is not a number we would
 * accept anyway, so it is refused unread rather than pulled into memory.
 */
const MAX_CHARGE_FILE_BYTES = 64;

/** u64 ceiling - SPL amounts are u64, and the pull would reject anything above. */
const U64_MAX = (1n << 64n) - 1n;

export interface DynamicScriptSkillParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  /** Absolute path to the script. */
  scriptPath: string;
  /** Extra args appended after the script path. */
  scriptArgs: string[];
  /** Optional override of the default 60s timeout. */
  scriptTimeoutMs?: number;
  /**
   * Full environment for the script. When omitted, the script inherits
   * `process.env`. Callers (typically the CLI loader) spread `process.env`
   * and add narrowly-scoped secrets like provider API keys.
   */
  scriptEnv?: NodeJS.ProcessEnv;
  image?: string;
  imageFile?: string;
  /**
   * Declared LLM dependency. The (provider, model) pair tells the runtime
   * which API key the script reaches under the hood so it can be
   * health-monitored. Carried through from SKILL.md as-is; the script
   * itself reads the key from its environment.
   */
  llmOverride?: SkillLlmOverride;
  /** Conversation-context participation (SKILL.md `context: true`). */
  context?: boolean;
  /**
   * MIME type the script declares for a file result (SKILL.md `output_mime`).
   * Used only when the script writes a file to `ELISYM_OUTPUT_FILE`; becomes the
   * iroh attachment's mime. Defaults to `application/octet-stream`.
   */
  outputMime?: string;
}

/**
 * Pipes the user's job input to the script's stdin and returns its
 * trimmed stdout. Enables script-backed capabilities (proxies to
 * external models, classical NLP, custom workers) without an LLM key
 * on the elisym side.
 */
export class DynamicScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  mode: SkillMode = 'dynamic-script';
  image?: string;
  imageFile?: string;
  llmOverride?: SkillLlmOverride;
  readonly context?: boolean;
  private scriptPath: string;
  private scriptArgs: string[];
  private scriptTimeoutMs?: number;
  private scriptEnv?: NodeJS.ProcessEnv;
  private outputMime?: string;

  constructor(params: DynamicScriptSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.llmOverride = params.llmOverride;
    this.context = params.context;
    this.scriptPath = params.scriptPath;
    this.scriptArgs = params.scriptArgs;
    this.scriptTimeoutMs = params.scriptTimeoutMs;
    this.scriptEnv = params.scriptEnv;
    this.outputMime = params.outputMime;
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    // File I/O contract (P2P via iroh): the runtime fetches a file INPUT to disk
    // and passes its path as `input.filePath`; the script reads it from
    // `ELISYM_INPUT_FILE`. For a file RESULT, the script writes to the path in
    // `ELISYM_OUTPUT_FILE` (a fresh temp file); if it does, the runtime seeds that
    // file via iroh. A script that ignores these vars keeps the original
    // stdin -> stdout text behavior unchanged.
    const outDir = await mkdtemp(join(tmpdir(), 'elisym-skill-out-'));
    const outputFile = join(outDir, 'output');
    // A skill returning MULTIPLE files writes them here instead of ELISYM_OUTPUT_FILE.
    // It lives under outDir (so the single `cleanup` of outDir removes both) and is a
    // distinct subpath from `outputFile`, so scanning it never picks up the single file.
    const outputDir = join(outDir, 'files');
    await mkdir(outputDir, { recursive: true });
    // No caller-provided env -> scoped copy of process.env (secret vars
    // stripped), never the raw parent env with the operator's key ring.
    // Metered charge channel. Deliberately a sibling of `outputFile` under
    // `outDir` and NOT inside `outputDir`: the multi-file scan below adopts
    // EVERY non-empty regular file in `outputDir` as a result attachment, so a
    // charge file placed there would be delivered to the buyer as output and
    // would make a text-only skill look like a file skill.
    const chargeFile = join(outDir, 'charge');
    const env: NodeJS.ProcessEnv = {
      ...(this.scriptEnv ?? scopedToolEnv()),
      ELISYM_OUTPUT_FILE: outputFile,
      ELISYM_OUTPUT_DIR: outputDir,
      ELISYM_CHARGE_FILE: chargeFile,
    };
    if (input.filePath !== undefined) {
      env.ELISYM_INPUT_FILE = input.filePath;
    }
    // Conversation contract (`context: true`): the session id always rides
    // along so a script can key its own upstream conversation state; prior
    // turns (when any) land in a JSON file - env values have size limits a
    // long transcript would blow. Absent vars = stateless job; a set id with
    // no history file = the conversation's first message.
    if (input.sessionId !== undefined) {
      env.ELISYM_SESSION_ID = input.sessionId;
    }
    if (input.history !== undefined && input.history.length > 0) {
      const historyFile = join(outDir, 'history.json');
      await writeFile(historyFile, JSON.stringify(input.history), 'utf8');
      env.ELISYM_HISTORY_FILE = historyFile;
    }

    // Keep the temp dir only when we hand a file result back to the runtime: it
    // seeds the file AFTER execute() returns, so we cannot delete it here - we
    // pass a `cleanup` callback the runtime invokes once seeding is done. Every
    // other path - text result, error, no file written - cleans up in `finally`.
    let keepOutDir = false;
    try {
      const result = await runScript(this.scriptPath, this.scriptArgs, {
        cwd: dirname(this.scriptPath),
        stdin: input.data,
        signal: ctx.signal,
        timeoutMs: this.scriptTimeoutMs,
        env,
      });
      if (result.spawnError) {
        throw new ScriptExecutionError(
          null,
          result.spawnError.message,
          'script could not be started',
        );
      }
      if (result.code === SCRIPT_EXIT_BILLING_EXHAUSTED) {
        throw new ScriptBillingExhaustedError(result.code, result.stdout, result.stderr);
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
        // Generic message reaches the customer; raw stderr/stdout stays on `detail`
        // for the operator log and health-monitor classification only.
        throw new ScriptExecutionError(result.code, detail);
      }

      // Read the metered charge ONCE, before the three return shapes below - a
      // metered skill may report a charge alongside text, one file, or many, and
      // reading it in only one branch would silently bill the ceiling for the
      // others. Same adoption rule as ELISYM_OUTPUT_FILE: exists, regular,
      // non-empty. Anything unparseable is treated as "no report".
      const chargeSubunits = await readChargeFile(chargeFile);

      // Multi-file result: the script wrote files to ELISYM_OUTPUT_DIR. Collect the
      // non-empty files (sorted, deterministic) and deliver them as N attachments.
      // Like the single-file path, the stdout note may be empty (no empty-output guard).
      const dirEntries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
      const filePaths: string[] = [];
      for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile()) {
          continue;
        }
        const candidate = join(outputDir, entry.name);
        const entryStat = await stat(candidate).catch(() => null);
        if (entryStat !== null && entryStat.isFile() && entryStat.size > 0) {
          filePaths.push(candidate);
        }
      }
      if (filePaths.length > 0) {
        keepOutDir = true;
        return {
          data: result.stdout.trim(),
          filePaths,
          ...(chargeSubunits !== undefined ? { chargeSubunits } : {}),
          outputMime: this.outputMime ?? 'application/octet-stream',
          cleanup: async () => {
            await rm(outDir, { recursive: true, force: true });
          },
        };
      }

      // File result: the script wrote a non-empty file to ELISYM_OUTPUT_FILE. The
      // stdout note (`data`) may be empty here - the runtime delivers the file
      // attachment, so the empty-output guard below intentionally does not apply.
      const outputStat = await stat(outputFile).catch(() => null);
      if (outputStat !== null && outputStat.isFile() && outputStat.size > 0) {
        keepOutDir = true;
        return {
          data: result.stdout.trim(),
          filePath: outputFile,
          ...(chargeSubunits !== undefined ? { chargeSubunits } : {}),
          outputMime: this.outputMime ?? 'application/octet-stream',
          cleanup: async () => {
            await rm(outDir, { recursive: true, force: true });
          },
        };
      }

      const output = result.stdout.trim();
      if (output === '') {
        // Exit 0 with no output is not a deliverable result: the marketplace
        // rejects empty results at delivery, but only after the ledger has
        // marked the job `executed`, and recovery then retries the empty
        // result on every tick forever. Failing here keeps the job on the
        // paid -> failed path so recovery terminates it. stderr (if any)
        // carries the underlying reason for the operator log.
        const detail = result.stderr.trim() || '(no stderr)';
        throw new ScriptExecutionError(result.code, detail, 'script produced empty output');
      }
      return { data: output, ...(chargeSubunits !== undefined ? { chargeSubunits } : {}) };
    } finally {
      if (!keepOutDir) {
        await rm(outDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

/**
 * Read a metered charge written by the skill to `ELISYM_CHARGE_FILE`.
 *
 * Deliberately forgiving in one direction only: a missing, empty, oversized or
 * unparseable file yields `undefined` ("the skill reported nothing"), and the
 * runtime then charges the declared ceiling. It never throws - a job whose work
 * is already done must not die over its accounting note.
 *
 * Strict about what it does accept: digits only, so no sign, no decimal point,
 * no exponent, no leading `+`. The value is subunits, and the runtime clamps it
 * into the card's published `[min, price]` regardless, so a hostile or buggy
 * figure can never bill above what the buyer approved.
 */
async function readChargeFile(path: string): Promise<bigint | undefined> {
  const chargeStat = await stat(path).catch(() => null);
  if (chargeStat === null || !chargeStat.isFile() || chargeStat.size === 0) {
    return undefined;
  }
  // A charge is at most 20 digits; anything larger is not a number we would
  // accept, so refuse to read it rather than pulling an arbitrary file into memory.
  if (chargeStat.size > MAX_CHARGE_FILE_BYTES) {
    return undefined;
  }
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d{1,20}$/.test(trimmed)) {
    return undefined;
  }
  const value = BigInt(trimmed);
  return value <= U64_MAX ? value : undefined;
}
