import { parseCaip19, verifyPaytoProof } from '@elisym/commerce';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkPastedProof,
  familyOf,
  ProofError,
  proofMessage,
  signPayoutProof,
  watchWallets,
  type ProofErrorCode,
  type WalletChoice,
} from '../../../src/hosted/lib/wallets';
import {
  announceEvmWallet,
  BASE_USDC,
  evmKey,
  fakeEvmProvider,
  fakeSolanaWallet,
  type FakeStandardWallet,
  injectStandardWallet,
  OWNER,
  personalSign,
  signEd25519,
  SOLANA_USDC_DEVNET,
  solanaKey,
  TEMPO_USDCE,
  userRejected,
  utf8Hex,
} from './fakes';

const cleanups: (() => void)[] = [];
let uuidCounter = 0;

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function chooseSolana(wallet: FakeStandardWallet): WalletChoice {
  cleanups.push(injectStandardWallet(window, wallet));
  let found: WalletChoice[] = [];
  watchWallets('solana', (wallets) => {
    found = wallets;
  })();
  const choice = found.find((candidate) => candidate.name === wallet.name);
  if (choice === undefined) {
    throw new Error('the fake wallet was not offered');
  }
  return choice;
}

function chooseEvm(provider: unknown): WalletChoice {
  uuidCounter += 1;
  const uuid = `wallet-${uuidCounter}`;
  cleanups.push(announceEvmWallet(window, { uuid, name: uuid }, provider));
  let found: WalletChoice[] = [];
  watchWallets('evm', (wallets) => {
    found = wallets;
  })();
  const choice = found.find((candidate) => candidate.id === `evm:${uuid}`);
  if (choice === undefined) {
    throw new Error('the fake provider was not offered');
  }
  return choice;
}

async function proofError(promise: Promise<unknown>): Promise<ProofErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProofError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a ProofError');
}

function chainOf(caip19: string) {
  const coin = parseCaip19(caip19);
  if (coin === undefined) {
    throw new Error(`unknown coin ${caip19}`);
  }
  return coin.chain;
}

describe('familyOf / proofMessage', () => {
  it('maps the solana namespace to solana and eip155 (EVM and Tempo) to evm', () => {
    expect(familyOf(SOLANA_USDC_DEVNET)).toBe('solana');
    expect(familyOf(BASE_USDC)).toBe('evm');
    expect(familyOf(TEMPO_USDCE)).toBe('evm');
    expect(familyOf('solana:unknown/token:abc')).toBeUndefined();
    expect(familyOf('bip122:000000000019d6689c085ae165831e93/slip44:0')).toBeUndefined();
    expect(familyOf('')).toBeUndefined();
  });

  it('is the exact commerce proof text', () => {
    expect(proofMessage(OWNER, BASE_USDC)).toBe(`elisym-payto:v1:${OWNER}:${BASE_USDC}`);
  });
});

