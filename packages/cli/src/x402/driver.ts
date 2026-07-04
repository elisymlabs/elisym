/**
 * The x402 protocol driver: everything money-touching for `mode: 'x402'`
 * skills. Payment signing goes through `@x402/fetch` + `@x402/svm` with a
 * requirements policy as the wallet guard (nothing above the skill's ceiling
 * is ever signed, regardless of what the upstream re-quotes); the preflight
 * protects the CUSTOMER by refusing doomed jobs before they pay; the
 * idempotency store bounds the operator's worst case at
 * `X402_MAX_PAID_ATTEMPTS` upstream prices per job.
 *
 * NOTE: no `onPaymentResponse` / scheme hooks are registered here - on
 * purpose. The fetch wrapper has a dormant `result.recovered` branch that
 * re-signs a second payment inside one call when a hook requests it;
 * without hooks it is dead code, with hooks it would silently double the
 * maximum loss per attempt.
 */
import {
  USDC_SOLANA_DEVNET,
  calculateProtocolFee,
  formatAssetAmount,
  signerFromSecretKeyBase58,
} from '@elisym/sdk';
import {
  address,
  createSolanaRpc,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm';
import { fetchUsdcBalance } from '../helpers.js';
import type { SkillInput, X402JobDriver, X402SkillJob } from '../skill/index.js';
import {
  X402_GET_INPUT_MAX_ENCODED_BYTES,
  X402_MAX_CHALLENGE_BYTES,
  X402_MAX_PAID_ATTEMPTS,
  X402_MAX_RESPONSE_BYTES,
  X402_PROBE_TTL_MS,
  X402_SOLANA_DEVNET_CAIP2,
  X402_SOLANA_DEVNET_V1,
} from './constants.js';
import { X402PermanentError, X402PreflightError, X402TransientError } from './errors.js';
import { buildRequirementsPolicy, maxAcceptableQuote, type RequirementRule } from './matcher.js';
import { X402ProbeError, probePaymentRequiredCached } from './probe.js';
import { X402JobStore } from './store.js';

export interface X402DriverOptions {
  agentDir: string;
  /** Revenue address from `elisym.yaml` `payments[]`; must equal the signer address. */
  paymentsAddress?: string;
  /** Decrypted at-rest base58 `solana_secret_key`; absent => every job refused at preflight. */
  solanaSecretKeyBase58?: string;
  rpcUrl: string;
  /** Live protocol fee accessor (bps) - fetched fresh, mirrors `collectPayment`. */
  getFeeBps: () => Promise<number>;
  log?: (message: string) => void;
}

const CUSTOMER_INPUT_TOO_LARGE = 'Input too large for this skill.';

/**
 * Whether to send the buyer input as `application/json`. Requires a JSON
 * object or array - NOT a bare scalar. A buyer of a text upstream who happens
 * to send `1234` or `"hi"` (valid JSON scalars) would otherwise flip the
 * outgoing Content-Type to JSON and pick a different upstream code path,
 * turning a paid job into a post-payment failure. Structured bodies still
 * forward as JSON so real JSON upstreams keep working.
 */
function jsonContentType(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isTextContentType(contentType: string): boolean {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json');
}

/** Buffer the body while enforcing the untrusted-upstream size cap. */
async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new X402PermanentError(`upstream response too large (> ${maxBytes} bytes)`);
    }
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new X402PermanentError(`upstream response too large (> ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Re-materialize a 402 challenge response through a bounded reader before the
 * payment wrapper reads it uncapped. The wrapper buffers the initial 402 body
 * to parse the requirements; capping it here stops a hostile upstream from
 * sending a giant 402 on the paid call (probes are already capped) to OOM the
 * agent. Non-402 responses pass through untouched (the success body is capped
 * separately by `readBodyCapped`).
 */
async function capChallengeResponse(response: Response): Promise<Response> {
  if (response.status !== 402) {
    return response;
  }
  const bytes = await readBodyCapped(response, X402_MAX_CHALLENGE_BYTES);
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class X402Driver implements X402JobDriver {
  private readonly store: X402JobStore;
  private readonly rpc: Rpc<SolanaRpcApi>;
  private signerPromise: Promise<KeyPairSigner> | null = null;
  private readonly repriceHintLogged = new Set<string>();

  constructor(private readonly options: X402DriverOptions) {
    this.store = new X402JobStore(options.agentDir);
    this.rpc = createSolanaRpc(options.rpcUrl);
    // Fire-and-forget retention sweep; a failed sweep only delays cleanup.
    this.store.sweepExpired().catch(() => {});
  }

  private log(message: string): void {
    (this.options.log ?? console.log)(`[x402] ${message}`);
  }

  private getSigner(): Promise<KeyPairSigner> {
    const secret = this.options.solanaSecretKeyBase58;
    if (secret === undefined || secret.length === 0) {
      return Promise.reject(
        new X402PreflightError(
          'bridge wallet missing: .secrets.json has no solana_secret_key (run `npx @elisym/cli x402 add` to set it up)',
        ),
      );
    }
    if (this.signerPromise === null) {
      this.signerPromise = signerFromSecretKeyBase58(secret);
    }
    return this.signerPromise;
  }

  /** The single-wallet invariant: revenue lands where the upstream payer spends from. */
  private async assertWalletInvariant(): Promise<KeyPairSigner> {
    const signer = await this.getSigner();
    const paymentsAddress = this.options.paymentsAddress;
    if (paymentsAddress === undefined || paymentsAddress.length === 0) {
      throw new X402PreflightError(
        'elisym.yaml has no payments[] entry: revenue would not refill the bridge wallet (run `npx @elisym/cli x402 add` to fix)',
      );
    }
    if (signer.address !== paymentsAddress) {
      throw new X402PreflightError(
        `wallet invariant violated: payments[].address (${paymentsAddress}) differs from the solana_secret_key address (${signer.address}); ` +
          'revenue would accumulate in one wallet while jobs drain the other - align them (re-run `npx @elisym/cli x402 add` or fix elisym.yaml)',
      );
    }
    return signer;
  }

  private assertInputRules(job: X402SkillJob, input: SkillInput): void {
    const { params } = job;
    if (params.method === 'GET' && params.queryParam !== undefined) {
      const encodedBytes = Buffer.byteLength(encodeURIComponent(input.data), 'utf8');
      if (encodedBytes > X402_GET_INPUT_MAX_ENCODED_BYTES) {
        throw new X402PreflightError(
          `GET input too large: ${encodedBytes} percent-encoded bytes (max ${X402_GET_INPUT_MAX_ENCODED_BYTES})`,
          CUSTOMER_INPUT_TOO_LARGE,
        );
      }
    }
    const inputBytes = Buffer.byteLength(input.data, 'utf8');
    if (inputBytes > params.maxInputBytes) {
      throw new X402PreflightError(
        `input too large: ${inputBytes} bytes (skill x402_max_input_bytes=${params.maxInputBytes})`,
        CUSTOMER_INPUT_TOO_LARGE,
      );
    }
  }

  async preflight(job: X402SkillJob, input: SkillInput): Promise<void> {
    // Cache-first: a bought result needs neither float nor a live quote to
    // deliver - a down or repriced upstream must not bury it.
    const cached = await this.store.getResult(input.jobId);
    if (cached !== null) {
      return;
    }

    const signer = await this.assertWalletInvariant();

    if (job.asset.mint !== USDC_SOLANA_DEVNET.mint || USDC_SOLANA_DEVNET.mint === undefined) {
      throw new X402PreflightError(
        `x402 skills must be priced in devnet USDC (skill "${job.skillName}" is priced in ${job.asset.symbol}); ` +
          'the margin check compares the elisym price to the upstream USDC quote - re-run `npx @elisym/cli x402 add`',
      );
    }

    this.assertInputRules(job, input);

    const rule: RequirementRule = { maxUpstreamSubunits: job.params.maxUpstreamSubunits };
    let probe;
    try {
      probe = await probePaymentRequiredCached(
        job.params.url,
        job.params.method,
        X402_PROBE_TTL_MS,
      );
    } catch (error) {
      if (error instanceof X402ProbeError) {
        throw new X402PreflightError(`upstream probe failed: ${error.message}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new X402PreflightError(`upstream unreachable: ${message}`);
    }
    // Margin/balance are checked against the WORST acceptable quote, not the
    // first-matched one: the client's policy admits every requirement <= the
    // ceiling and its selector may sign any of them, so the gate must hold for
    // the most expensive acceptable option (the ceiling still caps hard loss).
    const quote = maxAcceptableQuote(probe.accepts, rule);
    if (quote === null) {
      throw new X402PreflightError(
        'no acceptable upstream payment requirement: network/asset/scheme mismatch or the live quote exceeds x402_max_upstream ' +
          '(if the upstream repriced, re-run `npx @elisym/cli x402 add` to regenerate the skill)',
      );
    }
    if (quote < job.params.maxUpstreamSubunits && !this.repriceHintLogged.has(job.skillName)) {
      this.repriceHintLogged.add(job.skillName);
      this.log(
        `upstream for "${job.skillName}" now quotes ${formatAssetAmount(USDC_SOLANA_DEVNET, quote)} ` +
          `(your price was computed from ${formatAssetAmount(USDC_SOLANA_DEVNET, job.params.maxUpstreamSubunits)}); ` +
          're-run `npx @elisym/cli x402 add` to reprice',
      );
    }

    const balance = await fetchUsdcBalance(this.rpc, address(signer.address));
    if (balance < quote) {
      throw new X402PreflightError(
        `bridge float insufficient: ${formatAssetAmount(USDC_SOLANA_DEVNET, balance)} USDC in ${signer.address}, ` +
          `upstream quotes ${formatAssetAmount(USDC_SOLANA_DEVNET, quote)} - top up the wallet`,
      );
    }

    const feeBps = await this.options.getFeeBps();
    const fee = calculateProtocolFee(job.priceSubunits, feeBps);
    const net = BigInt(job.priceSubunits - fee);
    if (net < quote) {
      throw new X402PreflightError(
        `negative margin: net revenue ${formatAssetAmount(USDC_SOLANA_DEVNET, net)} (price minus ${feeBps} bps protocol fee) ` +
          `is below the upstream quote ${formatAssetAmount(USDC_SOLANA_DEVNET, quote)} - re-run \`npx @elisym/cli x402 add\` to reprice`,
      );
    }
  }

  /**
   * Instrumented fetch injected into the payment wrapper. The wrapper calls
   * it for the initial unpaid request (no headers) and, after signing, for
   * the paid retry (carrying `PAYMENT-SIGNATURE`). ONLY the paid request
   * claims a budget slot, and it does so ATOMICALLY: `claimPaidAttempt`
   * increments-or-refuses inside the store's serialization queue, so no set
   * of concurrent `execute()` flows for one jobId can each pass a stale
   * check and pay past the 2x bound. A refusal throws BEFORE `globalThis.fetch`
   * so no payment is sent.
   */
  private buildInstrumentedFetch(jobId: string): typeof globalThis.fetch {
    const store = this.store;
    return async function instrumentedFetch(info, init) {
      const request = new Request(info, init);
      if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT')) {
        const claim = await store.claimPaidAttempt(jobId, X402_MAX_PAID_ATTEMPTS);
        if (!claim.granted) {
          throw new X402PermanentError(
            `paid attempt budget exhausted (${claim.attempts}/${X402_MAX_PAID_ATTEMPTS}) - refusing to pay the upstream again`,
          );
        }
      }
      // `redirect: 'error'`: the upstream is untrusted. Auto-following a 3xx
      // would send the request - including the signed PAYMENT-SIGNATURE on the
      // paid retry - to an attacker-chosen host (SSRF / payment-header leak).
      // Rebuild the request with the original method/headers/body so the option
      // takes effect (a Request's redirect mode is otherwise fixed at construction).
      const response = await globalThis.fetch(new Request(request, { redirect: 'error' }));
      // Cap the 402 challenge body the wrapper is about to read uncapped.
      return capChallengeResponse(response);
    };
  }

  private buildClient(signer: KeyPairSigner, rule: RequirementRule): x402Client {
    const scheme = new ExactSvmScheme(signer, { rpcUrl: this.options.rpcUrl });
    return x402Client
      .fromConfig({
        schemes: [{ network: X402_SOLANA_DEVNET_CAIP2, client: scheme }],
        policies: [buildRequirementsPolicy(rule)],
      })
      .registerV1(X402_SOLANA_DEVNET_V1, scheme);
  }

  private classifyWrapperError(error: unknown): Error {
    if (error instanceof Error && error.name === 'AbortError') {
      return error;
    }
    // A budget refusal (or any error we already classified) raised inside the
    // instrumented fetch must pass through unchanged, not be re-wrapped as a
    // generic transient failure.
    if (error instanceof X402PermanentError || error instanceof X402TransientError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    // The wrapper re-throws a policy rejection ("All payment requirements
    // were filtered out...") as this generic message - match on it, there is
    // no dedicated error class to check.
    if (message.includes('Failed to create payment payload')) {
      return new X402PermanentError(
        `payment refused by policy (upstream likely repriced above x402_max_upstream): ${message}`,
      );
    }
    return new X402TransientError(`upstream request failed: ${message}`);
  }

  private classifyStatus(status: number): Error {
    if (status === 402) {
      return new X402TransientError('upstream still returned 402 after a payment attempt');
    }
    if (status === 429 || status >= 500) {
      return new X402TransientError(`upstream returned ${status}`);
    }
    return new X402PermanentError(`upstream returned ${status}`);
  }

  async execute(
    job: X402SkillJob,
    input: SkillInput,
    signal?: AbortSignal,
  ): Promise<{ data: string; outputMime?: string; filePath?: string }> {
    const cached = await this.store.getResult(input.jobId);
    if (cached !== null) {
      this.log(`job ${input.jobId.slice(0, 8)}: delivering cached upstream result (no re-payment)`);
      return cached;
    }

    // The runtime's pre-payment rules refuse binary attachments, but the
    // blossom fallback can still materialize a lying text descriptor
    // (actual bytes > re-inline cap) as a file - refuse BEFORE paying
    // upstream for a request whose body we cannot map.
    if (input.filePath !== undefined) {
      throw new X402PermanentError(
        'file inputs are not supported by x402 bridge skills (attachment exceeded the text re-inline cap)',
      );
    }
    // Symmetric re-check of the ACTUAL bytes (the preflight saw the declared
    // size only): never pay for a request the upstream will reject as too large.
    const inputBytes = Buffer.byteLength(input.data, 'utf8');
    if (inputBytes > job.params.maxInputBytes) {
      throw new X402PermanentError(
        `input exceeds x402_max_input_bytes after materialization: ${inputBytes} > ${job.params.maxInputBytes}`,
      );
    }

    // No up-front budget check: `claimPaidAttempt` in the instrumented fetch
    // is the single authoritative, atomic gate (an exhausted budget throws a
    // permanent error there, before any payment). An already-exhausted job
    // costs at most one wasted UNPAID probe, never a payment.

    const requestUrl = new URL(job.params.url);
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (job.params.method === 'GET') {
      if (job.params.queryParam !== undefined && input.data.length > 0) {
        requestUrl.searchParams.set(job.params.queryParam, input.data);
      }
    } else {
      body = input.data;
      headers['content-type'] = jsonContentType(input.data) ? 'application/json' : 'text/plain';
    }

    const signer = await this.assertWalletInvariant();
    const rule: RequirementRule = { maxUpstreamSubunits: job.params.maxUpstreamSubunits };
    const fetchWithPayment = wrapFetchWithPayment(
      this.buildInstrumentedFetch(input.jobId),
      this.buildClient(signer, rule),
    );

    let response: Response;
    try {
      response = await fetchWithPayment(requestUrl, {
        method: job.params.method,
        headers,
        body,
        signal,
      });
    } catch (error) {
      throw this.classifyWrapperError(error);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw this.classifyStatus(response.status);
    }

    const bytes = await readBodyCapped(response, X402_MAX_RESPONSE_BYTES);
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    if (isTextContentType(contentType)) {
      const data = new TextDecoder().decode(bytes);
      await this.store.saveTextResult(input.jobId, data);
      return { data };
    }
    const mime = contentType.split(';')[0]?.trim() ?? 'application/octet-stream';
    // The cache file doubles as the delivery source - handed out WITHOUT a
    // cleanup callback (the store's TTL sweep owns deletion; the runtime
    // calls cleanup even on a failed seed, which would destroy the only copy).
    const filePath = await this.store.saveFileResult(input.jobId, mime, bytes);
    return { data: '', outputMime: mime, filePath };
  }
}
