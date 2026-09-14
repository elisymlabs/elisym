import { LIMITS, utf8ByteLength, type CapabilityCard } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import type { PingStatus } from '~/hooks/usePingAgent';
import { useSolGasFeeEstimate } from '~/hooks/useSolGasFeeEstimate';
import { useWalletBalances } from '~/hooks/useWalletBalances';
import { checkBuyAffordability, checkSelfPayment } from '~/lib/balanceCheck';
import { resolvePaymentAsset } from '~/lib/cardAsset';
import { SOLANA_CLUSTER } from '~/lib/cluster';
import { formatCardPriceLabel } from '~/lib/formatPrice';

interface Args {
  card: CapabilityCard;
  agentPubkey: string;
  pingStatus: PingStatus;
  /** Raw text input (the hook derives `effectiveInput` for file-only cards). */
  input: string;
  file: File | null;
  buying: boolean;
  /**
   * An active delegated allowance covers this card's price: the send needs no
   * per-job payment tx (the provider pulls from the delegation after the
   * work), so wallet-balance affordability must not gate it.
   */
  delegatedCovers?: boolean;
}

export interface JobGate {
  isDisabled: boolean;
  tip: string | null;
  isFree: boolean;
  isStatic: boolean;
  isOwn: boolean;
  needsFileInput: boolean;
  fileOnly: boolean;
  textRequiredForFile: boolean;
  fileOptional: boolean;
  showsTextarea: boolean;
  /** For a file-only card any typed text is stale - never send/record it. */
  effectiveInput: string;
  freeFileBlocked: boolean;
  fileTooLarge: boolean;
  inputTooLarge: boolean;
  priceLabel: string | null;
  gasFeeLamports: number;
  /** Paid card with no connected wallet: the action button becomes "Connect". */
  needsWalletConnect: boolean;
}

/**
 * The single source of JobInput's disable/tip gating, shared verbatim by the
 * Products-tab JobInput, the Chat composer, and Retry (recomputed at render
 * and re-checked at click) - per the stage-2 rule that a send surface
 * specified only as "calls buy()" must not silently submit to offline agents.
 */
