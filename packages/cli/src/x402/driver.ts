/**
 * The x402 protocol driver: everything money-touching for `mode: 'x402'`
 * skills. Payment signing goes through `@x402/fetch` + `@x402/svm` with a
 * requirements policy as the wallet guard (nothing above the skill's ceiling
 * is ever signed, regardless of what the upstream re-quotes); the preflight
 * protects the CUSTOMER by refusing doomed jobs before they pay; the
 * idempotency store bounds the operator's steady-state worst case at
 * `X402_MAX_PAID_ATTEMPTS` upstream prices per job, and the adversarial
 * worst case (an upstream that settles payments while answering 402 to farm
 * attempt refunds) at `X402_MAX_PAYMENT_SIGNATURES` prices.
 *
 * NOTE: no `onPaymentResponse` / scheme hooks are registered here - on
 * purpose. The fetch wrapper has a dormant `result.recovered` branch that
 * re-signs a second payment inside one call when a hook requests it;
 * without hooks it is dead code, with hooks it would silently double the
 * maximum loss per attempt.
 */
import { createHash } from 'node:crypto';
import {
  calculateProtocolFee,
  formatAssetAmount,
  resolveUsdcAsset,
  signerFromSecretKeyBase58,
} from '@elisym/sdk';
import type { Asset, Network } from '@elisym/sdk';
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
import { sanitizeForTerminal } from '../logging.js';
import type { SkillInput, X402JobDriver, X402SkillJob } from '../skill/index.js';
import {
  X402_ERROR_BODY_READ_MS,
  X402_ERROR_EXCERPT_CHARS,
  X402_FREE_RETRY_DELAYS_MS,
  X402_GET_INPUT_MAX_ENCODED_BYTES,
  X402_MASKED_INPUT_MIN_CHARS,
  X402_MAX_CHALLENGE_BYTES,
  X402_MAX_CHALLENGE_HEADER_CHARS,
  X402_MAX_ERROR_BODY_BYTES,
  X402_MAX_ERROR_BODY_READS,
  X402_MAX_PAID_ATTEMPTS,
  X402_MAX_PAYMENT_SIGNATURES,
  X402_MAX_RESPONSE_BYTES,
  X402_PROBE_TTL_MS,
  X402_REFUNDED_RETRIES,
  x402SolanaNetworkIds,
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
  /**
   * The agent's Solana network. Drives the accepted x402 network-id set, the
   * USDC mint every requirement is compared against, and the float-balance
   * mint - all three must come from the same value (D15/H2).
   */
  network: Network;
  /** Live protocol fee accessor (bps) - fetched fresh, mirrors `collectPayment`. */
  getFeeBps: () => Promise<number>;
  log?: (message: string) => void;
  /** Backoff override for inline money-free retries (tests); defaults to `X402_FREE_RETRY_DELAYS_MS`. */
  freeRetryDelaysMs?: number[];
  /** Deadline override for reading a failing body (tests); defaults to `X402_ERROR_BODY_READ_MS`. */
  errorBodyReadMs?: number;
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

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
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
  return concatChunks(chunks, total);
}

/**
 * Read at most `maxBytes` of a body as text, then hang up.
 *
 * Unlike `readBodyCapped` an oversized body is truncated, not refused: the
 * caller wants a short excerpt OF a failure, so a flooding upstream must not
 * turn into a second failure of its own. Bounded three ways, because an
 * untrusted upstream can be hostile in three: by size (`maxBytes`), by time
 * (`timeoutMs`) and by reads (`X402_MAX_ERROR_BODY_READS`).
 */
