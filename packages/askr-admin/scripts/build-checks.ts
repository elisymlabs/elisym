/**
 * What a deployable admin must hold, as pure functions over the built files:
 * `check-build.ts` runs them after `vite build`.
 */

/** The path the Askr server serves the admin under (7.3). */
export const ADMIN_BASE = '/admin/';

/** Problems with the built page: an inline script, or a file not under the admin base. */
export function htmlProblems(html: string): string[] {
  const problems: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? '';
    if (!/\bsrc=/.test(attributes) || (match[2] ?? '').trim().length > 0) {
      problems.push('an inline <script>');
    }
  }
  for (const match of html.matchAll(/\b(?:src|href)=["']?([^"'\s>]+)/gi)) {
    const url = match[1] ?? '';
    if (!url.startsWith(ADMIN_BASE)) {
      problems.push(`loads ${url}, which is not under ${ADMIN_BASE}`);
    }
  }
  return problems;
}

/** Problems with a built chunk: a Node built-in, or a data: module the CSP would refuse. */
export function chunkProblems(name: string, code: string): string[] {
  const problems: string[] = [];
  if (/(?:from\s*|import\s*\(?\s*)["']node:/.test(code)) {
    problems.push(`${name} imports a Node built-in`);
  }
  if (/import\s*\(?\s*["']data:/.test(code)) {
    problems.push(`${name} imports a data: module`);
  }
  return problems;
}

/** App Bridge, the one file the embedded admin loads from elsewhere (askr-shopify 5.1). */
export const APP_BRIDGE_URL = 'https://cdn.shopify.com/shopifycloud/app-bridge.js';

/**
 * Problems with the built embedded page: App Bridge must be the first script, as a plain
 * script; everything else follows the admin's rules.
 */
export function shopifyHtmlProblems(html: string): string[] {
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1] ?? '');
  const first = scripts[0] ?? '';
  const problems: string[] = [];
  if (!first.includes(`src="${APP_BRIDGE_URL}"`) || /\b(?:type|async|defer)\b/.test(first)) {
    problems.push('App Bridge is not the first plain <script>');
  }
  if (!html.includes('content="__ASKR_SHOPIFY_API_KEY__"')) {
    problems.push('the shopify-api-key meta has no placeholder for the server to fill');
  }
  const withoutBridge = html.replace(`<script src="${APP_BRIDGE_URL}"></script>`, '');
  return [...problems, ...htmlProblems(withoutBridge)];
}

/** Browser storage the embedded admin must never touch: O lives in memory only (5.1). */
const STORAGE_RE = /\b(?:localStorage|sessionStorage|indexedDB)\b/;

/**
 * Problems with the chunks a page loads: any of them, or any chunk they import, touching
 * browser storage. `chunks` maps a built file name (`assets/x.js`) to its code.
 */
export function storageProblems(html: string, chunks: ReadonlyMap<string, string>): string[] {
  const seen = new Set<string>();
  const queue = [...html.matchAll(/\/admin\/(assets\/[^"'\s>]+\.js)/g)].map(
    (match) => match[1] ?? '',
  );
  while (queue.length > 0) {
    const name = queue.pop() ?? '';
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const code = chunks.get(name) ?? '';
    for (const match of code.matchAll(/["'](?:\.\/|\/admin\/assets\/)([^"']+\.js)["']/g)) {
      queue.push(`assets/${match[1] ?? ''}`);
    }
  }
  return [...seen]
    .filter((name) => STORAGE_RE.test(chunks.get(name) ?? ''))
    .map((name) => `${name}, loaded by the embedded admin, touches browser storage`);
}
