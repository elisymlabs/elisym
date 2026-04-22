import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Asset } from '../payment/assets';
import type {
  CompletionResult,
  LlmClient,
  Skill,
  SkillContext,
  SkillInput,
  SkillOutput,
  ToolCall,
  ToolDef,
  ToolResult,
} from './types';

const MAX_TOOL_OUTPUT = 1_000_000;
const TOOL_TIMEOUT_MS = 60_000;

export interface SkillToolDef {
  name: string;
  description: string;
  command: string[];
  parameters?: Array<{ name: string; description: string; required?: boolean }>;
}

export interface ScriptSkillLogger {
  debug?(obj: Record<string, unknown>, msg?: string): void;
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
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.skillDir = params.skillDir;
    this.systemPrompt = params.systemPrompt;
    this.tools = params.tools;
    this.maxToolRounds = params.maxToolRounds;
    this.logger = params.logger ?? {};
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    if (!ctx.llm) {
      throw new Error('LLM client not configured for skill runtime');
    }

    if (this.tools.length === 0) {
      const result = await ctx.llm.complete(this.systemPrompt, input.data, ctx.signal);
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
    const llm: LlmClient = ctx.llm;

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

  private runTool(toolDef: SkillToolDef, call: ToolCall, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      const args = [...toolDef.command];
      const cmd = args.shift();
      if (!cmd) {
        resolve(`Error: tool "${toolDef.name}" has an empty command`);
        return;
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

      const child = spawn(cmd, args, {
        cwd: this.skillDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TOOL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        signal,
      });

      let stdout = '';
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < MAX_TOOL_OUTPUT) {
          stdout += stdoutDecoder.write(data);
          if (stdout.length > MAX_TOOL_OUTPUT) {
            stdout = stdout.slice(0, MAX_TOOL_OUTPUT);
          }
        }
      });
      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < MAX_TOOL_OUTPUT) {
          stderr += stderrDecoder.write(data);
          if (stderr.length > MAX_TOOL_OUTPUT) {
            stderr = stderr.slice(0, MAX_TOOL_OUTPUT);
          }
        }
      });

      child.on('close', (code) => {
        // Flush any bytes the decoder buffered because a multi-byte UTF-8
        // codepoint straddled the final chunk boundary.
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }
        this.logger.debug?.(
          { tool: toolDef.name, code, stderrLen: stderr.length },
          'skill tool exited non-zero',
        );
        resolve(`Error (exit ${code}): ${stderr.trim() || stdout.trim()}`);
      });

      child.on('error', (err) => {
        resolve(`Error: ${err.message}`);
      });
    });
  }
}
