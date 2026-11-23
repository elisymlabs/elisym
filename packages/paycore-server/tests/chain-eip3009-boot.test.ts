import type { Eip1193Client } from '@elisym/pay-core/evm';
import type { MerchantConfig } from '@merchant-node/config';
import {
  type Eip3009Context,
  type Eip3009StartCheck,
  eip3009ContextsFor,
  sweepEip3009,
} from '@merchant-node/eip3009';
import { emptyLedger } from '@merchant-node/ledger';
import { describe, expect, it } from 'vitest';
import { Eip3009Boot } from '../src/chain/eip3009-boot';

const NOW = 1_791_000_000;
const BASE_RPC = 'https://base.operator.example';
const ARBITRUM_RPC = 'https://arbitrum.operator.example';
const CONFIG: Pick<MerchantConfig, 'network' | 'evm'> = {
  network: 'mainnet',
  evm: { base: { rpcUrl: BASE_RPC }, arbitrum: { rpcUrl: ARBITRUM_RPC } },
};
const STORE_KEYS = ['a', 'b', 'c'].map((letter) => letter.repeat(64));

function fakeClient(): Eip1193Client {
  return {
    request: async () => {
      throw new Error('the fake client is never asked');
    },
  };
}

/** A check answering from a script per chain, counting its calls. */
function scriptedCheck(script: Record<string, Eip3009StartCheck[]>) {
  const calls: string[] = [];
  const check = async (context: Eip3009Context): Promise<Eip3009StartCheck> => {
    const caip2 = context.chain.caip2;
    calls.push(caip2);
    const answers = script[caip2] ?? [];
    return answers.shift() ?? { kind: 'passed' };
  };
  return { check, calls };
}

function storeContexts(): Eip3009Context[][] {
  return STORE_KEYS.map((storePubkey) =>
    eip3009ContextsFor(CONFIG, storePubkey, { clientFor: fakeClient }),
  );
}

