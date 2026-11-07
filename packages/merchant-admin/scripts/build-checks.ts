/**
 * What a deployable admin must hold, as pure functions over the built files
 * and `vercel.json`: `check-build.ts` runs them after `vite build`.
 */

/**
 * Text only `@elisym/react`'s widget runtime holds, in every version so far
 * (its loader refusal: "customer-ref needs the v3 loader" in 0.1, "... the v3
 * or v4 loader" in 0.2), never its constants: a test pins it to the built
 * package, so a reworded runtime fails the test rather than the check.
 */
export const REACT_WIDGET_MARKER = 'customer-ref needs the v3';

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

/** Problems with the built page: inline scripts, or anything loaded from another origin. */
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
    if (!url.startsWith('/') || url.startsWith('//')) {
      problems.push(`loads ${url} from another origin`);
    }
  }
  return problems;
}

/** Problems with a built chunk. */
export function chunkProblems(name: string, code: string, forbidden: readonly string[]): string[] {
  const problems: string[] = [];
  for (const text of forbidden) {
    if (code.includes(text)) {
      problems.push(`${name} contains ${text}`);
    }
  }
  if (/(?:from\s*|import\s*\(?\s*)["']node:/.test(code)) {
    problems.push(`${name} imports a Node built-in`);
  }
  return problems;
}
