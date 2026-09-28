/**
 * The build's environment, checked before anything is built. `VITE_*` values
 * are inlined into the public bundle: an RPC key in them is protected only by
 * the key's own origin restriction (set at the provider), never by secrecy.
 */

/** Where production serves the checkout: the origin the pinned `v1/embed.js` frames. */
export const PRODUCTION_ORIGIN = 'https://pay.elisym.network';

/** Rejects requests that carry a browser `Origin`, and keeps no full history. */
const PUBLIC_MAINNET_HOST = 'api.mainnet-beta.solana.com';

export const RPC_ENV = ['VITE_SOLANA_RPC_URL_MAINNET', 'VITE_SOLANA_RPC_URL_DEVNET'] as const;

type BuildEnv = Readonly<Record<string, string | undefined>>;

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1';
}

/** What is wrong with the build's environment; empty when the build may go on. */
export function buildEnvProblems(env: BuildEnv): string[] {
  const problems: string[] = [];
  for (const name of RPC_ENV) {
    const value = env[name];
    if (value === undefined || value === '') {
      continue;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${name} is not a URL`);
      continue;
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url.hostname))) {
      problems.push(`${name} must be https:`);
    }
  }
  if (env.VERCEL_ENV === 'production') {
    const mainnet = env.VITE_SOLANA_RPC_URL_MAINNET;
    if (mainnet === undefined || mainnet === '') {
      problems.push('a production build needs VITE_SOLANA_RPC_URL_MAINNET (the widget key)');
    } else if (URL.canParse(mainnet) && new URL(mainnet).hostname === PUBLIC_MAINNET_HOST) {
      problems.push(
        `VITE_SOLANA_RPC_URL_MAINNET must be the widget's own full-history endpoint, not ${PUBLIC_MAINNET_HOST}`,
      );
    }
  }
  return problems;
}

/**
 * Where the checkout is served, for the loader to frame: `CHECKOUT_ORIGIN`
 * when set; on a Vercel preview, that very deployment's URL (so a preview
 * never frames production, nor a newer deployment of its branch); otherwise
 * production. A preview that names no URL of its own fails.
 */
export function checkoutOrigin(env: BuildEnv, production = PRODUCTION_ORIGIN): string {
  const explicit = env.CHECKOUT_ORIGIN;
  if (explicit !== undefined && explicit !== '') {
    return new URL(explicit).origin;
  }
  if (env.VERCEL_ENV === 'preview') {
    const deployment = env.VERCEL_URL;
    if (deployment === undefined || deployment === '') {
      throw new Error('a preview build needs VERCEL_URL (or CHECKOUT_ORIGIN) to frame itself');
    }
    return new URL(`https://${deployment}`).origin;
  }
  return production;
}
