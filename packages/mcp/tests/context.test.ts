import { describe, it, expect } from 'vitest';
import { AgentContext } from '../src/context.js';

describe('AgentContext', () => {
  it('throws when no active agent', () => {
    const ctx = new AgentContext();
    expect(() => ctx.active()).toThrow('No active agent');
  });

  it('registers and activates agent', () => {
    const ctx = new AgentContext();
    const instance = {
      client: {} as any,
      identity: {} as any,
      name: 'test',
    };
    ctx.register(instance);
    expect(ctx.active()).toBe(instance);
    expect(ctx.activeAgentName).toBe('test');
  });

  it('registers without activating', () => {
    const ctx = new AgentContext();
    const a = { client: {} as any, identity: {} as any, name: 'a' };
    const b = { client: {} as any, identity: {} as any, name: 'b' };
    ctx.register(a);
    ctx.register(b, false);
    expect(ctx.active()).toBe(a);
    expect(ctx.registry.size).toBe(2);
  });

  it('rate limiter blocks after max calls', () => {
    const ctx = new AgentContext();
    // toolRateLimiter allows 10 calls per 10s
    for (let i = 0; i < 10; i++) {
      ctx.toolRateLimiter.check();
    }
    expect(() => ctx.toolRateLimiter.check()).toThrow('Rate limit exceeded');
  });

  it('withdraw rate limiter is stricter', () => {
    const ctx = new AgentContext();
    // withdrawRateLimiter allows 3 calls per 60s
    for (let i = 0; i < 3; i++) {
      ctx.withdrawRateLimiter.check();
    }
    expect(() => ctx.withdrawRateLimiter.check()).toThrow('Rate limit exceeded');
  });

  it('rejects nonce issuance when MAX_PENDING_NONCES reached', () => {
    const ctx = new AgentContext();
    for (let i = 0; i < AgentContext.MAX_PENDING_NONCES; i++) {
      ctx.issueWithdrawalNonce({
        id: `n${i}`,
        agentName: 'a',
        destination: 'dest',
        amountRaw: '0.000000001',
        lamports: 1n,
        createdAt: Date.now(),
      });
    }
    expect(() =>
      ctx.issueWithdrawalNonce({
        id: 'overflow',
        agentName: 'a',
        destination: 'dest',
        amountRaw: '0.000000001',
        lamports: 1n,
        createdAt: Date.now(),
      }),
    ).toThrow('Too many pending withdrawal previews');
  });

  it('evicts expired nonces before checking MAX_PENDING_NONCES limit', () => {
    const ctx = new AgentContext();
    // Fill with expired nonces
    for (let i = 0; i < AgentContext.MAX_PENDING_NONCES; i++) {
      ctx.issueWithdrawalNonce({
        id: `expired${i}`,
        agentName: 'a',
        destination: 'dest',
        amountRaw: '0.000000001',
        lamports: 1n,
        createdAt: Date.now() - AgentContext.NONCE_TTL_MS - 1,
      });
    }
    // Should succeed because expired nonces are evicted first
    expect(() =>
      ctx.issueWithdrawalNonce({
        id: 'fresh',
        agentName: 'a',
        destination: 'dest',
        amountRaw: '0.000000001',
        lamports: 1n,
        createdAt: Date.now(),
      }),
    ).not.toThrow();
  });
});