async function readBodyPrefix(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { text: '', truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  let timedOut = false;
  // Cancelling resolves a pending read as `done`, so the deadline ends the
  // loop with whatever arrived rather than throwing - which is exactly why it
  // has to record that it fired: `done` alone cannot tell a body that finished
  // from one cut off mid-sentence.
  const deadline = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    for (let reads = 0; reads < X402_MAX_ERROR_BODY_READS && total < maxBytes; reads += 1) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      const fitting = value.subarray(0, maxBytes - total);
      total += fitting.byteLength;
      chunks.push(fitting);
    }
  } catch {
    // A stream that broke mid-read: the prefix that did arrive is still the
    // best explanation available, so keep it instead of losing the excerpt.
  } finally {
    clearTimeout(deadline);
  }
  // Not awaited: hanging up is a courtesy to the connection, and a source
  // whose `cancel()` never settles must not take the excerpt down with it.
  reader.cancel().catch(() => {});
  // Non-fatal decoding: a multi-byte character cut by the cap becomes U+FFFD
  // rather than throwing away the whole excerpt.
  return {
    text: new TextDecoder().decode(concatChunks(chunks, total)),
    truncated: !ended || timedOut,
  };
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

/** The x402 extension key an upstream uses to demand a payment idempotency id. */
const PAYMENT_IDENTIFIER_EXTENSION = 'payment-identifier';

/**
 * A plain JSON object, or null - an array is neither. Defensive narrowing with
 * no reachable failure mode behind it: every array an upstream could put here
 * is refused a step later, by `required === true` or by the envelope being
 * re-encoded unchanged. It earns its place by keeping `Record` honest for the
 * next reader, not by catching anything.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The `info` block of an x402 extension declaration, read the way `@x402/core`
 * reads it (`getExtensionInfo`): a declaration carrying no `info` wrapper IS
 * its own info. Both shapes are legal, and which one a server used decides
 * where an added field has to go - see `withPaymentIdentifier`.
 */
function extensionInfo(declaration: Record<string, unknown> | null): Record<string, unknown> {
  if (declaration === null) {
    return {};
  }
  return Object.hasOwn(declaration, 'info') ? (asRecord(declaration.info) ?? {}) : declaration;
}

/**
 * The `payment-identifier` declaration of a 402 challenge that marks it
 * REQUIRED, or `null` when the challenge asks for no identifier.
 *
 * Some upstreams (Birdeye among them) refuse a payment that carries no
 * idempotency id, with a 400 rather than a 402 - so the id has to be attached
 * before the paid request, not after being told off. Read from the header a v2
 * challenge arrives in, which is also the one the client itself prefers.
 *
 * The whole declaration is returned, not just the verdict, because the echo
 * back to the server has to preserve it - see `withPaymentIdentifier`.
 */
function requiredPaymentIdentifier(response: Response): Record<string, unknown> | null {
  const header = response.headers.get('payment-required');
  // Bounded before it is decoded - see the constant for what that does and
  // does not buy.
  if (header === null || header.length > X402_MAX_CHALLENGE_HEADER_CHARS) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const extensions = asRecord(asRecord(decoded)?.extensions);
    const declaration = asRecord(extensions?.[PAYMENT_IDENTIFIER_EXTENSION]);
    return extensionInfo(declaration).required === true ? declaration : null;
  } catch {
    return null;
  }
}

/**
 * Attach an idempotency id to a signed payment envelope, derived from the
 * signed transaction itself.
 *
 * Deterministic on purpose. A network-level retry of the SAME signed payment
 * carries the same id, so an upstream that honours it serves the original
 * result instead of charging twice; a re-signed payment (a fresh blockhash
 * after a 402 refusal) is a genuinely different payment and gets a different
 * id. Derived rather than stored, so a crash leaves no state to reconcile -
 * but not crash-idempotent: the job re-signs afterwards, which is a new
 * payment with a new id, bounded by the store's attempt and signature caps.
 *
 * Seeded with the JOB as well as the transaction, because the transaction
 * alone is not unique: `@x402/svm` gives a payment its per-payment memo nonce
 * only when the seller pinned no `extra.memo` of its own, so two concurrent
 * jobs at one price inside a single blockhash window can sign byte-identical
 * transactions. Sharing an id there would have an upstream serve one
 * customer's answer to another.
 *
 * The id is ADDED to what the challenge declared, never substituted for it:
 * a server validates the echo by checking that every field it advertised came
 * back unchanged (`objectContainsSubset` in `@x402/core`), so an envelope
 * carrying a bare `{ info: { id } }` is rejected as an echo mismatch - which
 * would burn the very payment this exists to make land.
 *
 * Only the envelope is touched - the signed transaction inside it is copied
 * verbatim, so the signature stays valid.
 */
