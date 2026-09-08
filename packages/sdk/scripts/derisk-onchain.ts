#!/usr/bin/env bun
/**
 * The on-chain call refusal matrix, against a LIVE cluster.
 *
 * `onchain-verify.test.ts` proves every refusal against a fake RPC that returns
 * exactly the state each case needs. That fake is written from the same reading
 * of the node as the verifier, so the two can agree with each other and both be
 * wrong. This script runs the same matrix against a real node, where the
 * simulation, the post-state, the inner instructions and the fee are the node's
 * own.
 *
 * A MANUAL tool, not a CI test - it needs a cluster and a signer with real
 * state. It NEVER signs and never sends: `verifyOnchainCall` is a read-only
 * path, so the signer's key is not needed and is never asked for.
 *
 *   NETWORK=devnet|mainnet \
 *   SIGNER=<base58 pubkey holding SOL and an SPL token account> \
 *   RPC_URL=<optional override> \
 *   bun packages/sdk/scripts/derisk-onchain.ts
 *
 * The default signer is the devnet wallet the elisym team funds for this. Any
 * wallet works as long as it holds SOL and one token account of the card asset;
 * the script reads that state and sizes each case against it.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AuthorityType,
  findAssociatedTokenPda,
  getApproveInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getSetAuthorityInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type IInstruction,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { parseOnchainDescriptor } from '../src/onchain/schema';
import type { OnchainRefusalReason, OnchainVerifyResult } from '../src/onchain/types';
import { verifyOnchainCall } from '../src/onchain/verify';

const NETWORK = (process.env.NETWORK ?? 'devnet') as 'devnet' | 'mainnet';
const RPC_URL =
  process.env.RPC_URL ??
  (NETWORK === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
const SIGNER = address(process.env.SIGNER ?? '2cwv5sFeT2FMdb5h4JSws9nCwW2kD1CCjGU2hxz3Q73x');

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const rpc: Rpc<SolanaRpcApi> = createSolanaRpc(RPC_URL);
const signer = createNoopSigner(SIGNER);

/** A card the loader would have produced, with only the fields a case varies. */
function cardFor(overrides: Record<string, unknown>) {
  const parsed = parseOnchainDescriptor({
    kind: 'transfer',
    programs: [SYSTEM_PROGRAM],
    network: NETWORK,
    token: 'sol',
    decimals: 9,
    max_per_call_subunits: '10000000',
    max_authority_subunits: '0',
    ...overrides,
  });
  if (parsed === null) {
    throw new Error(`fixture card does not parse: ${JSON.stringify(overrides)}`);
  }
  return parsed;
}

async function wireFor(
  instructions: IInstruction[],
  blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint },
) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

interface Case {
  name: string;
  expect: OnchainRefusalReason | 'ok';
  run: () => Promise<OnchainVerifyResult>;
}

const results: { name: string; expect: string; got: string; detail: string; pass: boolean }[] = [];

async function runCase(testCase: Case) {
  let got: string;
  let detail = '';
  try {
    const outcome = await testCase.run();
    got = outcome.ok ? 'ok' : outcome.reason;
    detail = outcome.ok ? describeFacts(outcome) : outcome.detail;
  } catch (error) {
    got = 'THREW';
    detail = error instanceof Error ? error.message : String(error);
  }
  results.push({
    name: testCase.name,
    expect: testCase.expect,
    got,
    detail,
    pass: got === testCase.expect,
  });
}

function describeFacts(outcome: Extract<OnchainVerifyResult, { ok: true }>) {
  const moves = outcome.facts.deltas
    .map((delta) => `${delta.mint ? delta.mint.slice(0, 4) : 'SOL'}:${delta.subunits}`)
    .join(' ');
  const grants = outcome.facts.grants
    .map((grant) => `${grant.delegate.slice(0, 4)}<-${grant.subunits}`)
    .join(' ');
  return `fee=${outcome.facts.feeLamports} moves=[${moves}] grants=[${grants}] inner=${outcome.facts.innerPrograms.length} unattributed=${outcome.facts.unattributed.length}`;
}

// ---------------------------------------------------------------------------
// The signer's real state. Every case is sized against it, so the script works
// against any funded wallet rather than a hard-coded fixture.
// ---------------------------------------------------------------------------

const { value: lamports } = await rpc.getBalance(SIGNER).send();
const { value: tokenAccounts } = await rpc
  .getTokenAccountsByOwner(
    SIGNER,
    { programId: address(TOKEN_PROGRAM) },
    { encoding: 'jsonParsed' },
  )
  .send();
if (tokenAccounts.length === 0) {
  console.error(`${SIGNER} holds no SPL token account; the authority cases need one.`);
  process.exit(1);
}
const tokenAccount = tokenAccounts[0];
const TOKEN_ATA = tokenAccount.pubkey;
const TOKEN_MINT = tokenAccount.account.data.parsed.info.mint as string;
const TOKEN_DECIMALS = tokenAccount.account.data.parsed.info.tokenAmount.decimals as number;

