/**
 * ScriptSkill - LLM orchestrator with tool-use via external scripts.
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  Skill,
  SkillInput,
  SkillOutput,
  SkillContext,
  ToolDef,
  ToolCall,
  ToolResult,
} from './index.js';

const MAX_TOOL_OUTPUT = 1_000_000; // 1MB limit per tool invocation

interface SkillToolDef {
  name: string;
  description: string;
  command: string[];
  parameters?: Array<{ name: string; description: string; required?: boolean }>;
}

export class ScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceLamports: number;
  image?: string;
  imageFile?: string;
  private skillDir: string;
  private systemPrompt: string;
  private tools: SkillToolDef[];
  private maxToolRounds: number;

  constructor(
    name: string,
    description: string,
    capabilities: string[],
    priceLamports: number,
    image: string | undefined,
    imageFile: string | undefined,
    skillDir: string,
    systemPrompt: string,
    tools: SkillToolDef[],
    maxToolRounds: number,
  ) {
    this.name = name;
    this.description = description;
    this.capabilities = capabilities;
    this.priceLamports = priceLamports;
    this.image = image;
    this.imageFile = imageFile;
    this.skillDir = skillDir;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.maxToolRounds = maxToolRounds;
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    if (!ctx.llm) {
      throw new Error('LLM client not configured');
    }

    // No tools: simple completion
    if (this.tools.length === 0) {
      const result = await ctx.llm.complete(this.systemPrompt, input.data, ctx.signal);
      return { data: result };
    }

    // Tool-use loop
    const toolDefs: ToolDef[] = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: (t.parameters ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        required: p.required ?? true,
      })),
    }));

    const messages: any[] = [{ role: 'user', content: input.data }];

    for (let round = 0; round < this.maxToolRounds; round++) {
      if (ctx.signal?.aborted) {
        throw new Error('Job aborted');
      }
      const result = await ctx.llm.completeWithTools(
        this.systemPrompt,
        messages,
        toolDefs,
        ctx.signal,
      );

      if (result.type === 'text') {
        return { data: result.text };
      }

      // Process tool calls
      messages.push(result.assistantMessage);

      const toolResults: ToolResult[] = [];
      for (const call of result.calls) {
        const toolDef = this.tools.find((t) => t.name === call.name);
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

      messages.push(...ctx.llm!.formatToolResultMessages(toolResults));
    }

    throw new Error(`Max tool rounds (${this.maxToolRounds}) exceeded`);
  }

  private runTool(toolDef: SkillToolDef, call: ToolCall, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, _reject) => {
      const args = [...toolDef.command];
      const cmd = args.shift()!;

      // Add parameters as arguments
      const params = toolDef.parameters ?? [];
      for (const param of params) {
        const value = call.arguments[param.name];
        if (value !== undefined) {
          if (param.required && params.indexOf(param) === 0) {
            // First required param as positional
            args.push(String(value));
          } else {
            args.push(`--${param.name}`, String(value));
          }
        }
      }

      const child = spawn(cmd, args, {
        cwd: this.skillDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
        killSignal: 'SIGKILL',
        signal,
      });

      let stdout = '';
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      child.stdout.on('data', (data: Buffer) => {
        if (stdout.length < MAX_TOOL_OUTPUT) {
          stdout += stdoutDecoder.write(data);
          if (stdout.length > MAX_TOOL_OUTPUT) {
            stdout = stdout.slice(0, MAX_TOOL_OUTPUT);
          }
        }
      });
      child.stderr.on('data', (data: Buffer) => {
        if (stderr.length < MAX_TOOL_OUTPUT) {
          stderr += stderrDecoder.write(data);
          if (stderr.length > MAX_TOOL_OUTPUT) {
            stderr = stderr.slice(0, MAX_TOOL_OUTPUT);
          }
        }
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          resolve(`Error (exit ${code}): ${stderr.trim() || stdout.trim()}`);
        }
      });

      child.on('error', (err) => {
        resolve(`Error: ${err.message}`);
      });
    });
  }
}
