import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { LAMPORTS_PER_SOL } from '../constants';
import {
  type Asset,
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  parseAssetAmount,
  resolveKnownAsset,
} from '../payment/assets';
import { DynamicScriptSkill } from './dynamicScriptSkill';
import { resolveInsidePath } from './path-safety';
import { DEFAULT_SCRIPT_TIMEOUT_MS, ScriptSkill, type SkillToolDef } from './scriptSkill';
import { StaticFileSkill } from './staticFileSkill';
import { StaticScriptSkill } from './staticScriptSkill';
import type { Skill, SkillLlmOverride, SkillMode } from './types';

const VALID_PROVIDERS: readonly SkillLlmOverride['provider'][] = ['anthropic', 'openai'] as const;
const MAX_TOKENS_LIMIT = 200_000;

export const DEFAULT_MAX_TOOL_ROUNDS = 10;

const VALID_MODES: readonly SkillMode[] = [
  'llm',
  'static-file',
  'static-script',
  'dynamic-script',
] as const;

export interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  capabilities?: unknown;
  price?: unknown;
  /** Lowercase token id ('sol', 'usdc'). Defaults to 'sol' for back-compat. */
  token?: unknown;
  /** SPL mint (base58). Optional - resolved from known assets when omitted. */
  mint?: unknown;
  image?: unknown;
  image_file?: unknown;
  tools?: unknown;
  max_tool_rounds?: unknown;
  /** Optional per-skill LLM provider override ('anthropic' | 'openai'). Pairs with `model`. */
  provider?: unknown;
  /** Optional per-skill LLM model override. Pairs with `provider`. */
  model?: unknown;
  /** Optional per-skill max_tokens override. Independent of provider/model. */
  max_tokens?: unknown;
  /** Execution mode. Default 'llm'. */
  mode?: unknown;
  /** Required when mode === 'static-file'. Path relative to skill dir. */
  output_file?: unknown;
  /** Required when mode === 'static-script' | 'dynamic-script'. Path relative to skill dir. */
  script?: unknown;
  /** Optional positional args appended after the script. */
  script_args?: unknown;
  /** Optional override of `DEFAULT_SCRIPT_TIMEOUT_MS`. */
  script_timeout_ms?: unknown;
}

export interface ParsedSkill {
  name: string;
  description: string;
  capabilities: string[];
  /** Price in subunits of `asset`. */
  priceSubunits: bigint;
  asset: Asset;
  mode: SkillMode;
  systemPrompt: string;
  tools: SkillToolDef[];
  maxToolRounds: number;
  /**
   * Per-skill LLM override (only present when mode === 'llm' and the SKILL.md
   * declared at least one of `provider`/`model`/`max_tokens`). Parse-time
   * invariant: `provider` set iff `model` set.
   */
  llmOverride?: SkillLlmOverride;
  image?: string;
  imageFile?: string;
  /** Set when mode === 'static-file'. */
  outputFile?: string;
  /** Set when mode is a script mode. */
  script?: string;
  /** Empty when no script. */
  scriptArgs: string[];
  /** Undefined => caller uses `DEFAULT_SCRIPT_TIMEOUT_MS`. */
  scriptTimeoutMs?: number;
}

export interface LoaderLogger {
  debug?(obj: Record<string, unknown>, msg?: string): void;
  warn?(obj: Record<string, unknown>, msg?: string): void;
}

export interface LoadSkillsOptions {
  /**
   * When true, SKILL.md may declare `price: 0` or omit `price` entirely
   * and the skill is loaded as free (`priceLamports === 0n`). Default
   * false: paid-only (plugin's historical behaviour).
   */
  allowFreeSkills?: boolean;
  logger?: LoaderLogger;
}

function solToLamports(sol: string | number): bigint {
  const asNumber = typeof sol === 'string' ? Number(sol) : sol;
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    throw new Error(`Invalid SOL amount: ${sol}`);
  }
  return BigInt(Math.round(asNumber * LAMPORTS_PER_SOL));
}

