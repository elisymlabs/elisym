import * as nip19 from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';
import {
  choiceOf,
  domainOf,
  domainRecord,
  emptyForm,
  formOf,
  nip05Of,
  storeReadOf,
} from '../../src/cloud/lib/settings';

const STORE = '1'.repeat(64);
const OWNER = '2'.repeat(64);

describe('the settings form', () => {
  it('reads a kept choice and sends it back as it was', () => {
    const choice = {
      name: 'Shop',
      nip05: '_@shop.example',
      webhookUrl: 'https://shop.example/hook',
      solana: { rpcUrl: 'https://my-rpc.example' },
      tempo: {},
      evm: { base: { credit: 'fast' }, ethereum: {} },
    };
    const form = formOf(choice);
    expect(form).toEqual({
      name: 'Shop',
      domain: 'shop.example',
      webhookUrl: 'https://shop.example/hook',
      solana: { on: true, rpcUrl: 'https://my-rpc.example' },
      tempo: { on: true, rpcUrl: '' },
      evm: {
        ethereum: { on: true, rpcUrl: '', credit: '' },
        arbitrum: { on: false, rpcUrl: '', credit: '' },
        base: { on: true, rpcUrl: '', credit: 'fast' },
      },
    });
    expect(form === undefined ? undefined : choiceOf(form)).toEqual({
      ...choice,
      evm: { base: { credit: 'fast' }, ethereum: {}, arbitrum: null },
    });
  });

  it('sends a rail off as null, an empty RPC as none, every field trimmed', () => {
    const form = emptyForm();
    expect(choiceOf(form)).toEqual({
      name: '',
      solana: null,
      tempo: null,
      evm: { ethereum: null, arbitrum: null, base: null },
    });
    expect(
      choiceOf({
        ...form,
        name: '  Shop ',
        domain: ' shop.example ',
        webhookUrl: '  ',
        solana: { on: true, rpcUrl: '  ' },
        tempo: { on: true, rpcUrl: ' https://t.example ' },
        evm: { ...form.evm, arbitrum: { on: true, rpcUrl: '', credit: 'safe' } },
      }),
    ).toEqual({
      name: 'Shop',
      nip05: '_@shop.example',
      solana: {},
      tempo: { rpcUrl: 'https://t.example' },
      evm: { ethereum: null, arbitrum: { credit: 'safe' }, base: null },
    });
  });

  it('refuses a kept choice it cannot show', () => {
    for (const broken of [
      { name: 1 },
      { name: 'S', nip05: 2 },
      { name: 'S', webhookUrl: {} },
      { name: 'S', solana: 'on' },
      { name: 'S', solana: { rpcUrl: 5 } },
      { name: 'S', tempo: [] },
      { name: 'S', evm: { base: { credit: 'later' } } },
      { name: 'S', evm: { base: null } },
      {},
      5,
      null,
    ]) {
      expect(formOf(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });
});

describe('the store as cloud-api gives it back', () => {
  const READ = {
    choice: null,
    products: {},
    storePubkey: null,
    pending: false,
    refused: null,
    relayHints: [],
    loader: null,
    waitingChoice: null,
    waitingProducts: null,
    ownerRefusal: null,
    keptPayoutList: null,
    publishing: false,
  };
  const LOADER = {
    src: 'https://pay.acme.example/v4/embed.js',
    integrity: `sha384-${'A'.repeat(64)}`,
  };

  it('names the kept products from productNames while a set waits, else from the kept texts', () => {
    expect(storeReadOf({ ...READ, products: { course: '---' } })?.productNames).toEqual(['course']);
    const waiting = storeReadOf({
      ...READ,
      products: {},
      productNames: ['course', 'ebook'],
      waitingProducts: { course: '---', ebook: '---', extra: '---' },
    });
    expect(waiting?.productNames).toEqual(['course', 'ebook']);
    expect(waiting?.waitingProducts).toEqual({ course: '---', ebook: '---', extra: '---' });
    expect(storeReadOf({ ...READ, productNames: [1] })).toBeUndefined();
    expect(storeReadOf({ ...READ, productNames: 'course' })).toBeUndefined();
  });

  it('takes a well-formed answer: nothing saved yet is the empty form', () => {
    expect(storeReadOf(READ)).toEqual({
      form: emptyForm(),
      saved: false,
      products: {},
      productNames: [],
      storePubkey: undefined,
      pending: false,
      refused: undefined,
      relayHints: [],
      loader: undefined,
      waitingForm: undefined,
      waitingProducts: undefined,
      ownerRefusal: undefined,
      keptPayoutList: undefined,
      publishing: false,
    });
    expect(storeReadOf({ ...READ, loader: LOADER })?.loader).toEqual(LOADER);
    expect(
      storeReadOf({
        choice: { name: 'S' },
        products: { course: '---' },
        storePubkey: STORE,
        pending: true,
        refused: ['name: is required'],
        relayHints: ['wss://relay.elisym.network'],
        loader: null,
        waitingChoice: { name: 'Waiting', nip05: '_@shop.example' },
        waitingProducts: { ebook: '---' },
        ownerRefusal: 'revoked',
        keptPayoutList: { id: 'a'.repeat(64), createdAt: 5 },
        publishing: true,
      }),
    ).toMatchObject({
      saved: true,
      refused: ['name: is required'],
      waitingForm: { ...emptyForm(), name: 'Waiting', domain: 'shop.example' },
      waitingProducts: { ebook: '---' },
      ownerRefusal: 'revoked',
      keptPayoutList: { id: 'a'.repeat(64), createdAt: 5 },
      publishing: true,
      products: { course: '---' },
      storePubkey: STORE,
      pending: true,
    });
  });

  it('leaves out a relay hint no page could reach, without refusing the read', () => {
    expect(
      storeReadOf({
        ...READ,
        relayHints: ['ws://local:7777', 'wss://relay.elisym.network', 'https://x'],
      })?.relayHints,
    ).toEqual(['wss://relay.elisym.network']);
  });

  it('refuses one that is not', () => {
    for (const broken of [
      { ...READ, choice: { name: 1 } },
      { ...READ, products: null },
      { ...READ, products: [] },
      { ...READ, products: { course: 1 } },
      { ...READ, storePubkey: 'npub1x' },
      { ...READ, storePubkey: 5 },
      { ...READ, pending: 'no' },
      { ...READ, choice: undefined },
      { ...READ, refused: 'no' },
      { ...READ, refused: [1] },
      { ...READ, refused: undefined },
      { ...READ, relayHints: undefined },
      { ...READ, relayHints: [1] },
      { ...READ, waitingChoice: { name: 1 } },
      { ...READ, waitingChoice: undefined },
      { ...READ, waitingProducts: { course: 1 } },
      { ...READ, waitingProducts: [] },
      { ...READ, waitingProducts: undefined },
      { ...READ, ownerRefusal: 'other' },
      { ...READ, ownerRefusal: undefined },
      { ...READ, keptPayoutList: undefined },
      { ...READ, keptPayoutList: { id: 'x', createdAt: 5 } },
      { ...READ, keptPayoutList: { id: 'a'.repeat(64), createdAt: '5' } },
      { ...READ, keptPayoutList: { id: 'a'.repeat(64), createdAt: 5.5 } },
      { ...READ, publishing: undefined },
      { ...READ, publishing: 'yes' },
      { ...READ, loader: undefined },
      { ...READ, loader: { ...LOADER, src: 'http://pay.acme.example/v4/embed.js' } },
      { ...READ, loader: { ...LOADER, src: 'https://pay.acme.example/v3/embed.js' } },
      { ...READ, loader: { ...LOADER, src: 'https://pay.acme.example/v4/embed.js?x' } },
      { ...READ, loader: { ...LOADER, integrity: 'sha256-x' } },
      { ...READ, loader: { src: LOADER.src } },
    ]) {
      expect(storeReadOf(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });
});

describe('the domain', () => {
  it('is sent as the domain-wide name; a name typed with @ goes as typed', () => {
    expect(nip05Of('shop.example')).toBe('_@shop.example');
    expect(nip05Of('  shop.example ')).toBe('_@shop.example');
    expect(nip05Of('bob@shop.example')).toBe('bob@shop.example');
    expect(nip05Of('')).toBeUndefined();
    expect(nip05Of('  ')).toBeUndefined();
  });

  it('a kept nip05 under another name shows whole in the field', () => {
    expect(formOf({ name: 'S', nip05: 'bob@shop.example' })?.domain).toBe('bob@shop.example');
    expect(formOf({ name: 'S', nip05: '_@shop.example' })?.domain).toBe('shop.example');
  });

  it('vouches for the store only under _; none for another name, an empty or unusable one', () => {
    expect(domainOf('_@shop.example')).toBe('shop.example');
    expect(domainOf(' _@Shop.Example ')).toBe('shop.example');
    expect(domainOf('shop.example')).toBe('shop.example');
    for (const value of [undefined, '', 'bob@shop.example', '_@localhost', '_@10.0.0.1']) {
      expect(domainOf(value), String(value)).toBeUndefined();
    }
  });

  it('its TXT record names the owner and the store, under _elisym', () => {
    expect(domainRecord('shop.example', OWNER, STORE)).toEqual({
      name: '_elisym.shop.example',
      value: `v=elisym1; owner=${nip19.npubEncode(OWNER)}; store=${nip19.npubEncode(STORE)}`,
    });
  });
});
