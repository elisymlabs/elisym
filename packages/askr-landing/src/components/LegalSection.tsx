import type { ReactNode } from 'react';

interface Props {
  id: string;
  title: string;
  children: ReactNode;
}

/** One numbered part of a legal page: a heading and its paragraphs and lists. */
export function LegalSection({ id, title, children }: Props) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="text-16 text-text-2 border-line-2 flex flex-col gap-14 border-t pt-32 leading-relaxed [&_li]:pl-4 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-8 [&_ul]:pl-20"
    >
      <h2 id={`${id}-title`} className="text-text text-24 sm:text-32 font-serif leading-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}
