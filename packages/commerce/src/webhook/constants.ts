/** Header names, exactly as the node sends them (lookups are case-insensitive). */
export const WEBHOOK_EVENT_HEADER = 'X-Elisym-Event';
export const WEBHOOK_EVENT_ID_HEADER = 'X-Elisym-Event-Id';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Elisym-Timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'X-Elisym-Signature';
/** Default replay window, both directions, seconds. */
export const WEBHOOK_TOLERANCE_SECS = 300;
/** Shortest secret either side accepts, UTF-8 bytes (`openssl rand -hex 32` gives 64). */
export const WEBHOOK_MIN_SECRET_BYTES = 32;