/**
 * Resolve the asset a SKILL.md declares.
 *
 * - `token` absent or `'sol'` => native SOL (NATIVE_SOL).
 * - `token: 'usdc'` (+ optional `mint`) => resolved via `resolveKnownAsset`;
 *   falls back to `USDC_SOLANA_DEVNET` when `mint` is omitted so operators
 *   don't need to memorize the devnet mint address.
 * - Any unknown `token` throws.
 */
function resolveSkillAsset(skillName: string, token: unknown, mint: unknown): Asset {
  if (token === undefined || token === null) {
    return NATIVE_SOL;
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`SKILL.md "${skillName}": "token" must be a non-empty string`);
  }
  let mintString: string | undefined;
  if (mint === undefined || mint === null) {
    mintString = undefined;
  } else if (typeof mint === 'string') {
    mintString = mint;
  } else {
    throw new Error(`SKILL.md "${skillName}": "mint" must be a base58 string`);
  }

  const normalized = token.toLowerCase();
  if (normalized === 'sol') {
    return NATIVE_SOL;
  }
  if (normalized === 'usdc' && mintString === undefined) {
    return USDC_SOLANA_DEVNET;
  }
  const resolved = resolveKnownAsset('solana', normalized, mintString);
  if (!resolved) {
    const display = mintString ? `solana:${normalized}:${mintString}` : `solana:${normalized}`;
    throw new Error(
      `SKILL.md "${skillName}": unknown asset ${display}. ` +
        `Known assets: sol, usdc (devnet mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU).`,
    );
  }
  return resolved;
}

export function parseSkillMd(content: string): {
  frontmatter: SkillFrontmatter;
  systemPrompt: string;
} {
  const lines = content.split('\n');
  let start = -1;
  let end = -1;

  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.trim() === '---') {
      if (start === -1) {
        start = index;
      } else {
        end = index;
        break;
      }
    }
  }

  if (start === -1 || end === -1) {
    throw new Error('SKILL.md must have YAML frontmatter between --- delimiters');
  }

  const yamlStr = lines.slice(start + 1, end).join('\n');
  const frontmatter = YAML.parse(yamlStr) as SkillFrontmatter;
  const systemPrompt = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  return { frontmatter, systemPrompt };
}

function validateTool(raw: unknown, skillName: string, index: number): SkillToolDef {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`skill "${skillName}" tool[${index}] must be an object`);
  }
  const tool = raw as Record<string, unknown>;
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new Error(`skill "${skillName}" tool[${index}] missing name`);
  }
  if (typeof tool.description !== 'string' || tool.description.length === 0) {
    throw new Error(`skill "${skillName}" tool "${tool.name}" missing description`);
  }
  if (!Array.isArray(tool.command) || tool.command.length === 0) {
    throw new Error(`skill "${skillName}" tool "${tool.name}" missing command[] array`);
  }
  for (const part of tool.command) {
    if (typeof part !== 'string') {
      throw new Error(`skill "${skillName}" tool "${tool.name}" command[] must be strings`);
    }
  }
  const parameters: SkillToolDef['parameters'] = [];
  if (tool.parameters !== undefined) {
    if (!Array.isArray(tool.parameters)) {
      throw new Error(`skill "${skillName}" tool "${tool.name}" parameters must be an array`);
    }
    for (let paramIndex = 0; paramIndex < tool.parameters.length; paramIndex++) {
      const param = tool.parameters[paramIndex];
      if (typeof param !== 'object' || param === null) {
        throw new Error(
          `skill "${skillName}" tool "${tool.name}" parameter[${paramIndex}] must be an object`,
        );
      }
      const record = param as Record<string, unknown>;
      if (typeof record.name !== 'string' || record.name.length === 0) {
        throw new Error(
          `skill "${skillName}" tool "${tool.name}" parameter[${paramIndex}] missing name`,
        );
      }
      if (typeof record.description !== 'string') {
        throw new Error(
          `skill "${skillName}" tool "${tool.name}" parameter "${record.name}" missing description`,
        );
      }
      parameters.push({
        name: record.name,
        description: record.description,
        required: record.required === undefined ? undefined : Boolean(record.required),
      });
    }
  }
  return {
    name: tool.name,
    description: tool.description,
    command: tool.command as string[],
    parameters,
  };
}