console.log(`network   ${NETWORK}  (${RPC_URL})`);
console.log(`signer    ${SIGNER}`);
console.log(`  lamports ${lamports}`);
console.log(`  token    ${TOKEN_ATA} mint=${TOKEN_MINT} decimals=${TOKEN_DECIMALS}`);
console.log('');

const { value: blockhash } = await rpc.getLatestBlockhash().send();
const nowSeconds = Math.floor(Date.now() / 1000);
const stranger = address('HKcm2GLavdb9BM5W62J8vwZd4bAMzBgbZtx4BR8FCsum');
const delegate = address('4ARYGgibfQDcERcBj8E8pjcoE5SmeHXsAHe2HvYKvY78');

function envelopeFor(transaction: string, overrides: Record<string, unknown> = {}) {
  return {
    elisym_call: 'v1',
    network: NETWORK,
    transaction,
    signer: SIGNER,
    expires_at: nowSeconds + 600,
    ...overrides,
  };
}

async function verify(
  instructions: IInstruction[],
  card: ReturnType<typeof cardFor>,
  envelopeOverrides: Record<string, unknown> = {},
) {
  const transaction = await wireFor(instructions, blockhash);
  return verifyOnchainCall({
    envelope: envelopeFor(transaction, envelopeOverrides),
    card,
    signer: SIGNER,
    network: NETWORK,
    rpc,
  });
}

const solCard = cardFor({});
const tokenCard = cardFor({
  token: 'usdc',
  mint: TOKEN_MINT,
  decimals: TOKEN_DECIMALS,
  programs: [SYSTEM_PROGRAM, TOKEN_PROGRAM],
  max_per_call_subunits: '1000000',
});

const cases: Case[] = [
  {
    name: 'happy path - SOL transfer inside the ceiling',
    expect: 'ok',
    run: () =>
      verify(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 1_000_000n })],
        solCard,
      ),
  },
  {
    name: 'spend above the card ceiling',
    expect: 'spend-ceiling-exceeded',
    run: () =>
      verify(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 50_000_000n })],
        solCard,
      ),
  },
  {
    name: 'top-level program the card never published',
    expect: 'program-not-on-card',
    run: () =>
      verify(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 1_000_000n })],
        cardFor({ programs: [TOKEN_PROGRAM] }),
      ),
  },
  {
    name: 'more SOL than the signer holds',
    expect: 'simulation-failed',
    run: () =>
      verify(
        [
          getTransferSolInstruction({
            source: signer,
            destination: stranger,
            amount: lamports + 1_000_000_000n,
          }),
        ],
        cardFor({ max_per_call_subunits: '99999999999999' }),
      ),
  },
  {
    name: 'wrong signer',
    expect: 'wrong-signer',
    run: () =>
      verify(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 1_000_000n })],
        solCard,
        { signer: stranger },
      ),
  },
  {
    name: 'already expired',
    expect: 'expired',
    run: () =>
      verify(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 1_000_000n })],
        solCard,
        { expires_at: nowSeconds - 60 },
      ),
  },
  {
    name: 'expiry further out than the protocol allows',
    expect: 'expiry-too-far',
    run: () =>
      verify(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 1_000_000n })],
        solCard,
        { expires_at: nowSeconds + 86_400 },
      ),
  },
  {
    name: 'card from the other network',
    expect: 'wrong-network',
    run: () =>
      verify(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 1_000_000n })],
        cardFor({ network: NETWORK === 'devnet' ? 'mainnet' : 'devnet' }),
      ),
  },
];

// The chain-dependent half: every case below is decided by what the node
// reports the call would LEAVE BEHIND, not by anything readable in its bytes.

