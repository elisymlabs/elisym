import {
  NATIVE_ASSET_SENTINEL,
  deriveAssetStatsAddress,
  deriveEventAuthorityAddress,
  deriveNetworkStatsAddress,
} from '@elisym/config-client';
import { getTransferSolInstructionDataDecoder } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getTransferCheckedInstructionDataDecoder,
} from '@solana-program/token';
import {
  type Address,
  type Blockhash,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  address,
  getAddressDecoder,
} from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  ELISYM_PROTOCOL_TAG,
  LSM_SOLANA_MAINNET,
  TOKEN_2022_PROGRAM_ADDRESS_STR,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  calculateProtocolFee,
  buildPaymentInstructions,
  getProtocolProgramId,
  SolanaPaymentStrategy,
  ProtocolConfigInput,
  parsePaymentRequest,
} from '../src';

const RANDOM_ADDRESS_BYTES = 32;
const ADDRESS_DECODER = getAddressDecoder();

function makeAddress(): Address {
  const bytes = new Uint8Array(RANDOM_ADDRESS_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes);
}

const TEST_FEE_BPS = 300;
const TEST_TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy' as Address;

const CONFIG: ProtocolConfigInput = {
  feeBps: TEST_FEE_BPS,
  treasury: TEST_TREASURY,
};
const TEST_PROGRAM_ID = getProtocolProgramId('devnet');

const payment = new SolanaPaymentStrategy();
const validAddress = makeAddress();

describe('calculateProtocolFee', () => {
  it('returns 0 for zero amount', () => {
    expect(calculateProtocolFee(0, TEST_FEE_BPS)).toBe(0);
  });

  it('returns 0 when feeBps is zero', () => {
    expect(calculateProtocolFee(1_000_000, 0)).toBe(0);
  });

  it('calculates 3% fee correctly (ceil)', () => {
    // 100_000_000 lamports (0.1 SOL) -> 3% = 3_000_000
    expect(calculateProtocolFee(100_000_000, TEST_FEE_BPS)).toBe(3_000_000);
  });

  it('rounds up (ceil) for non-divisible amounts', () => {
    // 1 lamport -> ceil(1 * 300 / 10000) = ceil(0.03) = 1
    expect(calculateProtocolFee(1, TEST_FEE_BPS)).toBe(1);
  });

  it('handles small amounts correctly', () => {
    // 10 lamports -> ceil(10 * 300 / 10000) = ceil(0.3) = 1
    expect(calculateProtocolFee(10, TEST_FEE_BPS)).toBe(1);
    // 100 lamports -> ceil(100 * 300 / 10000) = ceil(3) = 3
    expect(calculateProtocolFee(100, TEST_FEE_BPS)).toBe(3);
    // 333 lamports -> ceil(333 * 300 / 10000) = ceil(9.99) = 10
    expect(calculateProtocolFee(333, TEST_FEE_BPS)).toBe(10);
  });

  it('handles 1 SOL', () => {
    // 1_000_000_000 lamports -> 3% = 30_000_000
    expect(calculateProtocolFee(1_000_000_000, TEST_FEE_BPS)).toBe(30_000_000);
  });

  it('handles large amounts without overflow', () => {
    // 100 SOL = 100_000_000_000 lamports -> 3% = 3_000_000_000
    expect(calculateProtocolFee(100_000_000_000, TEST_FEE_BPS)).toBe(3_000_000_000);
  });

  it('throws on negative amount', () => {
    expect(() => calculateProtocolFee(-1, TEST_FEE_BPS)).toThrow('non-negative');
    expect(() => calculateProtocolFee(-100_000_000, TEST_FEE_BPS)).toThrow('non-negative');
  });

  it('throws on negative feeBps', () => {
    expect(() => calculateProtocolFee(100, -1)).toThrow('feeBps');
  });

  it('matches basis points formula: ceil(amount * BPS / 10000)', () => {
    const amounts = [1, 33, 100, 999, 1337, 50000, 140_000_000, 1_000_000_000];
    for (const amount of amounts) {
      const expected = Math.ceil((amount * TEST_FEE_BPS) / 10_000);
      expect(calculateProtocolFee(amount, TEST_FEE_BPS)).toBe(expected);
    }
  });
});

describe('SolanaPaymentStrategy.validatePaymentRequest', () => {
  const recipientAddr = makeAddress();
  const referenceAddr = makeAddress();
  const otherAddr = makeAddress();
  const validRequest = {
    recipient: recipientAddr,
    amount: 140_000_000,
    reference: referenceAddr,
    fee_address: TEST_TREASURY,
    fee_amount: calculateProtocolFee(140_000_000, TEST_FEE_BPS),
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 3600,
  };

  it('accepts valid payment request', () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(validRequest),
      CONFIG,
      'devnet',
      recipientAddr,
    );
    expect(result).toBeNull();
  });

  it('rejects a reference that is an address the payment is computed from', () => {
    // Preempts the fee codes deliberately: those are about diverting PART of
    // the payment, this costs the customer all of it, because the transfer
    // becomes unfindable once other traffic pushes it out of the listing.
    const result = payment.validatePaymentRequest(
      JSON.stringify({ ...validRequest, reference: recipientAddr }),
      CONFIG,
      'devnet',
      recipientAddr,
    );
    expect(result?.code).toBe('degenerate_reference');
  });

  it('rejects it at feeBps=0 as well, the config mainnet actually runs', () => {
    // The row above measures the gate only while a fee applies. On the deployed
    // mainnet program the fee is 0, so the request takes the `expectedFee === 0`
    // early return a few lines below - and a gate that drifted under that
    // return would leave every other row in this file green while the
    // commonest config in production lost the check entirely. Measured.
    const result = payment.validatePaymentRequest(
      JSON.stringify({ ...validRequest, fee_amount: 0, reference: recipientAddr }),
      { feeBps: 0, treasury: TEST_TREASURY },
      'devnet',
      recipientAddr,
    );
    expect(result?.code).toBe('degenerate_reference');

    // And it stays BELOW `recipient_mismatch`, which is the one refusal that
    // outranks it: a redirected recipient makes the reference question moot.
    const mismatched = payment.validatePaymentRequest(
      JSON.stringify({ ...validRequest, fee_amount: 0, reference: recipientAddr }),
      { feeBps: 0, treasury: TEST_TREASURY },
      'devnet',
      otherAddr,
    );
    expect(mismatched?.code).toBe('recipient_mismatch');
  });

  it('rejects invalid JSON', () => {
    const result = payment.validatePaymentRequest('not json', CONFIG, 'devnet');
    expect(result?.code).toBe('invalid_json');
    expect(result?.message).toContain('Invalid payment request JSON');
  });

  it('rejects recipient mismatch', () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(validRequest),
      CONFIG,
      'devnet',
      otherAddr,
    );
    expect(result?.code).toBe('recipient_mismatch');
    expect(result?.message).toContain('Recipient mismatch');
  });

  it('rejects wrong fee address', () => {
    const badRequest = { ...validRequest, fee_address: otherAddr };
    const result = payment.validatePaymentRequest(JSON.stringify(badRequest), CONFIG, 'devnet');
    expect(result?.code).toBe('fee_address_mismatch');
    expect(result?.message).toContain('Fee address mismatch');
  });

  it('rejects wrong fee amount', () => {
    const badRequest = { ...validRequest, fee_amount: 1 };
    const result = payment.validatePaymentRequest(JSON.stringify(badRequest), CONFIG, 'devnet');
    expect(result?.code).toBe('fee_amount_mismatch');
    expect(result?.message).toContain('Fee amount mismatch');
  });

  it('rejects missing fee', () => {
    const { fee_address: _a, fee_amount: _b, ...noFee } = validRequest;
    const result = payment.validatePaymentRequest(JSON.stringify(noFee), CONFIG, 'devnet');
    expect(result?.code).toBe('missing_fee');
    expect(result?.message).toContain('missing protocol fee');
  });

  it('accepts without expected recipient', () => {
    const result = payment.validatePaymentRequest(JSON.stringify(validRequest), CONFIG, 'devnet');
    expect(result).toBeNull();
  });

  it('accepts fee_amount=0 when feeBps=0 (legal on-chain state)', () => {
    // Regression: set_fee_bps enforces <= MAX_FEE_BPS but not > 0. When an admin
    // sets feeBps=0, createPaymentRequest emits fee_address=treasury, fee_amount=0.
    // validatePaymentRequest must accept the same request it just produced.
    const zeroFeeConfig = { feeBps: 0, treasury: TEST_TREASURY };
    const zeroFeeRequest = { ...validRequest, fee_amount: 0 };
    const result = payment.validatePaymentRequest(
      JSON.stringify(zeroFeeRequest),
      zeroFeeConfig,
      'devnet',
      recipientAddr,
    );
    expect(result).toBeNull();
  });
});

