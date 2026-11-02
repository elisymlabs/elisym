import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface VercelHeaders {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

const VERCEL = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
) as VercelHeaders;

/** The CSP every checkout path is served with. */
function csp(): string | undefined {
  return VERCEL.headers
    .find((rule) => rule.source === '/(.*)')
    ?.headers.find((header) => header.key === 'Content-Security-Policy')?.value;
}

describe("the checkout's CSP", () => {
  it("loads a product's picture from any https host, and nothing else changed with it", () => {
    expect(csp()).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https: wss:; img-src 'self' data: https:; frame-ancestors *; base-uri 'none'; form-action 'none'",
    );
  });

  it('sends no referrer, so a picture host never learns the page a buyer is on', () => {
    const rule = VERCEL.headers.find((each) => each.source === '/(.*)');
    expect(rule?.headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
  });
});
