import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { LIMITS } from '../constants';
import { type SkillDelegation, validateSkillDelegation } from '../delegation';
import type { SkillRateLimit } from '../llm-health/types';
import { validateSkillOnchain } from '../onchain/schema';
import type { SkillOnchainResolved } from '../onchain/types';
import {
  type Asset,
  KNOWN_ASSETS,
  LSM_SOLANA_MAINNET,
  NATIVE_SOL,
  parseAssetAmount,
  resolveKnownAsset,
  resolveLsmAsset,
  resolveUsdcAsset,
} from '../payment/assets';
import type { Network } from '../types';
import { DynamicScriptSkill } from './dynamicScriptSkill';
import { OnchainCallSkill } from './onchainCallSkill';
import { resolveInsidePathReal } from './path-safety';
import { DEFAULT_SCRIPT_TIMEOUT_MS, ScriptSkill, type SkillToolDef } from './scriptSkill';
import { StaticFileSkill } from './staticFileSkill';
import { StaticScriptSkill } from './staticScriptSkill';
import type { Skill, SkillLlmOverride, SkillMode, X402SkillParams } from './types';
import { X402ProxySkill } from './x402ProxySkill';

const MAX_TOKENS_LIMIT = 200_000;

export const DEFAULT_MAX_TOOL_ROUNDS = 10;

const VALID_MODES: readonly SkillMode[] = [
  'llm',
  'static-file',
  'static-script',
  'dynamic-script',
  'x402',
  'onchain',
] as const;

/**
 * Default ceiling on buyer input size for x402 skills (bytes). Conservative:
 * upstream request-body limits are opaque (express.json defaults to 100KB,
 * nginx to 1MiB) and an over-limit POST fails only AFTER the customer paid.
 * Operators raise it per skill via `x402_max_input_bytes` when the upstream
 * is known to accept more; hard cap is `LIMITS.MAX_REINLINE_TEXT_BYTES`.
 */
export const DEFAULT_X402_MAX_INPUT_BYTES = 100_000;

export interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  capabilities?: unknown;
  price?: unknown;
  /**
   * Lowercase token id ('sol', 'usdc', 'lsm'). Defaults to 'sol' for
   * back-compat. `lsm` is mainnet-only - on devnet it falls back to SOL
   * pricing at the same numeric price, with a load-time warning.
   */
  token?: unknown;
  /** SPL mint (base58). Optional - resolved from known assets when omitted. */
  mint?: unknown;
  image?: unknown;
  image_file?: unknown;
  tools?: unknown;
  max_tool_rounds?: unknown;
  /**
   * LLM provider id. For `mode: 'llm'` this overrides the agent default for
   * runtime LLM execution. For script modes, it declares the LLM the script
   * depends on so the agent can health-monitor the API key (startup probe +
   * reactive markUnhealthy + lazy recovery). Pairs with `model`.
   */
  provider?: unknown;
  /** LLM model id. Same semantics as `provider`. Must be set together with `provider`. */
  model?: unknown;
  /** Per-skill max_tokens override. Only valid for `mode: 'llm'`. */
  max_tokens?: unknown;
  /**
   * Conversation-context participation (default false). Only valid for
   * `mode: 'llm'` - declaring it on any other mode is a parse-time error,
   * mirroring the `max_tokens` rule.
   */
  context?: unknown;
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
  /**
   * MIME type for a file result. Only valid in mode 'dynamic-script' (the only
   * mode that can emit a file via `ELISYM_OUTPUT_FILE`). Becomes the iroh
   * attachment's mime; defaults to `application/octet-stream` when omitted.
   */
  output_mime?: unknown;
  /**
   * MIME the skill expects as a file input. Only valid in mode 'dynamic-script'
   * (the only mode that receives a file via `ELISYM_INPUT_FILE`). Discovery hint
   * only - the runtime still content-sniffs the actual file and does not enforce
   * this. Convention: `*` = any file, `image/*` = any image, `image/png` =
   * exact. Its presence signals "this capability needs a file input".
   */
  input_mime?: unknown;
  /**
   * How the skill treats a text prompt alongside a file input (`dynamic-script`
   * only; meaningful only with `input_mime`). `'none'` = file only, `'optional'` =
   * file optional + instruction required (a generate-or-edit skill), `'required'` =
   * needs both. Omitted = file required + optional note. Discovery hint only; lets
   * the web app show/hide/gate its text box and file picker for file jobs.
   */
  input_text?: unknown;
  /**
   * Optional per-skill rate limit. Applies to any skill mode. Snake-case
   * keys here match the YAML frontmatter convention; parsed into camelCase
   * `rateLimit` on `ParsedSkill`.
   */
  rate_limit?: unknown;
  /**
   * Optional per-skill execution budget in seconds. Applies to any skill mode.
   * `0` means unlimited. Omitted => the runtime falls through to the agent-level
   * `execution_timeout_secs`, then to unlimited.
   */
  max_execution_secs?: unknown;
  /** Required when mode === 'x402'. Upstream resource URL (https only). */
  x402_url?: unknown;
  /** HTTP method for the upstream call ('GET' | 'POST'). Default 'POST'. x402 mode only. */
  x402_method?: unknown;
  /** Query parameter carrying the buyer input. GET upstreams only; absent => skill takes no input. */
  x402_query_param?: unknown;
  /**
   * Required when mode === 'x402'. Ceiling on the upstream quote in integer
   * subunits of the upstream asset (recorded at `elisym x402 add` time). The
   * host's payment layer refuses to sign anything above it.
   */
  x402_max_upstream?: unknown;
  /**
   * Ceiling on buyer input size in bytes (x402 mode only). Default
   * `DEFAULT_X402_MAX_INPUT_BYTES`; hard cap `LIMITS.MAX_REINLINE_TEXT_BYTES`.
   */
  x402_max_input_bytes?: unknown;
  /**
   * Optional delegated-execution descriptor (v1: `spl-approve`). Declares that
   * the agent accepts a bounded USDC allowance for this capability. The
   * `delegate_pubkey` is NOT written here - it is derived from the agent's
   * `solana_delegate_secret_key` and injected into the card at `buildCard`.
   * Applies to any skill mode.
   */
  delegation?: unknown;
  /**
   * Required for `mode: 'onchain'`, rejected everywhere else: the capability's
   * public promise about the Solana calls it may return - the complete program
   * allowlist, the asset, and both ceilings. Ceilings are written in display
   * units and resolved to subunits here; the network is stamped at `buildCard`.
   */
  onchain?: unknown;
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
   * Per-skill LLM override / dependency. Present when SKILL.md declared at
   * least one of `provider`/`model`/`max_tokens`. Parse-time invariant:
   * `provider` set iff `model` set; `max_tokens` only when mode === 'llm'.
   *
   * For mode 'llm': the runtime uses these to construct the LLM client.
   * For script modes: the (provider, model) pair declares the API key the
   * script depends on so the agent can health-monitor it.
   */
  llmOverride?: SkillLlmOverride;
  /** Conversation-context participation (`context: true`, llm mode only). */
  context: boolean;
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
  /** MIME for a file result (mode 'dynamic-script' only). */
  outputMime?: string;
  /**
   * MIME the skill expects as a file input (mode 'dynamic-script' only).
   * Discovery hint only; not enforced at runtime. Presence signals the
   * capability needs a file input (clients gate file-only flows on it).
   */
  inputMime?: string;
  /**
   * How the skill treats a text prompt with a file input (mode 'dynamic-script'
   * only). `'none'` = file only, `'optional'` = file optional + instruction
   * required, `'required'` = both required. Discovery hint; clients (the web app)
   * gate their text box and file picker on it. Absent = file required + optional text.
   */
  inputText?: 'required' | 'optional' | 'none';
  /** Optional per-skill rate limit (any mode). */
  rateLimit?: SkillRateLimit;
  /**
   * Per-skill execution budget in seconds (any mode). `0` => explicitly
   * unlimited. `undefined` => caller falls through to the agent-level default,
   * then to unlimited.
   */
  executionTimeoutSecs?: number;
  /** Set when mode === 'x402': the parsed `x402_*` frontmatter block. */
  x402?: X402SkillParams;
  /**
   * True when the skill consumes no buyer input (x402 GET without a query
   * param). Hosts mark the discovery card `static` so clients hide the input
   * box instead of silently dropping what the buyer typed.
   */
  noInput?: boolean;
  /**
   * Delegated-execution descriptor declared in frontmatter (no
   * `delegate_pubkey`). Present when the skill opts into `spl-approve` bounded
   * delegation; the host injects the delegate pubkey at `buildCard`.
   */
  delegation?: SkillDelegation;
  /**
   * Set when mode === 'onchain': the published promise with its asset and both
   * ceilings resolved to subunits. No `network` - the host stamps it from the
   * agent's wallet at `buildCard`.
   */
  onchain?: SkillOnchainResolved;
}

export interface LoaderLogger {
  debug?(obj: Record<string, unknown>, msg?: string): void;
  warn?(obj: Record<string, unknown>, msg?: string): void;
}

export interface LoadSkillsOptions {
  /**
   * The agent's Solana network. Required (not defaulted): `token: usdc`
   * resolves to a different mint per cluster, and an explicit `mint:` must be
   * canonical for this network - a devnet default would let an SDK-only host
   * silently publish a card carrying the wrong-network mint (unpayable).
   */
  network: Network;
  /**
   * When true, SKILL.md may declare `price: 0` or omit `price` entirely
   * and the skill is loaded as free (`priceLamports === 0n`). Default
   * false: paid-only (plugin's historical behaviour).
   */
  allowFreeSkills?: boolean;
  /**
   * When true, `mode: 'x402'` skills load. Default false: an x402 skill
   * needs a host runtime that injects `SkillContext.x402` (the elisym CLI);
   * an SDK-only host (e.g. the ElizaOS plugin) must fail at load time -
   * NOT after a customer has paid for a job the skill cannot execute.
   * `loadSkillsFromDir` then skips the skill with a warning.
   */
  allowX402Skills?: boolean;
  /**
   * Env for script-mode skills (`static-script`, `dynamic-script`). When
   * omitted, script subprocesses fall back to a scoped copy of `process.env`
   * with known secret env vars stripped (see `scopedToolEnv`) - never the raw
   * parent env.
   */
  scriptEnv?: NodeJS.ProcessEnv;
  logger?: LoaderLogger;
}