function withPaymentIdentifier(
  headerValue: string,
  declaration: Record<string, unknown>,
  jobId: string,
): string {
  try {
    const record = asRecord(JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')));
    if (record === null) {
      return headerValue;
    }
    const transaction = asRecord(record.payload)?.transaction;
    const signed = typeof transaction === 'string' ? transaction : headerValue;
    const digest = createHash('sha256').update(`${jobId}:${signed}`).digest('hex');
    const id = `pay_${digest.slice(0, 32)}`;
    const extensions = asRecord(record.extensions) ?? {};
    // The x402 client already echoes the server's declaration into the
    // envelope; keep whatever it put there and fill the id in around it. The
    // id goes FIRST so that a server which advertised an id of its own keeps
    // it - overriding an advertised field is the very mismatch this avoids,
    // and a server that names the id owns that key space, including whether
    // two jobs may share one.
    const echoed = asRecord(extensions[PAYMENT_IDENTIFIER_EXTENSION]) ?? {};
    const info = { id, ...extensionInfo(declaration), ...extensionInfo(echoed) };
    record.extensions = {
      ...extensions,
      // Mirror the shape the server declared. Its echo VALIDATOR would accept
      // either (`@x402/core` normalizes both sides through `getExtensionInfo`
      // first), but whatever reads the id back out afterwards is the server's
      // own code, and the one place it can be counted on to look is where it
      // declared the extension.
      [PAYMENT_IDENTIFIER_EXTENSION]: Object.hasOwn(declaration, 'info')
        ? { ...echoed, info }
        : info,
    };
    return Buffer.from(JSON.stringify(record), 'utf8').toString('base64');
  } catch {
    // An envelope we cannot read is one we must not break. The upstream will
    // refuse it for the missing id, which is the same outcome as before this
    // function existed - whereas throwing here would turn a signed, sendable
    // payment into a crash on the money path.
    return headerValue;
  }
}

/**
 * Format characters: invisible, and survivors of control-stripping. The class
 * covers what an upstream would reach for to make a line read as something
 * other than what it says - direction overrides and isolates, zero-width
 * joiners, the byte-order mark, the tag block used to smuggle text past a
 * human reader - without this file having to enumerate them.
 */
const UNICODE_FORMAT_MARKS = /\p{Cf}/gu;

/**
 * Flatten untrusted text into something that cannot forge a line on the
 * operator's terminal: no C0/C1 controls, no format marks, and no newline to
 * turn one line into two. Everything an upstream can influence passes through
 * here before it is logged or quoted - a sanitized excerpt is only as good as
 * the least careful line reaching the same terminal.
 */
function flattenForOperator(text: string): string {
  // Marks first, then whitespace: the byte-order mark is both, and collapsing
  // first would leave it as a space this never strips. What remains of the
  // whitespace class - the line and paragraph separators among it - then
  // collapses to a single space rather than welding two words together.
  return sanitizeForTerminal(text).replace(UNICODE_FORMAT_MARKS, '').replace(/\s+/g, ' ').trim();
}

/**
 * Exactly the characters `clipForOperator` will print for this text: all of it
 * when it fits, otherwise the excerpt's worth minus a high surrogate the cut
 * separated from its pair - half a character is not something to hand a log
 * file or a terminal.
 */
function printedPrefix(flattened: string): string {
  return flattened.length <= X402_ERROR_EXCERPT_CHARS
    ? flattened
    : flattened.slice(0, X402_ERROR_EXCERPT_CHARS).replace(/[\ud800-\udbff]$/, '');
}

/** Clip an already-flattened quote to one line's worth of terminal. */
function clipForOperator(flattened: string): string {
  return flattened.length <= X402_ERROR_EXCERPT_CHARS
    ? flattened
    : `${printedPrefix(flattened)}...`;
}

/**
 * Quote an upstream's own words into a message that will be read on a
 * terminal. EVERY quote of untrusted text goes through here, not just the
 * response body: a library wraps an upstream's 402 challenge into its own
 * `Error.message` (`@x402/core` embeds the whole `accepts` array in one, and
 * V8 quotes raw input in a JSON parse failure), and the driver's messages are
 * printed verbatim by the runtime's job-error log. A bound that only covers
 * the body is not a bound - and neither is masking that only covers it, since
 * a GET bridge's input rides in the URL such a message can quote.
 *
 * `quoteUpstreamWithInput` below and `errorExcerpt` run the same steps
 * themselves - the first to add the masking, the second because its truncation
 * guard has to sit between that masking and the clip.
 */
function quoteUpstream(text: string): string {
  return clipForOperator(flattenForOperator(text));
}

/**
 * The same, for a quote that CAN carry the customer's input back - anything
 * describing a request the driver actually sent. The probe deliberately does
 * not use this: it sends only a URL and a method (`probePaymentRequired`), so
 * masking its failures could only ever blank the upstream's own words, and a
 * customer who sent `Connection refused` would erase the operator's one signal
 * that the bridge is down.
 */
function quoteUpstreamWithInput(text: string, sentInput: string): string {
  return clipForOperator(maskCustomerInput(flattenForOperator(text), inputForms(sentInput)));
}

/**
 * The input as it leaves the process. Both a UTF-8 body and a URL-encoded
 * query substitute U+FFFD for an unpaired surrogate, so an upstream echoing
 * back what it actually received would otherwise match none of the needles.
 */
function wireForm(sentInput: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(sentInput));
}

