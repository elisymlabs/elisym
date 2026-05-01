import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Asset } from '../payment/assets';
import type {
  CompletionResult,
  LlmClient,
  Skill,
  SkillContext,
  SkillInput,
  SkillLlmOverride,
  SkillMode,
  SkillOutput,
  ToolCall,
  ToolDef,
  ToolResult,
} from './types';

export const MAX_SCRIPT_OUTPUT = 1_000_000;
export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;

export interface SkillToolDef {
  name: string;
  description: string;
  command: string[];
  parameters?: Array<{ name: string; description: string; required?: boolean }>;
}

export interface ScriptSkillLogger {
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface RunScriptOptions {
  cwd: string;
  /**
   * UTF-8 string written to the child's stdin, then stdin closed.
   * When undefined, stdin is closed immediately (EOF) so that children
   * which read stdin do not block until `timeoutMs`.
   */
  stdin?: string;
  /** Cancel the spawn. SIGKILL is sent on abort. */
  signal?: AbortSignal;
  /** Hard timeout in ms. Default `DEFAULT_SCRIPT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Cap on stdout/stderr capture. Default `MAX_SCRIPT_OUTPUT`. */
  maxOutput?: number;
  /**
   * Full environment for the child. When omitted, the child inherits
   * `process.env`. Caller is responsible for spreading `process.env`
   * if PATH/HOME/etc. need to be preserved alongside extras.
   */
  env?: NodeJS.ProcessEnv;
}

export interface RunScriptResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed by signal before exiting. */
  code: number | null;
  /** Set when spawn itself failed (ENOENT, EACCES, etc.). */
  spawnError?: Error;
}

/**
 * Spawn `cmd` with `args` and capture stdout/stderr. Never uses `shell: true`,
 * so shell metacharacters in arguments are safe. Caller is responsible for
 * checking `code === 0` / interpreting `spawnError`.
 */
export function runScript(
  cmd: string,
  args: string[],
  opts: RunScriptOptions,
): Promise<RunScriptResult> {
  return new Promise((resolveResult) => {
    const maxOutput = opts.maxOutput ?? MAX_SCRIPT_OUTPUT;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      signal: opts.signal,
      env: opts.env,
    });

    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    child.stdout?.on('data', (data: Buffer) => {
      if (stdout.length < maxOutput) {
        stdout += stdoutDecoder.write(data);
        if (stdout.length > maxOutput) {
          stdout = stdout.slice(0, maxOutput);
        }
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (stderr.length < maxOutput) {
        stderr += stderrDecoder.write(data);
        if (stderr.length > maxOutput) {
          stderr = stderr.slice(0, maxOutput);
        }
      }
    });

    child.on('close', (code) => {
      // Flush any bytes the decoder buffered because a multi-byte UTF-8
      // codepoint straddled the final chunk boundary.
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolveResult({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      resolveResult({ stdout, stderr, code: null, spawnError: err });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Ignore EPIPE - the child may exit without consuming all input.
      });
      // Always close stdin: a child that reads from stdin would otherwise
      // block until `timeoutMs` even when the caller has no input to send.
      child.stdin.end(opts.stdin ?? '');
    }
  });
}

export interface ScriptSkillParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  skillDir: string;
  systemPrompt: string;
  tools: SkillToolDef[];
  maxToolRounds: number;
  /** Optional per-skill LLM override (provider/model pair and/or maxTokens). */
  llmOverride?: SkillLlmOverride;
  image?: string;
  imageFile?: string;
  logger?: ScriptSkillLogger;
}

/**
 * LLM-orchestrated skill runner. Tools are external scripts launched
 * via `child_process.spawn` (without `shell: true`, so shell
 * metacharacters in arguments are never interpreted - a security
 * property, not a convenience). Windows users cannot rely on
 * shell-script shebangs; target Linux/macOS for scripts.
 */
