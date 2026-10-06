import { useId } from 'preact/hooks';
import { type Problem, type View, payoutPaying } from '../session';
import { ChainGlyph } from './ChainGlyph';
import { EmailField } from './EmailField';
import { PROBLEM_PLACE } from './panel';
import { PayoutSelect } from './PayoutSelect';
import { ProblemNote } from './ProblemNote';
import { ProductBlock } from './ProductBlock';
import { payoutLabel } from './text';
import { WalletSection } from './WalletSection';

interface Props {
  view: Extract<View, { kind: 'offer' }>;
  /** The view's problem, unless the buyer moved on from it. */
  problem: Problem | undefined;
  email: string;
  onEmail(value: string): void;
  walletsOpen: boolean;
  onOpenWallets(): void;
  onChoosePayout(index: number): void;
  onPay(name: string): void;
  phone: boolean;
  /** A wallet was pressed: the payout and the wallets wait for the next view. */
  locked: boolean;
  /** Dev only (the fixture page): the payout list starts open. */
  initialListOpen?: boolean;
}

/**
 * The offer, top to bottom: the product and price, the payout, the email, then
 * the wallets. Only after a new offer-class problem (a changed price, say) does
 * "Choose wallet" stand in for them, so the buyer reviews before paying. Nothing
 * above is hidden by the wallets: the payout and the email stay editable until a
 * payment starts. A returning buyer's open order changes nothing here.
 */
export function OfferPanel({
  view,
  problem,
  email,
  onEmail,
  walletsOpen,
  onOpenWallets,
  onChoosePayout,
  onPay,
  phone,
  locked,
  initialListOpen = false,
}: Props) {
  const labelId = useId();
  const paying = payoutPaying(view.payout);
  const tempo = paying.chain === 'tempo';
  const emailField = view.askEmail;
  // A mistyped email shows at the field; with the wallets open, a wallet problem shows among them.
  const atEmail = emailField && problem?.reason === 'bad_email' ? problem : undefined;
  const inWallets =
    walletsOpen && problem !== undefined && PROBLEM_PLACE[problem.reason] === 'wallets'
      ? problem
      : undefined;
  const aboveButton = atEmail === undefined && inWallets === undefined ? problem : undefined;
  return (
    <div class="offer-panel">
      <ProductBlock product={view.offer.offer.product} />
      {view.payouts.length < 2 ? (
        <p class="pay-label">
          <ChainGlyph chain={paying.chain} />
          <span>{payoutLabel(paying)}</span>
        </p>
      ) : (
        <div class="pay-with">
          <p class="label" id={labelId}>
            Pay with
          </p>
          <PayoutSelect
            payouts={view.payouts}
            selected={view.payoutIndex}
            disabled={locked}
            onChoose={onChoosePayout}
            labelId={labelId}
            initialOpen={initialListOpen}
          />
        </div>
      )}
      {view.askEmail ? <EmailField value={email} onInput={onEmail} /> : null}
      <ProblemNote problem={atEmail} asset={paying.asset} reveal />
      <ProblemNote problem={aboveButton} asset={paying.asset} tempo={tempo} reveal />
      {walletsOpen ? (
        <WalletSection
          wallets={view.wallets}
          chain={paying.chain}
          asset={paying.asset}
          problem={inWallets}
          phone={phone}
          locked={locked}
          onPay={onPay}
        />
      ) : (
        <button type="button" class="primary" onClick={onOpenWallets}>
          Choose wallet
        </button>
      )}
    </div>
  );
}
