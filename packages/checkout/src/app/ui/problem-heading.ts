import type { Problem } from '../session';

/** Labels describe the problem; only the payment state may say whether money was paid. */
const HEADINGS = {
  no_wallet: 'Wallet not found',
  clock_skew: 'Check your device clock',
  rpc_error: 'Unable to reach the network',
  self_payment: 'Choose another account',
  too_late: 'This order has expired',
  tempo_unsupported: 'Selected wallet is not supported',
  wallet_busy: 'Check your open wallet request',
  order_not_acknowledged: 'Unable to send the order',
  no_store_inbox: 'Unable to contact the store',
  failed: 'Something went wrong',
  bad_email: 'Check your email',
  wallet_failed: 'Wallet confirmation interrupted',
  wallet_unsupported: 'Wallet not supported',
  other_payer: 'Use the original account',
  again_declined: 'Request declined',
  policy_blocked: 'Payment blocked',
  wrong_chain: 'Switch your wallet network',
  rejected: 'Request declined',
  attempt_over: 'This attempt has ended',
  late_approval: 'An earlier request was approved',
  offer_changed: 'Offer updated',
  offer_refused: 'Product unavailable',
  store_outdated: 'Store payments unavailable',
  wallet_cannot_batch: 'Choose another wallet',
  fee_config_unavailable: 'Unable to load payment terms',
  fee_config_invalid: 'Payment terms unavailable',
  wallet_payment_failed: 'Payment failed',
  sold_out: 'Sold out',
  other_purchase: 'Another payment is in progress',
  earlier_payment: 'Your earlier payment is being checked',
  insufficient_token: 'Insufficient funds',
  insufficient_sol: 'Insufficient SOL for fees',
  chain_unreachable: 'Unable to reach the network',
  sign_failed: 'Unable to use the signature',
  no_native: 'Network fee balance required',
  insufficient_native: 'Insufficient funds for network fees',
  token_blocked: 'Token transfer unavailable',
  payer_unsupported: 'Account not supported',
  wrong_chain_after_sign: 'Switch your wallet network',
  resign_needed: 'A new signature is needed',
  send_declined: 'Transaction not sent',
  send_failed: 'Transaction not sent',
  near_expiry: 'This request is about to expire',
  send_uncertain: 'Transaction status unknown',
  retry_blocked: 'Unable to retry this attempt',
} satisfies Record<Problem['reason'], string>;

export function problemHeading(problem: Problem): string {
  return problem.reason === 'wallet_failed' && problem.declined === true
    ? 'Request declined'
    : HEADINGS[problem.reason];
}
