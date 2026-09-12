import { finalizeEvent, verifyEvent, type Filter, type Event } from 'nostr-tools';
import {
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST_BASE,
  KIND_JOB_RESULT_BASE,
  DEFAULT_KIND_OFFSET,
  DEFAULTS,
  LIMITS,
  jobRequestKind,
  jobResultKind,
  utf8ByteLength,
} from '../constants';
import {
  DELEGATED_PAYMENT_MODE,
  DELEGATED_PAYMENT_TAG,
  DELEGATION_EXPIRY_TAG,
  DELEGATION_NONCE_REGEX,
  DELEGATION_NONCE_TAG,
  DELEGATION_OWNER_TAG,
  DELEGATION_PROOF_REGEX,
  DELEGATION_PROOF_TAG,
  MAX_PROOF_TTL_SECS,
  PROOF_CLOCK_SKEW_SECS,
} from '../delegation/auth-proof';
import { assertLamports } from '../payment/fee';
import { parsePaymentRequest } from '../payment/schema';
import { nip44Encrypt, nip44Decrypt } from '../primitives/crypto';
import type { ElisymIdentity } from '../primitives/identity';
import {
  encodeJobPayload,
  decodeJobPayload,
  attachmentsOf,
  buildAcceptTransportsTag,
  SESSION_ID_REGEX,
  type FileAttachment,
} from '../transport/attachment';
import type { NostrPool } from '../transport/pool';
import type {
  Job,
  JobStatus,
  Network,
  PaymentAssetRef,
  SubCloser,
  SubmitJobOptions,
  JobSubscriptionOptions,
} from '../types';

function isEncrypted(event: Event): boolean {
  return event.tags.some((t) => t[0] === 'encrypted' && t[1] === 'nip44');
}

function resolveRequestId(event: Event): string | undefined {
  return event.tags.find((t) => t[0] === 'e')?.[1];
}

function safeParseInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const n = parseInt(value, 10);
  return isNaN(n) ? undefined : n;
}

const VALID_JOB_STATUSES = new Set<string>([
  'payment-required',
  'payment-completed',
  'processing',
  'error',
  'success',
  'partial',
]);

/**
 * Max clock skew for an event's `created_at` in the newest-wins picks below. A validly
 * signed event can still carry an attacker-chosen future timestamp, which would win
 * newest-per-request and evict the legit event; reject anything dated further ahead.
 */
const MAX_FUTURE_SKEW_SECS = 300;

function toJobStatus(raw: string): JobStatus {
  return VALID_JOB_STATUSES.has(raw) ? (raw as JobStatus) : 'unknown';
}

/** base58 Solana address (32-44 chars). Format-only; on-chain code re-validates. */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * On-chain transaction signature shape (base58, 64 bytes -> 86-88 chars; lower
 * bound loose for safety). A result event's `tx` tag is provider-controlled
 * relay data that consumers surface in TRUSTED framing (tool results, history),
 * so anything not shaped like a signature is dropped at this boundary rather
 * than forwarded as free text.
 */
const SOLANA_TX_SIGNATURE_REGEX = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** Expiry bound well clear of anything a `Number` could mangle (year ~5138). */
const MAX_DELEGATION_EXPIRY_UNIX = 100_000_000_000;

/**
 * The delegated-payment tag set of a job request, parsed EXACTLY once into the
 * single struct that proof verification, `deriveOwnerDelegationAta`, and the
 * pull all consume - callers must never re-`.find()` these tags later.
 */
export interface DelegatedPaymentRequest {
  /** Owner base58 Solana address - source of funds AND the verify key. */
  owner: string;
  /** Unix seconds after which the proof is dead. */
  expiryUnix: number;
  /** Single-use base58 nonce (32-44 chars). */
  nonce: string;
  /** base58 Ed25519 signature by the owner over the shared auth message. */
  proof: string;
}

/**
 * Read the delegated-payment tags off a job request event. Returns `null` when
 * the event does not claim delegated payment (no `payment` tag, or a different
 * mode). THROWS on a malformed claim - duplicate `payment`/`delegation_*` tags
 * (an injection/confusion attempt is a hard reject, never a pick-first), a
 * missing companion tag, or a value failing its strict format. The expiry
 * check here is format + bounds only; the time-window check is the caller's.
 */
