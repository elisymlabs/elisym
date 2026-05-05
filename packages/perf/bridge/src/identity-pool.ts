/**
 * Pool of pre-generated Nostr customer identities for k6 scenarios.
 *
 * Why: generating a fresh keypair per VU iteration adds ~ms of crypto overhead
 * to every measured request. By materialising a fixed pool at bridge startup,
 * VUs get round-robin reuse and the measurements isolate the network/SDK cost.
 *
 * The pool is in-memory only and is regenerated every time the bridge restarts.
 * Phase 3+ expands this with optional Solana keypairs whose addresses are
 * pre-funded via `solana airdrop` on test-validator.
 */
import { ElisymIdentity } from '@elisym/sdk';

export interface PoolEntry {
  identity: ElisymIdentity;
  pubkeyHex: string;
}

export class IdentityPool {
  private entries: PoolEntry[] = [];
  private cursor = 0;

  constructor(size: number) {
    if (size <= 0) {
      throw new Error('IdentityPool size must be > 0');
    }
    for (let i = 0; i < size; i++) {
      const identity = ElisymIdentity.generate();
      this.entries.push({ identity, pubkeyHex: identity.publicKey });
    }
  }

  size(): number {
    return this.entries.length;
  }

  next(): PoolEntry {
    const entry = this.entries[this.cursor];
    this.cursor = (this.cursor + 1) % this.entries.length;
    return entry;
  }

  byIndex(index: number): PoolEntry {
    return this.entries[index % this.entries.length];
  }
}