describe('SolanaPaymentStrategy.createPaymentRequest', () => {
  it('creates a payment request with correct fee', () => {
    const pr = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG, 'devnet');
    expect(pr.recipient).toBe(validAddress);
    expect(pr.amount).toBe(100_000_000);
    expect(pr.fee_address).toBe(TEST_TREASURY);
    expect(pr.fee_amount).toBe(3_000_000);
    expect(pr.reference).toBeTruthy();
    expect(pr.created_at).toBeGreaterThan(0);
    expect(pr.expiry_secs).toBe(600);
  });

  it('respects custom expirySecs option', () => {
    const pr = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG, 'devnet', {
      expirySecs: 120,
    });
    expect(pr.expiry_secs).toBe(120);
  });

  it('rejects zero amount', () => {
    expect(() => payment.createPaymentRequest(validAddress, 0, CONFIG, 'devnet')).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects negative amount', () => {
    expect(() => payment.createPaymentRequest(validAddress, -100, CONFIG, 'devnet')).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects NaN', () => {
    expect(() => payment.createPaymentRequest(validAddress, NaN, CONFIG, 'devnet')).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects Infinity', () => {
    expect(() => payment.createPaymentRequest(validAddress, Infinity, CONFIG, 'devnet')).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects invalid treasury in config', () => {
    expect(() =>
      payment.createPaymentRequest(
        validAddress,
        100_000_000,
        {
          feeBps: TEST_FEE_BPS,
          treasury: 'not-a-valid-address' as Address,
        },
        'devnet',
      ),
    ).toThrow('Invalid treasury address');
  });
});

describe('buildPaymentInstructions', () => {
  function makeSigner(addressValue: Address): { address: Address } {
    return { address: addressValue };
  }

  it('produces 2 instructions when fee is present', async () => {
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        fee_address: TEST_TREASURY,
        fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );
    expect(instructions.length).toBe(3);
  });

  it('produces 1 instruction when fee is absent', async () => {
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );
    expect(instructions.length).toBe(2);
  });

  it('refuses a reference equal to an address it derives for the payment itself', async () => {
    // The customer's last look, and the half `validatePaymentRequest` cannot
    // take: it is synchronous, so it never sees the DERIVED addresses. Measured
    // before this check existed - `validatePaymentRequest` answered `null` here
    // while the provider's `verifyPayment` answers `degenerate_reference`, so
    // the customer paid for a job that could never be delivered.
    const signer = makeSigner(makeAddress());
    const eventAuthority = await deriveEventAuthorityAddress(TEST_PROGRAM_ID);

    await expect(
      buildPaymentInstructions(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: eventAuthority as string,
          fee_address: TEST_TREASURY,
          fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
        } as never,
        signer as never,
        { programId: TEST_PROGRAM_ID },
      ),
    ).rejects.toThrow(/computed from/);
  });

  it("refuses a reference equal to the recipient's own token account", async () => {
    // The SPL half of the same gap, and the one a hand-crafted request would
    // actually use: the recipient's ATA is where the money lands, so listing it
    // is listing the provider's whole balance history.
    const recipient = makeAddress();
    const [recipientAta] = await findAssociatedTokenPda({
      owner: recipient,
      mint: address(USDC_SOLANA_DEVNET.mint as string),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const signer = makeSigner(makeAddress());

    await expect(
      buildPaymentInstructions(
        {
          recipient,
          amount: 100_000_000,
          reference: recipientAta as string,
          fee_address: TEST_TREASURY,
          fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
          asset: {
            chain: 'solana',
            token: 'usdc',
            mint: USDC_SOLANA_DEVNET.mint,
            decimals: USDC_SOLANA_DEVNET.decimals,
          },
        } as never,
        signer as never,
        { programId: TEST_PROGRAM_ID },
      ),
    ).rejects.toThrow(/computed from/);
  });

  it.each([
    ['the network stats PDA', async () => await deriveNetworkStatsAddress(TEST_PROGRAM_ID)],
    [
      'the asset stats PDA',
      async () => await deriveAssetStatsAddress(TEST_PROGRAM_ID, NATIVE_ASSET_SENTINEL),
    ],
  ])('refuses a reference equal to %s as well', async (_label, derive) => {
    // The set is three addresses wide and one fixture used to hold it up.
    const signer = makeSigner(makeAddress());

    await expect(
      buildPaymentInstructions(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: (await derive()) as string,
          fee_address: TEST_TREASURY,
          fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
        } as never,
        signer as never,
        { programId: TEST_PROGRAM_ID },
      ),
    ).rejects.toThrow(/computed from/);
  });

  it("refuses the fee address's token account on a ZERO-fee request", async () => {
    // The commonest shape there is: the deployed mainnet program charges
    // `feeBps: 0`, so every mainnet SPL payment takes the zero-fee branch.
    // Deriving this account only when a fee leg gets built left exactly that
    // case unchecked here and checked by the provider - measured, before this
    // fixture existed: `validatePaymentRequest` answered `null`, the
    // transaction BUILT, and `verifyPayment` answered `degenerate_reference`.
    const [treasuryAta] = await findAssociatedTokenPda({
      owner: TEST_TREASURY,
      mint: address(USDC_SOLANA_DEVNET.mint as string),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const signer = makeSigner(makeAddress());

    await expect(
      buildPaymentInstructions(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: treasuryAta as string,
          fee_address: TEST_TREASURY,
          fee_amount: 0,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
          asset: {
            chain: 'solana',
            token: 'usdc',
            mint: USDC_SOLANA_DEVNET.mint,
            decimals: USDC_SOLANA_DEVNET.decimals,
          },
        } as never,
        signer as never,
        { programId: TEST_PROGRAM_ID },
      ),
    ).rejects.toThrow(/computed from/);
  });

  it("refuses the config treasury's token account when the request names no fee address", async () => {
    // A zero-fee request may leave `fee_address` out entirely, and the provider
    // reads the treasury from the CONFIG rather than from the request. Passing
    // it is how this side gets to know the same account.
    const [treasuryAta] = await findAssociatedTokenPda({
      owner: TEST_TREASURY,
      mint: address(USDC_SOLANA_DEVNET.mint as string),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const signer = makeSigner(makeAddress());

    await expect(
      buildPaymentInstructions(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: treasuryAta as string,
          fee_amount: 0,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
          asset: {
            chain: 'solana',
            token: 'usdc',
            mint: USDC_SOLANA_DEVNET.mint,
            decimals: USDC_SOLANA_DEVNET.decimals,
          },
        } as never,
        signer as never,
        { programId: TEST_PROGRAM_ID, treasury: TEST_TREASURY },
      ),
    ).rejects.toThrow(/computed from/);
  });

  it('creates no treasury token account on a ZERO-fee payment', async () => {
    // Every mainnet payment takes this branch (`feeBps` is 0 there), and the
    // idempotent create is not free: the customer pays the rent for an account
    // this transaction will never credit. Three instructions, not four.
    const signer = makeSigner(makeAddress());

    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        fee_address: TEST_TREASURY,
        fee_amount: 0,
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
        asset: {
          chain: 'solana',
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: USDC_SOLANA_DEVNET.decimals,
        },
      } as never,
      signer as never,
      { programId: TEST_PROGRAM_ID, treasury: TEST_TREASURY },
    );

    expect(instructions.length).toBe(3);
  });

  it('pays the fee leg to the fee address, in the fee amount', async () => {
    // Neither half was measured: a leg paying the RECIPIENT instead of the fee
    // address, and a leg carrying `providerAmount` instead of `feeAmount`, both
    // left the whole package green. The first sends the protocol's cut to the
    // provider, the second sends the customer's whole payment to the treasury.
    const recipient = makeAddress();
    const fee = calculateProtocolFee(100_000_000, TEST_FEE_BPS);
    const [recipientAta] = await findAssociatedTokenPda({
      owner: recipient,
      mint: address(USDC_SOLANA_DEVNET.mint as string),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [treasuryAta] = await findAssociatedTokenPda({
      owner: TEST_TREASURY,
      mint: address(USDC_SOLANA_DEVNET.mint as string),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const signer = makeSigner(makeAddress());

    const instructions = await buildPaymentInstructions(
      {
        recipient,
        amount: 100_000_000,
        reference: makeAddress(),
        fee_address: TEST_TREASURY,
        fee_amount: fee,
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
        asset: {
          chain: 'solana',
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: USDC_SOLANA_DEVNET.decimals,
        },
      } as never,
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );

    const transfers = instructions.filter(
      (
        instruction,
      ): instruction is {
        programAddress: string;
        data: Uint8Array;
        accounts: { address: string }[];
      } =>
        typeof instruction === 'object' &&
        instruction !== null &&
        (instruction as { programAddress?: string }).programAddress ===
          (TOKEN_PROGRAM_ADDRESS as string),
    );
    const paid = transfers.map((transfer) => ({
      // `TransferChecked` is `source, mint, destination, authority`, so the
      // destination is index 2 - the THIRD account, not the second.
      to: transfer.accounts[2]?.address,
      amount: getTransferCheckedInstructionDataDecoder().decode(transfer.data).amount,
    }));

    expect(paid).toEqual([
      { to: recipientAta as string, amount: BigInt(100_000_000 - fee) },
      { to: treasuryAta as string, amount: BigInt(fee) },
    ]);
  });

  it('pays the NATIVE legs to the recipient and the fee address, in the right amounts', async () => {
    // The mirror of the SPL row above, on the path a request with no `asset`
    // field takes - which is every SOL payment, the default asset. Measured:
    // a provider leg paying the FEE ADDRESS and a fee leg paying the RECIPIENT
    // both left the whole package green. The row that counts instructions does
    // not look at destinations, and `fee + providerAmount === totalAmount`
    // balances either way.
    const recipient = makeAddress();
    const fee = calculateProtocolFee(100_000_000, TEST_FEE_BPS);
    const signer = makeSigner(makeAddress());

    const instructions = await buildPaymentInstructions(
      {
        recipient,
        amount: 100_000_000,
        reference: makeAddress(),
        fee_address: TEST_TREASURY,
        fee_amount: fee,
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );

    const transfers = instructions.filter(
      (
        instruction,
      ): instruction is {
        programAddress: string;
        data: Uint8Array;
        accounts: { address: string }[];
      } =>
        typeof instruction === 'object' &&
        instruction !== null &&
        (instruction as { programAddress?: string }).programAddress ===
          '11111111111111111111111111111111',
    );
    const paid = transfers.map((transfer) => ({
      // `TransferSol` is `source, destination`, so the destination is index 1 -
      // a different shape from `TransferChecked` above, which is why this is
      // written out rather than copied.
      to: transfer.accounts[1]?.address,
      amount: getTransferSolInstructionDataDecoder().decode(transfer.data).amount,
    }));

    expect(paid).toEqual([
      { to: recipient as string, amount: BigInt(100_000_000 - fee) },
      { to: TEST_TREASURY as string, amount: BigInt(fee) },
    ]);
  });

  it('refuses a malformed fee address when the fee is POSITIVE', async () => {
    // The half the zero-fee row cannot reach, and it guards a hole this branch
    // could have opened rather than one it found: before the zero-fee
    // derivation went in, a malformed address threw out of `address()` and
    // nothing was signed. With the `isAddress(...) ? ... : undefined` form that
    // keeps a zero-fee request buildable, the same input would instead SKIP the
    // fee leg while `providerAmount` still subtracts the fee - a transaction
    // paying the recipient `amount - fee` and nobody the fee, which the
    // provider's own verifier then refuses. The whole job's money, for a job
    // that can never be accepted.
    const signer = makeSigner(makeAddress());

    await expect(
      buildPaymentInstructions(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: makeAddress(),
          fee_address: 'not-an-address',
          fee_amount: 5_000_000,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
          asset: {
            chain: 'solana',
            token: 'usdc',
            mint: USDC_SOLANA_DEVNET.mint,
            decimals: USDC_SOLANA_DEVNET.decimals,
          },
        } as never,
        signer as never,
        { programId: TEST_PROGRAM_ID },
      ),
    ).rejects.toThrow(/fee address/);
  });

  it('does not throw on a malformed fee address that a zero fee never spends', async () => {
    // Payable today: with `fee_amount: 0` no fee leg is built, so nothing in
    // this function used to look at the field at all. The degenerate check now
    // does, and it must not turn a payable request into a raw encoder error -
    // an owner it cannot parse simply contributes no account to compare.
    const signer = makeSigner(makeAddress());

    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        fee_address: 'not-an-address',
        fee_amount: 0,
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
        asset: {
          chain: 'solana',
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: USDC_SOLANA_DEVNET.decimals,
        },
      } as never,
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );

    // Payable means the RECIPIENT is paid IN FULL, and that is what gets
    // decoded: the first version of this row matched instructions by account
    // count, which is true of the ATA-create as well, so it asserted nothing
    // about the amount - measured, a mutant paying `amount - 1` on the zero-fee
    // branch (every mainnet payment) left the whole package green.
    const transfers = instructions.filter(
      (instruction): instruction is { programAddress: string; data: Uint8Array } =>
        typeof instruction === 'object' &&
        instruction !== null &&
        (instruction as { programAddress?: string }).programAddress ===
          (TOKEN_PROGRAM_ADDRESS as string),
    );
    expect(transfers.length).toBe(1);
    expect(getTransferCheckedInstructionDataDecoder().decode(transfers[0]?.data).amount).toBe(
      100_000_000n,
    );
  });

  it('does not throw on a malformed CONFIG treasury either', async () => {
    // The mirror of the row above, and the guard beside it used to be recorded
    // as unkillable on the grounds that the value comes off the chain. It does
    // on every first-party path - but this function is exported, and the
    // option's own docstring says a direct caller is on their own. Reached that
    // way, an unparseable treasury walked into `findAssociatedTokenPda` and
    // came back as a raw encoder error about base58 lengths instead of simply
    // contributing no account to the denylist.
    const signer = makeSigner(makeAddress());

    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        fee_address: makeAddress(),
        fee_amount: 0,
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
        asset: {
          chain: 'solana',
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: USDC_SOLANA_DEVNET.decimals,
        },
      } as never,
      signer as never,
      { programId: TEST_PROGRAM_ID, treasury: 'not-an-address' as Address },
    );

    // And the recipient is still paid in full, for the reason the row above
    // gives: an instruction count alone is true of the ATA-create too.
    const transfers = instructions.filter(
      (instruction): instruction is { programAddress: string; data: Uint8Array } =>
        typeof instruction === 'object' &&
        instruction !== null &&
        (instruction as { programAddress?: string }).programAddress ===
          (TOKEN_PROGRAM_ADDRESS as string),
    );
    expect(transfers.length).toBe(1);
    expect(getTransferCheckedInstructionDataDecoder().decode(transfers[0]?.data).amount).toBe(
      100_000_000n,
    );
  });

  it('fee + providerAmount === totalAmount for various amounts', async () => {
    interface TransferIxLike {
      data: Uint8Array;
    }
    const dataDecoder = getTransferSolInstructionDataDecoder();
    const decodeAmount = (ix: TransferIxLike): bigint => dataDecoder.decode(ix.data).amount;
    const signer = makeSigner(makeAddress());
    const amounts = [10, 33, 100, 333, 999, 1337, 50_000, 140_000_000, 1_000_000_000];
    for (const amount of amounts) {
      const fee = calculateProtocolFee(amount, TEST_FEE_BPS);
      const instructions = await buildPaymentInstructions(
        {
          recipient: makeAddress(),
          amount,
          reference: makeAddress(),
          fee_address: TEST_TREASURY,
          fee_amount: fee,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
        },
        signer as never,
        { programId: TEST_PROGRAM_ID },
      );
      const provider = decodeAmount(instructions[0] as TransferIxLike);
      const feeIx = instructions[1] as TransferIxLike | undefined;
      const feeLamports = feeIx ? decodeAmount(feeIx) : 0n;
      expect(Number(provider) + Number(feeLamports)).toBe(amount);
    }
  });

  it('attaches reference + protocol tag as read-only non-signer accounts on provider transfer', async () => {
    interface IxLike {
      accounts: ReadonlyArray<{ address: string; role: number }>;
    }
    const reference = makeAddress();
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference,
        fee_address: TEST_TREASURY,
        fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );
    const providerIx = instructions[0] as IxLike;
    const tail = providerIx.accounts.slice(-2);
    expect(tail[0]?.address).toBe(reference);
    expect(tail[0]?.role).toBe(0);
    expect(tail[1]?.address).toBe(ELISYM_PROTOCOL_TAG);
    expect(tail[1]?.role).toBe(0);
  });

  it('prepends an SPL Memo instruction when jobEventId is provided', async () => {
    interface IxLike {
      programAddress: string;
      data: Uint8Array;
    }
    const jobEventId = 'a'.repeat(64);
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
      { programId: TEST_PROGRAM_ID, jobEventId },
    );
    expect(instructions.length).toBe(3);
    const memoIx = instructions[0] as IxLike;
    // SPL Memo program ID
    expect(memoIx.programAddress).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const decoded = new TextDecoder().decode(memoIx.data);
    expect(decoded).toBe(`elisym:v1:${jobEventId}`);
  });

  it('omits the memo instruction when jobEventId is absent', async () => {
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );
    expect(instructions.length).toBe(2);
  });
});

