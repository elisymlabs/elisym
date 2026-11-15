import { describe, expect, it } from 'vitest';
import { connectorResultSentence } from '../src/lib/connector';

describe('connectorResultSentence', () => {
  it('names a bot check and the ways out when the home page refuses the reader', () => {
    expect(
      connectorResultSentence({
        status: 'verification_failed',
        failures: [{ origin: 'https://shop.example', reason: 'blocked' }],
      }),
    ).toBe(
      'Your site could not be verified, so nothing was synced: https://shop.example refuses automated readers (often a bot check such as Cloudflare, or a password or maintenance page): let the AskrConnector user agent through, or import a CSV file or a product feed instead.',
    );
  });

  it('adds the bot check hint to a closed source only for a refusing status', () => {
    for (const httpStatus of [401, 403, 429, 503]) {
      expect(
        connectorResultSentence({
          status: 'source_closed',
          url: 'https://shop.example/products.json',
          reason: `HTTP ${httpStatus}`,
          httpStatus,
        }),
      ).toContain('often a bot check such as Cloudflare');
    }
    expect(
      connectorResultSentence({
        status: 'source_closed',
        url: 'https://shop.example/products.json',
        reason: 'HTTP 404',
        httpStatus: 404,
      }),
    ).toBe(
      'The source is closed: https://shop.example/products.json answered HTTP 404. Check that your products are public.',
    );
  });
});