export function parseDelegatedPayment(event: Event): DelegatedPaymentRequest | null {
  const tagNames = [
    DELEGATED_PAYMENT_TAG,
    DELEGATION_OWNER_TAG,
    DELEGATION_EXPIRY_TAG,
    DELEGATION_NONCE_TAG,
    DELEGATION_PROOF_TAG,
  ];
  const found = new Map<string, string>();
  for (const tag of event.tags) {
    const name = tag[0];
    if (name === undefined || !tagNames.includes(name)) {
      continue;
    }
    if (found.has(name)) {
      throw new Error(`Duplicate "${name}" tag on a delegated payment request.`);
    }
    if (typeof tag[1] !== 'string') {
      throw new Error(`Missing value on the "${name}" tag.`);
    }
    found.set(name, tag[1]);
  }
  const mode = found.get(DELEGATED_PAYMENT_TAG);
  if (mode === undefined || mode !== DELEGATED_PAYMENT_MODE) {
    return null;
  }
  const owner = found.get(DELEGATION_OWNER_TAG);
  const expiryRaw = found.get(DELEGATION_EXPIRY_TAG);
  const nonce = found.get(DELEGATION_NONCE_TAG);
  const proof = found.get(DELEGATION_PROOF_TAG);
  if (
    owner === undefined ||
    expiryRaw === undefined ||
    nonce === undefined ||
    proof === undefined
  ) {
    throw new Error('Delegated payment request is missing one of the delegation_* tags.');
  }
  if (!SOLANA_ADDRESS_REGEX.test(owner)) {
    throw new Error('delegation_owner is not a base58 Solana address.');
  }
  if (!/^\d+$/.test(expiryRaw)) {
    throw new Error('delegation_expiry must be a non-negative integer (unix seconds).');
  }
  const expiryUnix = Number(expiryRaw);
  if (
    !Number.isSafeInteger(expiryUnix) ||
    expiryUnix <= 0 ||
    expiryUnix > MAX_DELEGATION_EXPIRY_UNIX
  ) {
    throw new Error('delegation_expiry is out of bounds.');
  }
  if (!DELEGATION_NONCE_REGEX.test(nonce)) {
    throw new Error('delegation_nonce must be base58 with 32-44 characters.');
  }
  if (!DELEGATION_PROOF_REGEX.test(proof)) {
    throw new Error('delegation_proof must be a base58 Ed25519 signature.');
  }
  return { owner, expiryUnix, nonce, proof };
}

export class MarketplaceService {
  constructor(private pool: NostrPool) {}

  /** Submit a job request with NIP-44 encrypted input. Returns the event ID. */
  async submitJobRequest(identity: ElisymIdentity, options: SubmitJobOptions): Promise<string> {
    const hasAttachment = options.attachment !== undefined;
    if (!options.input && !hasAttachment) {
      throw new Error('Job input must not be empty.');
    }
    if (options.input.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new Error(
        `Job input too long: ${options.input.length} chars (max ${LIMITS.MAX_INPUT_LENGTH}).`,
      );
    }
    if (!options.capability || options.capability.length > LIMITS.MAX_CAPABILITY_LENGTH) {
      throw new Error(`Invalid capability: must be 1-${LIMITS.MAX_CAPABILITY_LENGTH} characters.`);
    }
    if (options.providerPubkey && !/^[0-9a-f]{64}$/.test(options.providerPubkey)) {
      throw new Error('Invalid provider pubkey: expected 64 hex characters.');
    }
    if (options.sessionId !== undefined) {
      // Fail loudly at submit time: an invalid id would silently degrade to
      // stateless on the provider (lenient decode) with zero customer signal.
      if (!SESSION_ID_REGEX.test(options.sessionId)) {
        throw new Error('Invalid sessionId: expected a lowercase UUID v4.');
      }
      // The session ref travels inside the NIP-44-encrypted envelope; a broadcast
      // job is unencrypted, so a session id on it would ship in cleartext relay
      // content - refuse rather than leak.
      if (!options.providerPubkey) {
        throw new Error(
          'sessionId requires providerPubkey (sessions are encrypted, targeted jobs).',
        );
      }
    }
    if (options.delegatedPayment !== undefined) {
      // The proof binds ONE provider's delegate key, so a broadcast delegated
      // job could never be settled by anyone - refuse at submit (mirrors the
      // sessionId guard above).
      if (!options.providerPubkey) {
        throw new Error('delegatedPayment requires providerPubkey (targeted jobs only).');
      }
      const { owner, expiryUnix, nonce, proof } = options.delegatedPayment;
      if (!SOLANA_ADDRESS_REGEX.test(owner)) {
        throw new Error('delegatedPayment.owner must be a base58 Solana address.');
      }
      if (!Number.isSafeInteger(expiryUnix) || expiryUnix <= 0) {
        throw new Error('delegatedPayment.expiryUnix must be a positive unix-seconds integer.');
      }
      // Enforce the TTL horizon HERE, in the layer that owns it. Both constants
      // are declared next door in `auth-proof.ts`, and `SubmitJobOptions`
      // already documents the bound ("<= now + MAX_PROOF_TTL_SECS") - but until
      // now nothing on the customer side checked it. The provider does
      // (`runtime.ts`, before it burns the nonce), so an over-long proof was
      // never spendable; it just failed remotely, after a relay publish, with a
      // reason the caller had to parse out of job feedback. Every in-repo caller
      // already mints exactly `now + MAX_PROOF_TTL_SECS`, so this can only fire
      // on a third-party integration or a clock bug - which is precisely when a
      // local, immediate error beats a silent remote rejection.
      //
      // The skew allowance is added, not subtracted: it is the same tolerance
      // the provider grants, so a caller whose clock runs fast within the
      // allowed skew is not refused by its own SDK for a proof the provider
      // would have accepted.
      const nowSecs = Math.floor(Date.now() / 1000);
      if (expiryUnix > nowSecs + MAX_PROOF_TTL_SECS + PROOF_CLOCK_SKEW_SECS) {
        throw new Error(
          `delegatedPayment.expiryUnix is beyond the allowed horizon ` +
            `(max ${MAX_PROOF_TTL_SECS}s ahead); providers reject such a proof.`,
        );
      }
      if (expiryUnix <= nowSecs) {
        throw new Error('delegatedPayment.expiryUnix is already in the past - mint a fresh proof.');
      }
      if (!DELEGATION_NONCE_REGEX.test(nonce)) {
        throw new Error('delegatedPayment.nonce must be base58 with 32-44 characters.');
      }
      if (!DELEGATION_PROOF_REGEX.test(proof)) {
        throw new Error('delegatedPayment.proof must be a base58 Ed25519 signature.');
      }
    }
    // A file or session job wraps the (optional) text note + attachment + session
    // ref in an envelope; a plain-text job sends its text directly. The `i` tag is
    // unchanged either way.
    const needsEnvelope = hasAttachment || options.sessionId !== undefined;
    const plaintext = needsEnvelope
      ? encodeJobPayload({
          text: options.input || undefined,
          attachment: options.attachment,
          session: options.sessionId !== undefined ? { id: options.sessionId } : undefined,
        })
      : options.input;
    // NIP-44 backstop: the plaintext (post-envelope, the exact string handed to
    // nip44Encrypt) must fit the 65_535-byte cap or nip44Encrypt throws cryptically.
    // Large text should have been spilled to an attachment by the caller before here.
    if (options.providerPubkey) {
      const plaintextBytes = utf8ByteLength(plaintext);
      if (plaintextBytes > LIMITS.NIP44_MAX_PLAINTEXT_BYTES) {
        throw new Error(
          `Encrypted job input too large: ${plaintextBytes} bytes (max ${LIMITS.NIP44_MAX_PLAINTEXT_BYTES}). Send large input as a file/iroh attachment instead.`,
        );
      }
    }
    const encrypted = options.providerPubkey
      ? nip44Encrypt(plaintext, identity.secretKey, options.providerPubkey)
      : plaintext;

    const tags: string[][] = [
      ['i', options.providerPubkey ? 'encrypted' : 'text', 'text'],
      ['t', options.capability],
      ['t', 'elisym'],
      ['output', 'text/plain'],
    ];

    if (options.providerPubkey) {
      tags.push(['p', options.providerPubkey]);
      tags.push(['encrypted', 'nip44']);
    }

    if (options.acceptTransports && options.acceptTransports.length > 0) {
      // Advertise which transports this customer can RECEIVE output on. Public, signed tag; the
      // provider reads it to decide which transports to seed. Skip if no known kind survives.
      const acceptTag = buildAcceptTransportsTag(options.acceptTransports);
      if (acceptTag.length > 1) {
        tags.push(acceptTag);
      }
    }

    if (options.delegatedPayment !== undefined) {
      // Public top-level tags (targeted jobs encrypt only `content`, not tags):
      // the provider must read them BEFORE decrypting to route payment mode.
      tags.push([DELEGATED_PAYMENT_TAG, DELEGATED_PAYMENT_MODE]);
      tags.push([DELEGATION_OWNER_TAG, options.delegatedPayment.owner]);
      tags.push([DELEGATION_EXPIRY_TAG, String(options.delegatedPayment.expiryUnix)]);
      tags.push([DELEGATION_NONCE_TAG, options.delegatedPayment.nonce]);
      tags.push([DELEGATION_PROOF_TAG, options.delegatedPayment.proof]);
    }

    const kind = jobRequestKind(options.kindOffset ?? DEFAULT_KIND_OFFSET);
    const event = finalizeEvent(
      {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: encrypted,
      },
      identity.secretKey,
    );

    await this.pool.publish(event);
    return event.id;
  }

