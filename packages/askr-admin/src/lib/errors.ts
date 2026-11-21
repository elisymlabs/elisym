import { ApiError } from './api';

/** Why the server refused an authorization (`packages/askr-server/src/admin/nip98.ts`, plus replay). */
const UNAUTHORIZED_REASONS: Readonly<Record<string, string>> = {
  missing: 'The request was not signed. Sign in again and retry.',
  malformed: 'The request signature could not be read. Sign in again and retry.',
  signature: 'The request signature is not valid. Sign in again and retry.',
  stale:
    "Your computer's clock is off by more than a minute, so the server did not accept the request. Set the clock to the correct time and retry.",
  url: 'The request was signed for another address than this server. Open the admin from its own address and retry.',
  method: 'The request was signed for another action. Retry.',
  payload: 'The request content does not match its signature. Retry.',
  replay: 'This exact request was already sent once. Retry.',
};

/** Why the server refused an O-signed event (`refusal()` and `addEvents` in the server). */
const BAD_EVENT_REASONS: Readonly<Record<string, string>> = {
  too_large: 'One of the signed events is too large to store.',
  signature:
    "One of the changes is not signed by this store's secret key. Sign in again and retry.",
  future:
    "One of the signed events is dated in the future. Check your computer's clock and sign again.",
  config_assistant:
    "The store settings name another assistant than the server's. Press Refresh at the top, then save again.",
  auth_key: 'A catalog key authorization does not name a valid key.',
  deletion_target: 'A deletion may only remove this store owner settings or key authorizations.',
  kind: 'The server does not store this kind of event.',
  stale_config:
    'Newer store settings are already saved. Press Refresh at the top to see them, then make your change again.',
};

const CODES: Readonly<Record<string, string>> = {
  network: 'The server could not be reached. Check your connection and retry.',
  unexpected: 'The server gave an unexpected answer. Retry in a moment.',
  no_store: 'There is no store with this Store ID.',
  key_in_use:
    'This new key already belongs to a store, or once did. Go back and use another: clear "I already made and saved a new secret key" to get a fresh one.',
  moved:
    'This secret key was replaced, so it opens no store. Sign in with the new key; if you did not replace it, take your store back with "Lost your secret key?" on the sign-in page.',
  read_failed: "Your store's settings could not be read just now. Retry in a moment.",
  proof_running:
    "Your store's site is being checked for another request right now. Retry in a minute.",
  moved_meanwhile: 'Your store was moved by another request while your site was checked. Retry.',
  not_found: 'The server does not know this action.',
  bad_request: 'The server could not read the request. Check the fields and retry.',
  bad_email: 'That email address was not accepted. Enter one like you@yourshop.com.',
  rate_limited: 'Too many tries from this address. Try again in an hour.',
  too_many_events:
    'Too many changes are waiting to be published. Wait until your store is active and the waiting changes are published, then retry.',
  invalid_items: 'Some products are not valid. Fix the rows shown and retry.',
  sync_running:
    'A product sync or connector preview is already running for this store. Wait for it to finish, then retry.',
  inactive:
    'Your store is not active yet: products, policies and the connector work once it is. If it has no plan yet, choose one in Billing; otherwise message us with your Store ID.',
  no_settings: 'Save your settings first, then choose a plan.',
  free_unavailable: 'Free is not available right now. Message us with your Store ID.',
  capacity_reached: 'Free is not available right now. Message us with your Store ID.',
  not_pending: 'Your store is suspended. Message us with your Store ID.',
  operator_managed: "We manage your store's plan. Message us with your Store ID.",
  billing_unavailable: 'Paying here is not available right now. Message us with your Store ID.',
  plan_unavailable: 'Paying here is not available right now. Message us with your Store ID.',
  subscription_exists: 'Your store already has a paid plan: change it under Manage billing.',
  suspended: 'Your store is suspended. Message us with your Store ID.',
  billing_failed: 'Stripe did not answer. Retry in a moment.',
  no_customer: 'There is no billing to manage yet.',
  no_subscription:
    'Your store has no paid plan to change right now. Press Refresh at the top to see its plan.',
  past_due:
    'A payment for your plan failed, so it cannot be changed until it is paid. Update your payment method under Manage billing.',
  cancel_pending:
    'Your plan is canceled at the end of its period, so it cannot be changed. Undo the cancel under Manage billing first.',
  change_scheduled:
    'A change to your plan is already scheduled, so it cannot be changed again. Keep or undo that change under Manage billing.',
  same_plan: 'Your store is already on this plan and billing period.',
  subscription_unexpected:
    'Your subscription cannot be changed from here. Message us with your Store ID.',
  no_connector:
    'No connector is set up for this store. Choose your shop as the product source in Settings and save first.',
  policy_imported:
    'Your Shopify connector is set to import this policy, and each sync puts the shop version back. Change it in Shopify, or turn off policy import in Settings to change it here.',
};

