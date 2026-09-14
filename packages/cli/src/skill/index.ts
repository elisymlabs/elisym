/**
 * Skill interface and registry.
 */

import { toDTag, type Asset, type SkillDelegation, type SkillOnchainResolved } from '@elisym/sdk';
import type { SkillRateLimit } from '@elisym/sdk/llm-health';
import type { ChatTurn, SkillLlmOverride, SkillMode, X402SkillParams } from '@elisym/sdk/skills';

export type { ChatTurn, SkillLlmOverride, SkillMode, SkillRateLimit, X402SkillParams };

/**
 * Resolved (provider, model, maxTokens) triple for an LLM-mode skill.
 * Computed once at startup in `start.ts` after `resolveSkillLlm`, then
 * attached to the skill instance so the runtime preflight can read it
 * without re-running resolution from `loaded.yaml`.
 */
export interface ResolvedSkillTriple {
  provider: string;
  model: string;
  maxTokens: number;
}

export interface SkillInput {
  data: string;
  inputType: string;
  tags: string[];
  jobId: string;
  /**
   * Local path to a file input fetched out-of-band (P2P via iroh), when the job
   * carried a file attachment. The runtime fetches it after payment and removes
   * it after execution; the skill reads from disk rather than from `data`.
   */
  filePath?: string;
  /**
   * Prior conversation turns of the job's session, oldest first. Present only
   * when the job carries a session id AND the invoked skill declares
   * `context: true`. An llm skill sees `[...history, current input]`; a
   * dynamic-script skill receives the turns via `ELISYM_HISTORY_FILE`.
   */
  history?: ChatTurn[];
  /**
   * The job's session id (UUID v4), when the invoked skill takes the session
   * path (`context: true`). Lets a script key its own upstream conversation
   * state (`ELISYM_SESSION_ID`); llm skills ignore it - the runtime owns
   * their transcript.
   */
  sessionId?: string;
}

export interface SkillOutput {
  data: string;
  outputMime?: string;
  /**
   * Local path to a file result. When set, the runtime seeds the file via iroh
   * and the customer fetches it out-of-band; `data` carries any text note (or '').
   * `outputMime` is reused as the attachment's mime.
   */
  filePath?: string;
  /**
   * Local paths to MULTIPLE file results (a skill that wrote several files to
   * `ELISYM_OUTPUT_DIR`). Each is seeded + delivered as its own attachment;
   * `outputMime` applies to all. The runtime prefers `filePaths` over `filePath`.
   */
  filePaths?: string[];
  /**
   * Releases the resources backing `filePath`/`filePaths` (e.g. a temp dir). The
   * runtime calls it once it has seeded the file(s) - or failed to - since seeding
   * happens after `execute()` returns and the producer cannot release them itself.
   * Mirrors the input-side cleanup callback in the runtime's `resolveInputFile`.
   */
  cleanup?: () => Promise<void>;
}

export interface SkillContext {
  /** Agent-default LLM client. Undefined when every LLM skill overrides. */
  llm?: LlmClient;
  /**
   * Resolve the LLM client for a skill. The runtime caches clients by
   * resolved (provider, model, maxTokens) triple. Pass the skill's
   * `llmOverride` (or undefined for the agent default).
   */
  getLlm?: (override?: SkillLlmOverride) => LlmClient | undefined;
  /**
   * x402 protocol driver for `mode: 'x402'` skills. Wired by `start.ts`
   * when at least one x402 skill loads (implementation: `src/x402/driver.ts`).
   * Named `x402Driver` (not `x402`) so the CLI context stays structurally
   * assignable to the SDK's `SkillContext`, whose `x402` slot has a
   * different (SDK-side) driver shape.
   */
  x402Driver?: X402JobDriver;
  agentName: string;
  agentDescription: string;
  signal?: AbortSignal;
}

/** What the x402 driver needs to know about the skill behind a job. */
export interface X402SkillJob {
  skillName: string;
  params: X402SkillParams;
  /** elisym-side price in subunits of `asset` (the customer-facing price). */
  priceSubunits: number;
  asset: Asset;
}

/**
 * The x402 protocol driver contract. All money-touching logic lives behind
 * it: payment signing with requirement policies, the pre-payment preflight,
 * the idempotency cache and error classification. Kept as an interface here
 * so the skill layer stays import-cycle-free from `src/x402/`.
 */
