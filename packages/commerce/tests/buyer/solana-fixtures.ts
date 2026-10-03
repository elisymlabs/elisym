import {
  type PaymentRequestData,
  USDC_SOLANA_DEVNET,
  buildPaymentInstructions,
  getProtocolProgramId,
} from '@elisym/pay-core';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  type Blockhash,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from '@solana/kit';
import type { SolanaWallet } from '../../src/buyer/solana-pay';

type Compiled = ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;

/** The widget builds v0 messages; a v1 one is not what these fakes handle. */
function legacyOrV0(message: Compiled): Exclude<Compiled, { version: 1 }> {
  if (message.version === 1) {
    throw new Error('unexpected v1 message');
  }
  return message;
}

/** A well-formed signature (base58 of 64 bytes), distinct per `index`. */
export function signatureOf(index: number): string {
  const bytes = new Uint8Array(64).fill(7);
  new DataView(bytes.buffer).setUint32(0, index + 1, true);
  return getBase58Decoder().decode(bytes);
}

const BLOCKHASH_A = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' as Blockhash;
const BLOCKHASH_B = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash;
/** A blockhash lives this many blocks. */
const LIFETIME_BLOCKS = 150n;
const TOKEN_ACCOUNT_RENT = 2_039_280n;
/** Rent floor of an account with no data: what a fee payer must keep. */
export const EMPTY_ACCOUNT_RENT = 890_880n;
/** The confirmed tip runs this many blocks ahead of the finalized one. */
const CONFIRMED_LEAD = 32n;
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

interface Landed {
  json: Record<string, unknown>;
  accounts: string[];
  failed: boolean;
}

/**
 * A Solana node in memory. `sendTransaction` lands a signed transaction at once
 * (unless `dropSends`), crediting the payee's token account with the bound
 * transfer; the reference index and the transaction store answer from what
 * landed. The finalized block height moves only when a test says so.
 */
export class FakeSolana {
  height = 1_000n;
  blockhash: Blockhash = BLOCKHASH_A;
  lamports = 1_000_000_000n;
  tokens = 1_000_000_000n;
  /** Whether the payee already holds a token account for the asset. */
  payeeHasAccount = true;
  dropSends = false;
  failing = false;
  /** Run on each send, before the transaction lands. */
  onSend: (() => Promise<void>) | undefined;
  /** Run on each reference listing, before it answers. */
  onList: (() => Promise<void>) | undefined;
  /**
   * The node answering reads is behind: it refuses a `minContextSlot` it has not
   * reached, and otherwise answers without what landed.
   */
  lagging = false;
  /**
   * The node is at the slot (it accepts `minContextSlot`) but its address index
   * and transaction store lag: they omit what landed, which only its signature
   * statuses show.
   */
  indexLag = false;
  /** The node answering signature statuses is behind the one answering the listing. */
  statusLag = false;
  /**
   * The node keeps a short ledger: everything before the current slot is gone -
   * the listing, the transactions and their statuses answer without it.
   */
  pruned = false;
  /** What `getFirstAvailableBlock` answers, when a test sets it. */
  firstAvailableBlock: bigint | undefined;
  /** `getFirstAvailableBlock` alone fails. */
  historyReadFails = false;

  /** The tip's slot (slots run ahead of heights by a fixed 10 000 here). */
  private get tipSlot(): bigint {
    return this.height + CONFIRMED_LEAD + 10_000n;
  }
  /** The last valid height of every blockhash the node handed out. */
  private readonly lifetimes = new Map<string, bigint>();
  landed = new Map<string, Landed>();
  sent: string[] = [];
  calls: string[] = [];
  /**
   * Extra signatures listed under any account: failed ones, or `junk` - landed
   * transactions that pay nothing (spam under a public reference).
   */
  extraListed: { signature: string; failed: boolean; junk?: boolean }[] = [];
  blockTime = 0;

  constructor(
    private readonly payer: string,
    private readonly payee: string,
  ) {}

  /** A new blockhash, so the next attempt gets another lifetime. */
  nextBlockhash(): void {
    this.blockhash = this.blockhash === BLOCKHASH_A ? BLOCKHASH_B : BLOCKHASH_A;
  }

  /** Move the finalized height (the tip stays `CONFIRMED_LEAD` ahead). */
  advance(blocks: bigint): void {
    this.height += blocks;
  }

  /** Finalize past every blockhash handed out so far, and past the widget's settle margin. */
  expire(): void {
    this.height += CONFIRMED_LEAD + LIFETIME_BLOCKS + 1n + 32n;
  }

  private answer<T>(name: string, value: () => T | Promise<T>) {
    return {
      send: async () => {
        this.calls.push(name);
        if (this.failing) {
          throw new Error('node down');
        }
        return value();
      },
    };
  }