const SITE_FAILURES: Readonly<Record<string, string>> = {
  not_found: 'the tag or file was not found',
  fetch_failed: 'could not be reached',
  blocked: 'refused our check (often a bot filter in front of the site)',
};

/** What went wrong on each site, one sentence, from the server's `failures`. */
function siteFailures(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  const parts = value.flatMap((failure: unknown) => {
    if (typeof failure !== 'object' || failure === null) {
      return [];
    }
    const origin: unknown = Reflect.get(failure, 'origin');
    const reason: unknown = Reflect.get(failure, 'reason');
    return typeof origin === 'string' && typeof reason === 'string'
      ? [`${origin}: ${SITE_FAILURES[reason] ?? 'not proven'}`]
      : [];
  });
  return parts.length === 0 ? '' : `${parts.join('; ')}. `;
}

/** A plain sentence for any error the admin shows. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message !== ''
      ? error.message
      : 'Something went wrong. Retry in a moment.';
  }
  if (error.code === 'unauthorized') {
    return (
      UNAUTHORIZED_REASONS[error.reason ?? ''] ??
      'The server did not accept your signature. Sign in again and retry.'
    );
  }
  if (error.code === 'bad_event') {
    return BAD_EVENT_REASONS[error.reason ?? ''] ?? 'The server refused one of the signed events.';
  }
  if (error.code === 'too_many_products') {
    const max = error.detail.max;
    return typeof max === 'number'
      ? `Your plan allows at most ${max} products. Remove some and retry.`
      : 'Your plan does not allow this many products. Remove some and retry.';
  }
  if (error.code === 'too_many_policies') {
    const max = error.detail.max;
    return typeof max === 'number'
      ? `A store has at most ${max} policies. Delete one, or add this text to an existing policy.`
      : 'This store has as many policies as it can have. Delete one, or add this text to an existing policy.';
  }
  if (error.code === 'no_site_yet') {
    const readyAt = error.detail.readyAt;
    return typeof readyAt === 'number'
      ? `Your store has not listed its site long enough to prove it is yours. Try again after ${new Date(readyAt * 1000).toLocaleString()}.`
      : "None of your store's sites can prove it: none is listed, they are on shared hosting (like vercel.app), or they were dropped from the settings, or the store has not been served, for over 30 days. Contact us.";
  }
  if (error.code === 'site_not_proven') {
    const unlisted = error.detail.unlisted;
    const older =
      typeof unlisted === 'number' && unlisted > 0
        ? `${unlisted} site${unlisted === 1 ? '' : 's'} your store listed earlier did not either. `
        : '';
    return `None of your store's sites shows the new Store ID yet. ${siteFailures(error.detail.failures)}${older}Check the tag or file, wait a minute if your site caches pages, and retry.`;
  }
  if (error.code === 'sync_refused') {
    return `The product sync could not start: ${detailMessage(error)}`;
  }
  if (error.code === 'publish_refused') {
    return `The change could not be published: ${detailMessage(error)}`;
  }
  if (error.code === 'unexpected' && error.status === 413) {
    return 'The request is too large for the server. Send fewer products at once.';
  }
  return CODES[error.code] ?? CODES.unexpected ?? '';
}

function detailMessage(error: ApiError): string {
  const message = error.detail.message;
  return typeof message === 'string' && message !== '' ? message : 'no reason given';
}

/** Row-level messages of an `invalid_items` refusal, as "item N: field: message". */
export function invalidItemIssues(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== 'invalid_items') {
    return [];
  }
  const issues = error.detail.issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) {
      return [];
    }
    const path: unknown = Reflect.get(issue, 'path');
    const message: unknown = Reflect.get(issue, 'message');
    if (!Array.isArray(path) || typeof message !== 'string') {
      return [];
    }
    const [index, ...field] = path;
    const where = typeof index === 'number' ? `item ${index + 1}` : 'items';
    return [`${where}${field.length > 0 ? `: ${field.join('.')}` : ''}: ${message}`];
  });
}
