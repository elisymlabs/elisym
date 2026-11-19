import type { ReactNode } from 'react';

interface Props {
  href: string;
  className: string;
  children: ReactNode;
}

/**
 * A link off this page: it opens in a new tab, so the page stays where the visitor left it,
 * with no handle on it for the page it opens and no referrer.
 */
export function ExternalLink({ href, className, children }: Props) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