  /**
   * Subscribe to job updates (feedback + results) for a given job.
   * Creates 3 subscriptions per call (feedback, result by #e, result by #p+#e)
   * to cover different relay indexing strategies. Returns a cleanup function.
   */
  subscribeToJobUpdates(options: JobSubscriptionOptions): () => void {
    const {
      jobEventId: jid,
      providerPubkey: provPk,
      customerPublicKey: custPk,
      callbacks: cb,
      timeoutMs = DEFAULTS.SUBSCRIPTION_TIMEOUT_MS,
      customerSecretKey: custSk,
      kindOffsets: offsets_,
      sinceOverride: since_,
    } = options;

    const offsets = offsets_ ?? [DEFAULT_KIND_OFFSET];
    if (offsets.length === 0) {
      throw new Error('kindOffsets must not be empty.');
    }
    const resultKinds = offsets.map(jobResultKind);
    const since = since_ ?? Math.floor(Date.now() / 1000) - 30;
    const subs: SubCloser[] = [];
    let resolved = false;
    let resultDelivered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = () => {
      resolved = true;
      if (timer) {
        clearTimeout(timer);
      }
      for (const s of subs) {
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    };

    const decryptResult = (ev: Event): string | null => {
      if (isEncrypted(ev)) {
        if (!custSk) {
          return null;
        }
        try {
          return nip44Decrypt(ev.content, custSk, ev.pubkey);
        } catch {
          return null;
        }
      }
      return ev.content;
    };

    const handleResult = (ev: Event) => {
      if (resolved || resultDelivered) {
        return;
      }
      if (!verifyEvent(ev)) {
        return;
      }
      if (provPk && ev.pubkey !== provPk) {
        return;
      }
      const eTag = ev.tags.find((t) => t[0] === 'e')?.[1];
      if (eTag !== jid) {
        return;
      }
      const content = decryptResult(ev);
      if (content === null) {
        // Skip undecryptable results instead of terminating the subscription.
        // For broadcast jobs a rogue agent could send fake encrypted results;
        // killing the subscription would be a DoS vector.
        return;
      }
      let decoded;
      try {
        decoded = decodeJobPayload(content);
      } catch {
        // Malformed/unknown-version envelope - skip like an undecryptable result
        // rather than crashing the subscription.
        return;
      }
      resultDelivered = true;
      try {
        // For a file result, surface the text note (or '') plus the attachment
        // descriptor(s); the file(s) are fetched separately, never inlined here.
        // 3rd arg stays the single attachment (= attachments[0]) for back-compat;
        // 4th arg is the full list for multi-file results. 5th arg surfaces the
        // provider's settlement `tx` tag (delegated pull transparency) - shape-
        // gated so a hostile tag can never smuggle free text into the trusted
        // framing consumers render it in.
        const txTagValue = ev.tags.find((tag) => tag[0] === 'tx')?.[1];
        const paymentTxTag =
          txTagValue !== undefined && SOLANA_TX_SIGNATURE_REGEX.test(txTagValue)
            ? txTagValue
            : undefined;
        // 6th arg: what the provider says actually moved. On a metered job this
        // is the only place the real figure exists on the customer side - the
        // card carries the CEILING, and a local record built from that would
        // overstate every metered job in the buyer's own history.
        const amountTagValue = ev.tags.find((tag) => tag[0] === 'amount')?.[1];
        const paidAmountSubunits = safeParseInt(amountTagValue);
        cb.onResult?.(
          decoded.text ?? '',
          ev.id,
          decoded.attachment,
          attachmentsOf(decoded),
          paymentTxTag,
          paidAmountSubunits,
        );
      } catch {
        /* caller error - don't crash subscription */
      } finally {
        done();
      }
    };

    try {
      // Feedback subscription
      subs.push(
        this.pool.subscribe(
          {
            kinds: [KIND_JOB_FEEDBACK],
            '#e': [jid],
            since,
          } as Filter,
          (ev) => {
            if (resolved) {
              return;
            }
            if (!verifyEvent(ev)) {
              return;
            }
            if (provPk && ev.pubkey !== provPk) {
              return;
            }
            const eTag = ev.tags.find((t) => t[0] === 'e')?.[1];
            if (eTag !== jid) {
              return;
            }
            const statusTag = ev.tags.find((t) => t[0] === 'status');
            if (statusTag?.[1]) {
              const amtTag = ev.tags.find((t) => t[0] === 'amount');
              const amt = safeParseInt(amtTag?.[1]) ?? 0;
              const paymentReq = amtTag?.[2];
              try {
                cb.onFeedback?.(statusTag[1], amt, paymentReq, ev.pubkey);
              } catch {
                /* caller error - don't crash subscription */
              }
              // For targeted jobs (`provPk` set) an `error` feedback from
              // THE provider is terminal: surface the message via `onError`
              // and close the subscription so the customer doesn't sit
              // waiting until the global timeout. Broadcast jobs (no
              // `provPk`) intentionally keep the subscription open - a
              // single provider's rejection should not silence the others.
              if (provPk && statusTag[1] === 'error' && !resolved) {
                const errorMessage = ev.content?.trim() || 'Provider returned an error';
                done();
                try {
                  cb.onError?.(errorMessage);
                } catch {
                  /* caller error - don't crash subscription */
                }
              }
            }
          },
        ),
      );

      // Result subscription by #e tag
      subs.push(
        this.pool.subscribe(
          {
            kinds: resultKinds,
            '#e': [jid],
            since,
          } as Filter,
          handleResult,
        ),
      );

      // Result subscription by #p tag (customer pubkey) + #e tag
      subs.push(
        this.pool.subscribe(
          {
            kinds: resultKinds,
            '#p': [custPk],
            '#e': [jid],
            since,
          } as Filter,
          handleResult,
        ),
      );
    } catch (err) {
      done();
      throw err;
    }

    timer = setTimeout(() => {
      if (!resolved) {
        done();
        try {
          // Prefer the structured `onTimeout` signal; fall back to the
          // legacy `onError` string so callers that predate `onTimeout`
          // (and the external agent `hire.ts` scripts) keep working.
          if (cb.onTimeout) {
            cb.onTimeout(timeoutMs);
          } else {
            cb.onError?.(`Timed out waiting for response (${timeoutMs / 1000}s).`);
          }
        } catch {
          /* caller error - don't crash subscription */
        }
      }
    }, timeoutMs);

    return done;
  }

  /**
   * Submit payment confirmation feedback.
   *
   * `network` tags the event so the reputation tally can scope it to a network
   * (a missing tag is read as `devnet` by consumers). Optional and trailing to
   * keep the published signature backward-compatible.
   */
  async submitPaymentConfirmation(
    identity: ElisymIdentity,
    jobEventId: string,
    providerPubkey: string,
    txSignature: string,
    network?: Network,
  ): Promise<void> {
    const tags: string[][] = [
      ['e', jobEventId],
      ['p', providerPubkey],
      ['status', 'payment-completed'],
      ['tx', txSignature, 'solana'],
      ['t', 'elisym'],
    ];
    if (network) {
      tags.push(['network', network]);
    }

    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  /**
   * Submit rating feedback for a job.
   *
   * `opts.txSignature` attaches the payment tx as proof-carrying data for a
   * future off-chain indexer - it is NOT verified on-chain here. `opts.network`
   * scopes the rating to a network (missing => `devnet`). The options object is
   * a trailing 6th param to keep the published signature backward-compatible.
   */
  async submitFeedback(
    identity: ElisymIdentity,
    jobEventId: string,
    providerPubkey: string,
    positive: boolean,
    capability?: string,
    opts?: { txSignature?: string; network?: Network },
  ): Promise<void> {
    const tags: string[][] = [
      ['e', jobEventId],
      ['p', providerPubkey],
      ['status', 'success'],
      ['rating', positive ? '1' : '0'],
      ['t', 'elisym'],
    ];
    if (capability) {
      tags.push(['t', capability]);
    }
    if (opts?.txSignature) {
      tags.push(['tx', opts.txSignature, 'solana']);
    }
    if (opts?.network) {
      tags.push(['network', opts.network]);
    }

    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: positive ? 'Good result' : 'Poor result',
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  // --- Provider methods ---

  /**
   * Subscribe to incoming job requests for specific kinds.
   * Automatically decrypts NIP-44 encrypted content.
   * Note: decrypted events have modified `content` - do not call `verifyEvent()` on them.
   * Signature verification is performed before decryption.
   */
  subscribeToJobRequests(
    identity: ElisymIdentity,
    kinds: number[],
    onRequest: (event: Event) => void,
  ): SubCloser {
    return this.pool.subscribe(
      {
        kinds,
        '#p': [identity.publicKey],
        '#t': ['elisym'],
        since: Math.floor(Date.now() / 1000) - 5,
      } as Filter,
      (event: Event) => {
        if (!verifyEvent(event)) {
          return;
        }
        if (isEncrypted(event) && event.content) {
          try {
            const decrypted = nip44Decrypt(event.content, identity.secretKey, event.pubkey);
            onRequest({ ...event, content: decrypted });
          } catch {
            // Can't decrypt - skip event (likely not intended for us)
            return;
          }
        } else {
          onRequest(event);
        }
      },
    );
  }

  /**
   * Submit a job result with NIP-44 encrypted content. Result kind is derived
   * from the request kind. `options.paymentTx` attaches the on-chain
   * settlement signature (e.g. a delegated pull) as a public `tx` tag for
   * customer-side transparency.
   */
  async submitJobResult(
    identity: ElisymIdentity,
    requestEvent: Event,
    content: string,
    amount?: number,
    attachments?: FileAttachment[],
    options?: { paymentTx?: string },
  ): Promise<string> {
    const hasAttachment = attachments !== undefined && attachments.length > 0;
    if (!content && !hasAttachment) {
      throw new Error('Job result content must not be empty.');
    }
    if (!Number.isInteger(requestEvent.kind)) {
      throw new Error(`Invalid request event kind: expected integer, got ${requestEvent.kind}.`);
    }
    const offset = requestEvent.kind - KIND_JOB_REQUEST_BASE;
    if (offset < 0 || offset >= 1000) {
      throw new Error(
        `Invalid request event kind ${requestEvent.kind}: expected a NIP-90 job request kind (5000-5999).`,
      );
    }
    const shouldEncrypt = isEncrypted(requestEvent);
    // A file result wraps the (optional) text + attachment in an envelope so the
    // recovery/empty-content path always has non-empty content to deliver.
    const payload = hasAttachment
      ? encodeJobPayload({ text: content || undefined, attachments })
      : content;
    // NIP-44 backstop (same as submitJobRequest): the post-envelope payload must
    // fit the 65_535-byte cap. A large text result should have been spilled to a
    // text/plain attachment by the provider, leaving only the small ticket here.
    if (shouldEncrypt) {
      const payloadBytes = utf8ByteLength(payload);
      if (payloadBytes > LIMITS.NIP44_MAX_PLAINTEXT_BYTES) {
        throw new Error(
          `Encrypted job result too large: ${payloadBytes} bytes (max ${LIMITS.NIP44_MAX_PLAINTEXT_BYTES}). Deliver large results as a file/iroh attachment instead.`,
        );
      }
    }
    const resultContent = shouldEncrypt
      ? nip44Encrypt(payload, identity.secretKey, requestEvent.pubkey)
      : payload;
    const resultKind = KIND_JOB_RESULT_BASE + offset;

    const tags: string[][] = [
      ['e', requestEvent.id],
      ['p', requestEvent.pubkey],
      ['t', 'elisym'],
    ];
    if (shouldEncrypt) {
      tags.push(['encrypted', 'nip44']);
    }

    if (amount !== null && amount !== undefined) {
      assertLamports(amount, 'result amount');
      tags.push(['amount', String(amount)]);
    }

    if (options?.paymentTx) {
      tags.push(['tx', options.paymentTx, 'solana']);
    }

    const event = finalizeEvent(
      {
        kind: resultKind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: resultContent,
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
    return event.id;
  }

  /**
   * Submit a job result with retry and exponential backoff.
   * Retries on publish failures (e.g. relay disconnects).
   * With maxAttempts=3: try, ~1s, try, ~2s, try, throw.
   * Jitter: 0.5x-1.0x of calculated delay.
   */
  async submitJobResultWithRetry(
    identity: ElisymIdentity,
    requestEvent: Event,
    content: string,
    amount?: number,
    maxAttempts: number = DEFAULTS.RESULT_RETRY_COUNT,
    baseDelayMs: number = DEFAULTS.RESULT_RETRY_BASE_MS,
    attachments?: FileAttachment[],
    options?: { paymentTx?: string },
  ): Promise<string> {
    const attempts = Math.max(1, maxAttempts);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.submitJobResult(
          identity,
          requestEvent,
          content,
          amount,
          attachments,
          options,
        );
      } catch (e: unknown) {
        if (attempt >= attempts - 1) {
          throw e;
        }
        // Math.random is fine for jitter - not a security context
        const jitter = 0.5 + Math.random() * 0.5;
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt) * jitter));
      }
    }
    throw new Error('All delivery attempts failed');
  }

