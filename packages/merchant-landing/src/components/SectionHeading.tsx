import type { ReactNode } from 'react';

interface Props {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}

export function SectionHeading({ eyebrow, title, children }: Props) {
  return (
    <div className="flex max-w-680 flex-col gap-12">
      <p className="text-13 text-accent-ink font-semibold tracking-wide uppercase">{eyebrow}</p>
      <h2 className="text-32 sm:text-40 leading-tight font-semibold tracking-tight">{title}</h2>
      {children !== undefined && (
        <p className="text-16 sm:text-18 text-text-2 leading-relaxed">{children}</p>
      )}
    </div>
  );
}