function solToLamports(sol: string | number): bigint {
  const asString = (typeof sol === 'string' ? sol : String(sol)).trim();
  // Free skills declare price 0; `parseAssetAmount` rejects non-positive amounts,
  // so the zero case is handled here. Everything else goes through the exact
  // integer/string parser - no floating-point multiply (see money-math rule).
  if (/^0+(?:\.0+)?$/.test(asString)) {
    return 0n;
  }
  try {
    return parseAssetAmount(NATIVE_SOL, asString);
  } catch {
    throw new Error(`Invalid SOL amount: ${sol}`);
  }
}

/**
 * Resolve the asset a SKILL.md declares, for the agent's network.
 *
 * - `token` absent or `'sol'` => native SOL (NATIVE_SOL).
 * - `token: 'usdc'` with `mint` omitted => the canonical USDC mint for
 *   `network` (operators don't need to memorize mint addresses).
 * - `token: 'lsm'` => the mainnet LSM asset on mainnet; on devnet (where LSM
 *   does not exist) the skill FALLS BACK to native SOL at the same numeric
 *   price, with a loud warning - never silently. An explicit `mint:` that is
 *   not the canonical LSM mint fails loud on both networks.
 * - Any other explicit `mint:` must be canonical for `network` -
 *   `resolveKnownAsset` is network-blind, so without the gate a SKILL.md
 *   copied from an agent on the other network would load with that network's
 *   mint and publish an unpayable card. Fails loud at load, both directions.
 * - Any unknown `token` throws, listing the current `KNOWN_ASSETS` token ids.
 */