function validateMode(skillName: string, raw: unknown): SkillMode {
  if (raw === undefined || raw === null) {
    return 'llm';
  }
  if (typeof raw !== 'string') {
    throw new Error(`SKILL.md "${skillName}": "mode" must be a string`);
  }
  if (!(VALID_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `SKILL.md "${skillName}": invalid mode "${raw}". Allowed: ${VALID_MODES.join(', ')}`,
    );
  }
  return raw as SkillMode;
}

function validateScriptArgs(skillName: string, raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`SKILL.md "${skillName}": "script_args" must be an array of strings`);
  }
  for (const part of raw) {
    if (typeof part !== 'string') {
      throw new Error(`SKILL.md "${skillName}": "script_args" entries must be strings`);
    }
  }
  return raw as string[];
}

/**
 * Parse the optional per-skill LLM override block. The all-or-nothing rule
 * applies to (`provider`, `model`); `max_tokens` is independent.
 *
 * Returns `undefined` when no LLM override fields are declared at all.
 * Throws on partial pair, invalid provider, empty model, or out-of-range
 * max_tokens.
 *
 * Rejects all three fields when `mode !== 'llm'`.
 */
function validateLlmOverride(
  skillName: string,
  frontmatter: SkillFrontmatter,
  mode: SkillMode,
): SkillLlmOverride | undefined {
  const hasProvider = frontmatter.provider !== undefined && frontmatter.provider !== null;
  const hasModel = frontmatter.model !== undefined && frontmatter.model !== null;
  const hasMaxTokens = frontmatter.max_tokens !== undefined && frontmatter.max_tokens !== null;

  if (!hasProvider && !hasModel && !hasMaxTokens) {
    return undefined;
  }

  if (mode !== 'llm') {
    throw new Error(
      `SKILL.md "${skillName}": "provider"/"model"/"max_tokens" are only valid in mode 'llm' (got '${mode}')`,
    );
  }

  if (hasProvider !== hasModel) {
    throw new Error(
      `SKILL.md "${skillName}": "provider" and "model" must be set together (declare both, or neither)`,
    );
  }

  const override: SkillLlmOverride = {};

  if (hasProvider && hasModel) {
    if (typeof frontmatter.provider !== 'string') {
      throw new Error(`SKILL.md "${skillName}": "provider" must be a string`);
    }
    if (!(VALID_PROVIDERS as readonly string[]).includes(frontmatter.provider)) {
      throw new Error(
        `SKILL.md "${skillName}": invalid provider "${frontmatter.provider}". Allowed: ${VALID_PROVIDERS.join(', ')}`,
      );
    }
    if (typeof frontmatter.model !== 'string' || frontmatter.model.length === 0) {
      throw new Error(`SKILL.md "${skillName}": "model" must be a non-empty string`);
    }
    override.provider = frontmatter.provider as 'anthropic' | 'openai';
    override.model = frontmatter.model;
  }

  if (hasMaxTokens) {
    if (
      typeof frontmatter.max_tokens !== 'number' ||
      !Number.isInteger(frontmatter.max_tokens) ||
      frontmatter.max_tokens <= 0 ||
      frontmatter.max_tokens > MAX_TOKENS_LIMIT
    ) {
      throw new Error(
        `SKILL.md "${skillName}": "max_tokens" must be a positive integer <= ${MAX_TOKENS_LIMIT}`,
      );
    }
    override.maxTokens = frontmatter.max_tokens;
  }

  return override;
}

function validateScriptTimeoutMs(skillName: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`SKILL.md "${skillName}": "script_timeout_ms" must be a positive integer`);
  }
  return raw;
}

