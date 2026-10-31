/**
 * The store's settings as the console edits them: a form model to and from
 * the choice cloud-api takes (`POST /tenants/:id/store`) and gives back
 * (`GET /tenants/:id/store`). The cloud builds config.json from the choice;
 * the console never writes it.
 */
import { splitNip05 } from '@elisym/commerce';
import * as nip19 from 'nostr-tools/nip19';
import { fieldOf } from './fields';

export const EVM_CHAINS = ['ethereum', 'arbitrum', 'base'] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];

export interface RailForm {
  on: boolean;
  /** The merchant's own RPC; empty for the cloud's. */
  rpcUrl: string;
}

export interface EvmForm extends RailForm {
  /** Empty for the node's default. */
  credit: '' | 'fast' | 'safe';
}

export interface SettingsForm {
  name: string;
  /**
   * The store's own domain (`shop.example`; sent as nip05 `_@shop.example`, the
   * domain-wide name level A needs); empty for none. A kept nip05 under another
   * name shows whole, so the merchant sees it and can set the domain instead.
   */
  domain: string;
  webhookUrl: string;
  solana: RailForm;
  tempo: RailForm;
  evm: Record<EvmChain, EvmForm>;
}

/** What `GET /tenants/:id/store` says, checked. */
export interface StoreRead {
  form: SettingsForm;
  /** Whether settings were ever saved (applied). */
  saved: boolean;
  /** The kept set's texts; empty while this owner's set waits (`waitingProducts` holds the texts). */
  products: Record<string, string>;
  /** The kept, published products by name (the snippets name these), whether or not a set waits. */
  productNames: string[];
  storePubkey: string | undefined;
  /** An edit still waits to be kept: what is shown is what was kept before it. */
  pending: boolean;
  /** The node's problems with the latest settings edit, refused as it ran; undefined when none. */
  refused: string[] | undefined;
  /** The relays a product's naddr names (the store's first inbox relays). */
  relayHints: string[];
  /** A partner's checkout loader (its hostname's v4) the snippets name; undefined for the default. */
  loader: CheckoutLoader | undefined;
  /** The settings this owner saved that still wait to be kept (queued, or retried): edited on from. */
  waitingForm: SettingsForm | undefined;
  /** The product set this owner saved that still waits to be kept: edited on from. */
  waitingProducts: Record<string, string> | undefined;
  /** The node's standing owner-side refusal: the store was revoked, or its events must be signed again. */
  ownerRefusal: 'revoked' | 'resign' | undefined;
  /** The payout list the store keeps to publish, by id and date (what goes out with the store). */
  keptPayoutList: { id: string; createdAt: number } | undefined;
  /** A setup still to run (an edit, a launch, a Resume): what the store keeps has not gone out yet. */
  publishing: boolean;
}

/** A checkout loader: its URL and the SRI it is pinned by. */
export interface CheckoutLoader {
  src: string;
  integrity: string;
}

/** A loader the cloud names: an https `/v4/embed.js` and a sha384 SRI; anything else is not taken. */
function loaderOf(value: unknown): CheckoutLoader | null | 'bad' {
  if (value === null) {
    return null;
  }
  const src = fieldOf(value, 'src');
  const integrity = fieldOf(value, 'integrity');
  if (
    typeof src !== 'string' ||
    typeof integrity !== 'string' ||
    !/^https:\/\/[a-z0-9.-]+\/v4\/embed\.js$/.test(src) ||
    !/^sha384-[A-Za-z0-9+/]{64}$/.test(integrity)
  ) {
    return 'bad';
  }
  return { src, integrity };
}

const OFF: RailForm = { on: false, rpcUrl: '' };

function railForm(value: unknown): RailForm | 'bad' {
  if (value === undefined) {
    return OFF;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'bad';
  }
  const rpcUrl = fieldOf(value, 'rpcUrl');
  if (rpcUrl !== undefined && typeof rpcUrl !== 'string') {
    return 'bad';
  }
  return { on: true, rpcUrl: rpcUrl ?? '' };
}

function text(value: unknown): string | 'bad' {
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : 'bad';
}

