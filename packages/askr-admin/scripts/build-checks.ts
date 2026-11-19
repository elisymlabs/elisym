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