export function validateSkillFrontmatter(
  frontmatter: SkillFrontmatter,
  systemPrompt: string,
  options: LoadSkillsOptions = {},
): ParsedSkill {
  if (typeof frontmatter.name !== 'string' || frontmatter.name.length === 0) {
    throw new Error('SKILL.md: missing or invalid "name" field');
  }
  if (typeof frontmatter.description !== 'string' || frontmatter.description.length === 0) {
    throw new Error('SKILL.md: missing or invalid "description" field');
  }
  if (!Array.isArray(frontmatter.capabilities) || frontmatter.capabilities.length === 0) {
    throw new Error('SKILL.md: "capabilities" must be a non-empty array');
  }
  const capabilities: string[] = [];
  for (const capability of frontmatter.capabilities) {
    if (typeof capability !== 'string' || capability.length === 0) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": capability entries must be non-empty strings`,
      );
    }
    capabilities.push(capability);
  }

  const asset = resolveSkillAsset(frontmatter.name, frontmatter.token, frontmatter.mint);

  let priceSubunits: bigint;
  if (frontmatter.price === undefined || frontmatter.price === null) {
    if (!options.allowFreeSkills) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "price" is required (${asset.symbol}; e.g. ${
          asset === NATIVE_SOL ? '0.002' : '0.05'
        }). Free skills are not supported on the protocol yet.`,
      );
    }
    priceSubunits = 0n;
  } else {
    const priceRaw = frontmatter.price;
    if (typeof priceRaw !== 'number' && typeof priceRaw !== 'string') {
      throw new Error(`SKILL.md "${frontmatter.name}": "price" must be a number or numeric string`);
    }
    const priceString = typeof priceRaw === 'number' ? String(priceRaw) : priceRaw;
    if (asset === NATIVE_SOL) {
      // Preserve historical rounding behaviour: number * LAMPORTS_PER_SOL +
      // Math.round. `parseAssetAmount` would reject non-positive inputs before
      // we could check `allowFreeSkills`, so we keep the legacy path for SOL
      // and introduce the strict parser only for new token types.
      priceSubunits = solToLamports(priceRaw);
    } else {
      try {
        priceSubunits = parseAssetAmount(asset, priceString);
      } catch (error) {
        throw new Error(
          `SKILL.md "${frontmatter.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (priceSubunits <= 0n && !options.allowFreeSkills) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": price must be > 0 ${asset.symbol} (got ${priceRaw}); free skills are not yet supported`,
      );
    }
  }

  const mode = validateMode(frontmatter.name, frontmatter.mode);

  const tools: SkillToolDef[] = [];
  if (frontmatter.tools !== undefined) {
    if (mode !== 'llm') {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "tools" is only valid in mode 'llm' (got '${mode}')`,
      );
    }
    if (!Array.isArray(frontmatter.tools)) {
      throw new Error(`SKILL.md "${frontmatter.name}": "tools" must be an array`);
    }
    for (let index = 0; index < frontmatter.tools.length; index++) {
      tools.push(validateTool(frontmatter.tools[index], frontmatter.name, index));
    }
  }

  let maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS;
  if (frontmatter.max_tool_rounds !== undefined) {
    if (mode !== 'llm') {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "max_tool_rounds" is only valid in mode 'llm' (got '${mode}')`,
      );
    }
    if (
      typeof frontmatter.max_tool_rounds !== 'number' ||
      !Number.isInteger(frontmatter.max_tool_rounds) ||
      frontmatter.max_tool_rounds <= 0
    ) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "max_tool_rounds" must be a positive integer`,
      );
    }
    maxToolRounds = frontmatter.max_tool_rounds;
  }

  let outputFile: string | undefined;
  let script: string | undefined;
  let scriptArgs: string[] = [];
  let scriptTimeoutMs: number | undefined;

  if (mode === 'static-file') {
    if (typeof frontmatter.output_file !== 'string' || frontmatter.output_file.length === 0) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": mode 'static-file' requires "output_file" (string)`,
      );
    }
    if (frontmatter.script !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "script" is not valid in mode 'static-file'`,
      );
    }
    outputFile = frontmatter.output_file;
  } else if (mode === 'static-script' || mode === 'dynamic-script') {
    if (typeof frontmatter.script !== 'string' || frontmatter.script.length === 0) {
      throw new Error(`SKILL.md "${frontmatter.name}": mode '${mode}' requires "script" (string)`);
    }
    if (frontmatter.output_file !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "output_file" is only valid in mode 'static-file'`,
      );
    }
    script = frontmatter.script;
    scriptArgs = validateScriptArgs(frontmatter.name, frontmatter.script_args);
    scriptTimeoutMs = validateScriptTimeoutMs(frontmatter.name, frontmatter.script_timeout_ms);
  } else {
    if (frontmatter.output_file !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "output_file" is only valid in mode 'static-file'`,
      );
    }
    if (frontmatter.script !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "script" is only valid in script modes (static-script, dynamic-script)`,
      );
    }
    if (frontmatter.script_args !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "script_args" is only valid in script modes`,
      );
    }
    if (frontmatter.script_timeout_ms !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "script_timeout_ms" is only valid in script modes`,
      );
    }
  }

  const image = typeof frontmatter.image === 'string' ? frontmatter.image : undefined;
  const imageFile = typeof frontmatter.image_file === 'string' ? frontmatter.image_file : undefined;

  const llmOverride = validateLlmOverride(frontmatter.name, frontmatter, mode);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    capabilities,
    priceSubunits,
    asset,
    mode,
    systemPrompt,
    tools,
    maxToolRounds,
    llmOverride,
    image,
    imageFile,
    outputFile,
    script,
    scriptArgs,
    scriptTimeoutMs,
  };
}