  /** Submit payment-required feedback with a payment request. */
  async submitPaymentRequiredFeedback(
    identity: ElisymIdentity,
    requestEvent: Event,
    amount: number,
    paymentRequestJson: string,
  ): Promise<void> {
    assertLamports(amount, 'payment amount');
    if (amount === 0) {
      throw new Error('Invalid payment amount: 0. Must be positive.');
    }
    try {
      JSON.parse(paymentRequestJson);
    } catch {
      throw new Error('Invalid paymentRequestJson: must be valid JSON.');
    }
    if (paymentRequestJson.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new Error(
        `paymentRequestJson too long: ${paymentRequestJson.length} chars (max ${LIMITS.MAX_INPUT_LENGTH}).`,
      );
    }

    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', requestEvent.id],
          ['p', requestEvent.pubkey],
          ['status', 'payment-required'],
          ['amount', String(amount), paymentRequestJson, 'solana'],
          ['t', 'elisym'],
        ],
        content: '',
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  /** Submit processing feedback to notify customer that work has started. */
  async submitProcessingFeedback(identity: ElisymIdentity, requestEvent: Event): Promise<void> {
    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', requestEvent.id],
          ['p', requestEvent.pubkey],
          ['status', 'processing'],
          ['t', 'elisym'],
        ],
        content: '',
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  /** Submit error feedback to notify customer of a failure. */
  async submitErrorFeedback(
    identity: ElisymIdentity,
    requestEvent: Event,
    message: string,
  ): Promise<void> {
    if (!message) {
      throw new Error('Error message must not be empty.');
    }
    if (message.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new Error(
        `Error message too long: ${message.length} chars (max ${LIMITS.MAX_INPUT_LENGTH}).`,
      );
    }
    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', requestEvent.id],
          ['p', requestEvent.pubkey],
          ['status', 'error'],
          ['t', 'elisym'],
        ],
        content: message,
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  /**
   * Query job results by request IDs and decrypt NIP-44 content.
   *
   * SECURITY: bind results to a known author. Nostr event ids are public, so without a
   * binding ANY key can publish a higher-`created_at` kind-6xxx tagging a victim's job id
   * - and because NIP-44 is symmetric, even the encrypted body can be forged to the
   * customer - winning the newest-per-request slot. For a single known provider pass
   * `providerPubkey`. For a batch of jobs with different providers pass `providerByRequest`
   * (jobId -> trusted provider): the author check then runs INSIDE the newest-wins pick,
   * so a forgery cannot win the slot and evict (suppress) the legit result. A post-hoc
   * `senderPubkey` filter is NOT sufficient - the forgery would already have displaced the
   * real result. A request absent from `providerByRequest` (nostr-only, no known provider)
   * accepts any author, unchanged - surfaced as unauthenticated per the caller's warning.
   */
  async queryJobResults(
    identity: ElisymIdentity,
    requestIds: string[],
    kindOffsets?: number[],
    providerPubkey?: string,
    providerByRequest?: Map<string, string>,
  ): Promise<
    Map<
      string,
      { content: string; amount?: number; senderPubkey: string; decryptionFailed: boolean }
    >
  > {
    const offsets = kindOffsets ?? [DEFAULT_KIND_OFFSET];
    if (offsets.length === 0) {
      throw new Error('kindOffsets must not be empty.');
    }
    const resultKinds = offsets.map(jobResultKind);

    const results = await this.pool.queryBatchedByTag(
      { kinds: resultKinds } as Filter,
      'e',
      requestIds,
    );

    const resultByRequest = new Map<
      string,
      { content: string; amount?: number; senderPubkey: string; decryptionFailed: boolean }
    >();
    const createdAtByRequest = new Map<string, number>();
    const nowSecs = Math.floor(Date.now() / 1000);
    for (const r of results) {
      if (!verifyEvent(r)) {
        continue;
      }
      // Reject a far-future `created_at` (same clamp as fetchRecentJobs) so a forged
      // result cannot win newest-wins by post-dating the real one.
      if (r.created_at > nowSecs + MAX_FUTURE_SKEW_SECS) {
        continue;
      }
      if (providerPubkey && r.pubkey !== providerPubkey) {
        continue;
      }
      const eTag = r.tags.find((t) => t[0] === 'e');
      if (!eTag?.[1]) {
        continue;
      }
      // Per-request author binding for batch callers: reject a result not from the
      // request's known provider BEFORE the newest-wins pick, so a forgery cannot win
      // the slot and thereby suppress the legit result. A request absent from the map
      // (nostr-only, no known provider) accepts any author, unchanged.
      const boundProvider = providerByRequest?.get(eTag[1]);
      if (boundProvider !== undefined && r.pubkey !== boundProvider) {
        continue;
      }

      const prevTs = createdAtByRequest.get(eTag[1]) ?? 0;
      if (r.created_at < prevTs) {
        continue;
      }

      const amtTag = r.tags.find((t) => t[0] === 'amount');

      let content = r.content;
      let decryptionFailed = false;
      if (isEncrypted(r)) {
        try {
          content = nip44Decrypt(r.content, identity.secretKey, r.pubkey);
        } catch {
          content = '';
          decryptionFailed = true;
        }
      }

      createdAtByRequest.set(eTag[1], r.created_at);
      resultByRequest.set(eTag[1], {
        content,
        amount: safeParseInt(amtTag?.[1]),
        senderPubkey: r.pubkey,
        decryptionFailed,
      });
    }

    return resultByRequest;
  }

