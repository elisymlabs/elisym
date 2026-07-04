/**
 * Shared SKILL.md runtime types. A skill is a markdown document whose
 * YAML frontmatter declares capabilities, pricing, and optional
 * tool-use shape; the markdown body is the system prompt the LLM runs
 * against.
 */

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
   * `ELISYM_OUTPUT_DIR`). When set, each is seeded + delivered as its own
   * attachment; `outputMime` applies to all. Mutually exclusive with `filePath`
   * (the runtime prefers `filePaths` when both are somehow present).
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

/**
 * Optional per-skill LLM override declared in SKILL.md frontmatter.
 *
 * Parse-time invariant (enforced by `validateLlmOverride` in the loader):
 * `provider` is set iff `model` is set. `maxTokens` is independent. So
 * downstream code may rely on: when `provider !== undefined`, `model` is
 * also defined.
 */
export interface SkillLlmOverride {
  provider?: string;
  model?: string;
  maxTokens?: number;
}

export interface SkillContext {
  /** Agent-default LLM client. May be undefined when every LLM skill overrides. */
  llm?: LlmClient;
  /**
   * Resolve the LLM client for a skill. The runtime caches clients by
   * resolved (provider, model, maxTokens) triple. Callers pass their
   * `llmOverride` (or undefined for the agent default).
   */
  getLlm?: (override?: SkillLlmOverride) => LlmClient | undefined;
  /**
   * x402 protocol driver for `mode: 'x402'` skills. Injected by the elisym
   * CLI runtime; absent in SDK-only hosts (which also refuse to LOAD x402
   * skills - see `LoadSkillsOptions.allowX402Skills`).
   */
  x402?: X402Invoker;
  agentName: string;
  agentDescription: string;
  signal?: AbortSignal;
}

/**
 * How the runtime produces a result for a job:
 * - `llm`: feed input through Anthropic/OpenAI with the skill's system prompt (default).
 * - `static-file`: return the contents of a fixed file. No input required.
 * - `static-script`: spawn a script with no stdin. No input required.
 * - `dynamic-script`: spawn a script and pipe the user's input to stdin.
 * - `x402`: proxy the job to an x402-paid HTTP upstream; the host runtime pays
 *   the upstream from the agent's wallet. Requires an x402-capable host (the
 *   elisym CLI) that injects `SkillContext.x402` - gated at load time via
 *   `LoadSkillsOptions.allowX402Skills`.
 *
 * Static modes (and an x402 GET skill without a query param) set
 * `card.static = true` so the webapp hides its input box.
 */
export type SkillMode = 'llm' | 'static-file' | 'static-script' | 'dynamic-script' | 'x402';

/**
 * Static configuration of an x402 bridge skill, parsed from SKILL.md
 * frontmatter (`x402_*` fields). All money values are integer subunits.
 */
export interface X402SkillParams {
  /** Upstream resource URL (https only). */
  url: string;
  /** HTTP method for the upstream call. Buyer input maps to the POST body or a GET query param. */
  method: 'GET' | 'POST';
  /** Query parameter carrying the buyer input (GET only). Absent on GET => the skill takes no input. */
  queryParam?: string;
  /**
   * Ceiling on the upstream quote in subunits of the upstream asset. The
   * host's payment layer must refuse to sign anything above it - this is the
   * operator's wallet protection against upstream repricing.
   */
  maxUpstreamSubunits: bigint;
  /**
   * Ceiling on the buyer input size in bytes (inline UTF-8 length, or an
   * attachment's declared size). Enforced by the host BEFORE the customer
   * pays - upstream request-body limits are opaque, so an oversized input
   * would otherwise fail deterministically after payment.
   */
  maxInputBytes: number;
}

/** Upstream response mapped by Content-Type: text inline, anything else as a file. */
export interface X402ProxyResult {
  data: string;
  outputMime?: string;
  /**
   * Set for a non-text upstream body. The file is owned by the host's
   * idempotency cache (delivery source for crash recovery) - the skill must
   * NOT attach a cleanup callback for it; the cache's TTL sweep deletes it.
   */
  filePath?: string;
}

/**
 * Host-provided x402 protocol driver. Implemented by the elisym CLI runtime
 * (payment signing, requirement policies, idempotency, error classification
 * all live host-side); the SDK's `X402ProxySkill` only delegates to it.
 */
export interface X402Invoker {
  /**
   * Pre-payment gate: verify the wallet invariant, probe the live 402 quote
   * against `maxUpstreamSubunits`, check balance/margin and the input-size
   * rules. Throws to refuse the job before the customer pays.
   */
  preflight(params: X402SkillParams, input: SkillInput): Promise<void>;
  /** Perform the paid upstream call (or return a cached result for this jobId). */
  execute(
    params: X402SkillParams,
    input: SkillInput,
    signal?: AbortSignal,
  ): Promise<X402ProxyResult>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Array<{ name: string; description: string; required: boolean }>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  content: string;
}

export type CompletionResult =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; calls: ToolCall[]; assistantMessage: unknown };

export interface LlmClient {
  complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string>;
  completeWithTools(
    systemPrompt: string,
    messages: unknown[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult>;
  formatToolResultMessages(results: ToolResult[]): unknown[];
}

/** Provider id. Plain string so the registry stays open to additions without type-union edits. */
export type LlmProvider = string;

export interface LlmClientConfig {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export interface Skill {
  name: string;
  description: string;
  capabilities: string[];
  /** Price in subunits of `asset` (lamports for SOL, 1e-6 USDC for USDC). */
  priceSubunits: bigint;
  /** Asset the price is denominated in (NATIVE_SOL or USDC_SOLANA_DEVNET, etc.). */
  asset: import('../payment/assets').Asset;
  /** Execution mode. Default 'llm' for back-compat. */
  mode: SkillMode;
  /**
   * Optional per-skill LLM config / dependency.
   *
   * For mode 'llm', this overrides the agent default model/provider/max_tokens.
   * For script modes, the (provider, model) pair declares which LLM API key
   * the script depends on so the agent runtime can health-monitor it
   * (startup probe + reactive markUnhealthy + lazy recovery). `max_tokens`
   * is forbidden in script modes (the script controls its own limits).
   */
  llmOverride?: SkillLlmOverride;
  image?: string;
  imageFile?: string;
  /**
   * Optional pre-payment gate. The runtime calls it BEFORE the customer pays
   * (and before the job enters the ledger); throwing refuses the job with an
   * error feedback and no payment. `input` is the pre-payment view: inline
   * text, tags and jobId only - a file input is fetched after payment, so
   * `filePath` is never set here.
   */
  preflight?(input: SkillInput, ctx: SkillContext): Promise<void>;
  execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput>;
}