describe('SolanaPaymentStrategy.buildTransaction', () => {
  function createMockRpc(): Rpc<SolanaRpcApi> {
    return {
      getLatestBlockhash: () => ({
        send: () =>
          Promise.resolve({
            value: {
              blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi' as Blockhash,
              lastValidBlockHeight: 1000n,
            },
          }),
      }),
      getTransaction: vi.fn(),
      getSignaturesForAddress: vi.fn(),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  function makeSigner(addressValue: Address): {
    address: Address;
    signMessage: () => never;
  } {
    return {
      address: addressValue,
      signMessage: () => {
        throw new Error('not implemented');
      },
    };
  }

  it('hands the config treasury to the instruction builder', async () => {
    // The wiring the whole client-side check rests on for every MCP payment:
    // without it a zero-fee request that names no `fee_address` - which is what
    // a third-party provider on mainnet issues - gets no treasury account to
    // compare against, and the customer pays for a job the provider's own
    // verifier will refuse. Measured: deleting the one argument leaves every
    // other test in this package green.
    const [treasuryAta] = await findAssociatedTokenPda({
      owner: TEST_TREASURY,
      mint: address(USDC_SOLANA_DEVNET.mint as string),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const signer = makeSigner(makeAddress());

    await expect(
      payment.buildTransaction(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: treasuryAta as string,
          fee_amount: 0,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
          asset: {
            chain: 'solana',
            token: 'usdc',
            mint: USDC_SOLANA_DEVNET.mint,
            decimals: USDC_SOLANA_DEVNET.decimals,
          },
        } as never,
        signer as never,
        createMockRpc(),
        { feeBps: 0, treasury: TEST_TREASURY },
        { programId: TEST_PROGRAM_ID, network: 'devnet' },
      ),
    ).rejects.toThrow(/computed from/);
  });

  it('throws on negative provider amount (fee > amount)', async () => {
    const signer = makeSigner(makeAddress());
    await expect(
      payment.buildTransaction(
        {
          recipient: makeAddress(),
          amount: 100,
          reference: makeAddress(),
          fee_address: TEST_TREASURY,
          fee_amount: 999,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
        },
        signer as never,
        createMockRpc(),
        CONFIG,
        { programId: TEST_PROGRAM_ID, network: 'devnet' },
      ),
    ).rejects.toThrow('non-positive provider amount');
  });

  it('throws on fee_address not matching configured treasury', async () => {
    const signer = makeSigner(makeAddress());
    await expect(
      payment.buildTransaction(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: makeAddress(),
          fee_address: makeAddress(),
          fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
        },
        signer as never,
        createMockRpc(),
        CONFIG,
        { programId: TEST_PROGRAM_ID, network: 'devnet' },
      ),
    ).rejects.toThrow('Invalid fee address');
  });

  it('throws on expired payment request', async () => {
    const signer = makeSigner(makeAddress());
    await expect(
      payment.buildTransaction(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: makeAddress(),
          fee_address: TEST_TREASURY,
          fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
          created_at: Math.floor(Date.now() / 1000) - 7200,
          expiry_secs: 3600,
        },
        signer as never,
        createMockRpc(),
        CONFIG,
        { programId: TEST_PROGRAM_ID, network: 'devnet' },
      ),
    ).rejects.toThrow('expired');
  });
});

describe('SolanaPaymentStrategy.validatePaymentRequest - expiry', () => {
  it('rejects expired payment request', () => {
    const expired = {
      recipient: makeAddress(),
      amount: 100_000_000,
      reference: makeAddress(),
      fee_address: TEST_TREASURY,
      fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
      created_at: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
      expiry_secs: 3600, // 1 hour expiry
    };
    const result = payment.validatePaymentRequest(JSON.stringify(expired), CONFIG, 'devnet');
    expect(result?.code).toBe('expired');
    expect(result?.message).toContain('expired');
  });
});

// --- verifyPayment tests ---

describe('SolanaPaymentStrategy.verifyPayment', () => {
  const recipientAddr = makeAddress();
  const referenceAddr = makeAddress();
  const amount = 100_000_000;
  const feeAmount = calculateProtocolFee(amount, TEST_FEE_BPS);
  const netAmount = amount - feeAmount;

  function makePR(overrides?: Record<string, unknown>) {
    return {
      recipient: recipientAddr,
      amount,
      reference: referenceAddr,
      fee_address: TEST_TREASURY,
      fee_amount: feeAmount,
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
      ...overrides,
    };
  }

  function makeTx(opts: {
    keys: (string | null)[];
    pre: number[];
    post: number[];
    err?: unknown;
    /** What a v0 transaction pulled in from an Address Lookup Table. */
    loaded?: { writable: string[]; readonly: string[] };
  }) {
    return {
      meta: {
        err: opts.err ?? null,
        preBalances: opts.pre.map((value) => BigInt(value)),
        postBalances: opts.post.map((value) => BigInt(value)),
        ...(opts.loaded ? { loadedAddresses: opts.loaded } : {}),
      },
      transaction: {
        message: {
          accountKeys: opts.keys,
        },
      },
    };
  }

  /**
   * An SPL transfer as `getTransaction(json)` reports it: the deltas live in
   * `pre/postTokenBalances` keyed by OWNER, not in the lamport arrays.
   */
  function makeTokenTx(opts: {
    keys: (string | null)[];
    mint: string;
    recipientBefore: number;
    recipientAfter: number;
    treasuryBefore: number;
    treasuryAfter: number;
    /** Drops this many entries off `postBalances`, which this path never reads. */
    dropPostLamports?: number;
    /**
     * Rows placed AHEAD of the real ones in `preTokenBalances`. A real
     * transaction carries the token accounts of everyone it touched, so the
     * baseline is found by owner AND mint; these are the rows a half of that
     * match would settle on instead.
     *
     * They take the LOW `accountIndex` values, and the real rows shift up by
     * however many there are: a node sorts these rows by that index, so a decoy
     * that has to be found first has to be numbered first. Only the ORDER is
     * node-shaped - the absolute numbers are not, and cannot be while the real
     * rows keep a fixed offset from each other. The code never reads the field
     * at all.
     */
    decoyPre?: { owner: string; mint: string; amount: number }[];
  }) {
    const entryIn = (owner: string, mint: string, index: number, raw: number) => ({
      accountIndex: index,
      mint,
      owner,
      uiTokenAmount: { amount: String(raw), decimals: 6, uiAmount: raw / 1e6 },
    });
    const entry = (owner: string, index: number, raw: number) =>
      entryIn(owner, opts.mint, index, raw);
    const decoyCount = (opts.decoyPre ?? []).length;
    const recipientIndex = decoyCount + 1;
    const treasuryIndex = decoyCount + 3;
    return {
      meta: {
        err: null,
        preBalances: opts.keys.map(() => 0n),
        postBalances: opts.keys
          .map(() => 0n)
          .slice(0, opts.keys.length - (opts.dropPostLamports ?? 0)),
        preTokenBalances: [
          ...(opts.decoyPre ?? []).map((decoy, offset) =>
            entryIn(decoy.owner, decoy.mint, offset, decoy.amount),
          ),
          entry(recipientAddr, recipientIndex, opts.recipientBefore),
          entry(TEST_TREASURY, treasuryIndex, opts.treasuryBefore),
        ],
        postTokenBalances: [
          entry(recipientAddr, recipientIndex, opts.recipientAfter),
          entry(TEST_TREASURY, treasuryIndex, opts.treasuryAfter),
        ],
      },
      transaction: { message: { accountKeys: opts.keys } },
    };
  }

  function createMockRpc(
    overrides: {
      getTransaction?: (...args: unknown[]) => unknown;
      getSignaturesForAddress?: (...args: unknown[]) => unknown;
    } = {},
  ): Rpc<SolanaRpcApi> {
    const wrap = <T>(value: T) => ({ send: () => Promise.resolve(value) });
    const getTransactionImpl = overrides.getTransaction ?? (() => wrap<unknown>(null));
    const getSignaturesForAddressImpl =
      overrides.getSignaturesForAddress ?? (() => wrap<unknown[]>([]));
    return {
      getLatestBlockhash: () =>
        wrap({
          value: { blockhash: 'mock' as Blockhash, lastValidBlockHeight: 1n },
        }),
      getTransaction: (...args: unknown[]) => getTransactionImpl(...args),
      getSignaturesForAddress: (...args: unknown[]) => getSignaturesForAddressImpl(...args),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  const FAST = { retries: 1, intervalMs: 10 };

  describe('by signature', () => {
    const payerAddr = makeAddress();

    it('verifies valid payment', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'validSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(true);
      expect(result.txSignature).toBe('validSig');
    });

    it('rejects transaction without reference key (replay attack)', async () => {
      const wrongRef = makeAddress();
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, wrongRef, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'replaySig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Reference key not found');
    });

    it('rejects failed transaction', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [0, 0, 0, 0],
                post: [0, 0, 0, 0],
                err: { InstructionError: [0, 'Custom'] },
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'failedSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('failed on-chain');
    });

    it('rejects insufficient recipient amount', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000, 1_000, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'lowSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Recipient received');
    });

    it('refuses when the TREASURY is in no half of the transaction', async () => {
      // Both fee-leg rows put the treasury in `keys` and only starve it, so
      // neither reaches the branch where it is ABSENT - and that branch decides
      // money: fall back to any other slot and a transfer paying the provider
      // everything and the protocol nothing verifies. Measured: the mutant
      // answers `verified: true`.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr],
                pre: [200_000_000, 0, 0],
                post: [200_000_000 - amount, amount, 0],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'treasuryAbsentSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Treasury not found/);
    });

    it('refuses when the RECIPIENT is in no half of the transaction', async () => {
      // The SPL twin of this sentence is pinned deliberately (a delta of -1
      // used to be read as "no account here"), and the native one was not. The
      // verdict is a refusal either way; what the guard buys is an operator who
      // is told the recipient is missing instead of being told they were
      // underpaid by the whole amount.
      const strangerAddr = makeAddress();
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, strangerAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'recipientAbsentSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Recipient not found/);
    });

    it('refuses a native transfer the recipient merely already HELD', async () => {
      // The row above starts the recipient at zero, as every other row here
      // does, so it measures only the POST half of the delta. Read the baseline
      // as zero instead of as what was there and a transaction that moved
      // nothing at all verifies: the balance was already on the account, and
      // any wallet holding more than the price can pay for a job with a
      // transaction that merely mentions the reference.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [0, netAmount, 0, 0],
                post: [0, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'nativePreHeldSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Recipient received 0, expected >=/);
    });

    it('refuses a native transfer whose fee the treasury merely already HELD', async () => {
      // The same hole on the fee leg: the provider is paid in full, so only the
      // treasury baseline can refuse it.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [0, 0, 0, feeAmount],
                post: [0, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'nativeTreasuryPreHeldSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Treasury received 0, expected >=/);
    });

    it('rejects insufficient fee', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, 1],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'lowFeeSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Treasury received');
    });

    it('verifies correctly with sparse account keys (null key in middle)', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, null, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0, 0],
                post: [200_000_000 - amount, 0, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'sparseSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(true);
    });

    it('refuses a reference spelled the way a NULL account key stringifies', async () => {
      // `verifyPayment` checks the reference for PRESENCE, never for format, so
      // the four letters `null` reach the key map unscreened - and a null
      // account key is a shape this file's threat model already carries: a real
      // node does not emit one, a proxy or shim between us and it can, which is
      // the same door `mergeAccountKeys` guards a string through. Drop the
      // truthiness guard in `checkTxDiff` and that key registers as 'null', the
      // presence check that is the whole anti-replay on this rail passes, and
      // this transaction - which carries no reference at all - settles the job.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, null, recipientAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, 0, netAmount, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR({ reference: 'null' }), CONFIG, {
        txSignature: 'nullRefSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Reference key not found/);
    });

    it('retries on pending transaction', async () => {
      let calls = 0;
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () => {
            calls++;
            if (calls < 3) return Promise.resolve(null);
            return Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            );
          },
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'pendingSig' as Signature,
        retries: 5,
        intervalMs: 10,
      });
      expect(result.verified).toBe(true);
      expect(calls).toBe(3);
    });
  });

  describe('address lookup tables', () => {
    const payerAddr = makeAddress();
    const usdcRequest = {
      asset: {
        chain: 'solana',
        token: 'usdc',
        mint: USDC_SOLANA_DEVNET.mint,
        decimals: USDC_SOLANA_DEVNET.decimals,
      },
    };

    /**
     * One page of balances per malformed half, shared by the row that feeds it
     * a malformed half and the control beside it.
     *
     * SHARED rather than copied. The control exists to catch a later edit that
     * quietly turns the page into a valid payment - which is exactly what the
     * first version of each of these rows was - and two hand-copied literals
     * drift apart in silence, leaving the control passing against the page it
     * no longer describes.
     *
     * Both pages UNDERPAY when their key list can be read: the recipient owns
     * a slot carrying `feeAmount` and nothing more. The malformed half is one
     * key short of the real one, so a build that trusts it reads the recipient
     * off the slot before theirs and the shortfall disappears.
     */
    const staticHalfPage = {
      loaded: { writable: [recipientAddr, TEST_TREASURY, referenceAddr], readonly: [] },
      pre: [0, 0, 0, 0, 0, 0],
      post: [0, 0, netAmount, feeAmount, 0, 0],
    };
    const loadedHalfReadonly = [recipientAddr, TEST_TREASURY, referenceAddr];
    const loadedHalfPage = {
      keys: [payerAddr],
      pre: [200_000_000, 0, 0, 0, 0, 0, 0],
      post: [200_000_000 - amount, 0, 0, netAmount, feeAmount, 0, 0],
    };

    it('verifies a v0 payment whose reference and treasury came from a table', async () => {
      // `encoding: 'json'` puts only the STATIC keys in `accountKeys` and the
      // looked-up ones in `meta.loadedAddresses`; the balance arrays cover both,
      // ordered static keys, then writable loaded, then read-only loaded.
      // Reading only the static half rejects a routing or swap-then-pay
      // composer's transaction as "possible replay" after the customer paid.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr],
                loaded: { writable: [TEST_TREASURY], readonly: [referenceAddr] },
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, feeAmount, 0],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'v0LookupSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(true);
    });

    it('refuses a reference equal to the recipient, before it fetches anything', async () => {
      // No RPC answer is configured on purpose: the refusal has to come before
      // either path runs. This one drives the SIGNATURE path, which does not
      // list anything - it fetches one transaction and checks the reference is
      // present, and a reference equal to the recipient makes that check a
      // tautology.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () => Promise.reject(new Error('the verifier must not get this far')),
        }),
      });

      const result = await payment.verifyPayment(
        rpc,
        makePR({ reference: recipientAddr }),
        CONFIG,
        { txSignature: 'degenerateSig' as Signature, ...FAST },
      );

      expect(result.verified).toBe(false);
      expect(result.code).toBe('degenerate_reference');
    });

    it('refuses it on the REFERENCE path too, without listing anything', async () => {
      // The half the row above cannot reach, and the more dangerous one: with
      // no `txSignature` the call lists the reference's history, and a
      // degenerate reference makes that a listing of a whole wallet rather than
      // of this payment. The check sits ahead of BOTH branches, and only a
      // fixture that takes this branch keeps it there - moving it inside the
      // signature branch leaves every other test in this file green.
      const listing = vi.fn(() => ({
        send: () => Promise.reject(new Error('the verifier must not list a degenerate reference')),
      }));
      const rpc = createMockRpc({
        getSignaturesForAddress: listing,
        getTransaction: () => ({
          send: () => Promise.reject(new Error('the verifier must not get this far')),
        }),
      });

      const result = await payment.verifyPayment(
        rpc,
        makePR({ reference: recipientAddr }),
        CONFIG,
        {
          ...FAST,
        },
      );

      expect(result.verified).toBe(false);
      expect(result.code).toBe('degenerate_reference');
      expect(listing).not.toHaveBeenCalled();
    });

    it("refuses a reference equal to the recipient's TOKEN account, which only the DERIVED half knows", async () => {
      // Both rows above use the recipient's own address - a STATIC denylist
      // entry, which the synchronous predicate carries too. Before this row,
      // swapping the full `degenerateReference` for `degenerateReferenceSync`
      // here left the whole package green: nothing measured the derived half on
      // this rail, though the builder's docstring rests on exactly that
      // difference. That swap now reddens this row and only this row.
      const [recipientAta] = await findAssociatedTokenPda({
        owner: recipientAddr,
        mint: address(USDC_SOLANA_DEVNET.mint as string),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () => Promise.reject(new Error('the verifier must not get this far')),
        }),
      });

      const result = await payment.verifyPayment(
        rpc,
        makePR({ ...usdcRequest, reference: recipientAta }),
        CONFIG,
        { txSignature: 'degenerateAtaSig' as Signature, ...FAST },
      );

      expect(result.verified).toBe(false);
      expect(result.code).toBe('degenerate_reference');
    });

    it('refuses a reference equal to the CONFIG treasury on a zero-fee request', async () => {
      // The treasury argument, unpinned on this rail. It cannot be seen at a
      // non-zero fee, because the fee block above forces `fee_address` to equal
      // the treasury and the request carries it - so the static half catches it
      // anyway. At feeBps 0, the config is the only place the treasury is
      // named, and that is the configuration mainnet runs.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () => Promise.reject(new Error('the verifier must not get this far')),
        }),
      });

      const result = await payment.verifyPayment(
        rpc,
        makePR({ reference: TEST_TREASURY, fee_address: undefined, fee_amount: 0 }),
        { feeBps: 0, treasury: TEST_TREASURY },
        { txSignature: 'treasuryRefSig' as Signature, ...FAST },
      );

      expect(result.verified).toBe(false);
      expect(result.code).toBe('degenerate_reference');
    });

    it('refuses rather than MISREADS when the loaded half is malformed', async () => {
      // `mergeAccountKeys` guards each half with `Array.isArray` and falls back
      // to the static keys alone. Inline the raw concatenation instead - which
      // is what any refactor folding the helper back in would write - and a
      // proxy answering with a STRING for one half spreads it character by
      // character.
      //
      // Seven balance slots against one static key and three read-only ones
      // means the real writable half is three keys, so the recipient owns slot
      // 4, where this transaction credited `feeAmount` and nothing else. The
      // two characters fill three slots' worth of room with two, so a build
      // that trusts them reads the recipient off slot 3 and the shortfall
      // disappears. The price is an ACCEPT, not a refusal: measured, the mutant
      // answers `verified: true` on a transaction that paid a fee.
      //
      // For the shift to cost money the recipient has to sit behind the
      // malformed half, which puts them in the READ-ONLY one - so this page
      // credits a read-only account, and a node would reject that transaction
      // rather than report it. Same threat model as the null-key row: the
      // liar here is a proxy or shim, not the node.
      //
      // The recipient must sit BEHIND the malformed half: a fixture that keeps
      // it among the static keys is green in both worlds.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                ...loadedHalfPage,
                loaded: {
                  writable: 'ab' as unknown as string[],
                  readonly: loadedHalfReadonly,
                },
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'badLoadedSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Reference key not found/);
    });

    it('reads that same page as an UNDERPAYMENT when the writable half is well formed', async () => {
      // The control for the row above, and it earns its place the same way the
      // static one does: what makes that mutant dangerous is that the page it
      // accepts is one the verifier REFUSES as soon as it can read the key
      // list. Three writable keys put the recipient on slot 4, where this
      // transaction credited `feeAmount` and stopped.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                ...loadedHalfPage,
                loaded: {
                  writable: [makeAddress(), makeAddress(), makeAddress()],
                  readonly: loadedHalfReadonly,
                },
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'wellFormedLoadedSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Recipient received/);
    });

    it('refuses when the STATIC half is malformed, which shifts the MOST', async () => {
      // The loaded half has its own row; the static one had none on the money
      // path, and by `mergeAccountKeys`'s own docstring it is the worse of the
      // two to skip - a string spread element-by-element lands INSIDE the
      // prefix every balance index is read against, so every looked-up address
      // slides onto somebody else's slot.
      //
      // The page UNDERPAYS, which is what makes the shift cost money rather
      // than merely look untidy: six balance slots against three looked-up
      // addresses means the real static half is three keys, so the recipient
      // owns slot 3 and was credited `feeAmount` there - a fee and nothing
      // else. The malformed half spreads into two slots instead of three, so
      // with the guard removed the recipient is read off slot 2, which belongs
      // to nobody in this layout, and the shortfall disappears. Measured: the
      // mutant answers `verified: true` on a transaction that never paid.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({ keys: 'ab' as unknown as (string | null)[], ...staticHalfPage }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'badStaticSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Reference key not found/);
    });

    it('reads that same page as an UNDERPAYMENT when the static half is well formed', async () => {
      // The control for the row above, and the reason it is a row rather than a
      // sentence: what makes that mutant dangerous is that the page it accepts
      // is one the verifier REFUSES when it can read the key list. Three static
      // keys put the recipient on slot 3, where this transaction credited
      // `feeAmount` and nothing more.
      //
      // Without this, a later edit could quietly reshape the fixture into a
      // page that is a valid payment - which is what the first version of it
      // was, and why its comment then described a shift that was not happening.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({ keys: [payerAddr, makeAddress(), makeAddress()], ...staticHalfPage }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'wellFormedStaticSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Recipient received/);
    });

    it('refuses when the balance arrays disagree on length', async () => {
      // A SHORT `pre` with the reference PAST the prefix. Without the guard the
      // map is built over `preBalances.length`, the reference at index 3 never
      // gets mapped, and the refusal reads "Reference key not found - possible
      // replay" - blaming the customer for a page we could not read. Move the
      // reference inside the prefix and the very same shape accepts instead;
      // that case is below.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, TEST_TREASURY, referenceAddr],
                pre: [200_000_000, 0, 0],
                post: [200_000_000 - amount, netAmount, feeAmount, 0],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'lenMismatchSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/disagree on length/);
    });

    it('refuses a short preBalances whose prefix still covers everything read', async () => {
      // The direction the other two fixtures miss. `pre` is short, but the
      // reference, the recipient and the treasury all sit inside the prefix, so
      // every slot the verifier reads pairs correctly and the missing tail is
      // never noticed: measured without the guard, this verifies as `true`.
      const junkAddr = makeAddress();
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, TEST_TREASURY, referenceAddr, junkAddr],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, feeAmount, 0, 0],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'shortPreCoveredSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/disagree on length/);
    });

    it('refuses a short postBalances, which without the guard is ACCEPTED', async () => {
      // The direction that costs money, measured: with the guard removed this
      // exact shape verifies as `true`. `postBalances` is short by one but
      // still covers the recipient and the treasury, so every index the
      // verifier actually reads is present and the missing slot is never
      // noticed - the payment is accepted on a page we could not read.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, TEST_TREASURY, referenceAddr],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'shortPostSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/disagree on length/);
    });

    it('still refuses a transaction the reference is in no half of', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr],
                loaded: { writable: [TEST_TREASURY], readonly: [makeAddress()] },
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, feeAmount, 0],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'wrongRefSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/replay/);
    });

    it('refuses an SPL transfer the reference is in no half of', async () => {
      // The reference check runs BEFORE the SPL dispatch, and the whole case for
      // the length guard being native-only rests on that order: on this path the
      // worst a truncated prefix can do is lose the reference and refuse. Move
      // the check below the dispatch and the suite stays green while any past
      // USDC transfer of the right size pays for a new job - measured.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, TEST_TREASURY],
                mint: USDC_SOLANA_DEVNET.mint as string,
                recipientBefore: 0,
                recipientAfter: netAmount,
                treasuryBefore: 0,
                treasuryAfter: feeAmount,
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'splNoReferenceSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/replay/);
    });

    it('does not let one token pay a request denominated in another', async () => {
      // The token deltas are matched by owner AND mint. Matched by owner alone,
      // an LSM transfer satisfies a USDC request - both are six decimals, so the
      // amounts line up exactly - and the provider is paid in the cheaper of the
      // two. Measured: the whole suite stays green with the mint dropped from
      // the match.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                mint: LSM_SOLANA_MAINNET.mint as string,
                recipientBefore: 0,
                recipientAfter: netAmount,
                treasuryBefore: 0,
                treasuryAfter: feeAmount,
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'wrongMintSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/token account not found/);
    });

    it('names the real problem when a token account is short by one subunit', async () => {
      // A delta of exactly -1 used to be the "no account here" sentinel, so the
      // operator was sent looking for an ATA that exists while the answer they
      // needed - the recipient was short-changed - never reached them.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                mint: USDC_SOLANA_DEVNET.mint as string,
                recipientBefore: 1,
                recipientAfter: 0,
                treasuryBefore: 0,
                treasuryAfter: feeAmount,
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'shortBySubunitSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Recipient received -1 tokens/);
      expect(result.error).not.toMatch(/not found/);
    });

    it('refuses a transaction with MORE account keys than balance slots', async () => {
      // The length guard above compares `pre` with `post`; these two AGREE, so
      // it says nothing. The third leg - keys against balances - is held by the
      // `Math.min` clamp alone, and before this row nothing measured it:
      // without the clamp the reference is "found" at an index the balance
      // arrays do not reach, both money slots read fine, and a transaction the
      // node described inconsistently verifies as a payment. Dropping the clamp
      // now reddens this row and only this row.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, TEST_TREASURY, referenceAddr],
                pre: [200_000_000, 0, 0],
                post: [200_000_000 - amount, netAmount, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'keysPastBalancesSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/possible replay/);
    });

    it('refuses an SPL transfer that is short of the net by one subunit', async () => {
      // The row above cannot measure the comparison itself: a delta of -1 is
      // below zero as well as below the net, so weakening the check to
      // `recipientDelta < 0n` keeps that row red for the wrong reason. This
      // delta is SHORT and POSITIVE, which is the shape an underpayment
      // actually has, and it is the only row in the package that separates the
      // two - measured: with the comparison weakened, everything else stayed
      // green.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                mint: USDC_SOLANA_DEVNET.mint as string,
                recipientBefore: 0,
                recipientAfter: netAmount - 1,
                treasuryBefore: 0,
                treasuryAfter: feeAmount,
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'splShortNetSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Recipient received \d+ tokens, expected >=/);
    });

    it('refuses an SPL transfer whose fee leg is short by one subunit', async () => {
      // The native twin of this check has a row of its own; the SPL one had
      // none, and the whole `expectedFee > 0` block could be deleted with the
      // package still green - measured. The provider is paid in full here, so
      // nothing but the treasury comparison can refuse it: this is the protocol
      // fee being skimmed by a customer who builds their own transaction.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                mint: USDC_SOLANA_DEVNET.mint as string,
                recipientBefore: 0,
                recipientAfter: netAmount,
                treasuryBefore: 0,
                treasuryAfter: feeAmount - 1,
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'splShortFeeSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Treasury received \d+ tokens, expected >=/);
    });

    it('refuses an SPL transfer with NO treasury token account at all', async () => {
      // `makeTokenTx` always emits a treasury row, so every SPL fixture starves
      // the treasury rather than removing it - and the removed case is the one
      // that decides money: fall back to the recipient's own delta and a
      // transfer that paid the protocol nothing verifies.
      const entry = (owner: string, raw: number) => ({
        accountIndex: 1,
        mint: USDC_SOLANA_DEVNET.mint as string,
        owner,
        uiTokenAmount: { amount: String(raw), decimals: 6, uiAmount: raw / 1e6 },
      });
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve({
              meta: {
                err: null,
                preBalances: [0n, 0n, 0n],
                postBalances: [0n, 0n, 0n],
                preTokenBalances: [entry(recipientAddr as string, 0)],
                postTokenBalances: [entry(recipientAddr as string, amount)],
              },
              transaction: {
                message: { accountKeys: [payerAddr, recipientAddr, referenceAddr] },
              },
            }),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'splTreasuryAbsentSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Treasury token account not found/);
    });

    it('refuses an SPL transfer the recipient merely already HELD', async () => {
      // Every other row in this file leaves the recipient at zero before the
      // transfer, so the whole PRE half of the delta went unmeasured: read the
      // baseline as zero and a transaction that moved NOTHING verifies as a
      // payment, because the money was already sitting there. The decoy rows
      // are what makes the match itself measurable - a stranger's account in
      // the same mint and the recipient's account in another one, both empty,
      // are exactly the rows half of `owner === ... && mint === ...` settles on.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                mint: USDC_SOLANA_DEVNET.mint as string,
                recipientBefore: netAmount,
                recipientAfter: netAmount,
                treasuryBefore: 0,
                treasuryAfter: feeAmount,
                decoyPre: [
                  { owner: makeAddress(), mint: USDC_SOLANA_DEVNET.mint as string, amount: 0 },
                  { owner: recipientAddr, mint: LSM_SOLANA_MAINNET.mint as string, amount: 0 },
                ],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'splPreHeldSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Recipient received 0 tokens, expected >=/);
    });

    it('refuses an SPL transfer whose fee the treasury merely already HELD', async () => {
      // The same hole on the fee leg. The provider is paid in full here, so
      // nothing but the treasury baseline can refuse it.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                mint: USDC_SOLANA_DEVNET.mint as string,
                recipientBefore: 0,
                recipientAfter: netAmount,
                treasuryBefore: feeAmount,
                treasuryAfter: feeAmount,
                decoyPre: [
                  { owner: makeAddress(), mint: USDC_SOLANA_DEVNET.mint as string, amount: 0 },
                  { owner: TEST_TREASURY, mint: LSM_SOLANA_MAINNET.mint as string, amount: 0 },
                ],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'splTreasuryPreHeldSig' as Signature,
        ...FAST,
      });

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Treasury received 0 tokens, expected >=/);
    });

    it('takes an SPL transfer whose LAMPORT arrays disagree, reading none of them', async () => {
      // The length guard is native-only, and this fixture is why. This path
      // pairs accounts by owner and mint out of `pre/postTokenBalances`; it
      // opens no lamport slot, so a disagreement there cannot make it read a
      // wrong slot as a payment. Gating it here would refuse a USDC transfer
      // the token balances prove, over arrays the path never touches - the
      // customer pays and is never delivered to.
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                mint: USDC_SOLANA_DEVNET.mint as string,
                recipientBefore: 0,
                recipientAfter: netAmount,
                treasuryBefore: 0,
                treasuryAfter: feeAmount,
                dropPostLamports: 1,
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'splShortPostSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(true);
    });

    it('still says so when the recipient really has no token account', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve({
              meta: {
                err: null,
                preBalances: [0n, 0n, 0n, 0n],
                postBalances: [0n, 0n, 0n, 0n],
                preTokenBalances: [],
                postTokenBalances: [],
              },
              transaction: {
                message: {
                  accountKeys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                },
              },
            }),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(usdcRequest), CONFIG, {
        txSignature: 'noAtaSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/Recipient token account not found/);
    });
  });

  describe('by reference', () => {
    const payerAddr = makeAddress();

    it('verifies valid payment by reference', async () => {
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () => Promise.resolve([{ signature: 'refSig1' as Signature, err: null }]),
        }),
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(true);
      expect(result.txSignature).toBe('refSig1');
    });

    it('returns error when no matching signatures found', async () => {
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({ send: () => Promise.resolve([]) }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('No matching transaction found');
    });

    it('skips errored signatures without fetching them', async () => {
      // The verdict is NOT what this measures, and the old version of this row
      // pretended otherwise: it answered `null` from `getTransaction`, so the
      // entry was dropped by the missing-meta guard and the filter the row is
      // named after never ran. Drop the filter and the verdict is still the
      // same - a failed transaction carries `meta.err` and is refused one line
      // later. What the filter actually buys is the round trip, so that is what
      // is asserted: an errored signature is never fetched at all.
      const fetched = vi.fn(() => ({
        send: () =>
          Promise.resolve(
            makeTx({
              keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
              pre: [200_000_000, 0, 0, 0],
              post: [200_000_000 - amount, netAmount, 0, feeAmount],
              err: { InstructionError: 'x' },
            }),
          ),
      }));
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () =>
            Promise.resolve([
              {
                signature: 'failSig' as Signature,
                err: { InstructionError: 'x' },
              },
            ]),
        }),
        getTransaction: fetched,
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(false);
      expect(fetched).not.toHaveBeenCalled();
    });

    it('refuses a transaction found under the reference that UNDERPAYS', async () => {
      // The signature path measures this gate with fourteen rows; this path -
      // the one a provider runs by default, with no `txSignature` in hand -
      // measured it with none, so `if (verdict.ok)` could be deleted outright
      // and every transaction carrying the reference would settle the job.
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () => Promise.resolve([{ signature: 'refShortSig' as Signature, err: null }]),
        }),
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount - 1, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('No matching transaction found');
    });

    it('refuses one found under the reference that pays the TREASURY nothing', async () => {
      // The rail a provider runs by default, and its fee leg was a vacuum: the
      // fee amount could be passed as 0 and the treasury as the recipient, both
      // with the package green. `runtime.ts` takes this path on its own before
      // the signature one, so under either mutant the provider delivers work
      // for a transaction that paid the protocol nothing.
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () => Promise.resolve([{ signature: 'refNoFeeSig' as Signature, err: null }]),
        }),
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - netAmount, netAmount, 0, 0],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('No matching transaction found');
    });

    it('refuses one where the fee went to the RECIPIENT instead of the treasury', async () => {
      // The other half: the customer paid the full amount, all of it to the
      // provider. Reading the fee leg against the recipient's own slot makes
      // that pass, because the recipient received more than the fee.
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () =>
            Promise.resolve([{ signature: 'refFeeToProviderSig' as Signature, err: null }]),
        }),
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, amount, 0, 0],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(false);
    });

    it('verifies an SPL payment on the reference rail too', async () => {
      // The only row that holds the mint on this rail. Dropped, an SPL request
      // is verified as if it were native - the lamport arrays are all zeroes
      // here, so it refuses rather than misreads, but nothing said so.
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () => Promise.resolve([{ signature: 'refSplSig' as Signature, err: null }]),
        }),
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTokenTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                mint: USDC_SOLANA_DEVNET.mint as string,
                recipientBefore: 0,
                recipientAfter: netAmount,
                treasuryBefore: 0,
                treasuryAfter: feeAmount,
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(
        rpc,
        makePR({
          asset: {
            chain: 'solana',
            token: 'usdc',
            mint: USDC_SOLANA_DEVNET.mint,
            decimals: USDC_SOLANA_DEVNET.decimals,
          },
        }),
        CONFIG,
        FAST,
      );
      expect(result.verified).toBe(true);
    });

    it('refuses a FAILED transaction found under the reference', async () => {
      // The listing's own `err` field is not the only place a failure shows up:
      // a node that reports a signature as fine and the transaction as failed
      // gets past the filter, and this is the guard that catches it. Its twin
      // on the signature path has a row; this one had none, and a failed
      // transfer moves no money at all.
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () => Promise.resolve([{ signature: 'refFailedSig' as Signature, err: null }]),
        }),
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
                err: { InstructionError: 'x' },
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('No matching transaction found');
    });
  });

  describe('input validation', () => {
    // Every row here passes `FAST` even where the refusal is meant to come
    // before any RPC call: a guard that stops guarding falls through to the
    // reference path, and on the default budget the assertion arrives some
    // half a minute later, past the test timeout, as a hang rather than as the
    // sentence that says what broke. (The two default budgets are tuning, not
    // guards - `VERIFY_BY_REF_*` and `VERIFY_*` both come to about 30 seconds
    // and swapping them changes nothing measurable.)
    it('rejects invalid rpc', async () => {
      const result = await payment.verifyPayment(
        null as unknown as Rpc<SolanaRpcApi>,
        makePR(),
        CONFIG,
        FAST,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid rpc');
    });

    it('rejects zero amount', async () => {
      const result = await payment.verifyPayment(
        createMockRpc(),
        makePR({ amount: 0 }),
        CONFIG,
        FAST,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid payment amount');
    });

    it('rejects negative amount', async () => {
      const result = await payment.verifyPayment(
        createMockRpc(),
        makePR({ amount: -1 }),
        CONFIG,
        FAST,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid payment amount');
    });

    it('rejects fee below required', async () => {
      const result = await payment.verifyPayment(
        createMockRpc(),
        makePR({ fee_amount: 1 }),
        CONFIG,
        FAST,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Protocol fee');
    });

    it('rejects wrong fee address', async () => {
      const result = await payment.verifyPayment(
        createMockRpc(),
        makePR({ fee_address: makeAddress() }),
        CONFIG,
        FAST,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid fee address');
    });

    it('rejects fee exceeding amount', async () => {
      const result = await payment.verifyPayment(
        createMockRpc(),
        makePR({ fee_amount: amount + 1 }),
        CONFIG,
        FAST,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('exceeds or equals');
    });
  });
});

describe('USDC (SPL) payment flow', () => {
  it('parsePaymentRequest accepts an asset field', () => {
    const req = {
      recipient: validAddress,
      amount: 50_000_000,
      reference: makeAddress(),
      fee_address: TEST_TREASURY,
      fee_amount: calculateProtocolFee(50_000_000, TEST_FEE_BPS),
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
      asset: {
        chain: 'solana',
        token: 'usdc',
        mint: USDC_SOLANA_DEVNET.mint,
        decimals: 6,
      },
    };
    const result = parsePaymentRequest(JSON.stringify(req));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.asset?.token).toBe('usdc');
    }
  });

  it('parsePaymentRequest without asset stays backwards-compatible (defaults to SOL)', () => {
    const req = {
      recipient: validAddress,
      amount: 100_000_000,
      reference: makeAddress(),
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
    };
    const result = parsePaymentRequest(JSON.stringify(req));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.asset).toBeUndefined();
    }
  });

  it('validatePaymentRequest rejects unknown asset with invalid_asset code', () => {
    const req = {
      recipient: validAddress,
      amount: 50_000_000,
      reference: makeAddress(),
      fee_address: TEST_TREASURY,
      fee_amount: calculateProtocolFee(50_000_000, TEST_FEE_BPS),
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
      asset: {
        chain: 'solana',
        token: 'doge',
        mint: makeAddress(),
        decimals: 8,
      },
    };
    const err = payment.validatePaymentRequest(JSON.stringify(req), CONFIG, 'devnet', validAddress);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('invalid_asset');
  });

  it('createPaymentRequest embeds asset when provided', () => {
    const req = payment.createPaymentRequest(validAddress, 50_000_000, CONFIG, 'devnet', {
      asset: USDC_SOLANA_DEVNET,
    });
    expect(req.asset?.token).toBe('usdc');
    expect(req.asset?.mint).toBe(USDC_SOLANA_DEVNET.mint);
    expect(req.asset?.decimals).toBe(6);
  });

  it('createPaymentRequest omits asset when native SOL is selected', () => {
    const req = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG, 'devnet');
    expect(req.asset).toBeUndefined();
  });

  it('buildPaymentInstructions emits ATA create + TransferChecked for SPL', async () => {
    const signer = {
      address: makeAddress(),
    };
    const recipient = makeAddress();
    const reference = makeAddress();
    const instructions = await buildPaymentInstructions(
      {
        recipient,
        amount: 50_000_000,
        reference,
        fee_address: TEST_TREASURY,
        fee_amount: calculateProtocolFee(50_000_000, TEST_FEE_BPS),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
        asset: {
          chain: 'solana',
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: 6,
        },
      },
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );
    // Expect: 2x ATA create (recipient + treasury) + 2x TransferChecked (provider + fee) + increment_stats
    expect(instructions.length).toBe(5);

    interface IxLike {
      accounts: ReadonlyArray<{ address: string; role: number }>;
    }
    // TransferChecked with reference + protocol tag is ix[2] (after the two ATA creates).
    const providerIx = instructions[2] as IxLike;
    const tail = providerIx.accounts.slice(-2);
    expect(tail[0]?.address).toBe(reference);
    expect(tail[0]?.role).toBe(0);
    expect(tail[1]?.address).toBe(ELISYM_PROTOCOL_TAG);
    expect(tail[1]?.role).toBe(0);
  });

  it('buildPaymentInstructions targets Token-2022 for LSM (mainnet)', async () => {
    const signer = {
      address: makeAddress(),
    };
    const recipient = makeAddress();
    const reference = makeAddress();
    const lsmMint = LSM_SOLANA_MAINNET.mint;
    if (!lsmMint) {
      throw new Error('LSM_SOLANA_MAINNET must declare a mint');
    }
    const instructions = await buildPaymentInstructions(
      {
        recipient,
        amount: 5_000_000,
        reference,
        fee_address: TEST_TREASURY,
        fee_amount: calculateProtocolFee(5_000_000, TEST_FEE_BPS),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
        asset: {
          chain: 'solana',
          token: 'lsm',
          mint: lsmMint,
          decimals: 6,
        },
        network: 'mainnet',
      },
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );
    expect(instructions.length).toBe(5);

    interface IxLike {
      programAddress: string;
      accounts: ReadonlyArray<{ address: string; role: number }>;
    }
    const [createRecipientAta, createTreasuryAta, providerTransfer, feeTransfer, statsIx] =
      instructions as IxLike[];
    // ATA creates run under the ATA program but must reference the Token-2022
    // program account, and both transfers must target Token-2022 directly.
    const referencesT22 = (ix: IxLike | undefined): boolean =>
      Boolean(ix?.accounts.some((meta) => meta.address === TOKEN_2022_PROGRAM_ADDRESS_STR));
    expect(referencesT22(createRecipientAta)).toBe(true);
    expect(referencesT22(createTreasuryAta)).toBe(true);
    expect(providerTransfer?.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS_STR);
    expect(feeTransfer?.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS_STR);
    // Stats leg is increment_stats_v2 carrying the LSM AssetStats PDA and the
    // payer as a writable signer (it funds init_if_needed rent).
    const assetStatsPda = await deriveAssetStatsAddress(TEST_PROGRAM_ID, address(lsmMint));
    expect(statsIx?.accounts.some((meta) => meta.address === assetStatsPda)).toBe(true);
    expect(statsIx?.accounts.some((meta) => meta.address === signer.address)).toBe(true);
  });

  it('native SOL stats leg carries the sentinel AssetStats PDA', async () => {
    const signer = {
      address: makeAddress(),
    };
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 1_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
      { programId: TEST_PROGRAM_ID },
    );
    interface IxLike {
      accounts: ReadonlyArray<{ address: string; role: number }>;
    }
    const statsIx = instructions.at(-1) as IxLike;
    const sentinelPda = await deriveAssetStatsAddress(TEST_PROGRAM_ID, NATIVE_ASSET_SENTINEL);
    expect(statsIx.accounts.some((meta) => meta.address === sentinelPda)).toBe(true);
  });
});