function resolveSkillAsset(
  skillName: string,
  token: unknown,
  mint: unknown,
  network: Network,
  logger?: LoaderLogger,
): Asset {
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
    return resolveUsdcAsset(network);
  }
  if (normalized === 'lsm') {
    if (mintString !== undefined && mintString !== LSM_SOLANA_MAINNET.mint) {
      throw new Error(
        `SKILL.md "${skillName}": mint ${mintString} is not the canonical LSM mint ` +
          `(expected ${LSM_SOLANA_MAINNET.mint}). Omit "mint" to resolve it automatically.`,
      );
    }
    const lsm = resolveLsmAsset(network);
    if (lsm) {
      return lsm;
    }
    // LSM is mainnet-only; on devnet the skill degrades to default (SOL)
    // pricing at the same numeric price - loud by design. When the host
    // supplies no logger, console.warn is the documented fallback for this
    // one warning: a silently reinterpreted price would be an invisible
    // currency change.
    const message =
      `SKILL.md "${skillName}": token "lsm" is mainnet-only - falling back to SOL pricing ` +
      `on this ${network} agent. The numeric price is charged in SOL (e.g. price 25 = 25 SOL).`;
    if (logger?.warn) {
      logger.warn({ skill: skillName, network }, message);
    } else {
      console.warn(message);
    }
    return NATIVE_SOL;
  }
  const resolved = resolveKnownAsset('solana', normalized, mintString);
  if (!resolved) {
    const display = mintString ? `solana:${normalized}:${mintString}` : `solana:${normalized}`;
    const knownTokens = [...new Set(KNOWN_ASSETS.map((asset) => asset.token))].join(', ');
    throw new Error(
      `SKILL.md "${skillName}": unknown asset ${display}. ` +
        `Known assets: ${knownTokens} (mints resolve from the agent's network; omit "mint").`,
    );
  }
  // Canonical-mint gate: `lsm` resolves in its own arm above, so any minted
  // asset reaching this flat path is a USDC variant and must match the
  // agent's network. A future SPL asset needs its own per-network canonical
  // resolution here.
  if (resolved.mint !== undefined) {
    const canonical = resolveUsdcAsset(network);
    if (resolved.mint !== canonical.mint) {
      throw new Error(
        `SKILL.md "${skillName}": mint ${resolved.mint} is not the canonical ${resolved.symbol} ` +
          `mint for ${network} (expected ${canonical.mint}). This skill was likely copied from ` +
          `an agent on the other network - omit "mint" to resolve it from the agent's network.`,
      );
    }
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
  const parsedYaml: unknown = YAML.parse(yamlStr);
  // Empty or scalar frontmatter parses to null/string/number - fail with the
  // intended message instead of a TypeError deep inside field validation.
  if (parsedYaml === null || typeof parsedYaml !== 'object' || Array.isArray(parsedYaml)) {
    throw new Error('SKILL.md: frontmatter must be a YAML mapping');
  }
  const frontmatter = parsedYaml as SkillFrontmatter;
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
 * Parse the optional per-skill LLM override / dependency block. The
 * all-or-nothing rule applies to (`provider`, `model`); `max_tokens` is
 * independent.
 *
 * Semantics by mode:
 * - `mode: 'llm'`: provider+model override the agent default for runtime
 *   LLM execution. `max_tokens` overrides the agent default cap.
 * - script modes (`static-script` / `dynamic-script` / `static-file`):
 *   provider+model declare which LLM key the script depends on so the
 *   agent runtime can health-monitor it (startup probe + reactive
 *   markUnhealthy on `SCRIPT_EXIT_BILLING_EXHAUSTED` + lazy recovery).
 *   `max_tokens` is rejected here - it has no runtime effect because
 *   the script handles its own LLM call and token limits.
 *
 * Returns `undefined` when no LLM fields are declared at all.
 * Throws on partial pair, invalid provider, empty model, out-of-range
 * max_tokens, or `max_tokens` declared on a non-llm mode.
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

  if (mode === 'x402') {
    // x402 skills call no LLM and spawn no script - there is no API key to
    // health-monitor, so a declared pair would silently do nothing.
    throw new Error(
      `SKILL.md "${skillName}": "provider"/"model"/"max_tokens" are not valid in mode 'x402'`,
    );
  }

  if (hasMaxTokens && mode !== 'llm') {
    throw new Error(
      `SKILL.md "${skillName}": "max_tokens" is only valid in mode 'llm' (got '${mode}'). For script modes, control token limits inside the script.`,
    );
  }

  if (hasProvider !== hasModel) {
    throw new Error(
      `SKILL.md "${skillName}": "provider" and "model" must be set together (declare both, or neither)`,
    );
  }

  const override: SkillLlmOverride = {};

  if (hasProvider && hasModel) {
    if (typeof frontmatter.provider !== 'string' || frontmatter.provider.length === 0) {
      throw new Error(`SKILL.md "${skillName}": "provider" must be a non-empty string`);
    }
    if (typeof frontmatter.model !== 'string' || frontmatter.model.length === 0) {
      throw new Error(`SKILL.md "${skillName}": "model" must be a non-empty string`);
    }
    override.provider = frontmatter.provider;
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

/**
 * Parse the optional `context` frontmatter flag (conversation-context
 * participation). Valid on the modes that consume customer input per message:
 * `llm` (history goes into the LLM messages) and `dynamic-script` (history is
 * handed to the script via `ELISYM_HISTORY_FILE`). Static modes ignore input
 * entirely and `x402` state belongs to the upstream, so a declared flag would
 * silently do nothing there; rejecting it at parse time mirrors the
 * `max_tokens` rule above.
 */
function validateContext(skillName: string, value: unknown, mode: SkillMode): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`SKILL.md "${skillName}": "context" must be a boolean`);
  }
  if (mode !== 'llm' && mode !== 'dynamic-script') {
    throw new Error(
      `SKILL.md "${skillName}": "context" is only valid in modes 'llm' and 'dynamic-script' (got '${mode}')`,
    );
  }
  return value;
}

const MAX_RATE_LIMIT_WINDOW_SECS = 86400;
const MAX_RATE_LIMIT_PER_WINDOW = 10000;

/**
 * Parse the optional per-skill `rate_limit` block. Snake-case in YAML,
 * camelCase in the returned shape. Returns `undefined` when absent.
 *
 * Throws on partial or out-of-range values - we want operators to notice
 * misconfigurations at startup rather than have them silently fall back
 * to defaults at runtime.
 */
