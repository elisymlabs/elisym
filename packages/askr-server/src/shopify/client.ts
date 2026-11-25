import * as z from 'zod';
import { SHOP_DOMAIN_RE } from './auth';

/** The Admin GraphQL API version this server reads (re-checked against shopify.dev per release). */
export const ADMIN_API_VERSION = '2026-10';
const REQUEST_TIMEOUT_MS = 20_000;
/** An Admin API answer at most; bulk results are read as a stream with their own cap. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

export type ShopifyFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Tokens as Shopify issued them, with absolute expiry times (unix seconds). */
export interface ShopTokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires. */
  expiresAt: number;
  scopes: string;
}

/** Shopify refused the call for a reason a retry cannot fix (a dead refresh token, a 4xx). */
export class ShopifyRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TokenAnswerSchema = z.object({
  access_token: z.string().min(1).max(1024),
  refresh_token: z.string().min(1).max(1024),
  expires_in: z.number().int().positive(),
  scope: z.string().max(4096).default(''),
});

const GraphqlAnswerSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
});

/** A body read up to `maxBytes`; past it the read stops and throws. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Shopify answered with more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Calls to a shop's Admin (plan 3.2): token exchange for an expiring offline token, its refresh,
 * and Admin GraphQL. The shop is checked to be a myshopify host before any request.
 */
export class ShopifyClient {
  private readonly fetch: ShopifyFetch;

  constructor(
    private readonly app: { apiKey: string; apiSecret: string },
    fetchImpl?: ShopifyFetch,
  ) {
    this.fetch = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private base(shop: string): string {
    if (!SHOP_DOMAIN_RE.test(shop)) {
      throw new Error('not a myshopify shop');
    }
    return `https://${shop}`;
  }

  private async tokenCall(shop: string, params: Record<string, string>, now: number) {
    const response = await this.fetch(`${this.base(shop)}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      // The app's credentials last, so no parameter can replace them.
      body: new URLSearchParams({
        ...params,
        client_id: this.app.apiKey,
        client_secret: this.app.apiSecret,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await readCapped(response, 64 * 1024);
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new ShopifyRefused(`token call refused (${response.status})`, response.status);
    }
    if (!response.ok) {
      throw new Error(`token call failed (${response.status})`);
    }
    const answer = TokenAnswerSchema.safeParse(parseJson(text));
    if (!answer.success) {
      throw new Error('token call answered without the expected tokens');
    }
    const tokens: ShopTokens = {
      accessToken: answer.data.access_token,
      refreshToken: answer.data.refresh_token,
      expiresAt: now + answer.data.expires_in,
      scopes: answer.data.scope,
    };
    return tokens;
  }

  /** An expiring offline token for the shop the session token names (token exchange). */
  exchange(shop: string, sessionToken: string, now: number): Promise<ShopTokens> {
    return this.tokenCall(
      shop,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: sessionToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
        expiring: '1',
      },
      now,
    );
  }

  /**
   * New tokens for a refresh token; each refresh returns a new refresh token. A 4xx
   * (`ShopifyRefused`) means the refresh token is dead; anything else may be retried.
   */
  refresh(shop: string, refreshToken: string, now: number): Promise<ShopTokens> {
    return this.tokenCall(shop, { grant_type: 'refresh_token', refresh_token: refreshToken }, now);
  }

  /** One Admin GraphQL call; throws on a transport error or any GraphQL error. */
  async graphql(
    shop: string,
    accessToken: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<unknown> {
    const response = await this.fetch(
      `${this.base(shop)}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-shopify-access-token': accessToken,
        },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const text = await readCapped(response, MAX_ANSWER_BYTES);
    if (response.status === 401 || response.status === 403) {
      throw new ShopifyRefused(`Admin API refused (${response.status})`, response.status);
    }
    if (!response.ok) {
      throw new Error(`Admin API failed (${response.status})`);
    }
    const answer = GraphqlAnswerSchema.safeParse(parseJson(text));
    if (!answer.success) {
      throw new Error('Admin API answered with something other than GraphQL');
    }
    const firstError = answer.data.errors?.[0];
    if (firstError !== undefined) {
      throw new Error(`Admin API error: ${firstError.message.slice(0, 200)}`);
    }
    return answer.data.data;
  }

  /** A bulk operation's JSONL result from the URL Shopify gave, read up to `maxBytes`. */
  async bulkResult(url: string, maxBytes: number): Promise<string> {
    const parsed = new URL(url);
    // Shopify hands out a signed storage URL; never a bare address or a local name.
    const host = parsed.hostname;
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !host.includes('.') ||
      /^[\d.]+$/u.test(host) ||
      host.startsWith('[') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      throw new Error('bulk result URL is not a public https URL');
    }
    const response = await this.fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 6),
    });
    if (!response.ok) {
      throw new Error(`bulk result read failed (${response.status})`);
    }
    return readCapped(response, maxBytes);
  }
}