  private async payeeAccount(): Promise<string> {
    const [account] = await findAssociatedTokenPda({
      owner: address(this.payee),
      mint: address(USDC_SOLANA_DEVNET.mint ?? ''),
      tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });
    return account;
  }

  private async land(wire: string): Promise<void> {
    const bytes = new Uint8Array(getBase64Encoder().encode(wire));
    const transaction = getTransactionDecoder().decode(bytes);
    const message = legacyOrV0(
      getCompiledTransactionMessageDecoder().decode(transaction.messageBytes),
    );
    const payerSignature = transaction.signatures[address(this.otherPayer ?? this.payer)] ?? null;
    if (payerSignature === null) {
      return;
    }
    const signature = getBase58Decoder().decode(payerSignature);
    // A rebroadcast of what already landed is a no-op, as on the chain.
    if (this.landed.has(signature)) {
      return;
    }
    // An expired or unknown blockhash never lands.
    const lastValid = this.lifetimes.get(message.lifetimeToken);
    if (lastValid === undefined || this.height + CONFIRMED_LEAD > lastValid) {
      return;
    }
    const keys = message.staticAccounts.map(String);
    // The runtime refuses a compute-budget setting given twice.
    const settings = message.instructions
      .filter((instruction) => keys[instruction.programAddressIndex] === COMPUTE_BUDGET)
      .map((instruction) => instruction.data?.[0]);
    if (new Set(settings).size !== settings.length) {
      return;
    }
    const payeeAccount = await this.payeeAccount();
    let credited = 0n;
    for (const instruction of message.instructions) {
      const data = instruction.data ?? new Uint8Array();
      const indices = instruction.accountIndices ?? [];
      if (data[0] === 12 && data.length === 10 && keys[indices[2] ?? -1] === payeeAccount) {
        credited += new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
          1,
          true,
        );
      }
    }
    const base58 = getBase58Decoder();
    const failed = credited > this.tokens;
    this.landed.set(signature, {
      accounts: keys,
      failed,
      json: {
        slot: 42n,
        blockTime: this.blockTime,
        transaction: {
          message: {
            accountKeys: keys,
            header: {
              numRequiredSignatures: message.header.numSignerAccounts,
              numReadonlySignedAccounts: message.header.numReadonlySignerAccounts,
              numReadonlyUnsignedAccounts: message.header.numReadonlyNonSignerAccounts,
            },
            instructions: message.instructions.map((instruction) => ({
              programIdIndex: instruction.programAddressIndex,
              accounts: instruction.accountIndices ?? [],
              data: base58.decode(instruction.data ?? new Uint8Array()),
            })),
          },
        },
        meta: {
          err: failed ? { InstructionError: [0, 'InsufficientFunds'] } : null,
          loadedAddresses: { writable: [], readonly: [] },
          preTokenBalances: [
            {
              accountIndex: keys.indexOf(payeeAccount),
              mint: USDC_SOLANA_DEVNET.mint,
              owner: this.payee,
              uiTokenAmount: { amount: '0' },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: keys.indexOf(payeeAccount),
              mint: USDC_SOLANA_DEVNET.mint,
              owner: this.payee,
              uiTokenAmount: { amount: (failed ? 0n : credited).toString() },
            },
          ],
        },
      },
    });
    if (!failed) {
      this.tokens -= credited;
    }
  }

  /**
   * A payment of `request` sent from another wallet (another device): landed
   * now, listed under the reference, crediting the payee.
   */
  async injectPayment(request: PaymentRequestData): Promise<string> {
    const other = await generateKeyPairSigner();
    const instructions = await buildPaymentInstructions(request, createNoopSigner(other.address), {
      programId: getProtocolProgramId('devnet'),
    });
    const lastValidBlockHeight = this.height + CONFIRMED_LEAD + LIFETIME_BLOCKS;
    this.lifetimes.set(this.blockhash, lastValidBlockHeight);
    const transaction = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (draft) => setTransactionMessageFeePayer(other.address, draft),
        (draft) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: this.blockhash, lastValidBlockHeight },
            draft,
          ),
        (draft) =>
          appendTransactionMessageInstructions(
            instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
            draft,
          ),
      ),
    );
    const signed = await partiallySignTransaction([other.keyPair], transaction);
    // Landed through the same path as any send, as the other wallet.
    this.otherPayer = other.address;
    await this.land(
      getBase64Decoder().decode(new Uint8Array(getTransactionEncoder().encode(signed))),
    );
    this.otherPayer = undefined;
    return getBase58Decoder().decode(signed.signatures[other.address] ?? new Uint8Array());
  }

  /** The fee payer `land` accepts besides the buyer's wallet (an injected payment). */
  private otherPayer: string | undefined;

  get rpc(): Rpc<SolanaRpcApi> {
    const node = {
      getLatestBlockhash: () =>
        this.answer('getLatestBlockhash', () => {
          const lastValidBlockHeight = this.height + CONFIRMED_LEAD + LIFETIME_BLOCKS;
          this.lifetimes.set(this.blockhash, lastValidBlockHeight);
          return {
            context: { slot: this.tipSlot },
            value: { blockhash: this.blockhash, lastValidBlockHeight },
          };
        }),
      getSlot: () => this.answer('getSlot', () => 5_000n),
      getBlockTime: () => this.answer('getBlockTime', () => BigInt(this.blockTime)),
      getEpochInfo: (config: { commitment?: string } = {}) =>
        this.answer('getEpochInfo', () => {
          // Only `finalized` is the finalized height; anything else is the tip.
          const blockHeight =
            config.commitment === 'finalized' ? this.height : this.height + CONFIRMED_LEAD;
          return { blockHeight, absoluteSlot: blockHeight + 10_000n };
        }),
      getRecentPrioritizationFees: () => this.answer('getRecentPrioritizationFees', () => []),
      getMinimumBalanceForRentExemption: (size: bigint) =>
        this.answer('getMinimumBalanceForRentExemption', () =>
          BigInt(size) === 0n ? EMPTY_ACCOUNT_RENT : TOKEN_ACCOUNT_RENT,
        ),
      getBalance: () => this.answer('getBalance', () => ({ value: this.lamports })),
      getAccountInfo: (account: string) =>
        this.answer('getAccountInfo', async () => {
          const exists = account === (await this.payeeAccount()) ? this.payeeHasAccount : true;
          return { value: exists ? { data: ['', 'base64'], lamports: 1n } : null };
        }),
      getTokenAccountBalance: () =>
        this.answer('getTokenAccountBalance', () => ({
          value: { amount: this.tokens.toString(), decimals: 6 },
        })),
      sendTransaction: (wire: string) =>
        this.answer('sendTransaction', async () => {
          this.sent.push(wire);
          await this.onSend?.();
          if (!this.dropSends) {
            await this.land(wire);
          }
          return 'sent';
        }),
      getSignaturesForAddress: (
        account: string,
        config: { limit?: number; before?: string; minContextSlot?: bigint } = {},
      ) =>
        this.answer('getSignaturesForAddress', async () => {
          await this.onList?.();
          if (this.lagging && config.minContextSlot !== undefined) {
            throw new Error('Minimum context slot has not been reached');
          }
          const rows = [
            ...[...this.landed.entries()]
              .filter(
                ([, landed]) =>
                  !this.lagging &&
                  !this.indexLag &&
                  !this.pruned &&
                  landed.accounts.includes(account),
              )
              .map(([signature, landed]) => ({ signature, failed: landed.failed })),
            ...this.extraListed,
          ].map((entry) => ({
            signature: entry.signature,
            err: entry.failed ? {} : null,
            blockTime: this.blockTime,
            slot: 42n,
          }));
          const from =
            config.before === undefined
              ? 0
              : rows.findIndex((row) => row.signature === config.before) + 1;
          return rows.slice(from, from + (config.limit ?? 1000));
        }),
      getTransaction: (signature: string) =>
        this.answer('getTransaction', () => {
          const extra = this.extraListed.find((entry) => entry.signature === signature);
          if (extra?.junk === true) {
            return {
              slot: 42n,
              blockTime: this.blockTime,
              transaction: {
                message: {
                  accountKeys: [this.payer],
                  header: {
                    numRequiredSignatures: 1,
                    numReadonlySignedAccounts: 0,
                    numReadonlyUnsignedAccounts: 0,
                  },
                  instructions: [],
                },
              },
              meta: {
                err: null,
                loadedAddresses: { writable: [], readonly: [] },
                preTokenBalances: [],
                postTokenBalances: [],
              },
            };
          }
          return this.lagging || this.indexLag || this.pruned
            ? null
            : (this.landed.get(signature)?.json ?? null);
        }),
      getSignatureStatuses: (signatures: string[]) =>
        this.answer('getSignatureStatuses', () => {
          // A node behind the rest: its context is old and it knows nothing recent.
          const behind = this.lagging || this.statusLag;
          return {
            context: { slot: behind ? 0n : this.tipSlot },
            value: signatures.map((signature) =>
              !behind && !this.pruned && this.landed.has(signature)
                ? { confirmationStatus: 'confirmed', err: null }
                : null,
            ),
          };
        }),
      getFirstAvailableBlock: () =>
        this.answer('getFirstAvailableBlock', () => {
          if (this.historyReadFails) {
            throw new Error('history unavailable');
          }
          return this.firstAvailableBlock ?? (this.pruned ? this.tipSlot : 0n);
        }),
    };
    return node as unknown as Rpc<SolanaRpcApi>;
  }
}