function boot(check: ReturnType<typeof scriptedCheck>['check'], logs: string[] = []) {
  const sleeps: number[] = [];
  const instance = new Eip3009Boot({
    configs: [CONFIG],
    clientFor: fakeClient,
    log: (message) => logs.push(message),
    now: () => NOW,
    check,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { instance, sleeps };
}

describe('Eip3009Boot', () => {
  it('checks each chain once for every store, and registered contexts start verified', async () => {
    const { check, calls } = scriptedCheck({});
    const { instance } = boot(check);
    await instance.start();
    const perStore = storeContexts();
    for (const contexts of perStore) {
      instance.register(contexts);
    }
    expect(calls.sort()).toEqual(['eip155:42161', 'eip155:8453']);
    for (const context of perStore.flat()) {
      expect(context.gate).toEqual({ kind: 'verified' });
    }
  });

  it('a transient check, then a pass, moves every registered context to verified', async () => {
    const transient: Eip3009StartCheck = {
      kind: 'transient',
      problem: 'eth_chainId failed (HTTP 429)',
    };
    const { check, calls } = scriptedCheck({ 'eip155:8453': [transient, transient] });
    const logs: string[] = [];
    const sleeps: number[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new Eip3009Boot({
      configs: [CONFIG],
      clientFor: fakeClient,
      log: (message) => logs.push(message),
      now: () => NOW,
      check,
      sleep: async (ms) => {
        sleeps.push(ms);
        await held;
      },
    });
    await gated.start();
    const perStore = storeContexts();
    for (const contexts of perStore) {
      gated.register(contexts);
    }
    const baseContexts = perStore.flat().filter((context) => context.chain.caip2 === 'eip155:8453');
    expect(baseContexts).toHaveLength(STORE_KEYS.length);
    for (const context of baseContexts) {
      expect(context.gate).toMatchObject({ kind: 'deferred', attempts: 1 });
    }
    // A store's own sweep never runs the check while the shared one is deferred.
    const sweepChecks: number[] = [];
    const [firstBase] = baseContexts;
    if (firstBase === undefined) {
      throw new Error('no Base context');
    }
    const idle = await sweepEip3009(emptyLedger(), firstBase, NOW + 10 ** 9, () => undefined, {
      check: async () => {
        sweepChecks.push(1);
        return { kind: 'passed' };
      },
    });
    expect(idle).toEqual({ paid: [], incomplete: [] });
    expect(sweepChecks).toEqual([]);
    release();
    await gated.settled();
    expect(gated.gateOf('eip155:8453')).toEqual({ kind: 'verified' });
    for (const context of perStore.flat()) {
      expect(context.gate).toEqual({ kind: 'verified' });
    }
    expect(calls.filter((caip2) => caip2 === 'eip155:8453')).toHaveLength(3);
    expect(sleeps).toEqual([60_000, 120_000]);
    expect(logs.some((line) => line.includes('Base RPC verified'))).toBe(true);
  });

  it('a context registered while deferred, and one registered after, follow the shared gate', async () => {
    const { check } = scriptedCheck({
      'eip155:8453': [{ kind: 'transient', problem: 'transport' }],
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instance = new Eip3009Boot({
      configs: [CONFIG],
      clientFor: fakeClient,
      log: () => undefined,
      now: () => NOW,
      check,
      sleep: async () => {
        await held;
      },
    });
    await instance.start();
    const [first, second, third] = storeContexts();
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('three stores expected');
    }
    instance.register(first);
    const unregister = instance.register(second);
    unregister();
    release();
    await instance.settled();
    instance.register(third);
    for (const context of [...first, ...third]) {
      expect(context.gate).toEqual({ kind: 'verified' });
    }
    // An unregistered store is left as it was.
    const secondBase = second.find((context) => context.chain.caip2 === 'eip155:8453');
    expect(secondBase?.gate).toMatchObject({ kind: 'deferred' });
  });

  it('a wrong answer at boot throws', async () => {
    const { check } = scriptedCheck({
      'eip155:42161': [{ kind: 'wrong', problem: 'eth_chainId names another chain' }],
    });
    const { instance } = boot(check);
    await expect(instance.start()).rejects.toThrow(
      /RPC failed the start check: eth_chainId names another chain/,
    );
  });

  it('a wrong answer on a background retry fails the chain for every registered context', async () => {
    const { check } = scriptedCheck({
      'eip155:8453': [
        { kind: 'transient', problem: 'transport' },
        { kind: 'wrong', problem: 'no USDC transfer in the window' },
      ],
    });
    const logs: string[] = [];
    const { instance } = boot(check, logs);
    await instance.start();
    const perStore = storeContexts();
    for (const contexts of perStore) {
      instance.register(contexts);
    }
    await instance.settled();
    for (const context of perStore.flat()) {
      expect(context.gate).toEqual(
        context.chain.caip2 === 'eip155:8453'
          ? { kind: 'failed', problem: 'no USDC transfer in the window' }
          : { kind: 'verified' },
      );
    }
    expect(logs.some((line) => line.includes('not scanned until a restart'))).toBe(true);
  });

  it('refuses a store context for a chain not checked at boot', () => {
    const instance = new Eip3009Boot({
      configs: [{ network: 'mainnet', evm: { base: { rpcUrl: BASE_RPC } } }],
      clientFor: fakeClient,
      log: () => undefined,
      now: () => NOW,
    });
    const [contexts] = storeContexts();
    if (contexts === undefined) {
      throw new Error('no store');
    }
    expect(() => instance.register(contexts)).toThrow(/has no operator RPC checked at boot/);
  });

  it('stop ends the background retries', async () => {
    const { check, calls } = scriptedCheck({
      'eip155:8453': Array.from({ length: 10 }, () => ({
        kind: 'transient' as const,
        problem: 'transport',
      })),
    });
    let instance: Eip3009Boot | undefined;
    instance = new Eip3009Boot({
      configs: [CONFIG],
      clientFor: fakeClient,
      log: () => undefined,
      now: () => NOW,
      check,
      sleep: async () => {
        instance?.stop();
      },
    });
    await instance.start();
    await instance.settled();
    expect(calls.filter((caip2) => caip2 === 'eip155:8453')).toHaveLength(1);
    expect(instance.gateOf('eip155:8453')).toMatchObject({ kind: 'deferred' });
  });
});
