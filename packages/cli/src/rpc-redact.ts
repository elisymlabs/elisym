/**
 * Keeping an RPC credential out of anything an operator might paste, ship or
 * screen-share.
 *
 * Third-party RPC providers put the API key IN the URL - Helius in the query,
 * Alchemy and QuickNode in the path - and `SOLANA_RPC_URL` is where operators
 * paste it. Lives in a module of its own because two things need it and one of
 * them is imported by the other: `commands/start.ts` for the banner and the
 * wallet error, and `runtime.ts` for every line it logs.
 */

/**
 * Public Solana RPC hosts whose URL path carries no secret. For these the
 * path is safe to keep; every other host is treated as a third-party RPC
 * (Helius/Alchemy/QuickNode) whose path may embed an API key.
 */
const PUBLIC_SOLANA_RPC_HOSTS = new Set([
  'api.devnet.solana.com',
  'api.mainnet-beta.solana.com',
  'api.testnet.solana.com',
]);

/**
 * Return a log-safe representation of an RPC URL. Strips any userinfo and
 * query string so credentials embedded by third-party RPC providers
 * (Helius/Alchemy/QuickNode style `?api-key=...`) never land in verbose
 * stderr output or the startup banner.
 *
 * FIX #11: Alchemy/QuickNode embed the API key in the URL *path* (e.g.
 * `https://solana-mainnet.g.alchemy.com/v2/<APIKEY>`), so stripping only the
 * userinfo + query still leaks the key. For any host that is not a public
 * `api.*.solana.com` endpoint we therefore redact the path too, returning just
 * `protocol//host/***`. Public Solana hosts keep their (secret-free) path.
 */
export function stripRpcSecrets(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    if (!PUBLIC_SOLANA_RPC_HOSTS.has(parsed.hostname)) {
      // Third-party RPC: the path may carry an API key - drop it entirely.
      return `${parsed.protocol}//${parsed.host}/***`;
    }
    const marker = parsed.search.length > 0 ? '?***' : '';
    parsed.search = '';
    return `${parsed.toString()}${marker}`;
  } catch {
    return '[unparseable RPC URL]';
  }
}

/**
 * True when the URL points at a public `api.*.solana.com` endpoint with no
 * userinfo, path, or query - the shapes `stripRpcSecrets` treats as
 * credential-bearing. Public hosts need no API key, so anything beyond the
 * bare origin is treated as a secret an operator pasted in.
 */
export function isPublicSolanaRpcUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      PUBLIC_SOLANA_RPC_HOSTS.has(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      (parsed.pathname === '' || parsed.pathname === '/')
    );
  } catch {
    return false;
  }
}

/**
 * Redact any RPC URL embedded in free-form text (e.g. a thrown error message) by
 * routing every http(s) URL it contains through `stripRpcSecrets`. Used on error
 * messages that may interpolate the request URL (and thus an embedded API key)
 * while preserving the surrounding diagnostic text.
 */
export function redactRpcUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s)'"]+/g, (url) => stripRpcSecrets(url));
}