export type WalletBehaviour =
  | 'sign'
  /** Fails without proving a decline (a plain error): the attempt stays live. */
  | 'throw'
  /** The buyer declines: throws `{ code: 4001 }`, as Wallet Standard wallets do. */
  | 'reject'
  /** Replaces the blockhash with another one before signing. */
  | 'swap_blockhash'
  /** Lowers the transfer's amount before signing. */
  | 'change_amount'
  /** Returns the transaction without a signature. */
  | 'no_signature'
  /** Puts a durable-nonce advance first, keeping the blockhash. */
  | 'durable_nonce'
  /** Returns a signature that does not verify. */
  | 'bad_signature'
  /** Appends its own compute-budget limit and price after the widget's. */
  | 'append_compute_budget'
  /** Replaces the widget's compute-unit price with a much higher one. */
  | 'raise_price';

/** A Wallet Standard account in memory that signs (or misbehaves) as told. */
export class FakeWallet implements SolanaWallet {
  behaviour: WalletBehaviour = 'sign';
  requests = 0;
  /** Run while the wallet "shows" the prompt, before it answers. */
  duringPrompt: (() => Promise<void>) | undefined;

  private constructor(private readonly signer: KeyPairSigner) {}

  static async create(): Promise<FakeWallet> {
    return new FakeWallet(await generateKeyPairSigner());
  }

