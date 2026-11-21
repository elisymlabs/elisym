import { type AdminDeps, createAdminApi } from '../admin/api';
import { BillingService, createStripeWebhook } from '../billing/service';
import type { StripeGateway } from '../billing/stripe';
import type { BillingSecrets } from '../config';
import type { Db } from '../db/db';
import type { GatewayRequest } from './gateway';
import { createServerLlmsTxt } from './server-llms';

export interface RouteHandlers {
  /** The server's public base, no trailing slash: the server's own llms.txt links under it. */
  publicBase: string;
  /** The admin app's files, when they are built into this server. */
  adminPages?: ((input: GatewayRequest) => Response | undefined) | undefined;
  admin: (input: GatewayRequest) => Promise<Response | undefined>;
  storeDocs: (input: GatewayRequest) => Promise<Response | undefined>;
  /** Stripe's webhook (`POST /v1/stripe/webhook`); undefined for other paths. */
  stripeWebhook?: ((request: Request) => Promise<Response | undefined>) | undefined;
  gateway: (input: GatewayRequest) => Promise<Response>;
}

/**
 * The server's one handler, in routing order: the admin pages, the server's own
 * `/llms.txt`, the admin API (billing's checkout and portal included), the public store files,
 * Stripe's webhook, and the gateway for the rest.
 */
export function composeHandler(
  handlers: RouteHandlers,
): (input: GatewayRequest) => Promise<Response> {
  // A fixed file pointing agents to the store files and the docs.
  const serverLlmsTxt = createServerLlmsTxt(handlers.publicBase);
  return async (input) =>
    handlers.adminPages?.(input) ??
    serverLlmsTxt(input) ??
    (await handlers.admin(input)) ??
    (await handlers.storeDocs(input)) ??
    (await handlers.stripeWebhook?.(input.request)) ??
    handlers.gateway(input);
}

export interface RoutesDeps extends Pick<
  AdminDeps,
  'directory' | 'publicBase' | 'syncClient' | 'storeEventsChanged' | 'connectors' | 'freeTier'
> {
  db: Db;
  /** Both Stripe secrets; undefined: billing is off. */
  billingSecrets: BillingSecrets | undefined;
  /** The Stripe client for the secret key (the real one, or a test double). */
  stripeFor: (secretKey: string) => StripeGateway;
  adminPages?: (input: GatewayRequest) => Response | undefined;
  storeDocs: (input: GatewayRequest) => Promise<Response | undefined>;
  gateway: (input: GatewayRequest) => Promise<Response>;
  now?: () => number;
  log: (message: string) => void;
}

/**
 * The admin API and billing built for the server, and its one handler (`composeHandler`).
 * Billing applies a paid plan's end with the same Free tier and caps as an owner's Free choice,
 * and a store it changed is served and published at once (`storeEventsChanged`).
 */
export function createRoutes(deps: RoutesDeps): {
  handler: (input: GatewayRequest) => Promise<Response>;
  billing: BillingService | undefined;
} {
  const { billingSecrets, freeTier } = deps;
  const billing =
    billingSecrets === undefined
      ? undefined
      : new BillingService({
          db: deps.db,
          stripe: deps.stripeFor(billingSecrets.secretKey),
          webhookSecret: billingSecrets.webhookSecret,
          publicBase: deps.publicBase,
          tierExists: (name) => deps.directory.tierExists(name),
          ...(freeTier === undefined ? {} : { freeTier }),
          storesChanged: deps.storeEventsChanged,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          log: deps.log,
        });
  const admin = createAdminApi({
    directory: deps.directory,
    publicBase: deps.publicBase,
    syncClient: deps.syncClient,
    storeEventsChanged: deps.storeEventsChanged,
    connectors: deps.connectors,
    ...(freeTier === undefined ? {} : { freeTier }),
    ...(billing === undefined ? {} : { billing }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    log: deps.log,
  });
  const handler = composeHandler({
    publicBase: deps.publicBase,
    adminPages: deps.adminPages,
    admin,
    storeDocs: deps.storeDocs,
    stripeWebhook: createStripeWebhook(billing),
    gateway: deps.gateway,
  });
  return { handler, billing };
}