const [strangerAta] = await findAssociatedTokenPda({
  owner: stranger,
  mint: address(TOKEN_MINT),
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
const approve = getApproveInstruction({
  source: address(TOKEN_ATA),
  delegate,
  owner: SIGNER,
  amount: 5_000_000n,
}) as IInstruction;

cases.push(
  {
    name: 'approve the card never declared',
    expect: 'authority-grant-not-declared',
    run: () => verify([approve], tokenCard),
  },
  {
    name: 'approve above the declared authority ceiling',
    expect: 'authority-ceiling-exceeded',
    run: () =>
      verify(
        [approve],
        cardFor({
          token: 'usdc',
          mint: TOKEN_MINT,
          decimals: TOKEN_DECIMALS,
          programs: [SYSTEM_PROGRAM, TOKEN_PROGRAM],
          max_per_call_subunits: '1000000',
          grants_authority: true,
          max_authority_subunits: '1000000',
        }),
      ),
  },
  {
    name: 'approve inside a declared authority ceiling',
    expect: 'ok',
    run: () =>
      verify(
        [approve],
        cardFor({
          token: 'usdc',
          mint: TOKEN_MINT,
          decimals: TOKEN_DECIMALS,
          programs: [SYSTEM_PROGRAM, TOKEN_PROGRAM],
          max_per_call_subunits: '1000000',
          grants_authority: true,
          max_authority_subunits: '10000000',
        }),
      ),
  },
  {
    name: "handing the signer's token account to someone else",
    expect: 'account-authority-changed',
    run: () =>
      verify(
        [
          getSetAuthorityInstruction({
            owned: address(TOKEN_ATA),
            owner: SIGNER,
            authorityType: AuthorityType.AccountOwner,
            newAuthority: stranger,
          }) as IInstruction,
        ],
        tokenCard,
      ),
  },
  {
    name: 'CPI programs are read from the simulation',
    expect: 'ok',
    run: () =>
      verify(
        [
          getCreateAssociatedTokenIdempotentInstruction({
            payer: signer,
            ata: strangerAta,
            owner: stranger,
            mint: address(TOKEN_MINT),
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          }) as IInstruction,
        ],
        cardFor({
          programs: [ASSOCIATED_TOKEN_PROGRAM_ADDRESS],
          max_per_call_subunits: '10000000',
        }),
      ),
  },
  {
    name: 'SOL leaving a token-denominated card rides the fee allowance',
    expect: 'fee-ceiling-exceeded',
    run: () =>
      verify(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 50_000_000n })],
        cardFor({
          token: 'usdc',
          mint: TOKEN_MINT,
          decimals: TOKEN_DECIMALS,
          programs: [SYSTEM_PROGRAM],
          max_per_call_subunits: '1000000',
        }),
      ),
  },
  {
    name: 'a writable account elisym cannot attribute to the signer',
    expect: 'ok',
    run: () =>
      verify(
        [
          getTransferSolInstruction({
            source: signer,
            destination: address('EmwEdSFucibHHDeG5jwVtPELjJiMduTFZUM6dbCDZtn9'),
            amount: 1_000n,
          }),
        ],
        solCard,
      ),
  },
);

// A table the provider references and the chain does not have. Built by handing
// the compressor a map the node will not corroborate, which is exactly what a
// provider caching a closed table produces.
const PHANTOM_TABLE = address('EmwEdSFucibHHDeG5jwVtPELjJiMduTFZUM6dbCDZtn8');

async function phantomTableWire() {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        [getTransferSolInstruction({ source: signer, destination: stranger, amount: 1_000n })],
        m,
      ),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, { [PHANTOM_TABLE]: [stranger] }),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/** Stamp a non-zero signature into an otherwise unsigned wire transaction. */
function withSignature(wire: string): string {
  const bytes = Buffer.from(wire, 'base64');
  bytes.fill(7, 1, 65);
  return bytes.toString('base64');
}

cases.push(
  {
    name: 'a lookup table the chain does not have',
    expect: 'lookup-table-unavailable',
    run: async () =>
      verifyOnchainCall({
        envelope: envelopeFor(await phantomTableWire()),
        card: solCard,
        signer: SIGNER,
        network: NETWORK,
        rpc,
      }),
  },
  {
    name: 'a call that arrives already signed',
    expect: 'already-signed',
    run: async () =>
      verifyOnchainCall({
        envelope: envelopeFor(
          withSignature(
            await wireFor(
              [
                getTransferSolInstruction({
                  source: signer,
                  destination: stranger,
                  amount: 1_000n,
                }),
              ],
              blockhash,
            ),
          ),
        ),
        card: solCard,
        signer: SIGNER,
        network: NETWORK,
        rpc,
      }),
  },
  {
    name: 'someone else pays the fee',
    expect: 'foreign-fee-payer',
    run: async () => {
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(createNoopSigner(stranger), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) =>
          appendTransactionMessageInstructions(
            [
              getTransferSolInstruction({
                source: createNoopSigner(stranger),
                destination: SIGNER,
                amount: 1_000n,
              }),
            ],
            m,
          ),
      );
      return verifyOnchainCall({
        envelope: envelopeFor(getBase64EncodedWireTransaction(compileTransaction(message))),
        card: solCard,
        signer: SIGNER,
        network: NETWORK,
        rpc,
      });
    },
  },
);

for (const testCase of cases) {
  await runCase(testCase);
}

const width = Math.max(...results.map((r) => r.name.length));
for (const result of results) {
  const mark = result.pass ? 'PASS' : 'FAIL';
  console.log(
    `${mark}  ${result.name.padEnd(width)}  expected=${result.expect}  got=${result.got}`,
  );
  if (!result.pass || result.got === 'ok') {
    console.log(`      ${result.detail}`);
  }
}
const failed = results.filter((result) => !result.pass).length;
console.log(
  `\n${results.length - failed}/${results.length} cases behaved as the unit tests claim.`,
);
process.exit(failed === 0 ? 0 : 1);
