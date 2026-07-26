/**
 * `elisym x402 add <url> [agent]` - turn any x402-paid HTTP endpoint into an
 * elisym bridge skill. Probes the live 402 challenge, enforces the
 * single-wallet invariant (generate/import + payments[] write-back),
 * computes a margin-aware price, and generates `skills/<slug>/SKILL.md`
 * with `mode: x402`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  LIMITS,
  USDC_SOLANA_DEVNET,
  calculateProtocolFee,
  encodeSecretKeyBase58,
  formatAssetAmount,
  getProtocolConfig,
  getProtocolProgramId,
  generateSolanaWallet,
  signerFromSecretKeyBase58,
  toDTag,
} from '@elisym/sdk';
import {
  ensureGitignoreHasX402Entries,
  listAgents,
  loadAgent,
  writeSecrets,
  writeYaml,
} from '@elisym/sdk/agent-store';
import {
  DEFAULT_X402_MAX_INPUT_BYTES,
  parseSkillMd,
  validateSkillFrontmatter,
} from '@elisym/sdk/skills';
import { address, createSolanaRpc } from '@solana/kit';
import chalk from 'chalk';
import Decimal from 'decimal.js-light';
import YAML from 'yaml';
import { fetchUsdcBalance, getRpcUrl } from '../helpers.js';
import { requirementAmount, selectAcceptableRequirement } from '../x402/matcher.js';
import { X402ProbeError, probePaymentRequired, type X402ProbeResult } from '../x402/probe.js';

export interface X402AddOptions {
  method?: string;
  queryParam?: string;
  marginBps?: string;
  name?: string;
  generateWallet?: boolean;
  yes?: boolean;
}

const BPS_DENOMINATOR = 10_000;
const DEFAULT_MARGIN_BPS = 1_000;
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const CIRCLE_FAUCET_URL = 'https://faucet.circle.com';

function fail(message: string): never {
  console.error(`\n  ! ${message}\n`);
  process.exit(1);
}

/** Strip control chars and the (repo-banned) em dash from upstream-controlled text. */
export function sanitizeUpstreamText(raw: string, maxLength: number): string {
  let withoutControls = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    withoutControls += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return withoutControls.replace(/—/g, '-').replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

export function slugFromUrl(url: URL): string {
  const pathPart = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '';
  const host = url.hostname.replace(/^www\./, '').split('.')[0] ?? 'x402';
  return pathPart.length > 0 ? `${host}-${pathPart}` : host;
}

function parseMarginBps(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_MARGIN_BPS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    fail(`--margin-bps must be a non-negative integer (bps, 100 = 1%); got "${raw}"`);
  }
  return value;
}

/**
 * Import a wallet secret: solana-keygen JSON file (64-byte array) or a
 * base58 string. Throws on anything unparseable (the command maps it to a
 * clean exit); accepting the keygen JSON matters because the provider docs
 * hand exactly that file (`provider-wallet.json`) to every operator.
 */
export async function parseImportedSecret(input: string): Promise<string> {
  const trimmed = input.trim();
  if (existsSync(trimmed)) {
    const content = await readFile(trimmed, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`${trimmed} is not a valid solana-keygen JSON file`);
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      parsed.some(
        (byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255,
      )
    ) {
      throw new Error(`${trimmed} must contain a JSON array of 64 bytes (solana-keygen format)`);
    }
    return encodeSecretKeyBase58(new Uint8Array(parsed as number[]));
  }
  try {
    await signerFromSecretKeyBase58(trimmed);
  } catch {
    throw new Error('not a readable file and not a valid base58-encoded 64-byte secret key');
  }
  return trimmed;
}

/**
 * Customer price from the upstream quote: `ceil(quote * (1 + margin) / (1 - fee))`,
 * pure integer bps math. Guarantees net revenue (price minus the ceil'd
 * protocol fee) covers `quote * (1 + margin)`.
 */
export function computeBridgePriceSubunits(
  quote: bigint,
  marginBps: number,
  feeBps: number,
): bigint {
  if (feeBps >= BPS_DENOMINATOR) {
    throw new Error(`feeBps ${feeBps} >= ${BPS_DENOMINATOR} - refusing zero/negative denominator`);
  }
  return BigInt(
    new Decimal(quote.toString())
      .mul(BPS_DENOMINATOR + marginBps)
      .div(BPS_DENOMINATOR - feeBps)
      .toDecimalPlaces(0, Decimal.ROUND_CEIL)
      .toString(),
  );
}

