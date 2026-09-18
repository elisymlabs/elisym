/**
 * Shared CLI helpers - RPC URLs, SOL formatting, price validation.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Asset,
  type Network,
  calculateProtocolFee,
  deleteControlCharacters,
  formatAssetAmount,
  resolveUsdcAsset,
} from '@elisym/sdk';
import {
  AgentNameSchema,
  type AgentSource,
  type ListedAgent,
  agentPaths,
  listAgents,
  readAgentPublic,
  resolveInHome,
} from '@elisym/sdk/agent-store';
import { type Skill, loadSkillsFromDir } from '@elisym/sdk/skills';
import { type Rpc, type SolanaRpcApi, address } from '@solana/kit';

// --- Constants ---

export const RENT_EXEMPT_MINIMUM = 890_880; // lamports
export const MAX_CONCURRENT_JOBS = 10;
export const RECOVERY_MAX_RETRIES = 5;
export const RECOVERY_INTERVAL_SECS = 60;
/**
 * Hard cutoff for `paid` jobs the recovery loop cannot finish - an unhealthy
 * LLM pair, a preflight that keeps refusing, a payment it cannot confirm. After
 * this age the entry is force-failed and an error feedback is fired. Without
 * it, an operator who walks away from a billing-exhausted agent leaves the
 * ledger and recovery loop spinning on a job nobody will ever deliver.
 */
export const MAX_PAID_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
/**
 * How long a terminal ledger entry survives `pruneOldEntries`.
 *
 * RETENTION INVARIANT (`>= 2 * MAX_PAID_AGE_MS`): entries are also the "one
 * transaction settles one job" index, so pruning one forgets which transaction
 * it consumed. A rival can only ride a consumed settlement while itself alive
 * (`MAX_PAID_AGE_MS`) and may have been created much later, so keep the 2x.
 */
export const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, mirrors plugin

export const WATCHDOG_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const WATCHDOG_PROBE_TIMEOUT_MS = 10_000;
export const WATCHDOG_SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
export const WATCHDOG_SELF_PING_TIMEOUT_MS = 15_000;
/**
 * If a watchdog tick fires after a wall-clock gap larger than the smaller of
 * its two intervals multiplied by this factor, the gap is treated as host
 * suspension (macOS sleep, hibernation, container pause) rather than normal
 * scheduling jitter. Both `setInterval` callbacks freeze during OS sleep and
 * fire late on resume; the tick that detects the gap forces an immediate pool
 * reset instead of running the regular probe/self-ping (which would race
 * against still-half-dead WebSocket state).
 */
export const WATCHDOG_SLEEP_DETECT_MULTIPLIER = 2;

// --- Solana RPC ---

export function getRpcUrl(network: Network): string {
  // CLI-only override (D9): `start <agent>` is one agent, one network per
  // process, so a process-wide env override is unambiguous here.
  const envUrl = process.env.SOLANA_RPC_URL;
  if (envUrl) {
    return envUrl;
  }
  return network === 'mainnet'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com';
}

// --- Agent listing ---

/**
 * The Solana line `list` prints for one agent: receiving address plus the
 * network it is bound to. Read from the PUBLIC yaml instead of through
 * `loadAgent`, so an agent whose secrets are encrypted still shows its network -
 * a mainnet agent is the one most likely to be encrypted, and its network is the
 * one field worth checking before starting the wrong process. Selects by chain
 * rather than taking `payments[0]`: the two agree while `PaymentSchema.chain` is
 * the literal `'solana'`, and this one keeps reading the right entry when a
 * second rail lands. An unreadable or wallet-less agent contributes nothing
 * rather than failing the whole listing.
 */
export async function solanaLineFor(agent: ListedAgent): Promise<string> {
  try {
    const { yaml } = await readAgentPublic(agent);
    const solana = yaml.payments.find((entry) => entry.chain === 'solana');
    return solana ? ` | Solana: ${solana.address} (${solana.network})` : '';
  } catch {
    return '';
  }
}

// --- SPL balances ---

/**
 * Sum the agent's token-account balances for an SPL asset (raw subunits) on
 * the connected Solana RPC. Uses a mint-filtered `getTokenAccountsByOwner`,
 * which is token-program-agnostic (covers Token-2022 mints like LSM) and sums
 * non-ATA accounts too. An asset with no mint, or an owner with no token
 * account, is 0n; `null` means the balance could not be read. Callers render
 * that as unknown rather than failing the banner - printing "0 LSM" for a
 * wallet that holds a fortune is worse than saying the read failed.
 */