function validateRateLimit(skillName: string, raw: unknown): SkillRateLimit | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object') {
    throw new Error(`SKILL.md "${skillName}": "rate_limit" must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const perWindowSecs = record.per_window_secs;
  const maxPerWindow = record.max_per_window;
  if (
    typeof perWindowSecs !== 'number' ||
    !Number.isInteger(perWindowSecs) ||
    perWindowSecs < 1 ||
    perWindowSecs > MAX_RATE_LIMIT_WINDOW_SECS
  ) {
    throw new Error(
      `SKILL.md "${skillName}": "rate_limit.per_window_secs" must be an integer between 1 and ${MAX_RATE_LIMIT_WINDOW_SECS}`,
    );
  }
  if (
    typeof maxPerWindow !== 'number' ||
    !Number.isInteger(maxPerWindow) ||
    maxPerWindow < 1 ||
    maxPerWindow > MAX_RATE_LIMIT_PER_WINDOW
  ) {
    throw new Error(
      `SKILL.md "${skillName}": "rate_limit.max_per_window" must be an integer between 1 and ${MAX_RATE_LIMIT_PER_WINDOW}`,
    );
  }
  return {
    perWindowMs: perWindowSecs * 1000,
    maxPerWindow,
  };
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

// Friendly parse-time check for `output_mime`. The on-wire FileAttachment schema
// independently caps mime at 255 bytes; this just keeps a malformed value out of
// the skill instance with a clear message.
function validateOutputMime(skillName: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      `SKILL.md "${skillName}": "output_mime" must be a non-empty string (e.g. "image/png")`,
    );
  }
  if (raw.length > 255) {
    throw new Error(`SKILL.md "${skillName}": "output_mime" too long (max 255 chars)`);
  }
  return raw;
}

// Parse-time check for `input_mime`. Discovery hint only (the runtime sniffs the
// real file); no MIME-grammar validation so the `*`/`image/*` convention passes.
// Capped at 255 chars to match the read-side guard in `parseCapabilityEvent`.
function validateInputMime(skillName: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      `SKILL.md "${skillName}": "input_mime" must be a non-empty string (e.g. "image/png" or "*")`,
    );
  }
  if (raw.length > 255) {
    throw new Error(`SKILL.md "${skillName}": "input_mime" too long (max 255 chars)`);
  }
  return raw;
}

const INPUT_TEXT_VALUES = ['required', 'optional', 'none'] as const;

// Parse-time check for `input_text` (whether a file skill also takes a text prompt).
// Discovery hint only; enforced as a strict enum at author-time so a typo fails fast.
function validateInputText(
  skillName: string,
  raw: unknown,
): 'required' | 'optional' | 'none' | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string' || !(INPUT_TEXT_VALUES as readonly string[]).includes(raw)) {
    throw new Error(
      `SKILL.md "${skillName}": "input_text" must be one of "required", "optional", "none"`,
    );
  }
  return raw as 'required' | 'optional' | 'none';
}

function validateMaxExecutionSecs(skillName: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  // Mode-agnostic: applies to every skill mode. `0` is allowed and means
  // "explicitly unlimited" (overrides any agent-level cap back to no limit).
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `SKILL.md "${skillName}": "max_execution_secs" must be a non-negative integer (0 = unlimited)`,
    );
  }
  if (raw > LIMITS.MAX_EXECUTION_SECS) {
    throw new Error(
      `SKILL.md "${skillName}": "max_execution_secs" must be <= ${LIMITS.MAX_EXECUTION_SECS} (larger values overflow setTimeout)`,
    );
  }
  return raw;
}

const X402_METHODS = ['GET', 'POST'] as const;

/**
 * Parse and validate the `x402_*` frontmatter block. Returns `undefined` for
 * every non-x402 mode (throwing if any `x402_*` field is present there).
 * For `mode: 'x402'` the whole block is rejected unless the host opted in
 * via `allowX402Skills` - see `LoadSkillsOptions`.
 */
function validateX402Config(
  skillName: string,
  frontmatter: SkillFrontmatter,
  mode: SkillMode,
  options: LoadSkillsOptions,
): X402SkillParams | undefined {
  const fieldNames = [
    'x402_url',
    'x402_method',
    'x402_query_param',
    'x402_max_upstream',
    'x402_max_input_bytes',
  ] as const;
  const presentFields = fieldNames.filter(
    (field) => frontmatter[field] !== undefined && frontmatter[field] !== null,
  );

  if (mode !== 'x402') {
    if (presentFields.length > 0) {
      throw new Error(
        `SKILL.md "${skillName}": "${presentFields[0]}" is only valid in mode 'x402'`,
      );
    }
    return undefined;
  }

  if (!options.allowX402Skills) {
    throw new Error(
      `SKILL.md "${skillName}": x402 skills require the elisym CLI runtime; this host cannot execute mode 'x402'`,
    );
  }

  if (typeof frontmatter.x402_url !== 'string' || frontmatter.x402_url.length === 0) {
    throw new Error(`SKILL.md "${skillName}": mode 'x402' requires "x402_url" (string)`);
  }
  let url: URL;
  try {
    url = new URL(frontmatter.x402_url);
  } catch {
    throw new Error(`SKILL.md "${skillName}": "x402_url" is not a valid URL`);
  }
  // Loopback http is allowed so a locally-run x402 server (the guide's demo,
  // test fixtures) can be bridged; anything remote must be https - payment
  // headers over plain http leak to the network.
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(
      `SKILL.md "${skillName}": "x402_url" must be an https:// URL (plain http is allowed for localhost only)`,
    );
  }

  let method: X402SkillParams['method'] = 'POST';
  if (frontmatter.x402_method !== undefined && frontmatter.x402_method !== null) {
    if (
      typeof frontmatter.x402_method !== 'string' ||
      !(X402_METHODS as readonly string[]).includes(frontmatter.x402_method)
    ) {
      throw new Error(
        `SKILL.md "${skillName}": "x402_method" must be one of ${X402_METHODS.join(', ')}`,
      );
    }
    method = frontmatter.x402_method as X402SkillParams['method'];
  }

  let queryParam: string | undefined;
  if (frontmatter.x402_query_param !== undefined && frontmatter.x402_query_param !== null) {
    if (method !== 'GET') {
      throw new Error(
        `SKILL.md "${skillName}": "x402_query_param" is only valid with x402_method 'GET' (POST maps the input to the request body)`,
      );
    }
    if (
      typeof frontmatter.x402_query_param !== 'string' ||
      frontmatter.x402_query_param.length === 0
    ) {
      throw new Error(`SKILL.md "${skillName}": "x402_query_param" must be a non-empty string`);
    }
    if (url.searchParams.has(frontmatter.x402_query_param)) {
      throw new Error(
        `SKILL.md "${skillName}": "x402_query_param" ("${frontmatter.x402_query_param}") collides with a parameter already present in "x402_url"`,
      );
    }
    queryParam = frontmatter.x402_query_param;
  }

  const rawMaxUpstream = frontmatter.x402_max_upstream;
  if (rawMaxUpstream === undefined || rawMaxUpstream === null) {
    throw new Error(
      `SKILL.md "${skillName}": mode 'x402' requires "x402_max_upstream" (integer subunits - the ceiling on the upstream quote)`,
    );
  }
  let maxUpstreamSubunits: bigint;
  if (typeof rawMaxUpstream === 'number' && Number.isSafeInteger(rawMaxUpstream)) {
    maxUpstreamSubunits = BigInt(rawMaxUpstream);
  } else if (typeof rawMaxUpstream === 'string' && /^[0-9]+$/.test(rawMaxUpstream)) {
    maxUpstreamSubunits = BigInt(rawMaxUpstream);
  } else {
    throw new Error(
      `SKILL.md "${skillName}": "x402_max_upstream" must be a non-negative integer (subunits)`,
    );
  }
  if (maxUpstreamSubunits <= 0n) {
    throw new Error(`SKILL.md "${skillName}": "x402_max_upstream" must be > 0`);
  }

  let maxInputBytes = DEFAULT_X402_MAX_INPUT_BYTES;
  if (frontmatter.x402_max_input_bytes !== undefined && frontmatter.x402_max_input_bytes !== null) {
    const raw = frontmatter.x402_max_input_bytes;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      throw new Error(
        `SKILL.md "${skillName}": "x402_max_input_bytes" must be a positive integer (bytes)`,
      );
    }
    if (raw > LIMITS.MAX_REINLINE_TEXT_BYTES) {
      throw new Error(
        `SKILL.md "${skillName}": "x402_max_input_bytes" must be <= ${LIMITS.MAX_REINLINE_TEXT_BYTES} (inputs above it never reach the skill as text)`,
      );
    }
    maxInputBytes = raw;
  }

  return {
    url: frontmatter.x402_url,
    method,
    queryParam,
    maxUpstreamSubunits,
    maxInputBytes,
  };
}

