/**
 * A store save's refusal in words (plan `admin-onboarding.md` 2.6). The node
 * and cloud-api refuse with `<field path>: <what is wrong>` lines; a merchant
 * reads which part of the store it is about and what to do, never the path.
 * The line as it came stays under "Details", for support.
 */
import { EVM_CHAINS, type SettingsForm } from './settings';

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

/**
 * A network's refusal as the merchant can act on it. Their own endpoint
 * refused (the store has one for that network): back to ours, with "Use
 * ours" in Settings. An endpoint refused that is ours, or ours missing: ours
 * to fix, theirs to switch the network off meanwhile. Anything else about the
 * network: its settings.
 */
function networkText(network: Network, problem: string, own: ReadonlySet<string>): string {
  const name = NETWORK_NAMES[network];
  if (/rpc/i.test(problem) && own.has(network) && !/the cloud has no rpc/i.test(problem)) {
    return `Your own ${name} endpoint was refused: switch to ours in Settings (Use ours).`;
  }
  if (/rpc/i.test(problem)) {
    return `${name} is not available on our side yet: turn it off in Settings for now, or contact us.`;
  }
  return `${name}: this network's settings were refused. Turn it off and on again in Settings, or contact us.`;
}

function productText(path: string): string {
  const name = path.slice('products/'.length);
  return SHOWN_PRODUCT.test(name)
    ? `The product "${name}": check its title, price and description.`
    : 'One of your products: check its title, price and description.';
}

/** The networks a store's settings name an own endpoint for (by chain slug). */
export function ownEndpointsOf(form: SettingsForm | undefined): Set<string> {
  const own = new Set<string>();
  if (form === undefined) {
    return own;
  }
  if (form.solana.rpcUrl !== '') {
    own.add('solana');
  }
  if (form.tempo.rpcUrl !== '') {
    own.add('tempo');
  }
  for (const chain of EVM_CHAINS) {
    if (form.evm[chain].rpcUrl !== '') {
      own.add(chain);
    }
  }
  return own;
}

/**
 * A refusal line as the merchant reads it. `own`: the networks the store has
 * its own endpoint for (`ownEndpointsOf`); none known, every endpoint is ours.
 */
export function problemText(problem: string, own: ReadonlySet<string> = new Set()): ProblemText {
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
    return { field: network, text: networkText(network, problem, own), raw: problem };
  }
  return { field: undefined, text: FALLBACK, raw: problem };
}