describe('signPayoutProof - Solana', () => {
  it('signs the UTF-8 message and returns the base58 signature the verifier accepts', async () => {
    const key = solanaKey();
    const wallet = fakeSolanaWallet({ name: 'sol-happy', accounts: [key] });
    const proof = await signPayoutProof({
      wallet: chooseSolana(wallet),
      ownerPubkey: OWNER,
      caip19: SOLANA_USDC_DEVNET,
    });
    expect(proof.address).toBe(key.address);
    expect(wallet.signedTexts).toEqual([proofMessage(OWNER, SOLANA_USDC_DEVNET)]);
    expect(getBase58Encoder().encode(proof.signature)).toEqual(
      signEd25519(key.secretKey, proofMessage(OWNER, SOLANA_USDC_DEVNET)),
    );
    expect(
      verifyPaytoProof({
        chain: chainOf(SOLANA_USDC_DEVNET),
        address: proof.address,
        ownerPubkey: OWNER,
        caip19: SOLANA_USDC_DEVNET,
        signature: proof.signature,
      }),
    ).toBe(true);
  });

  it('picks the account matching expectedAddress among several', async () => {
    const first = solanaKey();
    const second = solanaKey();
    const wallet = fakeSolanaWallet({ name: 'sol-many', accounts: [first, second] });
    const proof = await signPayoutProof({
      wallet: chooseSolana(wallet),
      ownerPubkey: OWNER,
      caip19: SOLANA_USDC_DEVNET,
      expectedAddress: second.address,
    });
    expect(proof.address).toBe(second.address);
    expect(wallet.signedFor).toEqual([second.address]);
  });

  it('refuses an account that differs, even only in case, before signing', async () => {
    const key = solanaKey();
    const wallet = fakeSolanaWallet({ name: 'sol-wrong', accounts: [key] });
    const choice = chooseSolana(wallet);
    const flipped = key.address.replace(/[a-z]/, (letter) => letter.toUpperCase());
    expect(flipped).not.toBe(key.address);
    expect(
      await proofError(
        signPayoutProof({
          wallet: choice,
          ownerPubkey: OWNER,
          caip19: SOLANA_USDC_DEVNET,
          expectedAddress: flipped,
        }),
      ),
    ).toBe('wrong_address');
    expect(
      await proofError(
        signPayoutProof({
          wallet: choice,
          ownerPubkey: OWNER,
          caip19: SOLANA_USDC_DEVNET,
          expectedAddress: solanaKey().address,
        }),
      ),
    ).toBe('wrong_address');
    expect(wallet.signedTexts).toEqual([]);
  });

  it('a refused connect or signature is rejected', async () => {
    const refusesConnect = fakeSolanaWallet({
      name: 'sol-no-connect',
      connect: () => Promise.reject(new Error('User rejected')),
    });
    expect(
      await proofError(
        signPayoutProof({
          wallet: chooseSolana(refusesConnect),
          ownerPubkey: OWNER,
          caip19: SOLANA_USDC_DEVNET,
        }),
      ),
    ).toBe('rejected');
    const refusesSign = fakeSolanaWallet({
      name: 'sol-no-sign',
      sign: () => Promise.reject(new Error('User rejected')),
    });
    expect(
      await proofError(
        signPayoutProof({
          wallet: chooseSolana(refusesSign),
          ownerPubkey: OWNER,
          caip19: SOLANA_USDC_DEVNET,
        }),
      ),
    ).toBe('rejected');
  });

  it('no account is no_account', async () => {
    for (const [name, accounts] of [
      ['sol-empty', []],
      ['sol-junk', [{ nope: 1 }, null]],
      ['sol-not-array', 'x'],
    ] as const) {
      const wallet = fakeSolanaWallet({
        name,
        connect: () => Promise.resolve({ accounts }),
      });
      expect(
        await proofError(
          signPayoutProof({
            wallet: chooseSolana(wallet),
            ownerPubkey: OWNER,
            caip19: SOLANA_USDC_DEVNET,
          }),
        ),
      ).toBe('no_account');
    }
  });

  it('a signature that does not check out is bad_signature', async () => {
    const key = solanaKey();
    const answers: [string, (input: { message: Uint8Array }) => Promise<unknown>][] = [
      [
        'sol-other-text',
        () => Promise.resolve([{ signature: signEd25519(key.secretKey, 'something else') }]),
      ],
      [
        'sol-other-key',
        (input) =>
          Promise.resolve([
            {
              signature: signEd25519(
                solanaKey().secretKey,
                new TextDecoder().decode(input.message),
              ),
            },
          ]),
      ],
      ['sol-short', () => Promise.resolve([{ signature: new Uint8Array(63) }])],
      ['sol-long', () => Promise.resolve([{ signature: new Uint8Array(65) }])],
      ['sol-not-bytes', () => Promise.resolve([{ signature: 'abc' }])],
      ['sol-nothing', () => Promise.resolve([])],
      ['sol-not-array', () => Promise.resolve({ signature: new Uint8Array(64) })],
    ];
    for (const [name, sign] of answers) {
      const wallet = fakeSolanaWallet({ name, accounts: [key], sign });
      expect(
        await proofError(
          signPayoutProof({
            wallet: chooseSolana(wallet),
            ownerPubkey: OWNER,
            caip19: SOLANA_USDC_DEVNET,
          }),
        ),
        name,
      ).toBe('bad_signature');
    }
  });
});

