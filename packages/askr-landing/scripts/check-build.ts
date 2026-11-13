/**
 * Fails the build when the landing is not safe to deploy: its page loads only
 * its own files with no inline script, and `vercel.json` sets the landing CSP
 * on every path, admitting no other origin (the page runs no widget and no demo).
 */
import { readFileSync } from 'node:fs';
import { cspOfEveryPath, cspProblems, headerProblems, htmlProblems } from './build-checks';

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
const problems = [
  ...htmlProblems(readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8')),
  ...cspProblems(cspOfEveryPath(vercel), LANDING_CSP),
  ...headerProblems(vercel, LANDING_HEADERS),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('landing build checks passed');
