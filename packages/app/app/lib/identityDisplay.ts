/**
 * Pure display logic for external identity claims (github/x/website) -
 * framework-free so the node-environment vitest covers it directly.
 */
import type { AgentExternalIdentity, IdentityVerifyStatus } from '@elisym/sdk';

export type IdentityPlatform = AgentExternalIdentity['platform'];

export type IdentityChipTone = 'positive' | 'negative' | 'neutral';

export interface IdentityChip {
  label: string;
  tone: IdentityChipTone;
}

export function identityPlatformLabel(platform: IdentityPlatform): string {
  switch (platform) {
    case 'github':
      return 'GitHub';
    case 'x':
      return 'X';
    case 'website':
      return 'Website';
  }
}

/**
 * The website claim's handle is a normalized NIP-05 identifier
 * (`local@domain`); the domain part drives both the profile URL and the
 * display label. Bare input without `@` is treated as the domain itself.
 */
function websiteDomain(handle: string): string {
  const atIndex = handle.indexOf('@');
  return atIndex === -1 ? handle : handle.slice(atIndex + 1);
}

/** Public profile URL the handle links to. */
export function identityProfileUrl(identity: AgentExternalIdentity): string {
  switch (identity.platform) {
    case 'github':
      return `https://github.com/${encodeURIComponent(identity.handle)}`;
    case 'x':
      return `https://x.com/${encodeURIComponent(identity.handle)}`;
    case 'website':
      return `https://${websiteDomain(identity.handle)}`;
  }
}

/** Display text for the handle: the NIP-05 root form `_@domain` renders as the bare domain. */
export function identityHandleLabel(identity: AgentExternalIdentity): string {
  if (identity.platform === 'website' && identity.handle.startsWith('_@')) {
    return websiteDomain(identity.handle);
  }
  return identity.handle;
}

/**
 * Browser-verify gate: X proofs are never fetched in the browser (the oEmbed
 * endpoint's CORS behavior is undocumented), so only github and website
 * claims verify client-side.
 */
export function verifiesInBrowser(platform: IdentityPlatform): boolean {
  return platform !== 'x';
}

/**
 * Chip for a claim given its verification status. X never verifies in the
 * browser, so it renders as neutral "claimed" regardless of any status. A
 * missing status (verification in flight) and `unverifiable` (could not
 * check: network error, CORS, rate limit) get the same neutral treatment -
 * an outage must never read as "do not trust".
 */
export function identityStatusChip(
  platform: IdentityPlatform,
  status: IdentityVerifyStatus | undefined,
): IdentityChip {
  if (platform === 'x' || status === undefined || status === 'unverifiable') {
    return { label: 'claimed', tone: 'neutral' };
  }
  if (status === 'verified') {
    return { label: 'verified', tone: 'positive' };
  }
  return { label: 'broken proof', tone: 'negative' };
}

/**
 * Proof artifact URL to link next to the chip (gist / tweet). The website
 * claim's proof IS the domain - already the profile link - so no extra link.
 */
export function identityProofLinkUrl(identity: AgentExternalIdentity): string | null {
  return identity.platform === 'website' ? null : identity.proofUrl;
}