// --- payment request network (D7) ---

describe('payment request network (D7)', () => {
  function baseRequest(overrides: Record<string, unknown> = {}) {
    const recipientAddr = makeAddress();
    return {
      recipient: recipientAddr,
      amount: 140_000_000,
      reference: makeAddress(),
      fee_address: TEST_TREASURY,
      fee_amount: calculateProtocolFee(140_000_000, TEST_FEE_BPS),
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 3600,
      ...overrides,
    };
  }

  it('createPaymentRequest always stores the network (write-side required)', () => {
    const devnetRequest = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG, 'devnet');
    expect(devnetRequest.network).toBe('devnet');
    const mainnetRequest = payment.createPaymentRequest(
      validAddress,
      100_000_000,
      CONFIG,
      'mainnet',
    );
    expect(mainnetRequest.network).toBe('mainnet');
  });

  it('rejects a mainnet request for a devnet customer', () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(baseRequest({ network: 'mainnet' })),
      CONFIG,
      'devnet',
    );
    expect(result?.code).toBe('network_mismatch');
    expect(result?.message).toContain('mainnet');
  });

  it('rejects a devnet request for a mainnet customer', () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(baseRequest({ network: 'devnet' })),
      CONFIG,
      'mainnet',
    );
    expect(result?.code).toBe('network_mismatch');
  });

  it('treats a missing network as devnet (legacy providers)', () => {
    const legacy = baseRequest();
    expect(payment.validatePaymentRequest(JSON.stringify(legacy), CONFIG, 'devnet')).toBeNull();
    const rejected = payment.validatePaymentRequest(JSON.stringify(legacy), CONFIG, 'mainnet');
    expect(rejected?.code).toBe('network_mismatch');
  });

  it('accepts a matching mainnet request end-to-end', () => {
    const request = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG, 'mainnet');
    expect(
      payment.validatePaymentRequest(JSON.stringify(request), CONFIG, 'mainnet', validAddress),
    ).toBeNull();
  });

  function assetRef(asset: { chain: string; token: string; mint?: string; decimals: number }) {
    return {
      chain: asset.chain,
      token: asset.token,
      ...(asset.mint ? { mint: asset.mint } : {}),
      decimals: asset.decimals,
    };
  }

  it('rejects a mainnet-only asset quoted to a devnet customer', () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(baseRequest({ network: 'devnet', asset: assetRef(LSM_SOLANA_MAINNET) })),
      CONFIG,
      'devnet',
    );
    expect(result?.code).toBe('invalid_asset');
    expect(result?.message).toContain('not available on devnet');
  });

  it("rejects the other cluster's USDC even when the request network matches", () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(baseRequest({ network: 'mainnet', asset: assetRef(USDC_SOLANA_DEVNET) })),
      CONFIG,
      'mainnet',
    );
    expect(result?.code).toBe('invalid_asset');
  });

  it('refuses a currency swap between two assets that are both legal on the network', () => {
    // USDC and LSM are both mainnet and both 6 decimals, so the membership
    // gate cannot separate them - only the expected-asset binding can.
    const result = payment.validatePaymentRequest(
      JSON.stringify(baseRequest({ network: 'mainnet', asset: assetRef(LSM_SOLANA_MAINNET) })),
      CONFIG,
      'mainnet',
      undefined,
      { expectedAsset: USDC_SOLANA_MAINNET },
    );
    expect(result?.code).toBe('asset_mismatch');
    expect(result?.message).toContain('USDC');
    expect(result?.message).toContain('LSM');
  });

  it('refuses a native-SOL request when the caller expected an SPL asset', () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(baseRequest({ network: 'mainnet' })),
      CONFIG,
      'mainnet',
      undefined,
      { expectedAsset: USDC_SOLANA_MAINNET },
    );
    expect(result?.code).toBe('asset_mismatch');
  });

  it('accepts the expected asset', () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(baseRequest({ network: 'mainnet', asset: assetRef(LSM_SOLANA_MAINNET) })),
      CONFIG,
      'mainnet',
      undefined,
      { expectedAsset: LSM_SOLANA_MAINNET },
    );
    expect(result).toBeNull();
  });

  it('checks the network BEFORE any money check (tampered fee still reports network_mismatch)', () => {
    const tampered = baseRequest({
      network: 'mainnet',
      fee_amount: 1,
      fee_address: makeAddress(),
    });
    const result = payment.validatePaymentRequest(JSON.stringify(tampered), CONFIG, 'devnet');
    expect(result?.code).toBe('network_mismatch');
  });

  it('parse side keeps the wire round-trip: schema accepts and preserves network', () => {
    const request = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG, 'mainnet');
    const parsed = parsePaymentRequest(JSON.stringify(request));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.network).toBe('mainnet');
    }
  });

  it('schema rejects an unknown network value', () => {
    const parsed = parsePaymentRequest(JSON.stringify(baseRequest({ network: 'testnet' })));
    expect(parsed.ok).toBe(false);
  });
});