export class ScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  mode: SkillMode = 'llm';
  readonly llmOverride?: SkillLlmOverride;
  image?: string;
  imageFile?: string;
  private skillDir: string;
  private systemPrompt: string;
  private tools: SkillToolDef[];
  private maxToolRounds: number;
  private logger: ScriptSkillLogger;

  constructor(params: ScriptSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.llmOverride = params.llmOverride;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.skillDir = params.skillDir;
    this.systemPrompt = params.systemPrompt;
    this.tools = params.tools;
    this.maxToolRounds = params.maxToolRounds;
    this.logger = params.logger ?? {};
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    const llm = this.resolveLlmClient(ctx);

    if (this.tools.length === 0) {
      const result = await llm.complete(this.systemPrompt, input.data, ctx.signal);
      return { data: result };
    }

    const toolDefs: ToolDef[] = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: (tool.parameters ?? []).map((param) => ({
        name: param.name,
        description: param.description,
        required: param.required ?? true,
      })),
    }));

    const messages: unknown[] = [{ role: 'user', content: input.data }];

    for (let round = 0; round < this.maxToolRounds; round++) {
      if (ctx.signal?.aborted) {
        throw new Error('Job aborted');
      }
      const result: CompletionResult = await llm.completeWithTools(
        this.systemPrompt,
        messages,
        toolDefs,
        ctx.signal,
      );

      if (result.type === 'text') {
        return { data: result.text };
      }

      messages.push(result.assistantMessage);

      const toolResults: ToolResult[] = [];
      for (const call of result.calls) {
        const toolDef = this.tools.find((tool) => tool.name === call.name);
        if (!toolDef) {
          toolResults.push({
            callId: call.id,
            content: `Error: unknown tool "${call.name}"`,
          });
          continue;
        }
        const output = await this.runTool(toolDef, call, ctx.signal);
        toolResults.push({ callId: call.id, content: output });
      }

      messages.push(...llm.formatToolResultMessages(toolResults));
    }

    throw new Error(`Max tool rounds (${this.maxToolRounds}) exceeded`);
  }

  /**
   * Resolve the LLM client for this skill from the runtime context.
   *
   * Contract:
   * - When `llmOverride` is set, `ctx.getLlm` MUST be wired. Falling back to
   *   `ctx.llm` (the agent default) would silently use the wrong configuration
   *   for max-tokens-only overrides.
   * - When no override is set, prefer `ctx.getLlm()` (returns the agent
   *   default), then fall back to `ctx.llm` for legacy callers that wire only
   *   a single client.
   */
  private resolveLlmClient(ctx: SkillContext): LlmClient {
    let client: LlmClient | undefined;
    if (this.llmOverride) {
      client = ctx.getLlm?.(this.llmOverride);
      if (!client) {
        throw new Error(
          `Skill "${this.name}" requires ctx.getLlm to be configured (llmOverride is set)`,
        );
      }
      return client;
    }
    client = ctx.getLlm?.() ?? ctx.llm;
    if (!client) {
      throw new Error('LLM client not configured for skill runtime');
    }
    return client;
  }

  private async runTool(
    toolDef: SkillToolDef,
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<string> {
    const args = [...toolDef.command];
    const cmd = args.shift();
    if (!cmd) {
      return `Error: tool "${toolDef.name}" has an empty command`;
    }

    const params = toolDef.parameters ?? [];
    for (let index = 0; index < params.length; index++) {
      const param = params[index];
      if (!param) {
        continue;
      }
      const value = call.arguments[param.name];
      if (value === undefined) {
        continue;
      }
      if (param.required && index === 0) {
        args.push(String(value));
      } else {
        args.push(`--${param.name}`, String(value));
      }
    }

    const result = await runScript(cmd, args, { cwd: this.skillDir, signal });

    if (result.spawnError) {
      return `Error: ${result.spawnError.message}`;
    }
    if (result.code === 0) {
      return result.stdout.trim();
    }
    this.logger.debug?.(
      { tool: toolDef.name, code: result.code, stderrLen: result.stderr.length },
      'skill tool exited non-zero',
    );
    return `Error (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`;
  }
}
