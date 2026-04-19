import type { Signer } from '@elisym/sdk';
import type { IAgentRuntime } from '@elizaos/core';
import { createKmsSigner } from './kmsStub';
import { createLocalSigner } from './local';

export type SignerKind = 'local' | 'kms' | 'external';

export const SIGNER_KINDS: readonly SignerKind[] = ['local', 'kms', 'external'];

export type SignerSource = 'config' | 'persisted' | 'generated' | 'external';

export interface SignerContext {
  runtime: IAgentRuntime;
  fromConfig?: string;
}

export interface SignerHandle {
  signer: Signer;
  source: SignerSource;
  kind: SignerKind;
}

export async function createSigner(kind: SignerKind, ctx: SignerContext): Promise<SignerHandle> {
  if (kind === 'local') {
    return createLocalSigner(ctx);
  }
  if (kind === 'kms') {
    return createKmsSigner(ctx);
  }
  throw new Error(
    'ELISYM_SIGNER_KIND=external requires a custom adapter to be wired up by the agent author. ' +
      'See packages/plugin-elizaos/README.md#external-signers for the integration plan.',
  );
}

export function isSignerKind(value: string): value is SignerKind {
  return (SIGNER_KINDS as readonly string[]).includes(value);
}
