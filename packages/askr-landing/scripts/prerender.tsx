/**
 * Writes each legal page's text into its built HTML, so the page reads in full before (and
 * without) its script, as a crawler or a plain HTTP client fetches it. The script then renders
 * the same page over it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrivacyPolicy } from '../src/components/PrivacyPolicy';
import { TermsOfService } from '../src/components/TermsOfService';
import { withPrerendered } from './build-checks';

const PAGES: { file: string; page: ReactElement }[] = [
  { file: 'privacy.html', page: <PrivacyPolicy /> },
  { file: 'terms-of-service.html', page: <TermsOfService /> },
];

for (const { file, page } of PAGES) {
  const url = new URL(`../dist/${file}`, import.meta.url);
  writeFileSync(url, withPrerendered(readFileSync(url, 'utf8'), renderToStaticMarkup(page)));
}
console.log(`prerendered ${PAGES.map((entry) => entry.file).join(', ')}`);