/** The form for a kept choice (undefined: nothing saved yet, the empty form). */
export function formOf(choice: unknown): SettingsForm | undefined {
  const evm: Partial<Record<EvmChain, EvmForm>> = {};
  const evmChoice = fieldOf(choice, 'evm');
  for (const chain of EVM_CHAINS) {
    const rail = railForm(fieldOf(evmChoice, chain));
    const credit = fieldOf(fieldOf(evmChoice, chain), 'credit');
    if (rail === 'bad' || (credit !== undefined && credit !== 'fast' && credit !== 'safe')) {
      return undefined;
    }
    evm[chain] = { ...rail, credit: credit ?? '' };
  }
  const name = fieldOf(choice, 'name');
  const nip05 = text(fieldOf(choice, 'nip05'));
  // A domain-wide name shows as its domain; any other name whole.
  const wide = nip05 !== 'bad' && nip05.startsWith('_@');
  const domain = wide ? nip05.slice(2) : nip05;
  const webhookUrl = text(fieldOf(choice, 'webhookUrl'));
  const solana = railForm(fieldOf(choice, 'solana'));
  const tempo = railForm(fieldOf(choice, 'tempo'));
  const { ethereum, arbitrum, base } = evm;
  if (
    typeof name !== 'string' ||
    domain === 'bad' ||
    webhookUrl === 'bad' ||
    solana === 'bad' ||
    tempo === 'bad' ||
    ethereum === undefined ||
    arbitrum === undefined ||
    base === undefined
  ) {
    return undefined;
  }
  return { name, domain, webhookUrl, solana, tempo, evm: { ethereum, arbitrum, base } };
}

/** Every rail a store can have on, by its chain slug. */
export const ALL_RAILS = ['solana', 'tempo', ...EVM_CHAINS] as const;

/** The chain slugs of the rails a form has on. */
export function railsOf(form: SettingsForm): Set<string> {
  const rails = new Set<string>();
  if (form.solana.on) {
    rails.add('solana');
  }
  if (form.tempo.on) {
    rails.add('tempo');
  }
  for (const chain of EVM_CHAINS) {
    if (form.evm[chain].on) {
      rails.add(chain);
    }
  }
  return rails;
}

/**
 * The form with these rails on as well (on the cloud's RPC): a rail already
 * on keeps its own RPC and credit mode, and none is turned off.
 */
export function withRailsOn(form: SettingsForm, rails: Iterable<string>): SettingsForm {
  const turnOn = (rail: RailForm): RailForm => (rail.on ? rail : { on: true, rpcUrl: '' });
  const next: SettingsForm = { ...form, evm: { ...form.evm } };
  for (const rail of rails) {
    if (rail === 'solana') {
      next.solana = turnOn(form.solana);
    } else if (rail === 'tempo') {
      next.tempo = turnOn(form.tempo);
    } else {
      const chain = EVM_CHAINS.find((each) => each === rail);
      if (chain !== undefined) {
        next.evm[chain] = { ...form.evm[chain], ...turnOn(form.evm[chain]) };
      }
    }
  }
  return next;
}

/** The empty form: a new store's. */
export function emptyForm(): SettingsForm {
  const evm: EvmForm = { ...OFF, credit: '' };
  return {
    name: '',
    domain: '',
    webhookUrl: '',
    solana: OFF,
    tempo: OFF,
    evm: { ethereum: evm, arbitrum: evm, base: evm },
  };
}

function railChoice(rail: RailForm): { rpcUrl?: string } | null {
  if (!rail.on) {
    return null;
  }
  const rpcUrl = rail.rpcUrl.trim();
  return rpcUrl === '' ? {} : { rpcUrl };
}

/** The choice the console sends: a rail off is `null` (the cloud turns it off), fields trimmed. */
export function choiceOf(form: SettingsForm): Record<string, unknown> {
  const evm: Record<string, unknown> = {};
  for (const chain of EVM_CHAINS) {
    const rail = railChoice(form.evm[chain]);
    const credit = form.evm[chain].credit;
    evm[chain] = rail === null ? null : { ...rail, ...(credit === '' ? {} : { credit }) };
  }
  const nip05 = nip05Of(form.domain);
  return {
    name: form.name.trim(),
    ...(nip05 === undefined ? {} : { nip05 }),
    ...(form.webhookUrl.trim() === '' ? {} : { webhookUrl: form.webhookUrl.trim() }),
    solana: railChoice(form.solana),
    tempo: railChoice(form.tempo),
    evm,
  };
}

/** A kept choice as a form; undefined when the answer has none. */
function formOfAnswer(choice: unknown): SettingsForm | undefined {
  return choice === undefined ? undefined : formOf(choice);
}

