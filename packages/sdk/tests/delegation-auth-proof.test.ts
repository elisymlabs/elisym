import { describe, expect, it } from 'vitest';
import {
  DELEGATION_NONCE_REGEX,
  DELEGATION_PROOF_REGEX,
  buildAuthMessage,
  buildDelegationAuthProof,
  mintDelegationNonce,
  verifyDelegationAuthProof,
  type DelegationAuthFields,
} from '../src/delegation/auth-proof';
import { generateSolanaWallet } from '../src/payment/wallet';
import { ElisymIdentity } from '../src/primitives/identity';

async function proofFixture() {
  const owner = await generateSolanaWallet();
  const delegate = await generateSolanaWallet();
  const author = ElisymIdentity.generate();
  const fields: DelegationAuthFields = {
    agentDelegate: delegate.signer.address,
    nostrAuthor: author.publicKey,
    owner: owner.signer.address,
    expiryUnix: Math.floor(Date.now() / 1000) + 300,
    nonce: mintDelegationNonce(),
  };
  const proof = await buildDelegationAuthProof({ ownerSigner: owner.signer, ...fields });
  return { owner, delegate, author, fields, proof };
}

describe('buildAuthMessage', () => {
  it('is domain-separated, human-legible, and length-prefixes every field', async () => {
    const { fields } = await proofFixture();
    const text = new TextDecoder().decode(buildAuthMessage(fields));
    const lines = text.split('\n');
    expect(lines[0]).toBe('elisym delegated-payment authorization (v1)');
    expect(lines[1]).toBe(`agent-delegate=${fields.agentDelegate.length}:${fields.agentDelegate}`);
    expect(lines[2]).toBe(`nostr-author=${fields.nostrAuthor.length}:${fields.nostrAuthor}`);
    expect(lines[3]).toBe(`owner=${fields.owner.length}:${fields.owner}`);
    expect(lines[4]).toBe(`expires=${String(fields.expiryUnix).length}:${fields.expiryUnix}`);
    expect(lines[5]).toBe(`nonce=${fields.nonce.length}:${fields.nonce}`);
    expect(lines).toHaveLength(6);
  });

  it('rejects malformed fields (newline/format injection cannot reach the bytes)', async () => {
    const { fields } = await proofFixture();
    expect(() => buildAuthMessage({ ...fields, nonce: 'short' })).toThrow(/nonce/);
    expect(() => buildAuthMessage({ ...fields, nonce: `${fields.nonce}\nowner=1:x` })).toThrow(
      /nonce/,
    );
    expect(() => buildAuthMessage({ ...fields, owner: 'not-base58-0OIl' })).toThrow(/owner/);
    expect(() => buildAuthMessage({ ...fields, nostrAuthor: 'F00'.repeat(21) })).toThrow(
      /nostrAuthor/,
    );
    expect(() => buildAuthMessage({ ...fields, agentDelegate: '' })).toThrow(/agentDelegate/);
    expect(() => buildAuthMessage({ ...fields, expiryUnix: -1 })).toThrow(/expiryUnix/);
    expect(() => buildAuthMessage({ ...fields, expiryUnix: 1.5 })).toThrow(/expiryUnix/);
    expect(() => buildAuthMessage({ ...fields, expiryUnix: 1e15 })).toThrow(/expiryUnix/);
  });
});

describe('mintDelegationNonce', () => {
  it('mints unique nonces matching the strict charset/length', () => {
    const first = mintDelegationNonce();
    const second = mintDelegationNonce();
    expect(first).toMatch(DELEGATION_NONCE_REGEX);
    expect(second).toMatch(DELEGATION_NONCE_REGEX);
    expect(first).not.toBe(second);
  });
});

describe('proof round-trip', () => {
  it('verifies a valid proof', async () => {
    const { fields, proof } = await proofFixture();
    expect(proof).toMatch(DELEGATION_PROOF_REGEX);
    await expect(verifyDelegationAuthProof({ ...fields, proof })).resolves.toBe(true);
  });

  it('rejects a tampered field (nonce / expiry)', async () => {
    const { fields, proof } = await proofFixture();
    await expect(
      verifyDelegationAuthProof({ ...fields, nonce: mintDelegationNonce(), proof }),
    ).resolves.toBe(false);
    await expect(
      verifyDelegationAuthProof({ ...fields, expiryUnix: fields.expiryUnix + 1, proof }),
    ).resolves.toBe(false);
  });

  it('rejects a proof presented for a different owner (verify key IS the owner tag)', async () => {
    const { fields, proof } = await proofFixture();
    const otherOwner = await generateSolanaWallet();
    await expect(
      verifyDelegationAuthProof({ ...fields, owner: otherOwner.signer.address, proof }),
    ).resolves.toBe(false);
  });

  it('rejects a proof replayed by a different request author', async () => {
    const { fields, proof } = await proofFixture();
    const otherAuthor = ElisymIdentity.generate();
    await expect(
      verifyDelegationAuthProof({ ...fields, nostrAuthor: otherAuthor.publicKey, proof }),
    ).resolves.toBe(false);
  });

  it('rejects a proof replayed against a different provider delegate', async () => {
    const { fields, proof } = await proofFixture();
    const otherDelegate = await generateSolanaWallet();
    await expect(
      verifyDelegationAuthProof({
        ...fields,
        agentDelegate: otherDelegate.signer.address,
        proof,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a proof signed by a non-owner key', async () => {
    const { fields } = await proofFixture();
    const attacker = await generateSolanaWallet();
    // buildDelegationAuthProof itself refuses a signer/owner mismatch...
    await expect(
      buildDelegationAuthProof({ ownerSigner: attacker.signer, ...fields }),
    ).rejects.toThrow(/owner/);
    // ...and a proof crafted around it (attacker signs, claims the victim owner)
    // fails verification against the owner key.
    const forged = await buildDelegationAuthProof({
      ownerSigner: attacker.signer,
      ...fields,
      owner: attacker.signer.address,
    });
    await expect(verifyDelegationAuthProof({ ...fields, proof: forged })).resolves.toBe(false);
  });

  it('fail-closed on garbage proofs (never throws)', async () => {
    const { fields } = await proofFixture();
    await expect(verifyDelegationAuthProof({ ...fields, proof: 'not-base58-0OIl' })).resolves.toBe(
      false,
    );
    await expect(verifyDelegationAuthProof({ ...fields, proof: '' })).resolves.toBe(false);
    await expect(verifyDelegationAuthProof({ ...fields, proof: '1'.repeat(87) })).resolves.toBe(
      false,
    );
    // Malformed fields on the verify side return false rather than throwing.
    await expect(
      verifyDelegationAuthProof({ ...fields, owner: 'nope', proof: '1'.repeat(87) }),
    ).resolves.toBe(false);
  });
});
