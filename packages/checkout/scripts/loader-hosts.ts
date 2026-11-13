/**
 * Loader v4 per hostname. One deployment serves every checkout hostname
 * (pay.elisym.network and white-label ones), and a loader frames the origin
 * baked into it, so each hostname has its own frozen copy of v4:
 *
 * - `embed-prod/v4/embed.template.js`: the v4 build with an origin placeholder;
 * - `embed-prod/<host>/v4/embed.js`: the template with `https://<host>` in it;
 * - `src/embed/v4.sri`: the SRI of the template and of every host's copy.
 *
 * Vercel serves a static file before any rewrite, so there is no shared
 * `dist/v4/embed.js`: `/v4/embed.js` reaches `dist/v4-hosts/<host>/embed.js`
 * through a Host-matched rewrite (`vercel.json`), and any other host gets the
 * build's own copy (`_build`), which only a build for another origin than
 * production has (a Vercel preview, `CHECKOUT_ORIGIN` set).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRANDS } from '../src/app/brand';

/** Baked into the template in place of the checkout origin. */
export const V4_ORIGIN_PLACEHOLDER = 'https://checkout-origin.invalid';
export const V4_TEMPLATE = 'embed-prod/v4/embed.template.js';
export const V4_MANIFEST = 'src/embed/v4.sri';
/** The template's name in the manifest (never a hostname: it has no dot). */
export const TEMPLATE_ENTRY = 'template';
/** Where `dist/` keeps each host's copy. */
export const V4_HOSTS_DIR = 'v4-hosts';
/** The build's own origin's copy (a preview, a local demo): the catch-all rewrite's target. */
export const BUILD_ENTRY = '_build';
const V4_PATH = '/v4/embed.js';

/** Every checkout hostname: the brand registry's. */
export const LOADER_HOSTS: readonly string[] = [...BRANDS.keys()];

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** What a baked origin may be: nothing that could leave the string literal it lands in. */
const BAKED_ORIGIN = /^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1))(?::\d{1,5})?$/;

export function sriOf(bytes: string | Buffer): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

/** A host's committed copy, relative to the package. */
export function hostCopyPath(host: string): string {
  return `embed-prod/${host}/v4/embed.js`;
}

/** The template with `origin` baked in, everywhere the placeholder stands. */
export function loaderForOrigin(template: string, origin: string): string {
  if (!BAKED_ORIGIN.test(origin) || new URL(origin).origin !== origin) {
    throw new Error(`${origin} cannot be baked into a loader`);
  }
  const parts = template.split(V4_ORIGIN_PLACEHOLDER);
  if (parts.length < 2) {
    throw new Error('the v4 template holds no origin placeholder');
  }
  return parts.join(origin);
}

/** `src/embed/v4.sri`: name (`template` or a hostname) -> SRI. */
export function readV4Manifest(packageDir: string): Map<string, string> {
  const entries = new Map<string, string>();
  const path = join(packageDir, V4_MANIFEST);
  if (!existsSync(path)) {
    return entries;
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^(sha384-[A-Za-z0-9+/]{64}) {2}(\S+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.set(match[2], match[1]);
    }
  }
  return entries;
}

/** The manifest's text for these entries, the template first. */
export function v4ManifestText(entries: ReadonlyMap<string, string>): string {
  const hosts = [...entries.keys()].filter((name) => name !== TEMPLATE_ENTRY).sort();
  const names = entries.has(TEMPLATE_ENTRY) ? [TEMPLATE_ENTRY, ...hosts] : hosts;
  return names.map((name) => `${entries.get(name) ?? ''}  ${name}\n`).join('');
}

/**
 * What is wrong with the committed v4 loaders: the template and each host's
 * copy must be the pinned bytes, each copy the template with its own origin,
 * and the manifest must list exactly the template and the loader hosts.
 */
