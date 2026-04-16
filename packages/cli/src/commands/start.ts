/**
 * Start command - run agent in provider mode.
 * Loads all skills, publishes per-capability cards, processes jobs with per-capability pricing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  ElisymClient,
  ElisymIdentity,
  MediaService,
  formatSol,
  RELAYS,
  DEFAULTS,
  DEFAULT_KIND_OFFSET,
  jobRequestKind,
  type CapabilityCard,
} from '@elisym/sdk';
import { address, createSolanaRpc } from '@solana/kit';
import { loadConfig, listAgents } from '../config.js';
import {
  getRpcUrl,
  HEARTBEAT_INTERVAL_MS,
  MAX_CONCURRENT_JOBS,
  RECOVERY_MAX_RETRIES,
  RECOVERY_INTERVAL_SECS,
} from '../helpers.js';
import { JobLedger } from '../ledger.js';
import { createLlmClient } from '../llm';
import { AgentRuntime, type RuntimeConfig } from '../runtime.js';
import { SkillRegistry, type SkillContext } from '../skill';
import { loadSkillsFromDir } from '../skill/loader.js';
import { NostrTransport } from '../transport/nostr.js';
import { startWatchdog } from '../watchdog.js';

export async function cmdStart(name: string | undefined): Promise<void> {
  // -- Step 1: Resolve agent name --
  if (!name) {
    const agents = listAgents();
    if (agents.length === 0) {
      console.log('No agents configured. Run `elisym init` first.');
      process.exit(1);
    }
    const { default: inquirer } = await import('inquirer');
    const choices = [...agents, { name: '+ Create new agent', value: '__new__' }];
    const { selected } = await inquirer.prompt([
      { type: 'list', name: 'selected', message: 'Select agent to start', choices },
    ]);
    if (selected === '__new__') {
      const { cmdInit } = await import('./init.js');
      await cmdInit();

      return;
    }
    name = selected;
  }

  // -- Step 2: Load config (with optional passphrase for encrypted keys) --
  const config = await loadConfigWithPrompt(name!);

  // -- Step 3: Banner + starting message --
  console.log(`\n  Starting agent ${name}...\n`);

  // -- Step 4: Resolve Solana address and show balance --
  let solanaAddress: string | undefined;
  if (config.payments?.length) {
    const solPayment = config.payments.find((p) => p.chain === 'solana');
    if (solPayment) {
      solanaAddress = solPayment.address;
    }
  }

  const walletNetwork = config.payments?.find((p) => p.chain === 'solana')?.network ?? 'devnet';

  if (solanaAddress) {
    try {
      const rpcUrl = getRpcUrl(walletNetwork);
      const rpc = createSolanaRpc(rpcUrl);
      const walletAddress = address(solanaAddress);
      const { value: balanceLamports } = await rpc.getBalance(walletAddress).send();
      const balance = Number(balanceLamports);

      console.log('  Wallet');
      console.log(`     Network  ${walletNetwork}`);
      console.log(`     Address  ${solanaAddress}`);
      if (process.env.SOLANA_RPC_URL) {
        console.log(`     RPC      ${process.env.SOLANA_RPC_URL} (custom)`);
      }
      console.log(`     Balance  ${formatSol(balance)} (${balance} lamports)`);

      if (balance === 0) {
        if (walletNetwork === 'mainnet') {
          console.log(
            '  ! Warning: wallet is empty. First incoming payment needs rent-exempt SOL (~0.00089 SOL).',
          );
        } else {
          console.log('  ! Wallet is empty. Get devnet SOL: https://faucet.solana.com');
        }
      }
      if (walletNetwork === 'mainnet' && !process.env.SOLANA_RPC_URL) {
        console.log(
          '  ! Warning: using public Solana RPC for mainnet. Set SOLANA_RPC_URL for reliable operation.',
        );
      }
      console.log();
    } catch (e: any) {
      console.warn(`  ! Wallet error: ${e.message}\n`);
    }
  }

  // -- Step 5: LLM check --
  if (!config.llm) {
    console.error('  ! No LLM configured. Run `elisym init` to set up LLM.\n');
    process.exit(1);
  }

  // -- Step 6: Load and register all skills --
  const skillsDir = join(process.cwd(), 'skills');
  const allSkills = loadSkillsFromDir(skillsDir);

  if (allSkills.length === 0) {
    console.error(`  ! No skills found in ${skillsDir}\n`);
    console.error('  Create a skill directory with a SKILL.md to get started.');
    console.error('  Example: ./skills/my-skill/SKILL.md\n');
    process.exit(1);
  }

  const registry = new SkillRegistry();
  for (const skill of allSkills) {
    registry.register(skill);
    const price = skill.priceLamports > 0 ? formatSol(skill.priceLamports) : 'free';
    console.log(`  * Skill: ${skill.name} [${skill.capabilities.join(', ')}] - ${price}`);
  }
  console.log();

  // Validate that paid skills have a Solana address configured
  const hasPaid = allSkills.some((s) => s.priceLamports > 0);
  if (hasPaid && !solanaAddress) {
    console.error('  ! Paid skills require a Solana address. Run `elisym init` to configure.\n');
    process.exit(1);
  }

  // -- Step 8: Build LLM client --
  const llm = createLlmClient({
    provider: config.llm!.provider as any,
    apiKey: config.llm!.api_key,
    model: config.llm!.model,
    maxTokens: config.llm!.max_tokens,
    logUsage: true,
  });

  const skillCtx: SkillContext = {
    llm,
    agentName: config.identity.name,
    agentDescription: config.identity.description ?? '',
  };

  // -- Step 9: Connect to relays --
  console.log('  Connecting to relays and publishing capabilities...');

  const identity = ElisymIdentity.fromHex(config.identity.secret_key);
  const relays = config.relays?.length ? config.relays : [...RELAYS];
  const client = new ElisymClient({ relays });

  // -- Step 10: Upload skill images (image_file -> image URL in SKILL.md) --
  const media = new MediaService();

  for (const skill of allSkills) {
    if (skill.image || !skill.imageFile) {
      continue;
    }
    // Upload local file and write URL back to SKILL.md
    try {
      const filePath = join(skillsDir, skill.name, skill.imageFile);
      console.log(`  Uploading ${basename(filePath)}...`);
      const data = readFileSync(filePath);
      const blob = new Blob([data]);
      const url = await media.upload(identity, blob, basename(filePath));
      console.log(`  Uploaded: ${url}`);
      skill.image = url;

      // Write URL back to SKILL.md so it's not re-uploaded next time
      const skillMdPath = join(skillsDir, skill.name, 'SKILL.md');
      const mdContent = readFileSync(skillMdPath, 'utf-8');
      const updated = mdContent.replace(/^(image_file:\s*.+)$/m, (m) => `${m}\nimage: ${url}`);
      writeFileSync(skillMdPath, updated);
    } catch (e: any) {
      console.warn(`  ! Failed to upload image for "${skill.name}": ${e.message}`);
    }
  }

  // -- Step 11: Publish kind:0 profile --
  try {
    await client.discovery.publishProfile(
      identity,
      config.identity.name,
      config.identity.description ?? '',
      config.identity.picture,
      config.identity.banner,
    );
  } catch (e: any) {
    console.warn(`  ! Failed to publish profile: ${e.message}`);
  }

  // -- Step 11: Publish per-skill capability cards (kind:31990) --
  const kinds = [jobRequestKind(DEFAULT_KIND_OFFSET)];

  function buildCard(skill: (typeof allSkills)[0]): CapabilityCard {
    return {
      name: skill.name,
      description: skill.description,
      capabilities: skill.capabilities,
      image: skill.image,
      payment: solanaAddress
        ? {
            chain: 'solana',
            network: walletNetwork,
            address: solanaAddress,
            job_price: skill.priceLamports,
          }
        : undefined,
    };
  }

  for (const skill of allSkills) {
    try {
      await client.discovery.publishCapability(identity, buildCard(skill), kinds);
    } catch (e: any) {
      console.warn(`  ! Failed to publish "${skill.name}": ${e.message}`);
    }
  }

  // -- Step 12: Clean up stale capabilities from relay --
  try {
    const existingEvents = await client.pool.querySync({
      kinds: [31990],
      authors: [identity.publicKey],
      '#t': ['elisym'],
    });
    const skillNames = new Set(allSkills.map((s) => s.name));
    for (const ev of existingEvents) {
      const dTag = ev.tags.find((t: string[]) => t[0] === 'd')?.[1];
      if (!dTag) {
        continue;
      }
      // Parse card to get original name
      try {
        const card = JSON.parse(ev.content);
        if (card.name && !skillNames.has(card.name)) {
          await client.discovery.deleteCapability(identity, card.name);
          console.log(`  Removed stale capability: ${card.name}`);
        }
      } catch {
        // malformed event, skip
      }
    }
  } catch {
    // non-fatal: stale cards will expire naturally
  }

  console.log('  Connected.\n');

  // -- Step 13: Prepare ping responder (watchdog owns the subscription) --
  const onPing = (senderPubkey: string, nonce: string): void => {
    client.ping.sendPong(identity, senderPubkey, nonce).catch(() => {});
  };

  // -- Step 14: Start heartbeat (republish first card to update lastSeen) --
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (allSkills.length > 0) {
    const heartbeatCard = buildCard(allSkills[0]!);
    heartbeatTimer = setInterval(async () => {
      try {
        await client.discovery.publishCapability(identity, heartbeatCard, kinds);
      } catch {
        /* heartbeat failure is non-fatal */
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // -- Step 15: Build transport + ledger + runtime --
  const transport = new NostrTransport(client, identity, [DEFAULT_KIND_OFFSET]);
  const ledger = new JobLedger(name!);

  const runtimeConfig: RuntimeConfig = {
    paymentTimeoutSecs: DEFAULTS.PAYMENT_EXPIRY_SECS,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    recoveryMaxRetries: RECOVERY_MAX_RETRIES,
    recoveryIntervalSecs: RECOVERY_INTERVAL_SECS,
    network: walletNetwork,
    solanaAddress,
  };

  const logWithIndent = (msg: string): void => console.log(`  ${msg}`);

  const watchdog = startWatchdog({
    client,
    identity,
    transport,
    onPing,
    log: logWithIndent,
  });

  const runtime = new AgentRuntime(transport, registry, skillCtx, runtimeConfig, ledger, {
    onJobReceived: (job) => {
      const cap = job.tags.find((t) => t !== 'elisym') ?? 'unknown';
      console.log(`  [job] ${job.jobId.slice(0, 16)} | cap=${cap}`);
    },
    onJobCompleted: (jobId) => {
      console.log(`  [job] ${jobId.slice(0, 16)} | delivered`);
    },
    onJobError: (jobId, error) => {
      console.error(`  [job] ${jobId.slice(0, 16)} | error: ${error}`);
    },
    onLog: logWithIndent,
    onStop: () => {
      watchdog.stop();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    },
  });

  // -- Step 16: Run --
  console.log('  * Running. Press Ctrl+C to stop.\n');
  await runtime.run();
}