function jsonEscapedForm(sentInput: string): string {
  // What a JSON upstream produces when it quotes the request back inside its
  // own error object - the common case for a JSON bridge, not an edge one.
  return JSON.stringify(sentInput).slice(1, -1);
}

/**
 * The input as a URL carries it.
 *
 * `URLSearchParams` is the serializer a GET bridge actually sends through, and
 * it disagrees with `encodeURIComponent` on spaces and on `!'()~` - an
 * apostrophe is enough to make one of them miss - so both are needles.
 */
function urlEncodedForms(sentInput: string): string[] {
  const forms = [new URLSearchParams({ q: sentInput }).toString().slice('q='.length)];
  try {
    forms.push(encodeURIComponent(sentInput));
  } catch {
    // An unpaired surrogate makes `encodeURIComponent` throw. The form above
    // is already pushed, so this costs one needle - and contains a throw that
    // `classifyWrapperError` would otherwise let escape as an unclassified
    // error, failing the job rather than merely losing a quote.
  }
  return forms;
}

/**
 * Does this quote stop part-way through the customer's own input?
 *
 * A body cut short takes the upstream's echo with it, and half a needle
 * matches nothing - so the head of an input can survive masking meant to
 * remove it. If the quote's last characters appear anywhere in the input,
 * treat the cut as having landed inside an echo. A coincidence costs a
 * diagnostic; the other error costs the customer their privacy.
 */
function endsInsideInput(text: string, forms: string[]): boolean {
  // A cut lands on a byte, not a character: the multi-byte character it split
  // decodes to U+FFFD, which belongs to no input and would hide the very echo
  // this looks for - so an ASCII customer would be protected and everyone else
  // quietly not. Only reachable when the whole quote fits the printed window,
  // since that is what the caller passes.
  const tail = text.replace(/\ufffd+$/, '').slice(-X402_MASKED_INPUT_MIN_CHARS);
  // A quote shorter than the floor has no room to end inside anything worth
  // masking, and dropping every short excerpt would cost more than it saves.
  return tail.length >= X402_MASKED_INPUT_MIN_CHARS && forms.some((form) => form.includes(tail));
}