export interface SkillMdInput {
  skillName: string;
  description: string;
  capabilities: string[];
  priceDisplay: string;
  url: string;
  method: 'GET' | 'POST';
  queryParam?: string;
  quote: bigint;
  marginPercent: string;
  feePercent: string;
}

/**
 * Render SKILL.md with the WHOLE frontmatter serialized by the yaml package
 * (never template literals): name/description come from an untrusted
 * upstream, and a newline in a hand-rolled template would be frontmatter
 * injection (e.g. smuggling `price: 0`).
 */
export function buildSkillMd(input: SkillMdInput): string {
  const frontmatter: Record<string, unknown> = {
    name: input.skillName,
    description: input.description,
    capabilities: input.capabilities,
    price: input.priceDisplay,
    token: 'usdc',
    mode: 'x402',
    x402_url: input.url,
    x402_method: input.method,
    ...(input.queryParam !== undefined ? { x402_query_param: input.queryParam } : {}),
    x402_max_upstream: Number(input.quote),
    // GET input is dominated by the ~2KB percent-encoded query-string limit,
    // so the byte cap is written for POST bridges only.
    ...(input.method === 'POST' ? { x402_max_input_bytes: DEFAULT_X402_MAX_INPUT_BYTES } : {}),
  };
  const bodyLines = [
    `# ${input.skillName}`,
    '',
    'Operator notes for this x402 bridge skill (the executor ignores this body):',
    '',
    `- Upstream: ${input.url} (${input.method})`,
    `- Upstream quote at generation time: ${formatAssetAmount(USDC_SOLANA_DEVNET, input.quote)} (= x402_max_upstream, the signing ceiling)`,
    `- Price: ${input.priceDisplay} USDC (margin ${input.marginPercent}%, protocol fee ${input.feePercent}% at generation time)`,
    '- To reprice after an upstream change, re-run:',
    '',
    '```bash',
    `npx @elisym/cli x402 add ${input.url}`,
    '```',
  ];
  return `---\n${YAML.stringify(frontmatter)}---\n\n${bodyLines.join('\n')}\n`;
}

interface ExistingSkillScan {
  /** Directory of an existing bridge skill for the SAME upstream URL (update flow). */
  sameUrlDir?: string;
  sameUrlName?: string;
  /** Name of an existing skill whose d-tag collides with the candidate name. */
  dTagCollision?: string;
}

/**
 * Collisions are keyed on `toDTag(frontmatter name)`, NOT the folder name:
 * kind:31990 cards are replaceable by (pubkey, kind, d-tag), so a colliding
 * name would silently replace another skill's live card on the relays and
 * misroute its paid jobs.
 */
export function scanExistingSkills(
  skillsDir: string,
  candidateDTag: string,
  url: string,
): ExistingSkillScan {
  const scan: ExistingSkillScan = {};
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return scan;
  }
  for (const entry of entries) {
    const skillMdPath = join(skillsDir, entry, 'SKILL.md');
    try {
      if (!statSync(join(skillsDir, entry)).isDirectory()) {
        continue;
      }
      const { frontmatter } = parseSkillMd(readFileSync(skillMdPath, 'utf-8'));
      if (typeof frontmatter.name !== 'string') {
        continue;
      }
      if (typeof frontmatter.x402_url === 'string' && frontmatter.x402_url === url) {
        scan.sameUrlDir = join(skillsDir, entry);
        scan.sameUrlName = frontmatter.name;
        continue;
      }
      // One degenerate neighbor must not kill the whole scan.
      let existingDTag: string;
      try {
        existingDTag = toDTag(frontmatter.name);
      } catch {
        continue;
      }
      if (existingDTag === candidateDTag) {
        scan.dTagCollision = frontmatter.name;
      }
    } catch {
      continue;
    }
  }
  return scan;
}

function describeUnacceptableAccepts(probe: X402ProbeResult): string {
  const networks = [...new Set(probe.accepts.map((requirement) => String(requirement.network)))];
  if (networks.length > 0 && networks.every((network) => network.startsWith('eip155:'))) {
    return `the service accepts only EVM networks (${networks.join(', ')}) - not supported yet`;
  }
  if (networks.some((network) => network === SOLANA_MAINNET_CAIP2 || network === 'solana')) {
    return 'the service settles on Solana mainnet - elisym currently runs on devnet (mainnet is on the roadmap)';
  }
  return `no exact-scheme devnet-USDC requirement found (service accepts: ${networks.join(', ') || 'nothing parseable'})`;
}

