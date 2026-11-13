import type { ReactNode } from 'react';

interface Props {
  eyebrow: string;
  title: string;
  centered?: boolean;
  children?: ReactNode;
}

export function SectionHeading({ eyebrow, title, centered = false, children }: Props) {
  return (
    <div
      className={`flex max-w-720 flex-col gap-14 ${centered ? 'mx-auto items-center text-center' : ''}`}
    >
      <p className="text-13 text-accent-ink font-semibold tracking-wide uppercase">{eyebrow}</p>
      <h2 className="text-32 sm:text-48 leading-[1.1] font-semibold tracking-tight">{title}</h2>
      {children !== undefined && (
        <p className="text-16 sm:text-18 text-text-2 leading-relaxed">{children}</p>
      )}
    </div>
  );
}