export function validateSkillFrontmatter(
  frontmatter: SkillFrontmatter,
  systemPrompt: string,
  options: LoadSkillsOptions,
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

  const asset = resolveSkillAsset(
    frontmatter.name,
    frontmatter.token,
    frontmatter.mint,
    options.network,
    options.logger,
  );

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
      // SOL prices route through `solToLamports`, which uses the same exact
      // integer parser as other assets but tolerates a 0 price so the
      // `allowFreeSkills` check below can run (parseAssetAmount rejects 0).
      priceSubunits = solToLamports(priceString);
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
  let outputMime: string | undefined;
  let inputMime: string | undefined;
  let inputText: 'required' | 'optional' | 'none' | undefined;

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
    if (frontmatter.output_mime !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "output_mime" is only valid in mode 'dynamic-script'`,
      );
    }
    if (frontmatter.input_mime !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "input_mime" is only valid in mode 'dynamic-script'`,
      );
    }
    if (frontmatter.input_text !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "input_text" is only valid in mode 'dynamic-script'`,
      );
    }
    outputFile = frontmatter.output_file;
  } else if (mode === 'static-script' || mode === 'dynamic-script' || mode === 'onchain') {
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
    // Only dynamic-script can exchange files (via ELISYM_OUTPUT_FILE / ELISYM_INPUT_FILE).
    if (mode === 'dynamic-script') {
      outputMime = validateOutputMime(frontmatter.name, frontmatter.output_mime);
      inputMime = validateInputMime(frontmatter.name, frontmatter.input_mime);
      inputText = validateInputText(frontmatter.name, frontmatter.input_text);
    } else {
      if (frontmatter.output_mime !== undefined) {
        throw new Error(
          `SKILL.md "${frontmatter.name}": "output_mime" is only valid in mode 'dynamic-script'`,
        );
      }
      if (frontmatter.input_mime !== undefined) {
        throw new Error(
          `SKILL.md "${frontmatter.name}": "input_mime" is only valid in mode 'dynamic-script'`,
        );
      }
      if (frontmatter.input_text !== undefined) {
        throw new Error(
          `SKILL.md "${frontmatter.name}": "input_text" is only valid in mode 'dynamic-script'`,
        );
      }
    }
  } else {
    if (frontmatter.output_file !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "output_file" is only valid in mode 'static-file'`,
      );
    }
    if (frontmatter.script !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "script" is only valid in script modes (static-script, dynamic-script, onchain)`,
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
    if (frontmatter.output_mime !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "output_mime" is only valid in mode 'dynamic-script'`,
      );
    }
    if (frontmatter.input_mime !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "input_mime" is only valid in mode 'dynamic-script'`,
      );
    }
    if (frontmatter.input_text !== undefined) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "input_text" is only valid in mode 'dynamic-script'`,
      );
    }
  }

  const image = typeof frontmatter.image === 'string' ? frontmatter.image : undefined;
  const imageFile = typeof frontmatter.image_file === 'string' ? frontmatter.image_file : undefined;

  const llmOverride = validateLlmOverride(frontmatter.name, frontmatter, mode);
  const context = validateContext(frontmatter.name, frontmatter.context, mode);
  const rateLimit = validateRateLimit(frontmatter.name, frontmatter.rate_limit);
  const executionTimeoutSecs = validateMaxExecutionSecs(
    frontmatter.name,
    frontmatter.max_execution_secs,
  );
  const x402 = validateX402Config(frontmatter.name, frontmatter, mode, options);
  const delegation = validateSkillDelegation(frontmatter.name, frontmatter.delegation);
  // LOAD-TIME money invariant: a delegated pull moves `priceSubunits` as USDC
  // subunits (`buildDelegatedTransfer`), so a skill priced in any other asset
  // (e.g. SOL lamports, 9 decimals) would pull a wildly wrong USDC amount.
  // Enforced here - not in `validateSkillDelegation`, which cannot see the
  // asset - so a mis-priced skill fails loud at load and never reaches the
  // NIP-89 card. Symbol comparison is network-independent and mainnet-safe
  // (`network` is not in scope here). The runtime keeps its own asset guard as
  // defense-in-depth.
  if (delegation !== undefined && asset.symbol !== 'USDC') {
    throw new Error(
      `SKILL.md "${frontmatter.name}": a "delegation" block requires a USDC-priced skill ` +
        `(got ${asset.symbol}). Delegated pulls transfer the price in USDC subunits.`,
    );
  }

  const onchain = resolveSkillOnchain(frontmatter.name, frontmatter.onchain, mode, options);

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
    context,
    image,
    imageFile,
    outputFile,
    script,
    scriptArgs,
    scriptTimeoutMs,
    outputMime,
    inputMime,
    inputText,
    rateLimit,
    executionTimeoutSecs,
    x402,
    noInput:
      x402 === undefined ? undefined : x402.method === 'GET' && x402.queryParam === undefined,
    delegation,
    onchain,
  };
}

