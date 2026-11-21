/**
 * What the deployable landing must hold, as pure functions over the built files
 * and `vercel.json`: `check-build.ts` runs them after `vite build`.
 */

/** A CSP as directive -> sources. */
export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name.length > 0) {
      directives.set(name.toLowerCase(), sources);
    }
  }
  return directives;
}

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/** The CSP the `/(.*)` header rule sets, or `undefined`. */
export function cspOfEveryPath(vercel: { headers?: HeaderRule[] }): string | undefined {
  const rule = vercel.headers?.find((candidate) => candidate.source === '/(.*)');
  return rule?.headers.find((header) => header.key.toLowerCase() === 'content-security-policy')
    ?.value;
}

/** Problems with the headers the rule for `source` (by default every path) must set, by exact value. */
export function headerProblems(
  vercel: { headers?: HeaderRule[] },
  required: Record<string, string>,
  source = '/(.*)',
): string[] {
  const rule = vercel.headers?.find((candidate) => candidate.source === source);
  return Object.entries(required).flatMap(([key, value]) => {
    const found = rule?.headers.find((header) => header.key.toLowerCase() === key.toLowerCase());
    return found?.value === value
      ? []
      : [`${key} on ${source} is "${found?.value ?? '(missing)'}", must be "${value}"`];
  });
}

/** Problems with a CSP that must hold `expected` exactly, directive by directive. */
export function cspProblems(
  policy: string | undefined,
  expected: Record<string, string[]>,
): string[] {
  if (policy === undefined) {
    return ['no Content-Security-Policy on /(.*)'];
  }
  const directives = parseCsp(policy);
  const problems: string[] = [];
  for (const [name, sources] of Object.entries(expected)) {
    const found = directives.get(name);
    if (found === undefined || found.join(' ') !== sources.join(' ')) {
      problems.push(
        `${name} is "${found?.join(' ') ?? '(missing)'}", must be "${sources.join(' ')}"`,
      );
    }
  }
  return problems;
}

/** Problems with the built page: inline scripts or styles, or anything loaded from another origin. */
export function htmlProblems(html: string): string[] {
  const problems: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? '';
    if (!/\bsrc=/.test(attributes) || (match[2] ?? '').trim().length > 0) {
      problems.push('an inline <script>');
    }
  }
  if (/<style\b|\sstyle=/i.test(html)) {
    problems.push('an inline style');
  }
  // Every tag but a link someone follows (`<a>`): those load nothing.
  const loading = html.replace(/<a\b[^>]*>/gi, '');
  for (const match of loading.matchAll(/\b(?:src|href)=["']?([^"'\s>]+)/gi)) {
    const url = match[1] ?? '';
    if (!url.startsWith('/') || url.startsWith('//')) {
      problems.push(`loads ${url} from another origin`);
    }
  }
  return problems;
}

const EMPTY_ROOT = '<div id="root"></div>';

/** The built page with `markup` inside its empty `#root`; throws when the page has none. */
export function withPrerendered(html: string, markup: string): string {
  if (html.split(EMPTY_ROOT).length !== 2) {
    throw new Error('the page has no single empty #root to prerender into');
  }
  // A function, so a `$` in the markup is never read as a replacement pattern.
  return html.replace(EMPTY_ROOT, () => `<div id="root">${markup}</div>`);
}

/** Problems with how Vercel serves the pages: `/privacy` and `/terms-of-service` need `cleanUrls`. */
export function cleanUrlProblems(vercel: { cleanUrls?: boolean }): string[] {
  return vercel.cleanUrls === true
    ? []
    : ['vercel.json must set cleanUrls: true, or /privacy and /terms-of-service are not served'];
}

/** Problems with the set of built pages: every source page built, and nothing else. */
export function pageSetProblems(
  builtFiles: readonly string[],
  sourceFiles: readonly string[],
): string[] {
  return [
    ...sourceFiles
      .filter((file) => !builtFiles.includes(file))
      .map((file) => `${file} was not built`),
    ...builtFiles
      .filter((file) => !sourceFiles.includes(file))
      .map((file) => `${file} is built but has no source page`),
  ];
}

/** Problems with a built page's styles: it must link its stylesheet, or it renders unstyled. */
export function stylesheetProblems(html: string): string[] {
  return /<link\b[^>]*\brel=["']?stylesheet\b/i.test(html) ? [] : ['no stylesheet'];
}
