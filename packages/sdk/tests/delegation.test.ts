import { describe, expect, it } from 'vitest';
import {
  buildApproveDelegate,
  buildDelegatedTransfer,
  buildRevokeDelegate,
  decodeApproveDelegate,
  decodeDelegationFeeTransfer,
  delegationApproveFeeSubunits,
  deriveOwnerDelegationAta,
  formatDelegationGrant,
  parseDelegationDescriptor,
  resolveDelegationAsset,
  validateSkillDelegation,
} from '../src/delegation';
import { USDC_SOLANA_DEVNET } from '../src/payment/assets';
import { calculateProtocolFee } from '../src/payment/fee';
import { generateSolanaWallet } from '../src/payment/wallet';

async function twoSigners() {
  const owner = await generateSolanaWallet();
  const delegate = await generateSolanaWallet();
  return { owner: owner.signer, delegate: delegate.signer };
}

describe('descriptor schema (read side, .strip)', () => {
  it('accepts a valid descriptor and strips unknown keys', () => {
    const parsed = parseDelegationDescriptor({
      mechanism: 'spl-approve',
      delegate_pubkey: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
      suggested_cap_subunits: '50000000',
      expires_at: null,
      future_field: 'ignored',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.mechanism).toBe('spl-approve');
    expect(parsed?.suggested_cap_subunits).toBe('50000000');
    expect((parsed as Record<string, unknown>).future_field).toBeUndefined();
  });

  it('returns null for a malformed descriptor (never throws on read)', () => {
    expect(parseDelegationDescriptor({ mechanism: 'spl-approve' })).toBeNull();
    expect(
      parseDelegationDescriptor({
        mechanism: 'wat',
        delegate_pubkey: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
        suggested_cap_subunits: '1',
      }),
    ).toBeNull();
    expect(
      parseDelegationDescriptor({
        mechanism: 'spl-approve',
        delegate_pubkey: 'not-base58-0OIl',
        suggested_cap_subunits: '1',
      }),
    ).toBeNull();
    expect(
      parseDelegationDescriptor({
        mechanism: 'spl-approve',
        delegate_pubkey: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
        suggested_cap_subunits: '1.5',
      }),
    ).toBeNull();
  });

  it('returns null for absent input', () => {
    expect(parseDelegationDescriptor(undefined)).toBeNull();
    expect(parseDelegationDescriptor(null)).toBeNull();
  });

  it('accepts a suggested_cap at exactly the u64 maximum', () => {
    const parsed = parseDelegationDescriptor({
      mechanism: 'spl-approve',
      delegate_pubkey: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
      suggested_cap_subunits: '18446744073709551615',
    });
    expect(parsed?.suggested_cap_subunits).toBe('18446744073709551615');
  });

  it('clears a suggested_cap above the u64 maximum (read side)', () => {
    expect(
      parseDelegationDescriptor({
        mechanism: 'spl-approve',
        delegate_pubkey: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
        // 20 digits, ~1e20 > u64 max (18446744073709551615)
        suggested_cap_subunits: '99999999999999999999',
      }),
    ).toBeNull();
  });
});

describe('validateSkillDelegation (write side, fail-loud)', () => {
  it('accepts a frontmatter block without delegate_pubkey', () => {
    const parsed = validateSkillDelegation('demo', {
      mechanism: 'spl-approve',
      suggested_cap_subunits: '50000000',
    });
    expect(parsed?.mechanism).toBe('spl-approve');
    expect(parsed?.suggested_cap_subunits).toBe('50000000');
  });

  it('returns undefined when absent', () => {
    expect(validateSkillDelegation('demo', undefined)).toBeUndefined();
    expect(validateSkillDelegation('demo', null)).toBeUndefined();
  });

  it('throws on a malformed block', () => {
    expect(() => validateSkillDelegation('demo', { mechanism: 'spl-approve' })).toThrow(
      /delegation/,
    );
    expect(() =>
      validateSkillDelegation('demo', {
        mechanism: 'spl-approve',
        suggested_cap_subunits: 'abc',
      }),
    ).toThrow(/subunits/);
    expect(() => validateSkillDelegation('demo', 'nope')).toThrow(/mapping/);
  });

  it('throws on a suggested_cap above the u64 maximum (write side)', () => {
    expect(() =>
      validateSkillDelegation('demo', {
        mechanism: 'spl-approve',
        suggested_cap_subunits: '99999999999999999999',
      }),
    ).toThrow(/u64/i);
  });
});

describe('decodeApproveDelegate guard', () => {
  it('rejects a non-object input rather than throwing an opaque TypeError', () => {
    expect(() => decodeApproveDelegate(null)).toThrow(/approveChecked/i);
    expect(() => decodeApproveDelegate(undefined)).toThrow(/approveChecked/i);
    expect(() => decodeApproveDelegate('nope')).toThrow(/approveChecked/i);
  });

  it('rejects a Token instruction that is not ApproveChecked (a transfer)', async () => {
    const { owner, delegate } = await twoSigners();
    const source = await deriveOwnerDelegationAta(owner.address, 'devnet');
    const destination = await deriveOwnerDelegationAta(delegate.address, 'devnet');
    const transfer = await buildDelegatedTransfer({
      delegate,
      source,
      destination,
      amount: 1_000_000n,
      network: 'devnet',
    });
    expect(() => decodeApproveDelegate(transfer[0])).toThrow(/ApproveChecked|discriminator/);
  });
});

describe('resolveDelegationAsset', () => {
  it('resolves devnet USDC', () => {
    expect(resolveDelegationAsset('devnet')).toBe(USDC_SOLANA_DEVNET);
  });

  it('throws for mainnet (not wired yet)', () => {
    expect(() => resolveDelegationAsset('mainnet')).toThrow(/mainnet/i);
  });
});

describe('deriveOwnerDelegationAta', () => {
  it('is deterministic for the same owner', async () => {
    const { owner } = await twoSigners();
    const a = await deriveOwnerDelegationAta(owner.address, 'devnet');
    const b = await deriveOwnerDelegationAta(owner.address, 'devnet');
    expect(a).toBe(b);
  });

  it('rejects an invalid owner address', async () => {
    await expect(deriveOwnerDelegationAta('not-an-address', 'devnet')).rejects.toThrow(/owner/);
  });
});

describe('buildApproveDelegate', () => {
  it('builds create-ATA + approveChecked that decodes to the exact grant', async () => {
    const { owner, delegate } = await twoSigners();
    const instructions = await buildApproveDelegate({
      owner,
      delegate: delegate.address,
      capSubunits: 50_000_000n,
      network: 'devnet',
    });
    expect(instructions).toHaveLength(2);

    const view = decodeApproveDelegate(instructions[1]);
    expect(view.delegate).toBe(delegate.address);
    expect(view.capSubunits).toBe(50_000_000n);
    expect(view.decimals).toBe(6);
    expect(view.mint).toBe(USDC_SOLANA_DEVNET.mint);
    expect(view.symbol).toBe('USDC');
    expect(view.recognized).toBe(true);
    // source is the owner's derived ATA, never a caller-supplied account
    expect(view.source).toBe(await deriveOwnerDelegationAta(owner.address, 'devnet'));

    expect(formatDelegationGrant(view)).toBe(
      `Grant delegate ${delegate.address} up to 50 USDC on your account.`,
    );
  });

  it('rejects a non-positive cap', async () => {
    const { owner, delegate } = await twoSigners();
    await expect(
      buildApproveDelegate({
        owner,
        delegate: delegate.address,
        capSubunits: 0n,
        network: 'devnet',
      }),
    ).rejects.toThrow(/positive/);
  });

  it('rejects an over-u64 cap', async () => {
    const { owner, delegate } = await twoSigners();
    await expect(
      buildApproveDelegate({
        owner,
        delegate: delegate.address,
        capSubunits: 1n << 64n,
        network: 'devnet',
      }),
    ).rejects.toThrow(/u64/);
  });

  it('rejects an invalid delegate address', async () => {
    const { owner } = await twoSigners();
    await expect(
      buildApproveDelegate({
        owner,
        delegate: 'not-base58-0OIl',
        capSubunits: 1n,
        network: 'devnet',
      }),
    ).rejects.toThrow(/delegate/);
  });

  it('rejects delegate == owner', async () => {
    const { owner } = await twoSigners();
    await expect(
      buildApproveDelegate({
        owner,
        delegate: owner.address,
        capSubunits: 1n,
        network: 'devnet',
      }),
    ).rejects.toThrow(/differ/);
  });

  it('rejects mainnet (USDC-only, not wired)', async () => {
    const { owner, delegate } = await twoSigners();
    await expect(
      buildApproveDelegate({
        owner,
        delegate: delegate.address,
        capSubunits: 1n,
        network: 'mainnet',
      }),
    ).rejects.toThrow(/mainnet/i);
  });
});

describe('buildRevokeDelegate', () => {
  it('builds a single revoke on the owner ATA', async () => {
    const { owner } = await twoSigners();
    const instructions = await buildRevokeDelegate({ owner, network: 'devnet' });
    expect(instructions).toHaveLength(1);
  });
});

describe('buildDelegatedTransfer', () => {
  it('builds a single transferChecked from source to destination', async () => {
    const { owner, delegate } = await twoSigners();
    const source = await deriveOwnerDelegationAta(owner.address, 'devnet');
    const destination = await deriveOwnerDelegationAta(delegate.address, 'devnet');
    const instructions = await buildDelegatedTransfer({
      delegate,
      source,
      destination,
      amount: 1_000_000n,
      network: 'devnet',
    });
    expect(instructions).toHaveLength(1);
  });

  it('rejects a non-positive amount', async () => {
    const { owner, delegate } = await twoSigners();
    const source = await deriveOwnerDelegationAta(owner.address, 'devnet');
    await expect(
      buildDelegatedTransfer({
        delegate,
        source,
        destination: source,
        amount: 0n,
        network: 'devnet',
      }),
    ).rejects.toThrow(/positive/);
  });

  it('rejects an invalid destination', async () => {
    const { owner, delegate } = await twoSigners();
    const source = await deriveOwnerDelegationAta(owner.address, 'devnet');
    await expect(
      buildDelegatedTransfer({
        delegate,
        source,
        destination: 'not-base58-0OIl',
        amount: 1n,
        network: 'devnet',
      }),
    ).rejects.toThrow(/destination/);
  });
});

describe('delegation approve fee', () => {
  it('appends a treasury fee transfer when a fee is charged', async () => {
    const { owner, delegate } = await twoSigners();
    const treasury = (await generateSolanaWallet()).signer;
    const cap = 50_000_000n; // 50 USDC
    const feeBps = 250; // 2.5%
    const instructions = await buildApproveDelegate({
      owner,
      delegate: delegate.address,
      capSubunits: cap,
      network: 'devnet',
      fee: { feeBps, treasury: treasury.address },
    });
    // [0]=createOwnerAta, [1]=approveChecked, [2]=createTreasuryAta, [3]=feeTransfer
    expect(instructions).toHaveLength(4);
    // approve leg still decodes at [1]
    expect(decodeApproveDelegate(instructions[1]).capSubunits).toBe(cap);
    // fee leg at [3]: amount = feeBps of cap, to the treasury's USDC ATA
    const expectedFee = delegationApproveFeeSubunits(cap, feeBps);
    expect(expectedFee).toBe(BigInt(calculateProtocolFee(Number(cap), feeBps)));
    expect(expectedFee).toBe(1_250_000n); // 2.5% of 50 USDC
    const feeLeg = decodeDelegationFeeTransfer(instructions[3]);
    expect(feeLeg.amount).toBe(expectedFee);
    expect(feeLeg.mint).toBe(USDC_SOLANA_DEVNET.mint);
    expect(feeLeg.destination).toBe(await deriveOwnerDelegationAta(treasury.address, 'devnet'));
    expect(feeLeg.source).toBe(await deriveOwnerDelegationAta(owner.address, 'devnet'));
  });

  it('appends no fee leg when feeBps is 0', async () => {
    const { owner, delegate } = await twoSigners();
    const treasury = (await generateSolanaWallet()).signer;
    const instructions = await buildApproveDelegate({
      owner,
      delegate: delegate.address,
      capSubunits: 50_000_000n,
      network: 'devnet',
      fee: { feeBps: 0, treasury: treasury.address },
    });
    expect(instructions).toHaveLength(2);
  });

  it('appends no fee leg when fee is omitted', async () => {
    const { owner, delegate } = await twoSigners();
    const instructions = await buildApproveDelegate({
      owner,
      delegate: delegate.address,
      capSubunits: 50_000_000n,
      network: 'devnet',
    });
    expect(instructions).toHaveLength(2);
  });

  it('delegationApproveFeeSubunits rounds up like the payment fee', () => {
    expect(delegationApproveFeeSubunits(1n, 1)).toBe(1n); // ceil(1*1/10000) never rounds to 0
    expect(delegationApproveFeeSubunits(0n, 250)).toBe(0n);
    expect(delegationApproveFeeSubunits(1_000_000n, 250)).toBe(25_000n);
  });

  it('delegationApproveFeeSubunits throws above the safe-integer bound', () => {
    expect(() => delegationApproveFeeSubunits(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 250)).toThrow(
      /safe-integer/,
    );
  });

  it('rejects an invalid fee treasury address', async () => {
    const { owner, delegate } = await twoSigners();
    await expect(
      buildApproveDelegate({
        owner,
        delegate: delegate.address,
        capSubunits: 50_000_000n,
        network: 'devnet',
        fee: { feeBps: 250, treasury: 'not-base58-0OIl' },
      }),
    ).rejects.toThrow(/treasury/);
  });

  it('decodeDelegationFeeTransfer rejects a non-transfer instruction (anti-masquerade)', async () => {
    const { owner, delegate } = await twoSigners();
    const instructions = await buildApproveDelegate({
      owner,
      delegate: delegate.address,
      capSubunits: 50_000_000n,
      network: 'devnet',
    });
    // [1] is the approveChecked, not a transferChecked - the discriminator guard must reject it.
    expect(() => decodeDelegationFeeTransfer(instructions[1])).toThrow(
      /TransferChecked|discriminator/,
    );
    expect(() => decodeDelegationFeeTransfer(null)).toThrow(/transferChecked/i);
    expect(() => decodeDelegationFeeTransfer(undefined)).toThrow(/transferChecked/i);
  });
});