function inputForms(sentInput: string): string[] {
  // EVERY form is flattened, because the text they are matched against is. An
  // input carrying both a quote and a double space would otherwise miss on the
  // verbatim needle (the quote comes back escaped) AND on the escaped one (the
  // spaces come back collapsed), and go through unmasked.
  // `wireForm` stands in for the input itself: they differ only for an
  // unpaired surrogate, which never reaches an upstream to be echoed back, and
  // for a leading byte-order mark, which the flattening removes from needle
  // and haystack alike.
  return [wireForm(sentInput), jsonEscapedForm(sentInput), ...urlEncodedForms(sentInput)].map(
    flattenForOperator,
  );
}

/**
 * Blank the customer's own input out of a quoted upstream error.
 *
 * The input leaves verbatim in a POST body or encoded into a GET query, and a
 * JSON upstream escapes it again on the way back, so each of those forms is a
 * needle. Short forms are left alone (`X402_MASKED_INPUT_MIN_CHARS`), and an
 * upstream that reformats the input can still surface fragments of it: a floor
 * on what reaches the log, not a guarantee.
 *
 * It cuts the other way too - an input that happens to occur in the upstream's
 * own words is blanked there as well, so `[input]` in a quote means "the
 * customer sent this text", not "the upstream echoed it back".
 */
function maskCustomerInput(text: string, forms: string[]): string {
  let masked = text;
  for (const form of forms) {
    if (form.length >= X402_MASKED_INPUT_MIN_CHARS) {
      masked = masked.replaceAll(form, '[input]');
    }
  }
  return masked;
}

/** Per-attempt flag: flips the moment a payment claim is granted (i.e. just before a signed payment leaves). */
interface AttemptState {
  paymentSent: boolean;
}