/** The store read from an answer's body, or undefined when it is not what it must be. */
export function storeReadOf(body: unknown): StoreRead | undefined {
  const choice = fieldOf(body, 'choice');
  const form = choice === null ? emptyForm() : formOfAnswer(choice);
  const products = fieldOf(body, 'products');
  const storePubkey = fieldOf(body, 'storePubkey');
  const pending = fieldOf(body, 'pending');
  const refused = fieldOf(body, 'refused');
  const relayHints = fieldOf(body, 'relayHints');
  const loader = loaderOf(fieldOf(body, 'loader'));
  const waitingChoice = fieldOf(body, 'waitingChoice');
  const waitingForm = waitingChoice === null ? undefined : formOf(waitingChoice);
  const waitingProducts = fieldOf(body, 'waitingProducts');
  const productNames = fieldOf(body, 'productNames');
  const ownerRefusal = fieldOf(body, 'ownerRefusal');
  const publishing = fieldOf(body, 'publishing');
  if (typeof publishing !== 'boolean') {
    return undefined;
  }
  const keptPayoutList = fieldOf(body, 'keptPayoutList');
  const keptId = fieldOf(keptPayoutList, 'id');
  const keptCreatedAt = fieldOf(keptPayoutList, 'createdAt');
  if (
    keptPayoutList !== null &&
    (typeof keptId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(keptId) ||
      typeof keptCreatedAt !== 'number' ||
      !Number.isSafeInteger(keptCreatedAt))
  ) {
    return undefined;
  }
  if (ownerRefusal !== null && ownerRefusal !== 'revoked' && ownerRefusal !== 'resign') {
    return undefined;
  }
  if (
    form === undefined ||
    products === null ||
    typeof products !== 'object' ||
    Array.isArray(products) ||
    !Object.values(products).every((content) => typeof content === 'string') ||
    (storePubkey !== null &&
      (typeof storePubkey !== 'string' || !/^[0-9a-f]{64}$/.test(storePubkey))) ||
    typeof pending !== 'boolean' ||
    (refused !== null && !isTexts(refused)) ||
    !isTexts(relayHints) ||
    loader === 'bad' ||
    (waitingChoice !== null && waitingForm === undefined) ||
    (waitingProducts !== null && !isTextMap(waitingProducts)) ||
    (productNames !== undefined && !isTexts(productNames))
  ) {
    return undefined;
  }
  const texts: Record<string, string> = {};
  for (const [name, content] of Object.entries(products)) {
    texts[name] = String(content);
  }
  const waitingTexts: Record<string, string> = {};
  if (waitingProducts !== null) {
    for (const [name, content] of Object.entries(waitingProducts)) {
      waitingTexts[name] = String(content);
    }
  }
  return {
    form,
    saved: choice !== null,
    products: texts,
    productNames: Array.isArray(productNames) ? productNames.map(String) : Object.keys(texts),
    storePubkey: storePubkey === null ? undefined : storePubkey,
    pending,
    refused: refused === null ? undefined : refused,
    // A hint no page could reach is left out, never a reason to refuse the read.
    relayHints: relayHints.filter((relay) => relay.startsWith('wss://')),
    loader: loader === null ? undefined : loader,
    waitingForm,
    waitingProducts: waitingProducts === null ? undefined : waitingTexts,
    ownerRefusal: ownerRefusal === null ? undefined : ownerRefusal,
    keptPayoutList:
      typeof keptId === 'string' && typeof keptCreatedAt === 'number'
        ? { id: keptId, createdAt: keptCreatedAt }
        : undefined,
    publishing,
  };
}

function isTextMap(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((content) => typeof content === 'string')
  );
}

function isTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The nip05 the console sends for the domain field: `_@<domain>`, or as typed when it names someone. */
export function nip05Of(domain: string): string | undefined {
  const trimmed = domain.trim();
  if (trimmed === '') {
    return undefined;
  }
  return trimmed.includes('@') ? trimmed : `_@${trimmed}`;
}

/**
 * The domain a nip05 vouches for the whole store under (`_@shop.example` ->
 * `shop.example`); undefined for none, or for another name, which buyers do
 * not take as the domain's.
 */
export function domainOf(nip05: string | undefined): string | undefined {
  const split = nip05 === undefined ? undefined : splitNip05(nip05);
  return split?.local === '_' ? split.domain : undefined;
}

/** The DNS TXT record that makes the domain name this owner and this store (level A). */
export function domainRecord(
  domain: string,
  ownerPubkey: string,
  storePubkey: string,
): { name: string; value: string } {
  return {
    name: `_elisym.${domain}`,
    value: `v=elisym1; owner=${nip19.npubEncode(ownerPubkey)}; store=${nip19.npubEncode(storePubkey)}`,
  };
}