export function v4Problems(packageDir: string, hosts: readonly string[] = LOADER_HOSTS): string[] {
  const problems: string[] = [];
  const manifest = readV4Manifest(packageDir);
  const templatePath = join(packageDir, V4_TEMPLATE);
  if (!existsSync(templatePath)) {
    return [`${V4_TEMPLATE} is missing`];
  }
  const template = readFileSync(templatePath, 'utf8');
  if (sriOf(template) !== manifest.get(TEMPLATE_ENTRY)) {
    problems.push(`${V4_TEMPLATE} is not the template pinned in ${V4_MANIFEST}`);
  }
  if (!template.includes(V4_ORIGIN_PLACEHOLDER)) {
    problems.push(`${V4_TEMPLATE} holds no origin placeholder`);
  }
  for (const host of hosts) {
    if (!HOSTNAME.test(host)) {
      problems.push(`${host} is not a lowercase hostname`);
      continue;
    }
    const copyPath = join(packageDir, hostCopyPath(host));
    if (!existsSync(copyPath)) {
      problems.push(`${hostCopyPath(host)} is missing`);
      continue;
    }
    const copy = readFileSync(copyPath, 'utf8');
    if (copy !== loaderForOrigin(template, `https://${host}`)) {
      problems.push(`${hostCopyPath(host)} is not the template for https://${host}`);
    }
    const pinned = manifest.get(host);
    if (pinned === undefined) {
      problems.push(`${host} has no SRI in ${V4_MANIFEST}`);
    } else if (sriOf(copy) !== pinned) {
      problems.push(`${hostCopyPath(host)} is not the pinned ${pinned}`);
    }
  }
  for (const name of manifest.keys()) {
    if (name !== TEMPLATE_ENTRY && !hosts.includes(name)) {
      problems.push(`${V4_MANIFEST} lists ${name}, which is not a loader host`);
    }
  }
  return problems;
}

interface VercelConfig {
  rewrites?: { source: string; destination: string; has?: { type: string; value?: string }[] }[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
}

/** How a rewrite names a host: a regex, so its dots are escaped. */
export function hostPattern(host: string): string {
  return host.replaceAll('.', '\\.');
}

/** The rewrite that gives `host` its own copy. */
export function hostRewrite(host: string): Required<VercelConfig>['rewrites'][number] {
  return {
    source: V4_PATH,
    has: [{ type: 'host', value: hostPattern(host) }],
    destination: `/${V4_HOSTS_DIR}/${host}/embed.js`,
  };
}

const LOADER_HEADERS = [
  { key: 'Access-Control-Allow-Origin', value: '*' },
  { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
];

/**
 * `vercel.json` routes `/v4/embed.js` by Host: one rewrite per loader host, then
 * the catch-all to the build's own copy, last; and serves v4 like v1-v3 (CORS,
 * which SRI needs, and an immutable cache).
 */
export function vercelV4Problems(
  config: VercelConfig,
  hosts: readonly string[] = LOADER_HOSTS,
): string[] {
  const problems: string[] = [];
  const v4 = (config.rewrites ?? []).filter((rewrite) => rewrite.source === V4_PATH);
  const expected = [
    ...hosts.map((host) => hostRewrite(host)),
    { source: V4_PATH, destination: `/${V4_HOSTS_DIR}/${BUILD_ENTRY}/embed.js` },
  ];
  if (JSON.stringify(v4) !== JSON.stringify(expected)) {
    problems.push(
      `vercel.json must route ${V4_PATH} by Host: one rewrite per loader host (${hosts.join(', ')}), then the ${BUILD_ENTRY} catch-all`,
    );
  }
  for (const source of ['/v4/(.*)', `/${V4_HOSTS_DIR}/(.*)`]) {
    const rule = (config.headers ?? []).find((each) => each.source === source);
    const missing = LOADER_HEADERS.filter(
      (header) =>
        !rule?.headers.some((each) => each.key === header.key && each.value === header.value),
    );
    if (missing.length > 0) {
      problems.push(`vercel.json serves ${source} without CORS and an immutable cache`);
    }
  }
  return problems;
}
