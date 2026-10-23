/**
 * The start check's reading of a failed request, through pay-core's REAL
 * `createJsonRpcClient` over a stubbed `fetch`: if pay-core ever words an HTTP
 * status or a non-JSON body differently, these fail instead of the node
 * silently reading a mistyped URL as a passing outage.
 */
import { createJsonRpcClient } from '@elisym/pay-core/evm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCheckEip3009 } from '../src/eip3009';
import { NOW, setup } from './eip3009-support';

afterEach(() => {
  vi.unstubAllGlobals();
});

function answering(response: () => Response) {
  const run = setup();
  vi.stubGlobal('fetch', async () => response());
  run.context.client = createJsonRpcClient('https://rpc.example.com');
  return run;
}

describe('the start check over the real JSON-RPC client', () => {
  it.each([400, 401, 403, 404])('stops start-up on HTTP %i', async (status) => {
    const run = answering(() => new Response('nope', { status }));
    expect(await startCheckEip3009(run.context, NOW)).toEqual({
      kind: 'wrong',
      problem: `eth_chainId could not be read: the RPC refused eth_chainId (HTTP ${status})`,
    });
  });

  it.each([408, 429, 500, 503])('defers on HTTP %i', async (status) => {
    const run = answering(() => new Response('later', { status }));
    expect(await startCheckEip3009(run.context, NOW)).toEqual({
      kind: 'transient',
      problem: `eth_chainId could not be read: eth_chainId failed (HTTP ${status})`,
    });
  });

  it('stops start-up on an HTML page served with 200 (a mistyped URL)', async () => {
    const run = answering(
      () =>
        new Response('<html>Welcome</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    expect(await startCheckEip3009(run.context, NOW)).toEqual({
      kind: 'wrong',
      problem: 'eth_chainId could not be read: the RPC refused eth_chainId (not JSON)',
    });
  });

  it('stops start-up on JSON that is no JSON-RPC answer', async () => {
    const run = answering(() => Response.json({ hello: 'world' }));
    expect((await startCheckEip3009(run.context, NOW)).kind).toBe('wrong');
  });

  it('defers on a JSON-RPC internal error (-32603)', async () => {
    const run = answering(() =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal error' } }),
    );
    expect(await startCheckEip3009(run.context, NOW)).toEqual({
      kind: 'transient',
      problem: 'eth_chainId could not be read: eth_chainId failed (code -32603)',
    });
  });

  it('defers on a JSON-RPC rate limit (-32005), stops on another JSON-RPC refusal', async () => {
    const limited = answering(() =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } }),
    );
    expect(await startCheckEip3009(limited.context, NOW)).toEqual({
      kind: 'transient',
      problem: 'eth_chainId could not be read: eth_chainId failed (code -32005)',
    });
    const refused = answering(() =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }),
    );
    expect((await startCheckEip3009(refused.context, NOW)).kind).toBe('wrong');
  });

  it('defers when the connection fails', async () => {
    const run = setup();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    run.context.client = createJsonRpcClient('https://rpc.example.com');
    expect((await startCheckEip3009(run.context, NOW)).kind).toBe('transient');
  });
});