  // --- Query methods ---

  /**
   * Fetch recent jobs from the network.
   * NOTE: Job.result contains raw event content. For encrypted jobs,
   * this will be NIP-44 ciphertext - use queryJobResults() for decryption.
   */
  async fetchRecentJobs(
    agentPubkeys?: Set<string>,
    limit?: number,
    since?: number,
    /** Kind offsets to query (default [100]). */
    kindOffsets?: number[],
    /** Only return job requests authored by this customer pubkey. */
    customerPubkey?: string,
  ): Promise<Job[]> {
    const offsets = kindOffsets ?? [DEFAULT_KIND_OFFSET];
    if (offsets.length === 0) {
      throw new Error('kindOffsets must not be empty.');
    }
    if (customerPubkey !== undefined && !/^[0-9a-f]{64}$/.test(customerPubkey)) {
      throw new Error('Invalid customer pubkey: expected 64 hex characters.');
    }
    const requestKinds = offsets.map(jobRequestKind);
    const resultKinds = offsets.map(jobResultKind);

    const reqFilter: Filter = {
      kinds: requestKinds,
      '#t': ['elisym'],
      ...(customerPubkey !== undefined && { authors: [customerPubkey] }),
      ...(limit !== null && limit !== undefined && { limit }),
      ...(since !== null && since !== undefined && { since }),
    };
    const rawRequests = await this.pool.querySync(reqFilter);
    const requests = rawRequests.filter(verifyEvent);

    const requestIds = requests.map((r) => r.id);
    let results: Event[] = [];
    let feedbacks: Event[] = [];

    if (requestIds.length > 0) {
      const [rawResults, rawFeedbacks] = await Promise.all([
        this.pool.queryBatchedByTag({ kinds: resultKinds } as Filter, 'e', requestIds),
        this.pool.queryBatchedByTag({ kinds: [KIND_JOB_FEEDBACK] } as Filter, 'e', requestIds),
      ]);
      results = rawResults.filter(verifyEvent);
      feedbacks = rawFeedbacks.filter(verifyEvent);
    }

    // Build targeted agent map
    const targetedAgentByRequest = new Map<string, string>();
    for (const req of requests) {
      const pTag = req.tags.find((t) => t[0] === 'p');
      if (pTag?.[1]) {
        targetedAgentByRequest.set(req.id, pTag[1]);
      }
    }

    // For broadcast jobs (no `p` tag on the request) the provider the customer
    // actually paid is named in the `p` tag of the customer's own payment-completed
    // feedback - use it to author-bind the result, since the request has no target.
    const requestAuthorById = new Map(requests.map((req) => [req.id, req.pubkey]));
    const paidProviderByRequest = new Map<string, string>();
    for (const f of feedbacks) {
      const reqId = resolveRequestId(f);
      if (!reqId || f.pubkey !== requestAuthorById.get(reqId)) {
        continue;
      }
      if (f.tags.find((t) => t[0] === 'status')?.[1] !== 'payment-completed') {
        continue;
      }
      const paidProvider = f.tags.find((t) => t[0] === 'p')?.[1];
      if (paidProvider) {
        paidProviderByRequest.set(reqId, paidProvider);
      }
    }

    // The single trusted provider anchor per request: the targeted agent, or (for a
    // broadcast job) the provider the customer actually paid. It author-binds the fields
    // a third party must not be able to poison by `#e`-tagging the public job id:
    // `tx` (bound to the customer below) and `asset`/amount/status (bound to this anchor).
    // An UNBOUND broadcast job (no target, no payment) has no anchor: feedback-derived
    // fields are dropped entirely (see the feedback loop), but its RESULT is still
    // surfaced from the responding provider's own signed event - that is the
    // free-broadcast flow, whose provider self-selects and cannot be anchored on Nostr.
    // So for an unbound job the result-derived provider/status/amount/content are
    // unauthenticated (display-only, pending the off-chain indexer); the boundary-wrapped
    // sanitizer still caps result-content blast radius.
    const boundProviderByRequest = new Map<string, string>();
    for (const req of requests) {
      const bound = targetedAgentByRequest.get(req.id) ?? paidProviderByRequest.get(req.id);
      if (bound) {
        boundProviderByRequest.set(req.id, bound);
      }
    }

    // Index results by request ID (clock-skew capped, keep newest). Author-bound to the
    // anchor when there is one; an unbound broadcast job keeps the responding provider's
    // own result (free-broadcast) - unauthenticated, display-only per the anchor note.
    const nowSecs = Math.floor(Date.now() / 1000);
    const resultsByRequest = new Map<string, Event>();
    for (const r of results) {
      const reqId = resolveRequestId(r);
      if (!reqId) {
        continue;
      }
      // Reject a far-future `created_at` so a forged result cannot win newest-wins.
      if (r.created_at > nowSecs + MAX_FUTURE_SKEW_SECS) {
        continue;
      }
      // Bind to the anchor when present; an unbound broadcast job keeps the responding
      // provider's own result (free-broadcast) - see the boundProviderByRequest note.
      const boundProvider = boundProviderByRequest.get(reqId);
      if (boundProvider && r.pubkey !== boundProvider) {
        continue;
      }
      const existing = resultsByRequest.get(reqId);
      if (!existing || r.created_at > existing.created_at) {
        resultsByRequest.set(reqId, r);
      }
    }

    // Only the bound provider's own feedback drives the feedback-derived summary
    // (status/amount/asset). Unlike the result loop above, an unbound (broadcast) job
    // surfaces NO feedback - a status/amount claim from an arbitrary author carries no
    // deliverable, so forging one via an `#e`-tag on the public job id gains nothing.
    const feedbackByRequest = new Map<string, Event>();
    for (const f of feedbacks) {
      const reqId = resolveRequestId(f);
      if (!reqId || f.created_at > nowSecs + MAX_FUTURE_SKEW_SECS) {
        continue;
      }
      const boundProvider = boundProviderByRequest.get(reqId);
      if (!boundProvider || f.pubkey !== boundProvider) {
        continue;
      }
      const existing = feedbackByRequest.get(reqId);
      if (!existing || f.created_at > existing.created_at) {
        feedbackByRequest.set(reqId, f);
      }
    }

    // Index all feedbacks by request ID for O(1) lookup
    const feedbacksByRequestId = new Map<string, Event[]>();
    for (const f of feedbacks) {
      const reqId = resolveRequestId(f);
      if (!reqId) {
        continue;
      }
      const arr = feedbacksByRequestId.get(reqId);
      if (arr) {
        arr.push(f);
      } else {
        feedbacksByRequestId.set(reqId, [f]);
      }
    }

    const jobs: Job[] = [];
    for (const req of requests) {
      const result = resultsByRequest.get(req.id);
      const feedback = feedbackByRequest.get(req.id);
      // Provider is the result author or the bound provider anchor - never a feedback
      // author, which for an unbound broadcast job could be anyone.
      const jobAgentPubkey = result?.pubkey ?? boundProviderByRequest.get(req.id);

      if (agentPubkeys && agentPubkeys.size > 0 && jobAgentPubkey) {
        if (!agentPubkeys.has(jobAgentPubkey)) {
          continue;
        }
      }

      // NIP-90: one capability per job request - take the first non-elisym t tag
      const capability = req.tags.find((t) => t[0] === 't' && t[1] !== 'elisym')?.[1];
      const bid = req.tags.find((t) => t[0] === 'bid')?.[1];

      let status: JobStatus = 'processing';
      let amount: number | undefined;
      let txHash: string | undefined;
      let asset: PaymentAssetRef | undefined;

      if (result) {
        status = 'success';
        const amtTag = result.tags.find((t) => t[0] === 'amount');
        amount = safeParseInt(amtTag?.[1]);
      }

      // Read the tx hash + payment asset from feedback, but bind each field to
      // its legitimate author so a third party cannot poison them by publishing a
      // feedback that merely `#e`-references the public job id. `tx` is signed by
      // the customer (the request author) in the payment-completed / rating
      // feedback; the payment asset rides in the provider's payment-required
      // feedback (its `amount` tag holds `[amount, raw, requestJson, chain]`).
      const jobProvider = boundProviderByRequest.get(req.id);
      const allFeedbacksForReq = feedbacksByRequestId.get(req.id) ?? [];
      for (const fb of allFeedbacksForReq) {
        if (!txHash && fb.pubkey === req.pubkey) {
          const txTag = fb.tags.find((t) => t[0] === 'tx');
          if (txTag?.[1]) {
            txHash = txTag[1];
          }
        }
        if (!asset && jobProvider && fb.pubkey === jobProvider) {
          const amtTag = fb.tags.find((t) => t[0] === 'amount');
          const requestJson = amtTag?.[2];
          if (requestJson) {
            const parsed = parsePaymentRequest(requestJson);
            if (parsed.ok && parsed.data.asset) {
              asset = parsed.data.asset;
            }
          }
        }
      }

      if (feedback) {
        if (!result) {
          const statusTag = feedback.tags.find((t) => t[0] === 'status');
          if (statusTag?.[1]) {
            const isTargeted = targetedAgentByRequest.has(req.id);
            if (statusTag[1] === 'payment-required' && !bid && !isTargeted) {
              // Broadcast job without bid: a provider offered to work, but customer
              // hasn't committed. Keep "processing" because showing "payment-required"
              // would imply the customer chose this provider. The actual payment-required
              // transition happens via subscribeToJobUpdates() in real-time.
            } else {
              status = toJobStatus(statusTag[1]);
            }
          }
        }
        // Amount fallback: `feedback` was already selected as the bound provider's own
        // feedback above, so it carries no third-party amount and needs no further
        // author check here.
        if (!amount) {
          const amtTag = feedback.tags.find((t) => t[0] === 'amount');
          amount = safeParseInt(amtTag?.[1]);
        }
      }

      jobs.push({
        eventId: req.id,
        customer: req.pubkey,
        agentPubkey: jobAgentPubkey,
        capability,
        bid: safeParseInt(bid),
        status,
        result: result?.content,
        resultEventId: result?.id,
        amount,
        txHash,
        asset,
        createdAt: req.created_at,
      });
    }

    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Subscribe to live elisym events (requests, results, feedback). */
  subscribeToEvents(kinds: number[], onEvent: (event: Event) => void): SubCloser {
    return this.pool.subscribe(
      {
        kinds,
        '#t': ['elisym'],
        since: Math.floor(Date.now() / 1000),
      } as Filter,
      (event) => {
        if (!verifyEvent(event)) {
          return;
        }
        onEvent(event);
      },
    );
  }
}