/** Sleep between inline retries; resolves `false` early if the signal aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class X402Driver implements X402JobDriver {
  private readonly store: X402JobStore;
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly usdcAsset: Asset;
  private signerPromise: Promise<KeyPairSigner> | null = null;
  private readonly repriceHintLogged = new Set<string>();

  constructor(private readonly options: X402DriverOptions) {
    this.store = new X402JobStore(options.agentDir);
    this.rpc = createSolanaRpc(options.rpcUrl);
    this.usdcAsset = resolveUsdcAsset(options.network);
    // Fire-and-forget retention sweep; a failed sweep only delays cleanup.
    this.store.sweepExpired().catch(() => {});
  }

  private log(message: string): void {
    // The sink behind this is a bare `console.log`. Lines that quote an
    // upstream already went through `quoteUpstream`, so for them this is a
    // second lock - but the ones that interpolate a store failure or a skill
    // name have no other, and a future line that forgets to quote would forge
    // a line on the operator's terminal rather than merely read badly.
    (this.options.log ?? console.log)(`[x402] ${flattenForOperator(message)}`);
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

    if (job.asset.mint !== this.usdcAsset.mint || this.usdcAsset.mint === undefined) {
      throw new X402PreflightError(
        `x402 skills must be priced in ${this.options.network} USDC (skill "${job.skillName}" is priced in ${job.asset.symbol}); ` +
          'the margin check compares the elisym price to the upstream USDC quote - re-run `npx @elisym/cli x402 add`',
      );
    }

    this.assertInputRules(job, input);

    const rule: RequirementRule = {
      maxUpstreamSubunits: job.params.maxUpstreamSubunits,
      network: this.options.network,
    };
    let probe;
    try {
      probe = await probePaymentRequiredCached(
        job.params.url,
        job.params.method,
        X402_PROBE_TTL_MS,
      );
    } catch (error) {
      if (error instanceof X402ProbeError) {
        throw new X402PreflightError(`upstream probe failed: ${quoteUpstream(error.message)}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new X402PreflightError(`upstream unreachable: ${quoteUpstream(message)}`);
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
        `upstream for "${job.skillName}" now quotes ${formatAssetAmount(this.usdcAsset, quote)} ` +
          `(your price was computed from ${formatAssetAmount(this.usdcAsset, job.params.maxUpstreamSubunits)}); ` +
          're-run `npx @elisym/cli x402 add` to reprice',
      );
    }

    const balance = await fetchUsdcBalance(this.rpc, address(signer.address), this.options.network);
    if (balance === null) {
      throw new X402PreflightError(
        `could not read the bridge float balance for ${signer.address} - refusing to pay the ` +
          'upstream without verifying it; retry in a moment',
      );
    }
    if (balance < quote) {
      throw new X402PreflightError(
        `bridge float insufficient: ${formatAssetAmount(this.usdcAsset, balance)} USDC in ${signer.address}, ` +
          `upstream quotes ${formatAssetAmount(this.usdcAsset, quote)} - top up the wallet`,
      );
    }

    const feeBps = await this.options.getFeeBps();
    const fee = calculateProtocolFee(job.priceSubunits, feeBps);
    const net = BigInt(job.priceSubunits - fee);
    if (net < quote) {
      throw new X402PreflightError(
        `negative margin: net revenue ${formatAssetAmount(this.usdcAsset, net)} (price minus ${feeBps} bps protocol fee) ` +
          `is below the upstream quote ${formatAssetAmount(this.usdcAsset, quote)} - re-run \`npx @elisym/cli x402 add\` to reprice`,
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
   * check and pay past the budget caps. A refusal throws BEFORE
   * `globalThis.fetch` so no payment is sent.
   */
  private buildInstrumentedFetch(
    jobId: string,
    attemptState: AttemptState,
  ): typeof globalThis.fetch {
    const store = this.store;
    // Learned from this call's own 402, not from the cached probe: the
    // challenge that governs a payment is the one that immediately preceded it.
    let requiredIdentifier: Record<string, unknown> | null = null;
    return async function instrumentedFetch(info, init) {
      const request = new Request(info, init);
      if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT')) {
        const claim = await store.claimPaidAttempt(
          jobId,
          X402_MAX_PAID_ATTEMPTS,
          X402_MAX_PAYMENT_SIGNATURES,
        );
        if (!claim.granted) {
          throw new X402PermanentError(
            claim.refusedBy === 'signatures'
              ? `signed payment budget exhausted (${claim.signatures}/${X402_MAX_PAYMENT_SIGNATURES} payments signed for this job) - refusing to sign another`
              : `paid attempt budget exhausted (${claim.attempts}/${X402_MAX_PAID_ATTEMPTS}) - refusing to pay the upstream again`,
          );
        }
        // Set BEFORE the request goes out: if the send itself fails we do not
        // know whether the upstream saw (and can settle) the payment, so the
        // attempt must count as money-unknown, never as money-free.
        attemptState.paymentSent = true;
        const signature = request.headers.get('PAYMENT-SIGNATURE');
        if (requiredIdentifier !== null && signature !== null) {
          request.headers.set(
            'PAYMENT-SIGNATURE',
            withPaymentIdentifier(signature, requiredIdentifier, jobId),
          );
        }
      }
      // `redirect: 'error'`: the upstream is untrusted. Auto-following a 3xx
      // would send the request - including the signed PAYMENT-SIGNATURE on the
      // paid retry - to an attacker-chosen host (SSRF / payment-header leak).
      // Rebuild the request with the original method/headers/body so the option
      // takes effect (a Request's redirect mode is otherwise fixed at construction).
      const response = await globalThis.fetch(new Request(request, { redirect: 'error' }));
      if (response.status === 402) {
        requiredIdentifier = requiredPaymentIdentifier(response);
      }
      // Cap the 402 challenge body the wrapper is about to read uncapped.
      return capChallengeResponse(response);
    };
  }

  private buildClient(signer: KeyPairSigner, rule: RequirementRule): x402Client {
    const scheme = new ExactSvmScheme(signer, { rpcUrl: this.options.rpcUrl });
    const networkIds = x402SolanaNetworkIds(this.options.network);
    return x402Client
      .fromConfig({
        schemes: [{ network: networkIds.caip2, client: scheme }],
        policies: [buildRequirementsPolicy(rule)],
      })
      .registerV1(networkIds.v1, scheme);
  }

  private classifyWrapperError(error: unknown, sentInput: string): Error {
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
    // Matched on the RAW message, quoted from the bounded one. Not merely
    // because clipping could hide the marker: a customer whose input contains
    // it would have it masked out of the quote, and a policy refusal would
    // turn into a transient the recovery loop retries forever.
    const quoted = quoteUpstreamWithInput(message, sentInput);
    // The wrapper re-throws a policy rejection ("All payment requirements
    // were filtered out...") as this generic message - match on it, there is
    // no dedicated error class to check.
    if (message.includes('Failed to create payment payload')) {
      return new X402PermanentError(
        `payment refused by policy (upstream likely repriced above x402_max_upstream): ${quoted}`,
      );
    }
    return new X402TransientError(`upstream request failed: ${quoted}`);
  }

  /**
   * Read a short, safe excerpt of a failing upstream's body.
   *
   * A bare status code is not a diagnosis: a 4xx from an x402 upstream can
   * mean a rejected payload, a missing required extension, or an argument the
   * service did not like, and the operator cannot tell which without the
   * body's own words. The body is untrusted, so only a bounded prefix is read
   * at all, and it is stripped of anything that could forge a log line before
   * it reaches the operator's. Reading it never fails the caller - an
   * unreadable body simply yields no excerpt, which is exactly the
   * status-only message as before.
   *
   * `sentInput` is the customer's own job input, masked out of the quote by
   * `maskCustomerInput`: an upstream that echoes the request back would
   * otherwise put it in the operator's log, which the runtime keeps it out of
   * everywhere else.
   */
  private async errorExcerpt(response: Response, sentInput: string): Promise<string> {
    try {
      const body = await readBodyPrefix(
        response,
        X402_MAX_ERROR_BODY_BYTES,
        this.options.errorBodyReadMs ?? X402_ERROR_BODY_READ_MS,
      );
      const forms = inputForms(sentInput);
      const quoted = maskCustomerInput(flattenForOperator(body.text), forms);
      if (quoted.length === 0) {
        return '';
      }
      // A body this driver cut short - by size, by reads, or by the deadline -
      // can end inside an echo of the input that the masking could not match.
      // Quote nothing rather than the half of it that survived. Judged on the
      // characters that will actually be printed: an echo cut off thousands of
      // characters past the excerpt could never have been shown, and dropping
      // the diagnosis over it would cost the operator more than it protects.
      const shown = printedPrefix(quoted);
      if (body.truncated && endsInsideInput(shown, forms)) {
        return '';
      }
      // Clipped after masking, so a needle straddling the cut is still gone.
      return `: ${clipForOperator(quoted)}`;
    } catch {
      return '';
    }
  }

  private classifyStatus(status: number, excerpt: string): Error {
    if (status === 402) {
      return new X402TransientError(
        `upstream still returned 402 after a payment attempt${excerpt}`,
        status,
      );
    }
    if (status === 429 || status >= 500) {
      return new X402TransientError(`upstream returned ${status}${excerpt}`, status);
    }
    return new X402PermanentError(`upstream returned ${status}${excerpt}`);
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
    const rule: RequirementRule = {
      maxUpstreamSubunits: job.params.maxUpstreamSubunits,
      network: this.options.network,
    };
    const client = this.buildClient(signer, rule);
    const jobTag = input.jobId.slice(0, 8);

    // Inline retry loop: a transient failure that provably cost no money is
    // retried here after a short backoff instead of waiting a full recovery
    // cycle; a definitive 402 payment refusal refunds its budget slot (an
    // honest upstream did not settle) and retries once with a freshly signed
    // payment - the honest cause is a blockhash that expired while a slow
    // upstream served before settling. Money-unknown transients (network
    // error or 5xx AFTER a payment left) never retry inline: only the
    // recovery loop, with its delay and cache-first re-execution, owns them.
    let freeRetriesUsed = 0;
    let refundedRetriesUsed = 0;
    while (true) {
      const attemptState: AttemptState = { paymentSent: false };
      try {
        return await this.attemptUpstream(
          job,
          requestUrl,
          headers,
          body,
          input,
          client,
          attemptState,
          signal,
        );
      } catch (error) {
        if (!(error instanceof X402TransientError)) {
          throw error;
        }
        if (attemptState.paymentSent) {
          if (error.upstreamStatus !== 402) {
            throw error;
          }
          // Refund BEFORE checking the inline budget so recovery also gets
          // the freed slot; the monotonic signature cap keeps a lying
          // upstream bounded either way.
          try {
            await this.store.refundPaidAttempt(input.jobId);
          } catch (refundError) {
            // A refund that cannot flush must not surface raw (the runtime
            // would mark the paid job failed): keep the slot consumed
            // (fail-closed for money) and stay on the keep-paid transient
            // path - without the inline retry, since the store misbehaves.
            const message =
              refundError instanceof Error ? refundError.message : String(refundError);
            this.log(
              `job ${jobTag}: could not refund the refused payment attempt (${message}) - keeping the slot consumed`,
            );
            throw error;
          }
          if (refundedRetriesUsed >= X402_REFUNDED_RETRIES) {
            throw error;
          }
          refundedRetriesUsed += 1;
          this.log(
            `job ${jobTag}: upstream refused the signed payment with a fresh 402 (likely expired blockhash) - attempt slot refunded, retrying with a fresh payment`,
          );
          continue;
        }
        const freeRetryDelays = this.options.freeRetryDelaysMs ?? X402_FREE_RETRY_DELAYS_MS;
        const delayMs = freeRetryDelays[freeRetriesUsed];
        if (delayMs === undefined) {
          throw error;
        }
        freeRetriesUsed += 1;
        this.log(
          `job ${jobTag}: transient failure before any payment (${error.message}) - inline retry ${freeRetriesUsed}/${freeRetryDelays.length} in ${delayMs}ms`,
        );
        const slept = await abortableDelay(delayMs, signal);
        if (!slept) {
          // Aborted mid-backoff (shutdown/execution budget): surface the
          // already-classified keep-paid transient, not an AbortError the
          // runtime would turn into a permanent failure.
          throw error;
        }
      }
    }
  }

  /** One full payment-wrapper pass against the upstream; throws classified errors. */
  private async attemptUpstream(
    job: X402SkillJob,
    requestUrl: URL,
    headers: Record<string, string>,
    body: string | undefined,
    input: SkillInput,
    client: x402Client,
    attemptState: AttemptState,
    signal?: AbortSignal,
  ): Promise<{ data: string; outputMime?: string; filePath?: string }> {
    const fetchWithPayment = wrapFetchWithPayment(
      this.buildInstrumentedFetch(input.jobId, attemptState),
      client,
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
      throw this.classifyWrapperError(error, input.data);
    }
    if (!response.ok) {
      throw this.classifyStatus(response.status, await this.errorExcerpt(response, input.data));
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBodyCapped(response, X402_MAX_RESPONSE_BYTES);
    } catch (error) {
      // A network hiccup mid-body on a PAID 2xx must not fail the job for
      // good (the runtime marks unclassified errors failed): classify it so
      // recovery re-delivers. Size-cap violations stay permanent.
      throw this.classifyWrapperError(error, input.data);
    }
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
