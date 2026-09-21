/**
 * What the chain actually holds, copied by hand from
 * `contracts/elisym-config-evm/DEPLOYMENTS.md` after the read-back the runbook
 * requires. Kept apart from the registry so that a test comparing the two is
 * comparing two independent records, not a value with itself.
 */

/** `ElisymConfig` on Tempo Moderato, deployed 2026-09-20 in block 36177167. */
export const CONFIG_CONTRACT_MODERATO = '0x5fbde74a7ddc8133123e824ffbe161a909342b3d';
/** keccak256 of its runtime code, equal to a clean build's `deployedBytecode`. */
export const CONFIG_CODE_HASH_MODERATO =
  '0x85c2c8ec7b81dab08f32be4c4d834e7b45f6d6be5262de88a3118210529d4520';