/**
 * Resolve the `onchain:` block: the operator writes display amounts and a token
 * id, the card carries subunits and a mint.
 *
 * The block and the mode move together. A block without `mode: onchain` would
 * publish a promise nothing fulfills, and the mode without a block would ship a
 * capability whose calls no client can check - both are load-time errors, on
 * the operator's own file, where they are fixable.
 */
function resolveSkillOnchain(
  skillName: string,
  raw: unknown,
  mode: SkillMode,
  options: LoadSkillsOptions,
): SkillOnchainResolved | undefined {
  const block = validateSkillOnchain(skillName, raw);
  if (mode !== 'onchain') {
    if (block !== undefined) {
      throw new Error(
        `SKILL.md "${skillName}": an "onchain" block requires mode 'onchain' (got '${mode}')`,
      );
    }
    return undefined;
  }
  if (block === undefined) {
    throw new Error(`SKILL.md "${skillName}": mode 'onchain' requires an "onchain" block`);
  }

  const asset = resolveSkillAsset(
    skillName,
    block.token,
    block.mint,
    options.network,
    options.logger,
  );
  // `resolveSkillAsset` degrades `lsm` to SOL on devnet, which is right for a
  // PRICE (same number, cheaper asset) and wrong for a CEILING: "1000 LSM"
  // would silently become a 1000 SOL bound. Fail loud instead.
  if (asset.token !== block.token) {
    throw new Error(
      `SKILL.md "${skillName}": "onchain.token" is ${block.token}, which does not exist on ` +
        `${options.network}. A ceiling must be denominated in the asset it bounds - change the ` +
        'token, or run this capability on the network that has it.',
    );
  }
  for (const param of block.params) {
    if (!(ONCHAIN_PARAM_TYPES as readonly string[]).includes(param.type)) {
      throw new Error(
        `SKILL.md "${skillName}": unknown "onchain.params" type "${param.type}". ` +
          `Allowed: ${ONCHAIN_PARAM_TYPES.join(', ')}`,
      );
    }
  }
  const spendSubunits = ceilingToSubunits(skillName, 'max_per_call', block.max_per_call, asset);
  const authoritySubunits = ceilingToSubunits(
    skillName,
    'max_authority',
    block.max_authority,
    asset,
  );
  return {
    kind: block.kind,
    programs: block.programs,
    requires: block.requires,
    params: block.params,
    token: asset.token,
    ...(asset.mint ? { mint: asset.mint } : {}),
    decimals: asset.decimals,
    symbol: asset.symbol,
    max_per_call_subunits: spendSubunits.toString(),
    grants_authority: block.grants_authority,
    max_authority_subunits: authoritySubunits.toString(),
  };
}

