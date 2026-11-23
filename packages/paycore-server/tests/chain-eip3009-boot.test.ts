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

function boot(
  check: (context: Eip3009Context, now: number) => Promise<Eip3009StartCheck>,
  logs: string[] = [],
) {
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

  it('stop cuts a backoff wait short, so settled resolves at shutdown', async () => {
    const { check, calls } = scriptedCheck({
      'eip155:8453': [{ kind: 'transient', problem: 'transport' }],
    });
    const instance = new Eip3009Boot({
      configs: [CONFIG],
      clientFor: fakeClient,
      log: () => undefined,
      now: () => NOW,
      check,
      backoffSecs: [900],
    });
    await instance.start();
    instance.stop();
    const first = await Promise.race([
      instance.settled().then(() => 'settled'),
      new Promise((resolve) => {
        setImmediate(() => resolve('still waiting'));
      }),
    ]);
    expect(first).toBe('settled');
    expect(calls.filter((caip2) => caip2 === 'eip155:8453')).toHaveLength(1);
  });

  it('a check that throws on a retry is a logged transient, and the retries go on', async () => {
    let baseCalls = 0;
    const check = async (context: Eip3009Context): Promise<Eip3009StartCheck> => {
      if (context.chain.caip2 !== 'eip155:8453') {
        return { kind: 'passed' };
      }
      baseCalls += 1;
      if (baseCalls === 1) {
        return { kind: 'transient', problem: 'transport' };
      }
      if (baseCalls === 2) {
        throw new Error('socket hang up');
      }
      return { kind: 'passed' };
    };
    const logs: string[] = [];
    const { instance, sleeps } = boot(check, logs);
    await instance.start();
    await instance.settled();
    expect(baseCalls).toBe(3);
    expect(instance.gateOf('eip155:8453')).toEqual({ kind: 'verified' });
    expect(sleeps).toEqual([60_000, 120_000]);
    expect(
      logs.some(
        (line) => line.includes('not yet verified') && line.includes('threw: socket hang up'),
      ),
    ).toBe(true);
  });

  it('after the last configured delay the retries keep waiting that delay', async () => {
    const { check } = scriptedCheck({
      'eip155:8453': Array.from({ length: 8 }, () => ({
        kind: 'transient' as const,
        problem: 'transport',
      })),
    });
    const nextAts: number[] = [];
    const recording = async (context: Eip3009Context, now: number) => {
      const gate = instance.gateOf(context.chain.caip2);
      if (gate?.kind === 'deferred' && gate.attempts > 0) {
        nextAts.push(gate.nextAt - now);
      }
      return await check(context);
    };
    const { instance, sleeps } = boot(recording);
    await instance.start();
    await instance.settled();
    expect(sleeps).toEqual([60, 120, 300, 600, 900, 900, 900, 900].map((secs) => secs * 1000));
    expect(nextAts).toEqual([60, 120, 300, 600, 900, 900, 900, 900]);
    expect(instance.gateOf('eip155:8453')).toEqual({ kind: 'verified' });
  });

  it('a wrong answer at boot also ends the retries of a chain deferred before it', async () => {
    const { check, calls } = scriptedCheck({
      'eip155:42161': [{ kind: 'transient', problem: 'transport' }],
      'eip155:8453': [{ kind: 'wrong', problem: 'eth_chainId names another chain' }],
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
    expect(instance.chainIds).toEqual(['eip155:42161', 'eip155:8453']);
    await expect(instance.start()).rejects.toThrow(/Base RPC failed the start check/);
    release();
    await instance.settled();
    expect(calls).toEqual(['eip155:42161', 'eip155:8453']);
    expect(instance.gateOf('eip155:42161')).toMatchObject({ kind: 'deferred' });
  });

  it('logs the warning of a check passed at boot', async () => {
    const { check } = scriptedCheck({
      'eip155:8453': [{ kind: 'passed', warning: 'the RPC answers slowly' }],
    });
    const logs: string[] = [];
    const { instance } = boot(check, logs);
    await instance.start();
    expect(logs).toEqual(['warning: Base: the RPC answers slowly']);
    expect(instance.gateOf('eip155:8453')).toEqual({ kind: 'verified' });
  });

  it('each registered context holds its own copy of the shared gate', async () => {
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
    const perStore = storeContexts();
    for (const contexts of perStore) {
      instance.register(contexts);
    }
    const [first, second] = perStore.map((contexts) =>
      contexts.find((context) => context.chain.caip2 === 'eip155:8453'),
    );
    const [firstArbitrum, secondArbitrum] = perStore.map((contexts) =>
      contexts.find((context) => context.chain.caip2 === 'eip155:42161'),
    );
    if (
      first === undefined ||
      second === undefined ||
      firstArbitrum === undefined ||
      secondArbitrum === undefined
    ) {
      throw new Error('Base and Arbitrum contexts expected for two stores');
    }
    const deferredCopy = first.gate;
    expect(deferredCopy).not.toBe(second.gate);
    expect(deferredCopy).not.toBe(instance.gateOf('eip155:8453'));
    expect(firstArbitrum.gate).toEqual({ kind: 'verified' });
    expect(firstArbitrum.gate).not.toBe(secondArbitrum.gate);
    expect(firstArbitrum.gate).not.toBe(instance.gateOf('eip155:42161'));
    release();
    await instance.settled();
    // The change replaced each copy; the object a store held before is untouched.
    expect(deferredCopy).toMatchObject({ kind: 'deferred', attempts: 1 });
    expect(first.gate).toEqual({ kind: 'verified' });
    expect(first.gate).not.toBe(second.gate);
    expect(first.gate).not.toBe(instance.gateOf('eip155:8453'));
  });
});
