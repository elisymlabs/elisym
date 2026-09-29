import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { describe, expect, it } from 'vitest';
import { createGuardedFetch } from '../src/guarded-fetch';

/** A stand-in HTTPS client: records what it was asked to connect to, answers with `reply`. */
function fakeRequest(reply: { status: number; body?: string; headers?: Record<string, string> }) {
  const asked: RequestOptions[] = [];
  const request = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    asked.push(options);
    const outgoing = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      destroy: () => void;
      end: () => void;
    };
    outgoing.setTimeout = () => undefined;
    outgoing.destroy = () => undefined;
    outgoing.end = () => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        resume: () => void;
        destroy: () => void;
      };
      response.statusCode = reply.status;
      response.headers = reply.headers ?? {};
      response.resume = () => undefined;
      response.destroy = () => undefined;
      onResponse(response as unknown as IncomingMessage);
      queueMicrotask(() => {
        if (reply.body !== undefined) {
          response.emit('data', Buffer.from(reply.body));
        }
        response.emit('end');
      });
    };
    return outgoing;
  };
  return { asked, request };
}

describe('the guarded fetch', () => {
  it('connects to the address it checked, and checks the certificate for the name', async () => {
    const fake = fakeRequest({
      status: 200,
      body: '{"names":{}}',
      headers: { 'content-type': 'application/json' },
    });
    const guarded = createGuardedFetch({
      resolve: async () => ['93.184.216.34'],
      request: fake.request,
    });
    const response = await guarded('https://shop.example/.well-known/nostr.json?name=_');
    expect(await response.json()).toEqual({ names: {} });
    expect(fake.asked).toEqual([
      expect.objectContaining({
        host: '93.184.216.34',
        servername: 'shop.example',
        port: 443,
        path: '/.well-known/nostr.json?name=_',
        headers: expect.objectContaining({ host: 'shop.example' }),
      }),
    ]);
  });

  it('refuses a host with any private address, an IP literal, http, and credentials', async () => {
    const fake = fakeRequest({ status: 200, body: '{}' });
    const guarded = createGuardedFetch({
      resolve: async () => ['93.184.216.34', '10.0.0.5'],
      request: fake.request,
    });
    await expect(guarded('https://shop.example/x')).rejects.toThrow('private');
    const open = createGuardedFetch({
      resolve: async () => ['93.184.216.34'],
      request: fake.request,
    });
    await expect(open('https://127.0.0.1/x')).rejects.toThrow('IP address');
    await expect(open('https://[::1]/x')).rejects.toThrow('IP address');
    await expect(open('http://shop.example/x')).rejects.toThrow('only https');
    await expect(open('https://user:pass@shop.example/x')).rejects.toThrow('credentials');
    const none = createGuardedFetch({ resolve: async () => [], request: fake.request });
    await expect(none('https://shop.example/x')).rejects.toThrow('private or unknown');
    expect(fake.asked).toEqual([]);
  });

  it('never follows a redirect, and caps the body', async () => {
    const redirect = fakeRequest({ status: 302, headers: { location: 'https://evil.example/' } });
    await expect(
      createGuardedFetch({ resolve: async () => ['93.184.216.34'], request: redirect.request })(
        'https://shop.example/x',
      ),
    ).rejects.toThrow('redirect');
    const large = fakeRequest({ status: 200, body: 'x'.repeat(100) });
    await expect(
      createGuardedFetch({
        resolve: async () => ['93.184.216.34'],
        request: large.request,
        maxBytes: 10,
      })('https://shop.example/x'),
    ).rejects.toThrow('too large');
  });
});