function buildSkillFromParsed(parsed: ParsedSkill, skillDir: string, logger: LoaderLogger): Skill {
  switch (parsed.mode) {
    case 'llm':
      return new ScriptSkill({
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: parsed.priceSubunits,
        asset: parsed.asset,
        skillDir,
        systemPrompt: parsed.systemPrompt,
        tools: parsed.tools,
        maxToolRounds: parsed.maxToolRounds,
        llmOverride: parsed.llmOverride,
        image: parsed.image,
        imageFile: parsed.imageFile,
        logger,
      });
    case 'static-file': {
      if (parsed.outputFile === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - outputFile missing for mode 'static-file'`,
        );
      }
      const outputFilePath = resolveInsidePath(skillDir, parsed.outputFile);
      if (!outputFilePath) {
        throw new Error(
          `SKILL.md "${parsed.name}": "output_file" must stay inside the skill directory`,
        );
      }
      return new StaticFileSkill({
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: parsed.priceSubunits,
        asset: parsed.asset,
        outputFilePath,
        image: parsed.image,
        imageFile: parsed.imageFile,
      });
    }
    case 'static-script':
    case 'dynamic-script': {
      if (parsed.script === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - script missing for mode '${parsed.mode}'`,
        );
      }
      const scriptPath = resolveInsidePath(skillDir, parsed.script);
      if (!scriptPath) {
        throw new Error(`SKILL.md "${parsed.name}": "script" must stay inside the skill directory`);
      }
      const Ctor = parsed.mode === 'static-script' ? StaticScriptSkill : DynamicScriptSkill;
      return new Ctor({
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: parsed.priceSubunits,
        asset: parsed.asset,
        scriptPath,
        scriptArgs: parsed.scriptArgs,
        scriptTimeoutMs: parsed.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
        image: parsed.image,
        imageFile: parsed.imageFile,
      });
    }
  }
}

/**
 * Walk `skillsDir`, load each immediate subdirectory's SKILL.md, and
 * return constructed `Skill` instances (LLM or non-LLM depending on
 * frontmatter `mode`). Malformed directories are skipped with a `warn` log.
 */
export function loadSkillsFromDir(skillsDir: string, options: LoadSkillsOptions = {}): Skill[] {
  const logger = options.logger ?? {};
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch (error) {
    logger.debug?.({ err: error, skillsDir }, 'skills directory not readable; no skills loaded');
    return skills;
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const skillMdPath = join(entryPath, 'SKILL.md');
    try {
      const content = readFileSync(skillMdPath, 'utf-8');
      const { frontmatter, systemPrompt } = parseSkillMd(content);
      const parsed = validateSkillFrontmatter(frontmatter, systemPrompt, options);
      skills.push(buildSkillFromParsed(parsed, entryPath, logger));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.({ dir: entry, err: message }, 'skipping malformed skill directory');
    }
  }

  return skills;
}
