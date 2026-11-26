/** Where hosted mode talks to, read from the committed `config.ts`. */
export interface HostedConfig {
  /** The server's public base, exactly as its `/v1/meta` names it (no trailing slash). */
  apiBase: string;
  /** The operator's DNS name, as its 30490 `mode` tag names the service. */
  operator: string;
}

export type HostedConfigRead =
  /** Both empty: the service's domain is not chosen yet. */
  | { kind: 'unset' }
  | { kind: 'configured'; config: HostedConfig }
  /** Set, but not usable: the build refuses it, and the page treats it as not available. */
  | { kind: 'invalid'; problem: string };

/**
 * The operator as PayCore's server accepts it (`paycore-server/src/config.ts` `OPERATOR_RE`, pinned
 * by a test): a lowercase DNS name of letters, digits and dashes, two labels at least.
 */
export const OPERATOR_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Why `apiBase` is not an https base with no trailing slash, query or fragment, or undefined. */
function apiBaseProblem(apiBase: string): string | undefined {
  if (!URL.canParse(apiBase)) {
    return 'PAYCORE_API_BASE is not a URL';
  }
  const url = new URL(apiBase);
  if (url.protocol !== 'https:') {
    return 'PAYCORE_API_BASE is not https';
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return 'PAYCORE_API_BASE holds credentials, a query or a fragment';
  }
  const canonical = url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`;
  if (apiBase.endsWith('/') || canonical !== apiBase) {
    return 'PAYCORE_API_BASE is not written as its canonical form with no trailing slash';
  }
  return undefined;
}

/** The committed hosted configuration, checked. */
export function readHostedConfig(apiBase: string, operator: string): HostedConfigRead {
  if (apiBase === '' && operator === '') {
    return { kind: 'unset' };
  }
  const problem =
    apiBaseProblem(apiBase) ??
    (OPERATOR_RE.test(operator) ? undefined : 'PAYCORE_OPERATOR is not a lowercase DNS name');
  return problem === undefined
    ? { kind: 'configured', config: { apiBase, operator } }
    : { kind: 'invalid', problem };
}

/** The hosted page's CSP `connect-src`: the API's origin only, or nowhere at all. */
export function hostedConnectSrc(read: HostedConfigRead): string[] {
  return read.kind === 'configured' ? [new URL(read.config.apiBase).origin] : ["'none'"];
}