/**
 * Parameter types a client knows how to render. Enforced on the operator's own
 * file only: the card schema keeps `type` a bounded string so an older client
 * meeting a future type renders it as text instead of losing the descriptor.
 */
const ONCHAIN_PARAM_TYPES = ['amount', 'address', 'text', 'integer'] as const;

/**
 * Display amount to subunits for a ceiling. `"0"` is legitimate here (a call
 * that moves nothing, or a capability that grants no authority), and
 * `parseAssetAmount` rejects non-positive amounts, so zero is handled before it.
 */
function ceilingToSubunits(skillName: string, field: string, amount: string, asset: Asset): bigint {
  if (/^0+(?:\.0+)?$/.test(amount)) {
    return 0n;
  }
  try {
    return parseAssetAmount(asset, amount);
  } catch (error) {
    throw new Error(
      `SKILL.md "${skillName}": invalid "onchain.${field}" (${amount}) for ${asset.symbol}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildSkillFromParsed(
  parsed: ParsedSkill,
  skillDir: string,
  logger: LoaderLogger,
  network: Network,
  scriptEnv?: NodeJS.ProcessEnv,
): Skill {
  // Containment for `image_file`, matching `script`/`output_file` (which throw).
  // The image is decorative, so an out-of-dir path is dropped with a warning
  // rather than failing the load. Without this, `image_file: ../../.secrets.json`
  // would be read and uploaded to a public media host at startup (exfiltration).
  let imageFile = parsed.imageFile;
  if (imageFile !== undefined && resolveInsidePathReal(skillDir, imageFile) === null) {
    logger.warn?.(
      { skill: parsed.name, imageFile },
      'SKILL.md "image_file" escapes the skill directory (directly or via symlink); ignoring it',
    );
    imageFile = undefined;
  }
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
        context: parsed.context,
        image: parsed.image,
        imageFile,
        logger,
      });
    case 'static-file': {
      if (parsed.outputFile === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - outputFile missing for mode 'static-file'`,
        );
      }
      const outputFilePath = resolveInsidePathReal(skillDir, parsed.outputFile);
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
        skillDir,
        image: parsed.image,
        imageFile,
        llmOverride: parsed.llmOverride,
      });
    }
    case 'static-script':
    case 'dynamic-script': {
      if (parsed.script === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - script missing for mode '${parsed.mode}'`,
        );
      }
      // Symlink-aware like output_file/image_file: a script symlink escaping the
      // skill directory is rejected at load time rather than executed.
      const scriptPath = resolveInsidePathReal(skillDir, parsed.script);
      if (!scriptPath) {
        throw new Error(`SKILL.md "${parsed.name}": "script" must stay inside the skill directory`);
      }
      const scriptParams = {
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: parsed.priceSubunits,
        asset: parsed.asset,
        scriptPath,
        scriptArgs: parsed.scriptArgs,
        scriptTimeoutMs: parsed.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
        scriptEnv,
        image: parsed.image,
        imageFile,
        llmOverride: parsed.llmOverride,
      };
      // Only dynamic-script supports a file result and conversation context,
      // so `outputMime`/`context` are threaded only there (StaticScriptSkill
      // has no such params).
      return parsed.mode === 'dynamic-script'
        ? new DynamicScriptSkill({
            ...scriptParams,
            outputMime: parsed.outputMime,
            context: parsed.context,
          })
        : new StaticScriptSkill(scriptParams);
    }
    case 'onchain': {
      if (parsed.script === undefined || parsed.onchain === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - script or onchain block missing for mode 'onchain'`,
        );
      }
      const scriptPath = resolveInsidePathReal(skillDir, parsed.script);
      if (!scriptPath) {
        throw new Error(`SKILL.md "${parsed.name}": "script" must stay inside the skill directory`);
      }
      return new OnchainCallSkill({
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: parsed.priceSubunits,
        asset: parsed.asset,
        scriptPath,
        scriptArgs: parsed.scriptArgs,
        scriptTimeoutMs: parsed.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
        scriptEnv,
        image: parsed.image,
        imageFile,
        llmOverride: parsed.llmOverride,
        onchain: parsed.onchain,
        network,
      });
    }
    case 'x402': {
      if (parsed.x402 === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - x402 config missing for mode 'x402'`,
        );
      }
      return new X402ProxySkill({
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: parsed.priceSubunits,
        asset: parsed.asset,
        x402: parsed.x402,
        image: parsed.image,
        imageFile,
      });
    }
  }
}

/**
 * Walk `skillsDir`, load each immediate subdirectory's SKILL.md, and
 * return constructed `Skill` instances (LLM or non-LLM depending on
 * frontmatter `mode`). Malformed directories are skipped with a `warn` log.
 */
export function loadSkillsFromDir(skillsDir: string, options: LoadSkillsOptions): Skill[] {
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
      skills.push(
        buildSkillFromParsed(parsed, entryPath, logger, options.network, options.scriptEnv),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.({ dir: entry, err: message }, 'skipping malformed skill directory');
    }
  }

  return skills;
}
