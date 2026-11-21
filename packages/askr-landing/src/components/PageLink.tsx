import type { ReactNode } from 'react';
import { ExternalLink } from './ExternalLink';

interface Props {
  href: string;
  className: string;
  children: ReactNode;
}

/** Whether `href` stays on this site: a section (`#...`) or a path (`/...`, not `//host`). */
function isOnSite(href: string): boolean {
  return href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'));
}

/** A link on this site (in the same tab), or to another site in a new tab with no referrer. */
export function PageLink({ href, className, children }: Props) {
  if (isOnSite(href)) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <ExternalLink href={href} className={className}>
      {children}
    </ExternalLink>
  );
}
