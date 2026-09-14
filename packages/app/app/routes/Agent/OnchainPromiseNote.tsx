import { DEFAULT_INCIDENTAL_LAMPORTS, NATIVE_SOL, type OnchainDescriptor } from '@elisym/sdk';
import { ceilingLabel, descriptorAsset } from '~/lib/onchainCall';

interface Props {
  descriptor: OnchainDescriptor;
}

/**
 * What an `onchain` capability delivers, said BEFORE the money is spent.
 *
 * The wallet address is the load-bearing half. The provider's script is handed
 * the buyer's text and nothing else - no wallet, no customer identity - so a
 * call can only be built for an address the customer put in the message
 * themselves. Without that the paid job either errors or comes back built for
 * some other wallet, which this client refuses as `wrong-signer` after the
 * money is gone, and there is no refund path. MCP's `search_agents` has always
 * emitted this; the browser said nothing at all.
 *
 * ALL THREE BOUNDS ARE NAMED, not just the spend ceiling. `assertCeilings`
 * applies three, and a sentence promising only the first is a promise the code
 * does not keep on a page where the customer decides whether to buy: an
 * authority ceiling is a standing approval that outlives the transaction, and
 * the SOL allowance lets fees - and, on a token-denominated card, account rent
 * - leave on top of the published ceiling, so a `max_per_call: "0"` card would
 * otherwise read as "this cannot cost you anything".
 */
export function OnchainPromiseNote({ descriptor }: Props) {
  const asset = descriptorAsset(descriptor);
  const ceiling = ceilingLabel(BigInt(descriptor.max_per_call_subunits), asset);
  const authority = descriptor.grants_authority
    ? ceilingLabel(BigInt(descriptor.max_authority_subunits), asset)
    : null;
  const allowance = ceilingLabel(DEFAULT_INCIDENTAL_LAMPORTS, NATIVE_SOL);
  return (
    <div className="border-b border-border/60 px-14 pt-14 pb-10 text-xs text-text-2 sm:px-20 sm:pt-16">
      <span className="text-text">This capability delivers a Solana transaction you sign.</span>{' '}
      Include the address of the wallet you will sign with - it is the only thing the capability is
      given to build the call for you. It publishes a ceiling of {ceiling} leaving your wallet per
      call
      {authority ? `, and asks to approve up to ${authority} for it to spend later` : ''}. Network
      fees, and any rent for accounts the call creates, ride a separate allowance of up to{' '}
      {allowance} on top. Your wallet checks the call against all of it, and shows you what it
      found, before anything is signed.
    </div>
  );
}