export function useJobGating({
  card,
  agentPubkey,
  pingStatus,
  input,
  file,
  buying,
  delegatedCovers,
}: Args): JobGate {
  const { publicKey } = useWallet();
  const { relaysConnected } = useElisymClient();
  const idCtx = useIdentity();
  const isOwn = idCtx.publicKey === agentPubkey;

  const isStatic = card.static === true;
  // Capabilities that take a file input declare `inputMime`. We gate on presence
  // only and never trust/render the (untrusted) value - the file picker uses it as
  // a soft `accept` hint at most, and the provider content-sniffs the actual file.
  const needsFileInput = typeof card.inputMime === 'string' && card.inputMime.length > 0;
  // `input_text` says how a file skill treats the text prompt: 'none' = file only
  // (hide the text box), 'required' = file + text both required, 'optional' = the
  // FILE is optional and the instruction is required (a generate-or-edit skill:
  // text alone generates, text + photo edits), else (incl. undefined) = file
  // required + optional note. Only meaningful with `needsFileInput`.
  const fileOnly = needsFileInput && card.inputText === 'none';
  const textRequiredForFile = needsFileInput && card.inputText === 'required';
  // `optional` inverts the usual file-input gate: the instruction is required and
  // the file is an optional augmentation, so a file-capable card can still run
  // text-only (e.g. image generation without a photo to edit).
  const fileOptional = needsFileInput && card.inputText === 'optional';
  const showsTextarea = !isStatic && !fileOnly;
  // For a file-only card the text box is hidden, so any `input` is stale text left
  // over from a prior capability - never send/record it.
  const effectiveInput = fileOnly ? '' : input;
  const price = card.payment?.job_price ?? 0;
  const isFree = price === 0;
  // The provider rejects a file input on a zero-price skill before payment, so a
  // free + file-input card is unusable from the web - block it (gate on presence).
  const freeFileBlocked = isFree && needsFileInput;
  // Whole-buffer encrypt + upload is bounded to the encrypted-Blossom cap (100 MiB).
  const fileTooLarge = !!file && file.size > LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES;
  const gasFeeLamports = useSolGasFeeEstimate(card);
  // A metered card prices per use: `job_price` is the CEILING, and the buyer is
  // charged somewhere between the published floor and it. Labelling that as a
  // flat number would overstate the usual cost several-fold, so say the range.
  // Only the delegated rail can meter - a per-job purchase always pays the
  // ceiling, so the flat label stays correct there.
  //
  // `delegatedCovers` is the PAINTED buy mode, not the settled rail: if the
  // allowance lapses between paint and click the buy falls back to a per-job
  // payment and collects the ceiling (the same known window documented in
  // BuyContext's balance-recheck block). The label survives that honestly,
  // because the ceiling is the top of the range it already showed - it is only
  // ever an over-estimate, never an under-estimate.
  // `allowRange` is the rail: only a delegated buy can be metered, and a per-job
  // buy really does collect the ceiling, so its flat label is correct.
  const rangeLabel = formatCardPriceLabel(card, { allowRange: delegatedCovers });
  const showsMeteredRange = card.metered !== undefined && delegatedCovers;
  const priceLabel =
    rangeLabel !== null && showsMeteredRange ? `${rangeLabel} per use` : rangeLabel;
  // Poll only the asset this card is priced in - the gate never reads another.
  const paymentAsset = resolvePaymentAsset(card.payment, SOLANA_CLUSTER);
  const { solLamports, splRaw } = useWalletBalances(
    paymentAsset !== null && paymentAsset.mint !== undefined ? [paymentAsset] : [],
  );
  const selfPayment =
    !isFree && !!publicKey && !buying
      ? checkSelfPayment({ card, buyerWallet: publicKey.toBase58() })
      : { ok: true as const };
  const affordability =
    !isFree && !!publicKey && !buying && !delegatedCovers && selfPayment.ok
      ? checkBuyAffordability({
          card,
          solLamports,
          splRaw,
          gasLamports: gasFeeLamports,
          // Same cluster constant `useWalletBalances` keys `splRaw` by.
          network: SOLANA_CLUSTER,
        })
      : { ok: true as const };

  // The browser submits encrypted jobs and cannot spill large input to iroh
  // (node-only transport), so cap the input at the NIP-44 inline byte budget and
  // point large inputs at the CLI. Measured in BYTES - the cap is a byte cap.
  const inputTooLarge =
    !isStatic && utf8ByteLength(effectiveInput) > LIMITS.MAX_ENCRYPTED_INLINE_BYTES;

  const isDisabled =
    buying ||
    freeFileBlocked ||
    !relaysConnected ||
    // Text cards require text; file cards require a file (text is an optional note,
    // unless `input_text: required`, which needs both). A `fileOptional` card
    // inverts this: the file is optional and the instruction is required instead.
    ((!!publicKey || isFree) && !isStatic && !needsFileInput && !input.trim()) ||
    ((!!publicKey || isFree) && needsFileInput && !fileOptional && !file) ||
    ((!!publicKey || isFree) && textRequiredForFile && !input.trim()) ||
    ((!!publicKey || isFree) && fileOptional && !input.trim()) ||
    ((!!publicKey || isFree) && pingStatus !== 'online') ||
    inputTooLarge ||
    fileTooLarge ||
    !selfPayment.ok ||
    !affordability.ok;

  let tip: string | null = null;
  if (!buying) {
    if (freeFileBlocked) {
      tip = 'File inputs require a paid capability - this one is free.';
    } else if (!relaysConnected) {
      tip = 'Connecting to relays…';
    } else if ((!!publicKey || isFree) && pingStatus === 'pinging') {
      tip = 'Checking if the agent is available…';
    } else if ((!!publicKey || isFree) && pingStatus !== 'online') {
      tip = "This agent is offline right now, so you can't place an order. Try again later.";
    } else if (inputTooLarge) {
      tip = 'Input is too large for the web app - use the elisym CLI for large inputs.';
    } else if (fileTooLarge) {
      tip = 'File is too large for the web app (max 100 MiB) - use the elisym CLI.';
    } else if (!selfPayment.ok) {
      tip = selfPayment.tooltip;
    } else if (!affordability.ok) {
      tip = affordability.tooltip;
    }
  }

  return {
    isDisabled,
    tip,
    isFree,
    isStatic,
    isOwn,
    needsFileInput,
    fileOnly,
    textRequiredForFile,
    fileOptional,
    showsTextarea,
    effectiveInput,
    freeFileBlocked,
    fileTooLarge,
    inputTooLarge,
    priceLabel,
    gasFeeLamports,
    needsWalletConnect: !isFree && !publicKey,
  };
}
