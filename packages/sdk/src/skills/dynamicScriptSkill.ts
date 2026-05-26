import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCRIPT_EXIT_BILLING_EXHAUSTED } from '../llm-health/constants';
import { ScriptBillingExhaustedError, ScriptExecutionError } from '../llm-health/types';
import type { Asset } from '../payment/assets';
import { runScript } from './scriptSkill';
import type {
  Skill,
  SkillContext,
  SkillInput,
  SkillLlmOverride,
  SkillMode,
  SkillOutput,
} from './types';

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
    const env: NodeJS.ProcessEnv = {
      ...(this.scriptEnv ?? process.env),
      ELISYM_OUTPUT_FILE: outputFile,
    };
    if (input.filePath !== undefined) {
      env.ELISYM_INPUT_FILE = input.filePath;
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

      // File result: the script wrote a non-empty file to ELISYM_OUTPUT_FILE. The
      // stdout note (`data`) may be empty here - the runtime delivers the file
      // attachment, so the empty-output guard below intentionally does not apply.
      const outputStat = await stat(outputFile).catch(() => null);
      if (outputStat !== null && outputStat.isFile() && outputStat.size > 0) {
        keepOutDir = true;
        return {
          data: result.stdout.trim(),
          filePath: outputFile,
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
      return { data: output };
    } finally {
      if (!keepOutDir) {
        await rm(outDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
