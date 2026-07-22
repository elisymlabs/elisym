import { verifyAgentIdentities } from '@elisym/sdk';
import type { AgentExternalIdentity, IdentityVerifyStatus } from '@elisym/sdk';
import { useEffect, useState } from 'react';
import { IdentityPlatformIcon } from '~/components/IdentityPlatformIcon';
import { cn } from '~/lib/cn';
import {
  identityHandleLabel,
  identityPlatformLabel,
  identityProfileUrl,
  identityProofLinkUrl,
  identityStatusChip,
  verifiesInBrowser,
  type IdentityChipTone,
} from '~/lib/identityDisplay';

const CHIP_TONE_CLASS: Record<IdentityChipTone, string> = {
  positive: 'bg-feedback-positive-bg text-feedback-positive',
  negative: 'bg-feedback-negative-bg text-feedback-negative',
  neutral: 'bg-tag-bg text-text-2',
};

function claimKey(identity: AgentExternalIdentity): string {
  return `${identity.platform}:${identity.handle}`;
}

interface Props {
  pubkey: string;
  identities: AgentExternalIdentity[];
}

/**
 * Identities row for the agent header: platform icon + handle linking to the
 * public profile + status chip. GitHub and website verify in the browser on
 * mount (SDK module cache makes repeats free); X is never fetched here and
 * renders as "claimed" with a link to the proof tweet.
 */
export function AgentIdentities({ pubkey, identities }: Props) {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, IdentityVerifyStatus>>(new Map());

  useEffect(() => {
    const verifiable = identities.filter((identity) => verifiesInBrowser(identity.platform));
    if (verifiable.length === 0) {
      return;
    }
    let cancelled = false;
    async function verify() {
      try {
        const results = await verifyAgentIdentities(pubkey, verifiable);
        if (cancelled) {
          return;
        }
        setStatuses(new Map(results.map((result) => [claimKey(result.identity), result.status])));
      } catch {
        // Unexpected failure: every chip stays in the neutral "claimed" state.
      }
    }
    void verify();
    return () => {
      cancelled = true;
    };
  }, [pubkey, identities]);

  if (identities.length === 0) {
    return null;
  }

  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-14 gap-y-6 text-xs">
      {identities.map((identity) => {
        const chip = identityStatusChip(identity.platform, statuses.get(claimKey(identity)));
        const proofUrl = identityProofLinkUrl(identity);
        return (
          <span key={claimKey(identity)} className="flex items-center gap-6">
            <a
              href={identityProfileUrl(identity)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-6 text-text-2 no-underline transition-colors hover:text-text"
              title={`${identityPlatformLabel(identity.platform)} profile`}
            >
              <IdentityPlatformIcon
                platform={identity.platform}
                className="size-14 shrink-0 opacity-50"
              />
              {identityHandleLabel(identity)}
            </a>
            <span
              className={cn(
                'inline-flex h-18 items-center rounded-full px-8 font-mono text-[10px] leading-none font-medium tracking-wide uppercase',
                CHIP_TONE_CLASS[chip.tone],
              )}
            >
              {chip.label}
            </span>
            {proofUrl !== null && (
              <a
                href={proofUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text-2 opacity-60 transition-opacity hover:opacity-100"
                title="View proof"
              >
                <svg
                  aria-hidden
                  className="size-12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            )}
          </span>
        );
      })}
    </div>
  );
}
