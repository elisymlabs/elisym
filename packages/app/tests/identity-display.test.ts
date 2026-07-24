/**
 * Pure display logic for identity claims (`identityDisplay.ts`): profile URL
 * mapping, status-to-chip mapping, and the per-platform browser-verify gate.
 */
import type { AgentExternalIdentity } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import {
  identityHandleLabel,
  identityPlatformLabel,
  identityProfileUrl,
  identityProofLinkUrl,
  identityStatusChip,
  verifiesInBrowser,
} from '../app/lib/identityDisplay';

const GITHUB_CLAIM: AgentExternalIdentity = {
  platform: 'github',
  handle: 'alice',
  proofUrl: 'https://gist.github.com/alice/9721ce4ee4fceb91c9711ca2a6c9a5ab',
};

const X_CLAIM: AgentExternalIdentity = {
  platform: 'x',
  handle: 'alice_ai',
  proofUrl: 'https://x.com/alice_ai/status/1893471190424121782',
};

const WEBSITE_CLAIM: AgentExternalIdentity = {
  platform: 'website',
  handle: 'agent@example.com',
  proofUrl: 'https://example.com',
};

describe('identityProfileUrl', () => {
  it('maps github to the github.com profile', () => {
    expect(identityProfileUrl(GITHUB_CLAIM)).toBe('https://github.com/alice');
  });

  it('maps x to the x.com profile', () => {
    expect(identityProfileUrl(X_CLAIM)).toBe('https://x.com/alice_ai');
  });

  it('derives the website URL from the nip05 domain', () => {
    expect(identityProfileUrl(WEBSITE_CLAIM)).toBe('https://example.com');
    expect(identityProfileUrl({ ...WEBSITE_CLAIM, handle: '_@agents.example.com' })).toBe(
      'https://agents.example.com',
    );
  });

  it('URL-encodes handles defensively', () => {
    // The SDK's charset regexes never produce such a handle - defense in depth.
    expect(identityProfileUrl({ ...GITHUB_CLAIM, handle: 'a/../b' })).toBe(
      'https://github.com/a%2F..%2Fb',
    );
  });
});

describe('identityHandleLabel', () => {
  it('renders the nip05 root form as the bare domain', () => {
    expect(identityHandleLabel({ ...WEBSITE_CLAIM, handle: '_@example.com' })).toBe('example.com');
  });

  it('keeps a named nip05 identifier intact', () => {
    expect(identityHandleLabel(WEBSITE_CLAIM)).toBe('agent@example.com');
  });

  it('keeps github and x handles verbatim', () => {
    expect(identityHandleLabel(GITHUB_CLAIM)).toBe('alice');
    expect(identityHandleLabel(X_CLAIM)).toBe('alice_ai');
  });
});

describe('identityStatusChip', () => {
  it('maps verified to a positive chip', () => {
    expect(identityStatusChip('github', 'verified')).toEqual({
      label: 'verified',
      tone: 'positive',
    });
    expect(identityStatusChip('website', 'verified')).toEqual({
      label: 'verified',
      tone: 'positive',
    });
  });

  it('maps broken to a negative chip', () => {
    expect(identityStatusChip('github', 'broken')).toEqual({
      label: 'broken proof',
      tone: 'negative',
    });
  });

  it('keeps unverifiable neutral, never negative', () => {
    expect(identityStatusChip('website', 'unverifiable')).toEqual({
      label: 'claimed',
      tone: 'neutral',
    });
  });

  it('renders a pending (no status yet) claim as neutral', () => {
    expect(identityStatusChip('github', undefined)).toEqual({ label: 'claimed', tone: 'neutral' });
  });

  it('always renders x as neutral "claimed" - no browser verification', () => {
    expect(identityStatusChip('x', undefined)).toEqual({ label: 'claimed', tone: 'neutral' });
    expect(identityStatusChip('x', 'verified')).toEqual({ label: 'claimed', tone: 'neutral' });
    expect(identityStatusChip('x', 'broken')).toEqual({ label: 'claimed', tone: 'neutral' });
  });
});

describe('verifiesInBrowser', () => {
  it('gates x out of browser verification, github and website in', () => {
    expect(verifiesInBrowser('github')).toBe(true);
    expect(verifiesInBrowser('website')).toBe(true);
    expect(verifiesInBrowser('x')).toBe(false);
  });
});

describe('identityProofLinkUrl', () => {
  it('links the gist and tweet proofs', () => {
    expect(identityProofLinkUrl(GITHUB_CLAIM)).toBe(GITHUB_CLAIM.proofUrl);
    expect(identityProofLinkUrl(X_CLAIM)).toBe(X_CLAIM.proofUrl);
  });

  it('omits the website proof link - it duplicates the profile URL', () => {
    expect(identityProofLinkUrl(WEBSITE_CLAIM)).toBeNull();
  });
});

describe('identityPlatformLabel', () => {
  it('names each platform for titles', () => {
    expect(identityPlatformLabel('github')).toBe('GitHub');
    expect(identityPlatformLabel('x')).toBe('X');
    expect(identityPlatformLabel('website')).toBe('Website');
  });
});
