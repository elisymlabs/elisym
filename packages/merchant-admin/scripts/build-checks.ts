/**
 * What a deployable admin must hold, as pure functions over the built files
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

/** The CSP the header rule for exactly `source` sets, or `undefined`. */
export function cspOf(vercel: { headers?: HeaderRule[] }, source: string): string | undefined {
  const rule = vercel.headers?.find((candidate) => candidate.source === source);
  return rule?.headers.find((header) => header.key.toLowerCase() === 'content-security-policy')
    ?.value;
}

/** Every header rule source that sets a CSP: two matching one path would both be enforced. */
export function cspSources(vercel: { headers?: HeaderRule[] }): string[] {
  return (vercel.headers ?? [])
    .filter((rule) =>
      rule.headers.some((header) => header.key.toLowerCase() === 'content-security-policy'),
    )
    .map((rule) => rule.source);
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
  source = '/(.*)',
): string[] {
  if (policy === undefined) {
    return [`no Content-Security-Policy on ${source}`];
  }
  const directives = parseCsp(policy);
  const problems: string[] = [];
  for (const [name, sources] of Object.entries(expected)) {
    const found = directives.get(name);
    if (found === undefined || found.join(' ') !== sources.join(' ')) {
      problems.push(
        `${name} on ${source} is "${found?.join(' ') ?? '(missing)'}", must be "${sources.join(' ')}"`,
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

/**
 * Every whole occurrence of `text`: one running on (`.../embed.js2`,
 * `...embed.js?x`) is a use of its own, not this one.
 */
function wholeString(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![\\w./?#%&=:-])`, 'g');
}

/**
 * Problems with a built chunk: a `forbidden` text found once every exact
 * `allowed` string (say, the one checkout loader URL) is taken out.
 */
export function chunkProblems(
  name: string,
  code: string,
  forbidden: readonly string[],
  allowed: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const rest = allowed.reduce((left, text) => left.replace(wholeString(text), '\n'), code);
  for (const text of forbidden) {
    if (rest.includes(text)) {
      problems.push(`${name} contains ${text}`);
    }
  }
  if (/(?:from\s*|import\s*\(?\s*)["']node:/.test(code)) {
    problems.push(`${name} imports a Node built-in`);
  }
  return problems;
}
