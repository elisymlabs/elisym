import type { ReactNode } from 'react';
import { LEGAL_LAST_UPDATED } from '../legal';
import { Footer } from './Footer';
import { LegalNotice } from './LegalNotice';
import { SiteHeader } from './SiteHeader';

interface Props {
  title: string;
  /** What the page is, in a sentence under the title. */
  summary: string;
  children: ReactNode;
}

/** A legal page: the landing's header and footer around one long text, ending in the legal notice. */
export function LegalPage({ title, summary, children }: Props) {
  return (
    <div className="grain min-h-screen overflow-x-clip">
      <SiteHeader home="/" />
      <main className="mx-auto max-w-760 px-16 pt-144 pb-96 sm:px-24 sm:pt-176">
        <article className="flex flex-col gap-40">
          <header className="flex flex-col gap-16">
            <h1 className="text-48 sm:text-64 font-serif leading-[0.95]">{title}</h1>
            <p className="text-18 text-text-2 leading-relaxed">{summary}</p>
            <p className="text-14 text-text-3">{`Last updated: ${LEGAL_LAST_UPDATED}`}</p>
          </header>
          {children}
        </article>
        <LegalNotice />
      </main>
      <Footer home="/" />
    </div>
  );
}