export interface X402JobDriver {
  /**
   * Pre-payment gate: wallet invariant, live 402 quote vs ceiling, float
   * balance, live margin, input-size rules. Throws (`X402PreflightError`)
   * to refuse the job BEFORE the customer pays. A cached completed result
   * short-circuits to success - delivery needs neither float nor upstream.
   */
  preflight(job: X402SkillJob, input: SkillInput): Promise<void>;
  /** Paid upstream call, or the cached result for this jobId. */
  execute(
    job: X402SkillJob,
    input: SkillInput,
    signal?: AbortSignal,
  ): Promise<{ data: string; outputMime?: string; filePath?: string }>;
}

export interface LlmClient {
  /**
   * Single completion. `history` (optional, trailing - existing implementations
   * stay type-compatible and simply run stateless until updated) carries prior
   * conversation turns to prepend before the current `userInput`.
   */
  complete(
    systemPrompt: string,
    userInput: string,
    signal?: AbortSignal,
    history?: ChatTurn[],
  ): Promise<string>;
  completeWithTools(
    systemPrompt: string,
    messages: any[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult>;
  /** Format tool results into provider-specific messages (Anthropic vs OpenAI). */
  formatToolResultMessages(results: ToolResult[]): any[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Array<{ name: string; description: string; required: boolean }>;
}

export type CompletionResult =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; calls: ToolCall[]; assistantMessage: any };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/** Provider-agnostic tool result passed from ScriptSkill to LlmClient. */
export interface ToolResult {
  callId: string;
  content: string;
}

/**
 * A skill that can be executed by the agent runtime.
 *
 * Skills should be idempotent or tolerant of re-execution: if the agent crashes
 * after execute() returns but before the result is persisted, recovery will
 * re-execute the skill with the same input (at-least-once delivery).
 */
export interface Skill {
  name: string;
  description: string;
  capabilities: string[];
  /**
   * Price in subunits of `asset` (0 = free). For SOL: lamports (1e-9 SOL).
   * For USDC: 1e-6 USDC. Converted from SKILL.md's human-readable `price`.
   *
   * Number (not bigint) for ergonomics - realistic agent prices fit well
   * below `Number.MAX_SAFE_INTEGER` subunits.
   */
  priceSubunits: number;
  /** Asset the price is denominated in (NATIVE_SOL or USDC_SOLANA_DEVNET, etc.). */
  asset: Asset;
  /** Execution mode (`'llm'` for the historical LLM-orchestrated path). */
  mode: SkillMode;
  /**
   * Per-skill LLM override / dependency.
   *
   * For `mode: 'llm'`: overrides the agent default (provider/model/maxTokens)
   * for runtime LLM execution. The runtime constructs the LLM client from this.
   *
   * For script modes: declares which LLM API key the script depends on so
   * the runtime can health-monitor it (startup probe + reactive markUnhealthy
   * on `SCRIPT_EXIT_BILLING_EXHAUSTED` + lazy recovery). Only `provider` and
   * `model` are meaningful here; `maxTokens` is rejected at parse time.
   */
  llmOverride?: SkillLlmOverride;
  /**
   * Whether this skill participates in conversation sessions (SKILL.md
   * frontmatter `context: true`; llm and dynamic-script modes only,
   * parse-time error otherwise). Optional - absent means `false`. When
   * enabled, a session-carrying job gets prior turns in `SkillInput.history`
   * (llm: into the LLM messages; dynamic-script: via `ELISYM_HISTORY_FILE`)
   * and its exchange is recorded to the session store.
   */
  context?: boolean;
  /** Hero image URL. */
  image?: string;
  /** Local file path for hero image (uploaded on first start). */
  imageFile?: string;
  /** On-disk skill directory (e.g. `<agent>/skills/whois-lookup`). */
  dir?: string;
  /**
   * Resolved (provider, model, maxTokens) for `mode: 'llm'` skills. Set
   * once at startup. Undefined for script modes - they use `llmOverride`
   * directly when declared. Read by the runtime to gate against the
   * `LlmHealthMonitor` before sending `payment-required`.
   */
  resolvedTriple?: ResolvedSkillTriple;
  /**
   * Optional per-skill rate limit declared in SKILL.md frontmatter
   * (snake_case `rate_limit` -> camelCase). Applies to any mode but the
   * runtime treats free LLM skills as the primary use case.
   */
  rateLimit?: SkillRateLimit;
  /**
   * Per-skill execution budget in seconds, from SKILL.md `max_execution_secs`
   * (any mode). `0` => explicitly unlimited. `undefined` => the runtime falls
   * through to the agent-level `executionTimeoutSecs`, then to unlimited.
   */
  executionTimeoutSecs?: number;
  /**
   * MIME the skill expects as a file input (`input_mime`, dynamic-script only).
   * Discovery hint published in the capability card; not enforced at runtime.
   * Presence signals the capability needs a file input (clients gate on it).
   */
  inputMime?: string;
  /** MIME of a file result (`output_mime`, dynamic-script only). */
  outputMime?: string;
  /**
   * Whether a file-input skill also accepts a text prompt (`input_text`,
   * dynamic-script only). Discovery hint published in the capability card.
   */
  inputText?: 'required' | 'optional' | 'none';
  /** Parsed `x402_*` frontmatter (mode 'x402' only). Read by the runtime's pre-payment input rules. */
  x402?: X402SkillParams;
  /**
   * True when the skill consumes no buyer input (x402 GET without a query
   * param). `buildCard` marks the discovery card `static` so clients hide
   * the input box instead of silently dropping what the buyer typed.
   */
  noInput?: boolean;
  /**
   * Delegated-execution descriptor from SKILL.md `delegation` frontmatter
   * (no `delegate_pubkey`; the host injects it at `buildCard` from the agent's
   * `solana_delegate_secret_key`). Present when the skill opts into
   * `spl-approve` bounded delegation. Advertised on the capability card.
   */
  delegation?: SkillDelegation;
  /**
   * The capability's on-chain promise (`mode: 'onchain'`): the program
   * allowlist, the asset and both ceilings, with amounts already in subunits.
   * `buildCard` stamps the agent's network onto it and publishes it; clients
   * verify every returned call against it before signing. The agent itself
   * never signs an on-chain call.
   */
  onchain?: SkillOnchainResolved;
  /**
   * Optional pre-payment gate. The runtime calls it BEFORE `recordPaid` /
   * payment collection (and in the recovery path BEFORE a retry slot is
   * consumed); throwing refuses/defers the job without touching customer
   * funds. `input.filePath` is never set here - file inputs are fetched
   * only after payment.
   */
  preflight?(input: SkillInput, ctx: SkillContext): Promise<void>;
  execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput>;
}

export class SkillRegistry {
  private skills: Skill[] = [];
  private defaultIndex: number | null = null;

  register(skill: Skill): void {
    if (this.defaultIndex === null) {
      this.defaultIndex = this.skills.length;
    }
    this.skills.push(skill);
  }

  route(tags: string[]): Skill | null {
    // Match by skill name in canonical d-tag form. Outgoing capability cards
    // publish `['d', toDTag(card.name)]`, so incoming job tags arrive
    // d-tag-shaped (lowercase, ASCII letters + digits + hyphens). Comparing
    // raw `skill.name` only works when the name is already kebab-case;
    // normalize through `toDTag` so human-readable names route too.
    for (const tag of tags) {
      const byName = this.skills.find((skill) => toDTag(skill.name) === tag);
      if (byName) {
        return byName;
      }
    }
    // Then declared capability tags (secondary matching).
    for (const tag of tags) {
      const byCap = this.skills.find((skill) => skill.capabilities.includes(tag));
      if (byCap) {
        return byCap;
      }
    }
    // Default fallback only for genuinely untargeted jobs (no specific tag
    // beyond the 'elisym' protocol marker). A job that *does* carry a
    // specific capability tag must not silently degrade to a free default -
    // that was a payment-bypass vector.
    const hasSpecificTag = tags.some((tag) => tag && tag !== 'elisym');
    if (hasSpecificTag) {
      return null;
    }
    return this.defaultIndex !== null ? this.skills[this.defaultIndex]! : null;
  }

  allCapabilities(): string[] {
    return this.skills.flatMap((s) => s.capabilities);
  }

  isEmpty(): boolean {
    return this.skills.length === 0;
  }

  all(): Skill[] {
    return this.skills;
  }
}
