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

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
