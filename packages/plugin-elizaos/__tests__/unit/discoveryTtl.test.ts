import type { IAgentRuntime } from '@elizaos/core';
import { describe, expect, it } from 'vitest';
import { hireAgentAction } from '../../src/actions/hireAgent';
import { DISCOVERY_TTL_MS } from '../../src/constants';
import { getState } from '../../src/state';
import { bootState, makeStubRuntime } from '../helpers/runtime';

function seedDiscovery(runtime: IAgentRuntime, ts: number, expiresAt: number): void {
  const state = getState(runtime);
  state.lastDiscovery = {
    query: 'summarization',
    candidates: [
      {
        pubkey: 'provider-pk',
        capabilities: ['summarization'],
        priceLamports: 2_000_000n,
        address: 'So1addr111111111111111111111111111111111',
      },
    ],
    ts,
    expiresAt,
  };
}

describe('discovery TTL', () => {
  it('hireAgent.validate returns true for fresh discovery', async () => {
    const runtime = makeStubRuntime();
    bootState(runtime);
    const now = Date.now();
    seedDiscovery(runtime, now, now + DISCOVERY_TTL_MS);
    const ok = await hireAgentAction.validate(runtime, {} as never, undefined);
    expect(ok).toBe(true);
  });

  it('hireAgent.validate returns false once discovery is past expiresAt', async () => {
    const runtime = makeStubRuntime();
    bootState(runtime);
    const past = Date.now() - DISCOVERY_TTL_MS - 1_000;
    seedDiscovery(runtime, past, past + DISCOVERY_TTL_MS);
    const ok = await hireAgentAction.validate(runtime, {} as never, undefined);
    expect(ok).toBe(false);
  });

  it('hireAgent.validate returns false when no discovery has happened', async () => {
    const runtime = makeStubRuntime();
    bootState(runtime);
    const ok = await hireAgentAction.validate(runtime, {} as never, undefined);
    expect(ok).toBe(false);
  });
});
