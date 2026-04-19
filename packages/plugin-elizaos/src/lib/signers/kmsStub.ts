import type { SignerContext, SignerHandle } from './index';

const KMS_REQUIRED_ENV = ['ELISYM_KMS_PROVIDER', 'ELISYM_KMS_KEY_ID'] as const;

export function createKmsSigner(ctx: SignerContext): Promise<SignerHandle> {
  const missing = KMS_REQUIRED_ENV.filter((key) => {
    const value = ctx.runtime.getSetting?.(key) ?? process.env[key];
    return typeof value !== 'string' || value.length === 0;
  });
  if (missing.length > 0) {
    return Promise.reject(
      new Error(
        `ELISYM_SIGNER_KIND=kms requires ${missing.join(', ')} to be set. ` +
          'See packages/plugin-elizaos/README.md#external-signers for the integration plan.',
      ),
    );
  }
  return Promise.reject(
    new Error(
      'ELISYM_SIGNER_KIND=kms is recognized but no concrete KMS adapter is bundled. ' +
        'Implement a Signer adapter against your provider (AWS KMS, Turnkey, etc.) and ' +
        'wire it in via the createSigner factory. ' +
        'See packages/plugin-elizaos/README.md#external-signers for the integration plan.',
    ),
  );
}