export async function cmdX402Add(
  url: string,
  agentName: string | undefined,
  options: X402AddOptions,
): Promise<void> {
  const cwd = process.cwd();
  const { default: inquirer } = await import('inquirer');

  // -- URL + method --
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`"${url}" is not a valid URL`);
  }
  // Mirrors the SDK loader rule: loopback http is fine (local demo/test
  // servers), anything remote must be https - payment headers over plain
  // http leak to the network.
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isLoopback)) {
    fail('the upstream must be an https:// URL (plain http is allowed for localhost only)');
  }
  const methodRaw = (options.method ?? 'POST').toUpperCase();
  if (methodRaw !== 'GET' && methodRaw !== 'POST') {
    fail(`--method must be GET or POST; got "${options.method}"`);
  }
  const method = methodRaw as 'GET' | 'POST';
  const marginBps = parseMarginBps(options.marginBps);

  // -- Agent --
  if (!agentName) {
    const agents = await listAgents(cwd);
    if (agents.length === 0) {
      fail('no agents found - create one first: npx @elisym/cli init');
    }
    if (options.yes) {
      fail('--yes needs an explicit agent argument: elisym x402 add <url> <agent> --yes');
    }
    const { selected } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selected',
        message: 'Add the bridge skill to which agent?',
        choices: agents.map((agent) => ({
          name: `${agent.name} (${agent.source})`,
          value: agent.name,
        })),
      },
    ]);
    agentName = selected as string;
  }
  const passphrase = process.env.ELISYM_PASSPHRASE;
  const loaded = await loadAgent(agentName, cwd, passphrase);

  // -- Probe the live 402 --
  console.log(`\n  Probing ${url} (${method}, unpaid)...`);
  let probe: X402ProbeResult;
  try {
    probe = await probePaymentRequired(url, method);
  } catch (error) {
    if (error instanceof X402ProbeError) {
      fail(error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    fail(`upstream unreachable: ${message}`);
  }
  const anyCeiling = { maxUpstreamSubunits: BigInt(Number.MAX_SAFE_INTEGER) };
  const requirement = selectAcceptableRequirement(probe.accepts, anyCeiling);
  if (requirement === undefined) {
    fail(describeUnacceptableAccepts(probe));
  }
  const quote = requirementAmount(requirement);
  if (quote === null || quote <= 0n) {
    fail('the upstream quote is not a positive integer amount');
  }

  // -- Wallet: single-wallet invariant --
  let solanaSecretKey = loaded.secrets.solana_secret_key;
  if (solanaSecretKey === undefined || solanaSecretKey.length === 0) {
    let choice: 'generate' | 'import';
    if (options.yes || options.generateWallet) {
      if (!options.generateWallet) {
        fail(
          'this agent has no Solana wallet key. Run interactively to generate/import one, or pass --generate-wallet (a money-holding key is never created silently under --yes).',
        );
      }
      choice = 'generate';
    } else {
      const { walletChoice } = await inquirer.prompt([
        {
          type: 'list',
          name: 'walletChoice',
          message:
            'The bridge pays the upstream from the agent wallet, but .secrets.json has no solana_secret_key:',
          choices: [
            { name: 'Generate a new wallet', value: 'generate' },
            { name: 'Import an existing one (solana-keygen JSON file or base58)', value: 'import' },
          ],
        },
      ]);
      choice = walletChoice as 'generate' | 'import';
    }
    if (choice === 'generate') {
      const wallet = await generateSolanaWallet();
      solanaSecretKey = wallet.secretKeyBase58;
    } else {
      const { imported } = await inquirer.prompt([
        {
          // Masked: a pasted base58 secret key must not echo to the terminal
          // scrollback (matches every other secret prompt in the CLI). A file
          // path can still be pasted/drag-dropped under the mask.
          type: 'password',
          mask: '*',
          name: 'imported',
          message: 'Path to a solana-keygen JSON file (or paste a base58 secret key):',
        },
      ]);
      try {
        solanaSecretKey = await parseImportedSecret(imported as string);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    // Isolation invariant (reciprocal of `delegate-key`'s guard): the payment
    // wallet must differ from the dedicated delegate key, else a single
    // compromise both drains the wallet AND acts as delegate for every owner
    // who approved it. `delegate-key` blocks a colliding delegate; block the
    // colliding payment key here too, so importing the delegate key as the
    // wallet cannot slip through in the reverse order.
    if (loaded.secrets.solana_delegate_secret_key) {
      const paymentSigner = await signerFromSecretKeyBase58(solanaSecretKey);
      const delegateSigner = await signerFromSecretKeyBase58(
        loaded.secrets.solana_delegate_secret_key,
      );
      if (paymentSigner.address === delegateSigner.address) {
        fail(
          'the wallet key equals this agent delegate key (solana_delegate_secret_key). ' +
            'They must differ for blast-radius isolation - import a different wallet key or rotate the delegate key.',
        );
      }
    }
    await writeSecrets(
      loaded.dir,
      { ...loaded.secrets, solana_secret_key: solanaSecretKey },
      passphrase,
    );
    console.log('  Wallet key saved to .secrets.json');
  }
  const signer = await signerFromSecretKeyBase58(solanaSecretKey);

  const solPayment = loaded.yaml.payments.find((entry) => entry.chain === 'solana');
  if (solPayment !== undefined && solPayment.address !== signer.address) {
    fail(
      `wallet invariant violated: elisym.yaml payments[].address (${solPayment.address}) differs from the solana_secret_key address (${signer.address}).\n` +
        '    Revenue must land in the wallet the bridge spends from, or the float never refills.\n' +
        '    Fix: set payments[].address to the key address, or import the matching key.',
    );
  }
  if (solPayment === undefined) {
    // Without a payments[] entry publishCapability throws at start and the
    // bridge silently gets no discovery - never let the invariant pass vacuously.
    console.log(
      `  elisym.yaml has no Solana payments entry; adding address ${signer.address} (devnet).`,
    );
    await writeYaml(loaded.dir, {
      ...loaded.yaml,
      payments: [
        ...loaded.yaml.payments,
        { chain: 'solana', network: 'devnet', address: signer.address },
      ],
    });
  }

  // -- Balance + protocol fee --
  const rpc = createSolanaRpc(getRpcUrl('devnet'));
  const balance = await fetchUsdcBalance(rpc, address(signer.address));
  let feeBps: number;
  try {
    const protocolConfig = await getProtocolConfig(rpc, getProtocolProgramId('devnet'), {
      forceRefresh: true,
    });
    feeBps = protocolConfig.feeBps;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`could not read the on-chain protocol config (fee): ${message}`);
  }
  if (feeBps >= BPS_DENOMINATOR) {
    fail(
      `protocol fee is ${feeBps} bps (>= 100%) - price math would divide by zero or go negative`,
    );
  }

  // -- Price: ceil(quote * (1 + margin) / (1 - fee)), integer bps math --
  const priceSubunits = computeBridgePriceSubunits(quote, marginBps, feeBps);
  const priceDisplay = new Decimal(priceSubunits.toString())
    .div(new Decimal(10).pow(USDC_SOLANA_DEVNET.decimals))
    .toString();
  const protocolFee = calculateProtocolFee(Number(priceSubunits), feeBps);
  const netMargin = priceSubunits - BigInt(protocolFee) - quote;

  // -- Name / description / capabilities (upstream-controlled - sanitize) --
  const fallbackName = slugFromUrl(parsedUrl);
  const rawName = options.name ?? probe.resource?.serviceName ?? fallbackName;
  const skillName = sanitizeUpstreamText(rawName, LIMITS.MAX_AGENT_NAME_LENGTH);
  if (!/[a-zA-Z0-9]/.test(skillName)) {
    fail(
      `the upstream service name ("${rawName}") has no ASCII letters or digits - pass an explicit --name <skill-name>`,
    );
  }
  const candidateDTag = toDTag(skillName);
  const description = sanitizeUpstreamText(
    probe.resource?.description ?? `x402 bridge to ${parsedUrl.hostname}`,
    LIMITS.MAX_DESCRIPTION_LENGTH,
  );
  const capabilities = [candidateDTag];

  // -- Collision checks (d-tag first, then folder) --
  const skillsDir = join(loaded.dir, 'skills');
  const scan = scanExistingSkills(skillsDir, candidateDTag, url);
  let targetDir = join(skillsDir, candidateDTag);
  if (scan.sameUrlDir !== undefined) {
    if (!options.yes) {
      const { update } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'update',
          message: `Skill "${scan.sameUrlName}" already bridges this URL - regenerate it with the fresh quote?`,
          default: true,
        },
      ]);
      if (!(update as boolean)) {
        fail('aborted');
      }
    }
    targetDir = scan.sameUrlDir;
  } else if (scan.dTagCollision !== undefined) {
    fail(
      `the generated name "${skillName}" collides with existing skill "${scan.dTagCollision}" ` +
        `(both map to d-tag "${candidateDTag}", which would replace its live discovery card) - pass a distinct --name`,
    );
  } else if (existsSync(targetDir)) {
    fail(`skill directory ${targetDir} already exists - pass a distinct --name`);
  }

  // -- GET input mapping --
  let queryParam = options.queryParam;
  if (method === 'GET' && queryParam === undefined && !options.yes) {
    const { param } = await inquirer.prompt([
      {
        type: 'input',
        name: 'param',
        message:
          'GET upstream: which query parameter should carry the buyer input? (empty = the skill takes no input)',
      },
    ]);
    queryParam = (param as string).trim() === '' ? undefined : (param as string).trim();
  }
  if (queryParam !== undefined && parsedUrl.searchParams.has(queryParam)) {
    fail(`--query-param "${queryParam}" collides with a parameter already present in the URL`);
  }
  if (method === 'POST' && queryParam !== undefined) {
    fail('--query-param only applies to GET upstreams (POST maps the input to the request body)');
  }
  const noInput = method === 'GET' && queryParam === undefined;

  // -- Summary --
  const feePercent = new Decimal(feeBps).div(100).toString();
  const marginPercent = new Decimal(marginBps).div(100).toString();
  console.log('');
  console.log(`  ${chalk.bold(skillName)}`);
  console.log(`  ${description}`);
  console.log('');
  console.log(
    `  Upstream     ${url} (${method}${queryParam !== undefined ? `, input in ?${queryParam}=` : ''}${noInput ? ', no buyer input' : ''})`,
  );
  console.log(`  Quote        ${formatAssetAmount(USDC_SOLANA_DEVNET, quote)}`);
  console.log(
    `  Your price   ${formatAssetAmount(USDC_SOLANA_DEVNET, priceSubunits)}  (margin ${marginPercent}% + protocol fee ${feePercent}%)`,
  );
  console.log(`  Net margin   ${formatAssetAmount(USDC_SOLANA_DEVNET, netMargin)} per job`);
  console.log(
    `  Float        ${formatAssetAmount(USDC_SOLANA_DEVNET, balance)} in ${signer.address}`,
  );
  if (balance < quote) {
    console.log(
      chalk.yellow(
        `  ! Float below one upstream quote - fund the wallet with devnet USDC: ${CIRCLE_FAUCET_URL}`,
      ),
    );
  }
  console.log(`  Skill dir    ${targetDir}`);
  console.log('');
  if (!options.yes) {
    const { confirmed } = await inquirer.prompt([
      { type: 'confirm', name: 'confirmed', message: 'Write the skill?', default: true },
    ]);
    if (!(confirmed as boolean)) {
      fail('aborted');
    }
  }

  // -- Generate SKILL.md --
  const content = buildSkillMd({
    skillName,
    description,
    capabilities,
    priceDisplay,
    url,
    method,
    queryParam,
    quote,
    marginPercent,
    feePercent,
  });

  // Round-trip through the real loader before touching disk: a generation
  // bug must fail HERE, not at the next `start`.
  const roundTrip = parseSkillMd(content);
  validateSkillFrontmatter(roundTrip.frontmatter, roundTrip.systemPrompt, {
    allowFreeSkills: false,
    allowX402Skills: true,
  });

  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, 'SKILL.md'), content, 'utf-8');
  await ensureGitignoreHasX402Entries(dirname(loaded.dir));

  console.log(`\n  Wrote ${join(targetDir, 'SKILL.md')}`);
  if (balance < quote) {
    console.log(`  Next: fund the float (devnet USDC): ${CIRCLE_FAUCET_URL}`);
  }
  console.log(`  Start the agent: npx @elisym/cli start ${agentName}\n`);
}
