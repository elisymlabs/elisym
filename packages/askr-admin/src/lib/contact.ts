/** As the server checks it: one @, a dot in the domain, no spaces, at most 254 characters. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_EMAIL_LENGTH = 254;

/**
 * The email as typed, trimmed and lowercased as the server stores it, when it is one the server
 * takes; otherwise undefined.
 */
export function contactEmailOf(typed: string): string | undefined {
  const email = typed.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email) ? email : undefined;
}