// --- zero-fee round-trip on the mainnet path (launch invariant) ---

describe('zero-fee mainnet round-trip', () => {
  const ZERO_FEE_CONFIG: ProtocolConfigInput = {
    feeBps: 0,
    treasury: TEST_TREASURY,
  };

  it('feeBps=0 produces fee_amount 0 and validates on mainnet', () => {
    const request = payment.createPaymentRequest(
      validAddress,
      100_000_000,
      ZERO_FEE_CONFIG,
      'mainnet',
    );
    expect(request.fee_amount).toBe(0);
    expect(request.fee_address).toBe(TEST_TREASURY);
    expect(request.network).toBe('mainnet');
    expect(
      payment.validatePaymentRequest(
        JSON.stringify(request),
        ZERO_FEE_CONFIG,
        'mainnet',
        validAddress,
      ),
    ).toBeNull();
  });

  it('rejects fee_amount > 0 under a zero fee rate on mainnet (fund diversion guard)', () => {
    const request = payment.createPaymentRequest(
      validAddress,
      100_000_000,
      ZERO_FEE_CONFIG,
      'mainnet',
    );
    const tampered = { ...request, fee_amount: 1_000_000 };
    const result = payment.validatePaymentRequest(
      JSON.stringify(tampered),
      ZERO_FEE_CONFIG,
      'mainnet',
      validAddress,
    );
    expect(result?.code).toBe('fee_amount_mismatch');
  });

  it('zero-fee mainnet instructions carry no fee leg (transfer + increment_stats only)', async () => {
    const request = payment.createPaymentRequest(
      validAddress,
      100_000_000,
      ZERO_FEE_CONFIG,
      'mainnet',
    );
    const signer = { address: makeAddress() };
    const instructions = await buildPaymentInstructions(request, signer as never, {
      programId: getProtocolProgramId('mainnet'),
    });
    expect(instructions.length).toBe(2);
  });
});