export async function fetchSplBalance(
  rpc: Rpc<SolanaRpcApi>,
  owner: ReturnType<typeof address>,
  asset: Asset,
): Promise<bigint | null> {
  const mint = asset.mint;
  if (!mint) {
    return 0n;
  }
  try {
    const response = await rpc
      .getTokenAccountsByOwner(
        owner,
        { mint: address(mint) },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      )
      .send();
    let total = 0n;
    for (const entry of response.value) {
      const parsed = entry.account.data as
        | { parsed?: { info?: { tokenAmount?: { amount?: string } } } }
        | undefined;
      const raw = parsed?.parsed?.info?.tokenAmount?.amount;
      // An entry the node returned unparsed (it falls back to base64 when it
      // cannot parse the owning program - a node without the Token-2022 parser
      // does this for LSM) is a FAILED read, not an empty account. Skipping it
      // would silently under-report, which is the "0 LSM for a funded wallet"
      // outcome this function exists to avoid.
      if (typeof raw !== 'string') {
        return null;
      }
      total += BigInt(raw);
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Balance value for a banner - the bare amount, no symbol prefix (callers
 * supply their own label). An unreadable balance never renders as zero.
 */
export function formatSplBalanceValue(asset: Asset, balance: bigint | null | undefined): string {
  return balance === undefined || balance === null
    ? 'unavailable (balance read failed)'
    : formatAssetAmount(asset, balance);
}

/**
 * The network's canonical-USDC balance via `fetchSplBalance` - kept for the
 * x402 surfaces (driver float check, `x402 add` preflight, settle-check).
 * `null` when the balance could not be read: the float checks refuse on an
 * unknown balance rather than treating it as empty or as sufficient.
 */
export async function fetchUsdcBalance(
  rpc: Rpc<SolanaRpcApi>,
  owner: ReturnType<typeof address>,
  network: Network,
): Promise<bigint | null> {
  return fetchSplBalance(rpc, owner, resolveUsdcAsset(network));
}

// --- Price validation ---

export function validateJobPrice(
  lamports: number,
  accountFunded: boolean,
  feeBps: number,
): string | null {
  if (lamports === 0) {
    return null;
  }
  const fee = calculateProtocolFee(lamports, feeBps);
  const providerNet = lamports - fee;
  if (!accountFunded && providerNet < RENT_EXEMPT_MINIMUM) {
    const pct = (feeBps / 100).toFixed(2);
    return (
      `Price too low. After ${pct}% fee, provider receives ${providerNet} lamports, ` +
      `which is below rent-exempt minimum (${RENT_EXEMPT_MINIMUM}). Increase price or fund wallet first.`
    );
  }
  return null;
}

// --- Shared payout address ---

/** A neighboring agent serving the same (network, address) pair. */
export interface SharedPayoutNeighbor {
  name: string;
  /** As the operator sees it on disk: not dereferenced, but sanitized. */
  dir: string;
  /** `'unknown'` when this process could not read enough of `skills/` to tell. */
  paid: true | 'unknown';
}

/**
 * Agents other than this one that would be paid at the same address.
 *
 * Scope, so the quiet answer is not mistaken for a clean bill: this sees the
 * home root and the ONE project root reachable by walking up from `cwd`. Two
 * agents in two different project trees, both paid at one address, are a real
 * collision this cannot see.
 *
 * Not a lock, and deliberately not a refusal: a safe would need a cross-process
 * lock this repository does not have. One transaction carrying two jobs'
 * references settles both on the flat paid rail, and two agents behind one
 * address make that reachable without anybody doing anything wrong - so the
 * answer is to make it visible at start.
 *
 * Reads the disk, touches no network, never exits. The "is THIS agent paid"
 * gate lives in the caller.
 */
export async function findSharedPayoutNeighbors(
  cwd: string,
  ownDir: string,
  network: Network,
  payoutAddress: string,
): Promise<SharedPayoutNeighbor[]> {
  let ownReal: string;
  try {
    ownReal = realpathSync(ownDir);
  } catch {
    // Without our own directory we cannot tell ourselves from a neighbor, and
    // an agent warning about itself is worse than one that says nothing.
    return [];
  }

  const listed = await listAgents(cwd);
  // Shadowed home twins are expanded BEFORE anyone is dropped: dropping our own
  // record first would take the record the home twin is derived from with it.
  const candidates: { name: string; dir: string; source: AgentSource }[] = [];
  for (const agent of listed) {
    candidates.push({ name: agent.name, dir: agent.dir, source: agent.source });
    if (agent.shadowsGlobal) {
      const homeDir = resolveInHome(agent.name);
      if (homeDir !== null) {
        candidates.push({ name: agent.name, dir: homeDir, source: 'home' });
      }
    }
  }

  const neighbors: SharedPayoutNeighbor[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // The name is checked RAW - sanitizing first would turn `ali\x01ce` into
    // `alice` and print it as a legitimate neighbor's. `safeParse`, never
    // `validateAgentName`: that one throws instead of answering, and
    // `if (!validateAgentName(n))` would drop every neighbor and silently
    // switch this whole feature off.
    if (!AgentNameSchema.safeParse(candidate.name).success) {
      continue;
    }
    let candidateReal: string;
    try {
      candidateReal = realpathSync(candidate.dir);
    } catch {
      continue;
    }
    // BOTH sides dereferenced. On macOS `tmpdir()` lives behind a symlink, so
    // comparing a resolved path against a raw one diverges in every test and
    // usually not in production - which is exactly how such a bug survives
    // review. Neighbors are de-duplicated on the same resolved path, so a
    // project `.elisym` that is a symlink to the home root cannot list one
    // physical directory twice.
    if (candidateReal === ownReal || seen.has(candidateReal)) {
      continue;
    }
    seen.add(candidateReal);

    let neighborAddress: string | undefined;
    let neighborNetwork: string | undefined;
    try {
      const { yaml } = await readAgentPublic({
        name: candidate.name,
        dir: candidate.dir,
        source: candidate.source,
        shadowsGlobal: false,
      });
      const solana = yaml.payments.find((entry) => entry.chain === 'solana');
      neighborAddress = solana?.address;
      neighborNetwork = solana?.network;
    } catch {
      continue;
    }
    if (neighborAddress !== payoutAddress || neighborNetwork !== network) {
      continue;
    }

    // Skills are read only AFTER the pair matches: this is the expensive half,
    // and it opens files inside somebody else's directory.
    const paid = await neighborPaidState(candidate.dir, network);
    if (paid === false) {
      continue;
    }
    neighbors.push({
      name: candidate.name,
      // Sanitized, and newlines collapsed SEPARATELY: the sanitizer deletes
      // every C0/C1 control except tab and newline, and a newline in a POSIX
      // path is legal - left alone it would break the banner across lines. Two
      // different defenses, and neither substitutes for the other: the name is
      // checked by a pattern that admits nothing the sanitizer touches, while
      // the path carries an operator's project root that nobody validates.
      // `\s+` would be wrong here - it would eat the legitimate double spaces
      // and tabs a real path can carry, and the printed path would stop
      // matching the one on disk.
      dir: deleteControlCharacters(candidate.dir).replace(/\n+/g, ' '),
      paid,
    });
  }
  return neighbors;
}

/**
 * Does this neighbor serve anything paid?
 *
 * `true`, `false`, or `'unknown'` - and the third is not a nicety. The loader
 * collapses an unreadable `skills/` and a skipped subdirectory into the same
 * empty list, so "no paid skills" and "I could not see" are indistinguishable
 * from its answer alone. Counting the denominator ourselves is what separates
 * them, and the count is over subdirectories whose `SKILL.md` EXISTS AND READS -
 * not over `readdir` entries, or a stray `.DS_Store` would tip every neighbor
 * into `'unknown'` forever.
 */
async function neighborPaidState(
  neighborDir: string,
  network: Network,
): Promise<true | false | 'unknown'> {
  const skillsDir = agentPaths(neighborDir).skills;
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch (error) {
    // ENOENT is absolute - there is no directory. Anything else (EACCES,
    // ENOTDIR) may be a fact about OUR process rather than about the agent,
    // whose own process may read it perfectly well.
    return (error as { code?: string }).code === 'ENOENT' ? false : 'unknown';
  }

  let denominator = 0;
  let sawLess = false;
  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }
    } catch {
      sawLess = true;
      continue;
    }
    const skillMd = join(entryPath, 'SKILL.md');
    try {
      const stats = statSync(skillMd);
      // A blocking node here would hang the synchronous read below and take the
      // event loop with it, so the loader is not called for this neighbor at
      // all - the whole neighbor goes `'unknown'`, whatever else is in
      // `skills/`. Not "not a regular file": a directory answers EISDIR at once
      // and is a signal of its own.
      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        return 'unknown';
      }
      readFileSync(skillMd, 'utf-8');
      denominator += 1;
    } catch (error) {
      // ENOENT on SKILL.md is NOT a signal: a subdirectory without one simply
      // is not in the denominator. Anything else is.
      if ((error as { code?: string }).code !== 'ENOENT') {
        sawLess = true;
      }
    }
  }

  let skills: Skill[];
  try {
    skills = loadSkillsFromDir(skillsDir, {
      network,
      allowFreeSkills: true,
      allowX402Skills: true,
      logger: { warn: () => {} },
    });
  } catch {
    return 'unknown';
  }
  if (skills.some((skill) => skill.priceSubunits > 0n)) {
    return true;
  }
  // Symmetric in both directions: a paid skill among those loaded wins
  // outright; with none loaded the answer depends on whether we saw everything.
  return sawLess || skills.length < denominator ? 'unknown' : false;
}
