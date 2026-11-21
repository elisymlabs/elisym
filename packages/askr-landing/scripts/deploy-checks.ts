/**
 * Everything the deployable site must hold, over a built `dist/` and `vercel.json`: each page
 * loads only its own files with no inline script or style, each legal page holds its text
 * (prerendered), and `vercel.json` serves the pages at their clean paths and sets the landing
 * CSP on every path, admitting no other origin (the site runs no widget and no demo).
 * `llms.txt` is built from the page's constants and served as UTF-8 Markdown, readable from any
 * origin. `check-build.ts` runs it after the build; tests run it on a made-up `dist/`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LLMS_TXT_PATH, renderLlmsTxt } from '../src/llms-txt';
import {
  cleanUrlProblems,
  cspOfEveryPath,
  cspProblems,
  headerProblems,
  htmlProblems,
  llmsTxtProblems,
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

export const LLMS_TXT_HEADERS: Record<string, string> = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

/** Every page but the landing is a legal page, prerendered. */
const LANDING_PAGE = 'index.html';

/**
 * Problems with the built site in `distDir`, served by `vercel`, for the HTML source pages
 * `sourcePages` (every HTML file at the package root: `vite.config.ts` builds each).
 */
export function deployProblems(
  distDir: string,
  vercel: Parameters<typeof headerProblems>[0] & { cleanUrls?: boolean },
  sourcePages: readonly string[],
): string[] {
  const builtPages = readdirSync(distDir).filter((file) => file.endsWith('.html'));
  const builtLlmsTxt = join(distDir, LLMS_TXT_PATH.slice(1));
  return [
    ...pageSetProblems(builtPages, sourcePages),
    ...builtPages.flatMap((file) => {
      const html = readFileSync(join(distDir, file), 'utf8');
      // A prerendered page holds its own heading before its script runs.
      const prerendered =
        file === LANDING_PAGE || html.includes('<h1') ? [] : ['is not prerendered'];
      return [...htmlProblems(html), ...stylesheetProblems(html), ...prerendered].map(
        (problem) => `${file}: ${problem}`,
      );
    }),
    ...cleanUrlProblems(vercel),
    ...cspProblems(cspOfEveryPath(vercel), LANDING_CSP),
    ...headerProblems(vercel, LANDING_HEADERS),
    ...llmsTxtProblems(
      existsSync(builtLlmsTxt) ? readFileSync(builtLlmsTxt, 'utf8') : undefined,
      renderLlmsTxt(),
    ),
    ...headerProblems(vercel, LLMS_TXT_HEADERS, LLMS_TXT_PATH),
  ];
}
