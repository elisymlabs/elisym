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
  signature: 'One of the signed events is not signed by this store owner key.',
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
  no_store: 'There is no store for this owner key yet.',
  not_found: 'The server does not know this action.',
  bad_request: 'The server could not read the request. Check the fields and retry.',
  too_many_events:
    'Too many changes are waiting to be published. Wait until your store is active and the waiting changes are published, then retry.',
  invalid_items: 'Some products are not valid. Fix the rows shown and retry.',
  sync_running:
    'A product sync or connector preview is already running for this store. Wait for it to finish, then retry.',
  inactive:
    'Your store is not active yet. Products, policies and the connector work once the operator has activated it.',
  no_connector: 'No connector is set up for this store. Save the connector settings first.',
};

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
  if (error.code === 'sync_refused') {
    return `The product sync could not start: ${detailMessage(error)}`;
  }
  if (error.code === 'publish_refused') {
    return `The relay did not take the change: ${detailMessage(error)}`;
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