  get address(): string {
    return this.signer.address;
  }

  async signTransaction(bytes: Uint8Array): Promise<Uint8Array> {
    this.requests += 1;
    await this.duringPrompt?.();
    if (this.behaviour === 'throw') {
      throw new Error('wallet failed');
    }
    if (this.behaviour === 'reject') {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    }
    const decoded = getTransactionDecoder().decode(bytes);
    let messageBytes = decoded.messageBytes;
    if (this.behaviour === 'append_compute_budget' || this.behaviour === 'raise_price') {
      const message = legacyOrV0(getCompiledTransactionMessageDecoder().decode(messageBytes));
      const budget = message.staticAccounts.findIndex((account) => account === COMPUTE_BUDGET);
      const price = new Uint8Array(9);
      price[0] = 3;
      new DataView(price.buffer).setBigUint64(1, 50_000_000n, true);
      const limit = new Uint8Array(5);
      limit[0] = 2;
      new DataView(limit.buffer).setUint32(1, 300_000, true);
      const instructions =
        this.behaviour === 'append_compute_budget'
          ? [
              ...message.instructions,
              { programAddressIndex: budget, data: limit },
              { programAddressIndex: budget, data: price },
            ]
          : message.instructions.map((instruction) =>
              instruction.programAddressIndex === budget && instruction.data?.[0] === 3
                ? { ...instruction, data: price }
                : instruction,
            );
      messageBytes = getCompiledTransactionMessageEncoder().encode({
        ...message,
        instructions,
      }) as typeof decoded.messageBytes;
    }
    if (this.behaviour === 'durable_nonce') {
      const message = legacyOrV0(getCompiledTransactionMessageDecoder().decode(messageBytes));
      const system = message.staticAccounts.findIndex(
        (account) => account === '11111111111111111111111111111111',
      );
      messageBytes = getCompiledTransactionMessageEncoder().encode({
        ...message,
        instructions: [
          { programAddressIndex: system, data: new Uint8Array([4, 0, 0, 0]) },
          ...message.instructions,
        ],
      }) as typeof decoded.messageBytes;
    }
    if (this.behaviour === 'swap_blockhash' || this.behaviour === 'change_amount') {
      const message = legacyOrV0(getCompiledTransactionMessageDecoder().decode(messageBytes));
      const changed =
        this.behaviour === 'swap_blockhash'
          ? {
              ...message,
              lifetimeToken:
                message.lifetimeToken === BLOCKHASH_A ? BLOCKHASH_B : (BLOCKHASH_A as string),
            }
          : {
              ...message,
              instructions: message.instructions.map((instruction) => {
                const data = instruction.data;
                if (data === undefined || data[0] !== 12 || data.length !== 10) {
                  return instruction;
                }
                const lowered = new Uint8Array(data);
                new DataView(lowered.buffer).setBigUint64(1, 1n, true);
                return { ...instruction, data: lowered };
              }),
            };
      messageBytes = getCompiledTransactionMessageEncoder().encode(
        changed,
      ) as typeof decoded.messageBytes;
    }
    const unsigned = { ...decoded, messageBytes };
    if (this.behaviour === 'no_signature') {
      return new Uint8Array(getTransactionEncoder().encode(unsigned));
    }
    const signed = await partiallySignTransaction([this.signer.keyPair], unsigned);
    const wire = new Uint8Array(getTransactionEncoder().encode(signed));
    if (this.behaviour === 'bad_signature') {
      // The first signature starts right after its one-byte count.
      wire[1] = (wire[1] ?? 0) ^ 0xff;
    }
    return wire;
  }
}