describe('signPayoutProof - EVM', () => {
  it('signs with personal_sign and returns a checksummed account lowercase', async () => {
    const key = evmKey();
    expect(key.checksummed).not.toBe(key.lower);
    const provider = fakeEvmProvider({
      accounts: [{ address: key.checksummed, secretKey: key.secretKey }],
    });
    const proof = await signPayoutProof({
      wallet: chooseEvm(provider),
      ownerPubkey: OWNER,
      caip19: BASE_USDC,
    });
    expect(proof.address).toBe(key.lower);
    expect(proof.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(provider.calls).toEqual([
      { method: 'eth_requestAccounts' },
      {
        method: 'personal_sign',
        params: [utf8Hex(proofMessage(OWNER, BASE_USDC)), key.checksummed],
      },
    ]);
    expect(
      verifyPaytoProof({
        chain: chainOf(BASE_USDC),
        address: proof.address,
        ownerPubkey: OWNER,
        caip19: BASE_USDC,
        signature: proof.signature,
      }),
    ).toBe(true);
  });

  it('Tempo coins sign on the EVM path', async () => {
    const key = evmKey();
    const provider = fakeEvmProvider({
      accounts: [{ address: key.checksummed, secretKey: key.secretKey }],
    });
    const proof = await signPayoutProof({
      wallet: chooseEvm(provider),
      ownerPubkey: OWNER,
      caip19: TEMPO_USDCE,
      expectedAddress: key.lower,
    });
    expect(proof.address).toBe(key.lower);
    expect(provider.calls[1]).toEqual({
      method: 'personal_sign',
      params: [utf8Hex(proofMessage(OWNER, TEMPO_USDCE)), key.checksummed],
    });
  });

  it('matches expectedAddress case-insensitively and picks it among several', async () => {
    const first = evmKey();
    const second = evmKey();
    const provider = fakeEvmProvider({
      accounts: [
        { address: first.checksummed, secretKey: first.secretKey },
        { address: second.lower, secretKey: second.secretKey },
      ],
    });
    const proof = await signPayoutProof({
      wallet: chooseEvm(provider),
      ownerPubkey: OWNER,
      caip19: BASE_USDC,
      expectedAddress: second.checksummed,
    });
    expect(proof.address).toBe(second.lower);
    expect(provider.calls[1]?.params?.[1]).toBe(second.lower);
  });

  it('refuses an account other than expectedAddress, before signing', async () => {
    const provider = fakeEvmProvider();
    expect(
      await proofError(
        signPayoutProof({
          wallet: chooseEvm(provider),
          ownerPubkey: OWNER,
          caip19: BASE_USDC,
          expectedAddress: evmKey().lower,
        }),
      ),
    ).toBe('wrong_address');
    expect(provider.calls.map((call) => call.method)).toEqual(['eth_requestAccounts']);
  });

  it('4001 is rejected, any other error unavailable', async () => {
    const cases: [Parameters<typeof fakeEvmProvider>[0], ProofErrorCode][] = [
      [{ requestAccounts: () => Promise.reject(userRejected()) }, 'rejected'],
      [{ sign: () => Promise.reject(userRejected()) }, 'rejected'],
      [{ requestAccounts: () => Promise.reject(new Error('locked')) }, 'unavailable'],
      [
        { sign: () => Promise.reject(Object.assign(new Error('x'), { code: 4100 })) },
        'unavailable',
      ],
      [{ sign: () => Promise.reject(null) }, 'unavailable'],
    ];
    for (const [options, code] of cases) {
      expect(
        await proofError(
          signPayoutProof({
            wallet: chooseEvm(fakeEvmProvider(options)),
            ownerPubkey: OWNER,
            caip19: BASE_USDC,
          }),
        ),
      ).toBe(code);
    }
  });

  it('no account is no_account', async () => {
    for (const answer of [[], 'x', [7, null]]) {
      expect(
        await proofError(
          signPayoutProof({
            wallet: chooseEvm(fakeEvmProvider({ requestAccounts: () => Promise.resolve(answer) })),
            ownerPubkey: OWNER,
            caip19: BASE_USDC,
          }),
        ),
      ).toBe('no_account');
    }
  });

  it('a signature that does not check out is bad_signature', async () => {
    const key = evmKey();
    const accounts = [{ address: key.checksummed, secretKey: key.secretKey }];
    const answers: ((params: readonly unknown[]) => Promise<unknown>)[] = [
      (params) => Promise.resolve(personalSign(evmKey().secretKey, String(params[0]))),
      () => Promise.resolve(personalSign(key.secretKey, utf8Hex('something else'))),
      () => Promise.resolve(personalSign(key.secretKey, utf8Hex(proofMessage(OWNER, TEMPO_USDCE)))),
      () => Promise.resolve(undefined),
      () => Promise.resolve('0x1234'),
    ];
    for (const sign of answers) {
      expect(
        await proofError(
          signPayoutProof({
            wallet: chooseEvm(fakeEvmProvider({ accounts, sign })),
            ownerPubkey: OWNER,
            caip19: BASE_USDC,
          }),
        ),
      ).toBe('bad_signature');
    }
  });

  it('an uppercase hex signature comes back lowercase', async () => {
    const key = evmKey();
    const provider = fakeEvmProvider({
      accounts: [{ address: key.lower, secretKey: key.secretKey }],
      sign: (params) =>
        Promise.resolve(
          `0x${personalSign(key.secretKey, String(params[0])).slice(2).toUpperCase()}`,
        ),
    });
    const proof = await signPayoutProof({
      wallet: chooseEvm(provider),
      ownerPubkey: OWNER,
      caip19: BASE_USDC,
    });
    expect(proof.signature).toBe(proof.signature.toLowerCase());
    expect(proof.signature).toBe(
      personalSign(key.secretKey, utf8Hex(proofMessage(OWNER, BASE_USDC))),
    );
  });
});

describe('signPayoutProof - unavailable', () => {
  it('a wallet this page never offered, a coin of the other family, or an unknown coin', async () => {
    const solana = chooseSolana(fakeSolanaWallet({ name: 'sol-family' }));
    const evm = chooseEvm(fakeEvmProvider());
    const attempts: Parameters<typeof signPayoutProof>[0][] = [
      {
        wallet: { id: 'evm:never', name: 'x', family: 'evm' },
        ownerPubkey: OWNER,
        caip19: BASE_USDC,
      },
      { wallet: { ...evm, family: 'solana' }, ownerPubkey: OWNER, caip19: SOLANA_USDC_DEVNET },
      { wallet: solana, ownerPubkey: OWNER, caip19: BASE_USDC },
      { wallet: evm, ownerPubkey: OWNER, caip19: SOLANA_USDC_DEVNET },
      { wallet: evm, ownerPubkey: OWNER, caip19: 'eip155:1/erc20:0xnot' },
    ];
    for (const attempt of attempts) {
      expect(await proofError(signPayoutProof(attempt))).toBe('unavailable');
    }
  });
});

describe('checkPastedProof', () => {
  const key = evmKey();
  const signature = personalSign(key.secretKey, utf8Hex(proofMessage(OWNER, BASE_USDC)));

  it('accepts a valid EIP-191 proof, checksummed or lowercase address', () => {
    expect(
      checkPastedProof({ ownerPubkey: OWNER, caip19: BASE_USDC, address: key.lower, signature }),
    ).toBe(true);
    expect(
      checkPastedProof({
        ownerPubkey: OWNER,
        caip19: BASE_USDC,
        address: key.checksummed,
        signature,
      }),
    ).toBe(true);
  });

  it('refuses another owner, coin, address or a broken signature', () => {
    const base = { ownerPubkey: OWNER, caip19: BASE_USDC, address: key.lower, signature };
    expect(checkPastedProof({ ...base, ownerPubkey: 'b'.repeat(64) })).toBe(false);
    expect(checkPastedProof({ ...base, caip19: TEMPO_USDCE })).toBe(false);
    expect(checkPastedProof({ ...base, address: evmKey().lower })).toBe(false);
    expect(checkPastedProof({ ...base, signature: '0x1234' })).toBe(false);
    expect(checkPastedProof({ ...base, caip19: 'eip155:1/erc20:0xnot' })).toBe(false);
  });

  it('is false for Solana coins, even with a valid Solana proof', () => {
    const solana = solanaKey();
    const solanaSignature = signEd25519(solana.secretKey, proofMessage(OWNER, SOLANA_USDC_DEVNET));
    const valid = {
      ownerPubkey: OWNER,
      caip19: SOLANA_USDC_DEVNET,
      address: solana.address,
      signature: getBase58Decoder().decode(solanaSignature),
    };
    expect(verifyPaytoProof({ chain: chainOf(SOLANA_USDC_DEVNET), ...valid })).toBe(true);
    expect(checkPastedProof(valid)).toBe(false);
  });
});
