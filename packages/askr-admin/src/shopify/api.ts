import { nip98Header } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { apiBase } from '../constants';
import { ApiError } from '../lib/api';
import type { OnboardingKeys, SettingsInput, SettingsRead, ShopifyView } from './types';

export interface ShopifyApiOptions {
  /** A fresh App Bridge session token per call. */
  token: () => Promise<string>;
  base?: string;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The Shopify app's routes (`/v1/shopify/`): every call carries a session token; onboarding's
 * first call also O's own NIP-98, signed here with the key held in memory.
 */
export class ShopifyApi {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ShopifyApiOptions) {
    this.base = options.base ?? apiBase();
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const text = body === undefined ? '' : JSON.stringify(body);
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.options.token()}`,
          ...(text === '' ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(text === '' ? {} : { body: text }),
      });
    } catch {
      throw new ApiError(0, 'network');
    }
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      answer = undefined;
    }
    if (!response.ok) {
      const detail = isRecord(answer) ? answer : {};
      throw new ApiError(
        response.status,
        typeof detail.error === 'string' ? detail.error : 'unexpected',
        detail,
      );
    }
    return answer;
  }

  /** The server's clock: everything onboarding signs is dated by it, never by this device. */
  async time(): Promise<number> {
    const answer = await this.call('GET', '/v1/shopify/time');
    const now = isRecord(answer) ? answer.now : undefined;
    if (typeof now !== 'number') {
      throw new ApiError(500, 'unexpected');
    }
    return now;
  }

  async store(): Promise<ShopifyView> {
    return (await this.call('GET', '/v1/shopify/store')) as ShopifyView;
  }

  /** Onboarding's first call: O proves itself with a NIP-98 dated by the server's clock. */
  async begin(shop: string, ownerSecret: Uint8Array, now: number): Promise<OnboardingKeys> {
    const path = '/v1/shopify/onboard/begin';
    const body = JSON.stringify({ shop });
    const ownerAuthorization = await nip98Header({
      signEvent: (template) => Promise.resolve(finalizeEvent(template, ownerSecret)),
      url: `${this.base}${path}`,
      method: 'POST',
      body,
      now,
    });
    return (await this.call(
      'POST',
      path,
      { shop },
      {
        'x-askr-owner-authorization': ownerAuthorization,
      },
    )) as OnboardingKeys;
  }

  async finish(events: NostrEvent[]): Promise<ShopifyView> {
    return (await this.call('POST', '/v1/shopify/onboard/finish', { events })) as ShopifyView;
  }

  async settings(): Promise<SettingsRead> {
    return (await this.call('GET', '/v1/shopify/settings')) as SettingsRead;
  }

  async saveSettings(input: SettingsInput): Promise<void> {
    await this.call('PUT', '/v1/shopify/settings', input);
  }
}
