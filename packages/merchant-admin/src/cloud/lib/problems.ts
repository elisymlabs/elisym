/**
 * A store save's refusal in words (plan `admin-onboarding.md` 2.6). The node
 * and cloud-api refuse with `<field path>: <what is wrong>` lines; a merchant
 * reads which part of the store it is about and what to do, never the path.
 * The line as it came stays under "Details", for support.
 */

/** The part of the store a refusal is about, where the form shows it; undefined: the store as a whole. */
export type ProblemField =
  | 'name'
  | 'domain'
  | 'webhook'
  | 'solana'
  | 'tempo'
  | 'ethereum'
  | 'arbitrum'
  | 'base'
  | 'products'
  | 'payouts';

export interface ProblemText {
  field: ProblemField | undefined;
  /** The sentence shown. */
  text: string;
  /** The refusal as it came. */
  raw: string;
}

type Network = 'solana' | 'tempo' | 'ethereum' | 'arbitrum' | 'base';

const NETWORK_NAMES: Record<Network, string> = {
  solana: 'Solana',
  tempo: 'Tempo',
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  base: 'Base',
};

/** A product's name shown in a sentence only when it reads as one: the form's own ids do. */
const SHOWN_PRODUCT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FALLBACK = 'The store could not take this change: try again, or contact us with the details.';

function networkOf(path: string): Network | undefined {
  const [first = '', second = ''] = path.split('.');
  if (first === 'solana' || first === 'rpcUrl') {
    return 'solana';
  }
  if (first === 'tempo' || first.startsWith('tempo')) {
    return 'tempo';
  }
  if (first === 'evm' && (second === 'ethereum' || second === 'arbitrum' || second === 'base')) {
    return second;
  }
  return undefined;
}

/** About its RPC (in the path or the words): the network could not be reached; else its settings. */
function networkText(network: Network, problem: string): string {
  const name = NETWORK_NAMES[network];
  return /rpc/i.test(problem)
    ? `${name}: we could not reach this network just now. Try again shortly.`
    : `${name}: this network's settings were refused. Turn it off and on again, or contact us.`;
}

function productText(path: string): string {
  const name = path.slice('products/'.length);
  return SHOWN_PRODUCT.test(name)
    ? `The product "${name}": check its title, price and description.`
    : 'One of your products: check its title, price and description.';
}

/** A refusal line as the merchant reads it. */
export function problemText(problem: string): ProblemText {
  const colon = problem.indexOf(': ');
  const path = colon < 0 ? '' : problem.slice(0, colon);
  if (problem.startsWith('no products')) {
    return { field: 'products', text: 'Add at least one product to sell.', raw: problem };
  }
  if (path.startsWith('products/')) {
    return { field: 'products', text: productText(path), raw: problem };
  }
  const root = path.split('.')[0] ?? '';
  if (root === 'name') {
    return {
      field: 'name',
      text: 'Store name: give your store a name, up to 100 characters.',
      raw: problem,
    };
  }
  if (root === 'nip05') {
    return {
      field: 'domain',
      text: 'Domain: write only a domain you own, with no https:// and no path.',
      raw: problem,
    };
  }
  if (root === 'webhookUrl' || root === 'webhook') {
    return {
      field: 'webhook',
      text: 'Webhook: use an https address on a public server.',
      raw: problem,
    };
  }
  if (root === 'payouts') {
    return {
      field: 'payouts',
      text: 'Payouts: one of your wallets was refused. Check its address and network.',
      raw: problem,
    };
  }
  const network = networkOf(path);
  if (network !== undefined) {
    return { field: network, text: networkText(network, problem), raw: problem };
  }
  return { field: undefined, text: FALLBACK, raw: problem };
}
