/**
 * Fixed strings of the `askr` commands. Read as text by the landing's prompt
 * test (`packages/askr-landing/tests`), so the URLs here stay literal.
 */

/** How every command is documented and resumed: `-y` never stops at npx's prompt, `@latest` never runs a stale cached CLI. */
export const ASKR_COMMAND = 'npx -y @elisym/cli@latest askr';

/** Each command ends within this, so a coding agent's 2-minute command limit is never hit (5.0). */
export const DEADLINE_MS = 85_000;

export const ADMIN_URL = 'https://app.askr.elisym.network/admin/';
export const CONTACT_URL = 'https://askr.elisym.network/contact';
export const PRICING_URL = 'https://askr.elisym.network/#pricing';
export const FIND_STORE_ID_URL = 'https://docs.elisym.network/askr/overview#find-your-store-id';

/** Printed by every limit error and by `askr status` (5.6). */
export const UPGRADE = {
  howTo: 'Message us with your Store ID',
  contact: CONTACT_URL,
  pricing: PRICING_URL,
  findStoreId: FIND_STORE_ID_URL,
} as const;

/** The public widget script and element (`packages/askr-admin/src/constants.ts`). */
export const WIDGET_SCRIPT_URL = 'https://app.askr.elisym.network/widget.js';
export const WIDGET_ELEMENT = 'askr-chat';

/** Test overrides of the API base and the relay: honoured only for a local host unless unsafe (5.0). */
export const API_OVERRIDE_ENV = 'ELISYM_ASKR_API';
export const RELAY_OVERRIDE_ENV = 'ELISYM_ASKR_RELAY';
export const UNSAFE_OVERRIDE_ENV = 'ELISYM_ASKR_UNSAFE_TEST';
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/** The refusal `requireCatalogKey` throws (`packages/askr/src/sync.ts`): server K's 30497 is not on the relay yet. */
export const NOT_AUTHORIZED_MESSAGE =
  'This key is not authorized as a catalog key by the store owner';
/** A scheduled connector sync that found the store's sync guard taken (`packages/askr-server/src/connectors/service.ts`). */
export const SYNC_BUSY_MESSAGE = 'Another catalog sync of this store is running';

export const STORE_POLL_MS = 2_000;
export const SYNC_POLL_MS = 3_000;
export const PROBE_RETRY_MS = 10_000;
/** The real catalog call is sent only with this much time left: the server answers after its own dry run. */
export const MIN_REAL_CALL_MS = 20_000;
export const PREVIEW_TIMEOUT_MS = 70_000;
export const NOT_AUTHORIZED_RETRY_MS = 2_000;

/** Server body caps (`packages/askr-server/src/gateway/http.ts`). */
export const MAX_CATALOG_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_ADMIN_BODY_BYTES = 2 * 1024 * 1024;

/** Config dates more than this far ahead are a forger's, never read (the server's rule). */
export const MAX_AHEAD_SECS = 10 * 60;

/** Upsert warning: more than this share (bps) or count of listed products not in the file. */
export const ABSENT_WARNING_BPS = 2_000;
export const ABSENT_WARNING_COUNT = 10;
export const SAMPLE_SIZE = 20;
export const MAX_ISSUES = 20;

/** `--profile`: one owner key file per store on this computer (4). */
export const PROFILE_RE = /^[a-z0-9-]{1,32}$/;
export const DEFAULT_PROFILE = 'default';
export const POLICY_SLUG_RE = /^[a-z0-9-]{1,64}$/;
