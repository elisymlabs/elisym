import { loadPersistedSolanaSecret, persistSolanaSecret } from '../secretsMemory';
import { generateSolanaSecretBase58, signerFromBase58 } from '../solana';
import type { SignerContext, SignerHandle } from './index';

export async function createLocalSigner(ctx: SignerContext): Promise<SignerHandle> {
  if (ctx.fromConfig) {
    const signer = await signerFromBase58(ctx.fromConfig);
    return { signer, source: 'config', kind: 'local' };
  }
  const persisted = await loadPersistedSolanaSecret(ctx.runtime);
  if (persisted) {
    const signer = await signerFromBase58(persisted);
    return { signer, source: 'persisted', kind: 'local' };
  }
  const fresh = await generateSolanaSecretBase58();
  await persistSolanaSecret(ctx.runtime, fresh);
  const signer = await signerFromBase58(fresh);
  return { signer, source: 'generated', kind: 'local' };
}
