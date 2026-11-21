/**
 * Fails the build when the site is not safe to deploy: each page loads only its own files with
 * no inline script or style, each legal page holds its text (prerendered), and `vercel.json`
 * serves the pages at their clean paths and sets the landing CSP on every path, admitting no
 * other origin (the site runs no widget and no demo).
 */
import { readFileSync, readdirSync } from 'node:fs';
import {
  cleanUrlProblems,
  cspOfEveryPath,
  cspProblems,
  headerProblems,
  htmlProblems,
  pageSetProblems,
  stylesheetProblems,
} from './build-checks';

const LANDING_CSP: Record<string, string[]> = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'frame-src': ["'none'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'media-src': ["'self'"],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'object-src': ["'none'"],
};

const LANDING_HEADERS: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
/** Every HTML file at the package root is a page (`vite.config.ts` builds each). */
const sourcePages = readdirSync(new URL('..', import.meta.url)).filter((file) =>
  file.endsWith('.html'),
);
const dist = new URL('../dist/', import.meta.url);
const builtPages = readdirSync(dist).filter((file) => file.endsWith('.html'));
/** Every page but the landing is a legal page, prerendered. */
const LANDING_PAGE = 'index.html';

const problems = [
  ...pageSetProblems(builtPages, sourcePages),
  ...builtPages.flatMap((file) => {
    const html = readFileSync(new URL(file, dist), 'utf8');
    // A prerendered page holds its own heading before its script runs.
    const prerendered = file === LANDING_PAGE || html.includes('<h1') ? [] : ['is not prerendered'];
    return [...htmlProblems(html), ...stylesheetProblems(html), ...prerendered].map(
      (problem) => `${file}: ${problem}`,
    );
  }),
  ...cleanUrlProblems(vercel),
  ...cspProblems(cspOfEveryPath(vercel), LANDING_CSP),
  ...headerProblems(vercel, LANDING_HEADERS),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('landing build checks passed');
