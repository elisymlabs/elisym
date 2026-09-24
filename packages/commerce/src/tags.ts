export type Tags = readonly (readonly string[])[];

export const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

export function tagValue(tags: Tags, name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

export function tagsNamed(tags: Tags, name: string): (readonly string[])[] {
  return tags.filter((tag) => tag[0] === name);
}

export function tagValues(tags: Tags, name: string): string[] {
  return tagsNamed(tags, name)
    .map((tag) => tag[1])
    .filter((value): value is string => value !== undefined);
}

const EXPIRATION_RE = /^\d{1,12}$/;

/**
 * An event's NIP-40 expiration at `now`. Strict: two tags, a tag with no value,
 * or a value that is not whole seconds is `malformed`, never "does not expire".
 */
export function expirationState(
  tags: Tags,
  now: number,
): 'none' | 'active' | 'expired' | 'malformed' {
  const expirationTags = tagsNamed(tags, 'expiration');
  if (expirationTags.length === 0) {
    return 'none';
  }
  const expiration = expirationTags[0]?.[1] ?? '';
  if (expirationTags.length > 1 || !EXPIRATION_RE.test(expiration)) {
    return 'malformed';
  }
  return Number(expiration) <= now ? 'expired' : 'active';
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
