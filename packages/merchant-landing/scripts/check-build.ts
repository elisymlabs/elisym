/**
 * Fails the build when the landing is not safe to deploy: its page loads only
 * its own files with no inline script, and `vercel.json` sets the landing CSP
 * on every path, admitting exactly one other origin (the checkout's).
 */
import { readFileSync } from 'node:fs';
import {
  cspOfEveryPath,
  cspProblems,
  htmlProblems,
} from '../../merchant-admin/scripts/build-checks';

const LANDING_CSP: Record<string, string[]> = {
  'default-src': ["'none'"],
  'script-src': ["'self'", 'https://pay.elisym.network'],
  'frame-src': ['https://pay.elisym.network'],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'object-src': ["'none'"],
};

const problems = [
  ...htmlProblems(readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8')),
  ...htmlProblems(readFileSync(new URL('../dist/terms.html', import.meta.url), 'utf8')),
  ...cspProblems(
    cspOfEveryPath(JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))),
    LANDING_CSP,
  ),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('landing build checks passed');
