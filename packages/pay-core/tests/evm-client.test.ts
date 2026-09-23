/**
 * The JSON-RPC client the rail uses when a caller holds a URL and nothing else.
 * Everything a node can answer that is NOT a result must become an error here:
 * one that leaks through as a value would be read as chain state further up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJsonRpcClient, EvmRpcError, withAbort } from '@elisym/pay-core';

const URL = 'https://rpc.example/APIKEY-secret';

function respond(body: unknown, init?: { ok?: boolean; status?: number }) {
  const fetchMock = vi.fn(async () => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createJsonRpcClient', () => {
  it('sends one JSON-RPC request and returns its result', async () => {
    const fetchMock = respond({ jsonrpc: '2.0', id: 1, result: '0xa5bf' });
    const client = createJsonRpcClient(URL);
    expect(await client.request({ method: 'eth_chainId' })).toBe('0xa5bf');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL);
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_chainId',
      params: [],
    });
    // Nothing may hang for ever: a node that accepts the connection and never
    // answers cannot become an error, so no fallback would ever fire.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses an HTTP failure, whatever body it carries', async () => {
    respond({ jsonrpc: '2.0', id: 1, result: '0x1' }, { ok: false, status: 500 });
    const client = createJsonRpcClient(URL);
    await expect(client.request({ method: 'eth_chainId' })).rejects.toThrow(/HTTP 500/);
  });

  it('turns a JSON-RPC error into an EvmRpcError, keeping the code and the data', async () => {
    respond({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32003, message: 'insufficient funds', data: '0xdeadbeef' },
    });
    const client = createJsonRpcClient(URL);
    const error = await client
      .request({ method: 'eth_sendRawTransaction' })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EvmRpcError);
    expect((error as EvmRpcError).code).toBe(-32003);
    expect((error as EvmRpcError).data).toBe('0xdeadbeef');
  });

  it.each([
    ['neither a result nor an error', { jsonrpc: '2.0', id: 1 }, /neither a result nor an error/],
    ['something that is not an object', 'pong', /not a JSON-RPC response/],
    ['a batch array', [{ jsonrpc: '2.0', id: 1, result: '0x1' }], /neither a result nor an error/],
    ['null', null, /not a JSON-RPC response/],
    ['another request’s id', { jsonrpc: '2.0', id: 99, result: '0x1' }, /wrong request id/],
  ])('refuses %s', async (_label, body, message) => {
    respond(body);
    const client = createJsonRpcClient(URL);
    await expect(client.request({ method: 'eth_chainId' })).rejects.toThrow(message);
  });

  it.each([
    ['omits the id, as some do on an error', { jsonrpc: '2.0', result: '0xa5bf' }],
    // Two deliberate leniencies: a node that stringifies its ids, or one that
    // sends a null `error` beside a real result, is odd but not hostile - and
    // refusing it would be an outage, not a safeguard.
    ['stringifies the id', { jsonrpc: '2.0', id: '1', result: '0xa5bf' }],
    [
      'sends a null error beside the result',
      { jsonrpc: '2.0', id: 1, error: null, result: '0xa5bf' },
    ],
  ])('tolerates a node that %s', async (_label, body) => {
    respond(body);
    const client = createJsonRpcClient(URL);
    expect(await client.request({ method: 'eth_chainId' })).toBe('0xa5bf');
  });

  it('never puts the endpoint - which may carry a key - into an error', async () => {
    respond({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } });
    const client = createJsonRpcClient(URL);
    const error = await client.request({ method: 'eth_call' }).catch((thrown: unknown) => thrown);
    const text = `${String((error as Error).message)} ${String((error as Error).stack)}`;
    expect(text).not.toContain('APIKEY-secret');
  });

  it('counts ids up, so two answers cannot be swapped', async () => {
    const fetchMock = respond({ jsonrpc: '2.0', result: '0x1' });
    const client = createJsonRpcClient(URL);
    await client.request({ method: 'eth_chainId' });
    await client.request({ method: 'eth_blockNumber' });
    const ids = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as unknown as RequestInit).body)).id,
    );
    expect(ids).toEqual([1, 2]);
  });
});

describe('withAbort', () => {
  it('passes a settled promise straight through', async () => {
    await expect(withAbort(Promise.resolve(7))).resolves.toBe(7);
    await expect(withAbort(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });

  it('stops awaiting when the signal aborts, and leaves no unhandled rejection', async () => {
    const controller = new AbortController();
    const never = new Promise<number>((_resolve, reject) => {
      setTimeout(() => reject(new Error('the node answered far too late')), 50);
    });
    const raced = withAbort(never, controller.signal);
    controller.abort();
    await expect(raced).rejects.toThrow(/abandoned before it answered/);
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  it('refuses immediately when the signal is already aborted', async () => {
    await expect(withAbort(Promise.resolve(1), AbortSignal.abort())).rejects.toThrow(
      /abandoned before it answered/,
    );
  });

  it('calls it an AbortError, so a caller can tell a deadline from a bad answer', async () => {
    const error = await withAbort(Promise.resolve(1), AbortSignal.abort()).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as Error).name).toBe('AbortError');
  });

  it('leaves NO unhandled rejection when the request fails after we stopped waiting', async () => {
    // The early-abort branch returns before the promise is ever awaited, so
    // without its own handler the later rejection crashes the process.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const failing = new Promise<number>((_resolve, reject) => {
      setTimeout(() => reject(new Error('the node answered far too late')), 10);
    });
    await expect(withAbort(failing, AbortSignal.abort())).rejects.toThrow(/abandoned/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('lets go of its abort listener once the request has settled', async () => {
    // One request-scoped signal outlives many reads; a listener per read would
    // pile up until Node starts warning about a leak.
    const controller = new AbortController();
    const removals: string[] = [];
    const signal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: (name: string) => removals.push(name),
    } as unknown as AbortSignal;
    await withAbort(Promise.resolve(1), signal);
    expect(removals).toEqual(['abort']);
    controller.abort();
  });
});