const MAX_PASSPHRASE_ATTEMPTS = 3;

async function loadConfigWithPrompt(name: string) {
  const envPassphrase = process.env.ELISYM_PASSPHRASE;
  try {
    return loadConfig(name, envPassphrase);
  } catch (e: any) {
    const isEncryptedConfigError = /encrypted but no passphrase/i.test(e?.message ?? '');
    const isWrongPassphrase = /Decryption failed/i.test(e?.message ?? '');
    if (!isEncryptedConfigError && !isWrongPassphrase) {
      throw e;
    }
    if (!process.stdin.isTTY) {
      throw e;
    }
  }

  const { default: inquirer } = await import('inquirer');
  for (let attempt = 1; attempt <= MAX_PASSPHRASE_ATTEMPTS; attempt += 1) {
    const { passphrase } = await inquirer.prompt([
      {
        type: 'password',
        name: 'passphrase',
        message: 'Passphrase to decrypt secrets:',
        mask: '*',
      },
    ]);
    try {
      return loadConfig(name, passphrase);
    } catch (e: any) {
      if (!/Decryption failed/i.test(e?.message ?? '')) {
        throw e;
      }
      const remaining = MAX_PASSPHRASE_ATTEMPTS - attempt;
      if (remaining === 0) {
        console.error('  ! Wrong passphrase. Aborting.');
        process.exit(1);
      }
      console.error(`  ! Wrong passphrase. ${remaining} attempt(s) left.`);
    }
  }
  throw new Error('Unreachable');
}
