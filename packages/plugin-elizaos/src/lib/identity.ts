import { ElisymIdentity } from '@elisym/sdk';

export function identityToHex(identity: ElisymIdentity): string {
  return Array.from(identity.secretKey, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function identityFromHex(hex: string): ElisymIdentity {
  return ElisymIdentity.fromHex(hex);
}
