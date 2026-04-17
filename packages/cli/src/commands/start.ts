/**
 * Start command - run agent in provider mode.
 * Loads all skills from agentDir/skills/, publishes per-capability cards,
 * processes jobs with per-capability pricing, caches uploaded media URLs.
 */
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
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
import {
  agentPaths,
  hashFile,
  listAgents,
  loadAgent,
  lookupCachedUrl,
  newCacheEntry,
  readMediaCache,
  writeMediaCache,
  type LoadedAgent,
  type MediaCache,
} from '@elisym/sdk/agent-store';
import { address, createSolanaRpc } from '@solana/kit';
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

export async function cmdStart(nameArg: string | undefined): Promise<void> {
  const cwd = process.cwd();

  // -- Step 1: Resolve agent name --
  const agentName = await resolveStartAgentName(nameArg, cwd);
  if (!agentName) {
    return;
  }

  // -- Step 2: Load agent (with optional passphrase for encrypted keys) --
  const loaded = await loadAgentWithPrompt(agentName, cwd);

  // -- Step 3: Banner --
  console.log(`\n  Starting agent ${agentName} (${loaded.source})...\n`);
  if (loaded.shadowsGlobal) {
    console.log(
      `  ! Using project-local ${agentName} (shadows global agent in ~/.elisym/${agentName}/)\n`,
    );
  }

  // -- Step 4: Resolve Solana address and show balance --
  const solPayment = loaded.yaml.payments.find((entry) => entry.chain === 'solana');
  const solanaAddress = solPayment?.address;
  const walletNetwork = solPayment?.network ?? 'devnet';

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
        console.log('  ! Wallet is empty. Get devnet SOL: https://faucet.solana.com');
      }
      console.log();
    } catch (e: any) {
      console.warn(`  ! Wallet error: ${e.message}\n`);
    }
  }

  // -- Step 5: LLM check --
  if (!loaded.yaml.llm) {
    console.error('  ! No LLM configured. Run `elisym init` to set up LLM.\n');
    process.exit(1);
  }
  if (!loaded.secrets.llm_api_key) {
    console.error(
      `  ! No LLM API key. Set ${loaded.yaml.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} env var or update the agent's secrets.\n`,
    );
    process.exit(1);
  }

  // -- Step 6: Load and register all skills --
  const paths = agentPaths(loaded.dir);
  const skillsDir = paths.skills;
  const allSkills = loadSkillsFromDir(skillsDir);

  if (allSkills.length === 0) {
    console.error(`  ! No skills found in ${skillsDir}\n`);
    console.error('  Create a skill directory with a SKILL.md to get started.');
    console.error(`  Example: ${skillsDir}/my-skill/SKILL.md\n`);
    process.exit(1);
  }

  const registry = new SkillRegistry();
  for (const skill of allSkills) {
    registry.register(skill);
    const price = skill.priceLamports > 0 ? formatSol(skill.priceLamports) : 'free';
    console.log(`  * Skill: ${skill.name} [${skill.capabilities.join(', ')}] - ${price}`);
  }
  console.log();

  // Validate that paid skills have a Solana address configured.
  const hasPaid = allSkills.some((s) => s.priceLamports > 0);
  if (hasPaid && !solanaAddress) {
    console.error('  ! Paid skills require a Solana address. Run `elisym init` to configure.\n');
    process.exit(1);
  }

  // -- Step 7: Build LLM client --
  const llm = createLlmClient({
    provider: loaded.yaml.llm.provider as any,
    apiKey: loaded.secrets.llm_api_key,
    model: loaded.yaml.llm.model,
    maxTokens: loaded.yaml.llm.max_tokens,
    logUsage: true,
  });

  const skillCtx: SkillContext = {
    llm,
    agentName,
    agentDescription: loaded.yaml.description ?? '',
  };

  // -- Step 8: Connect to relays --
  console.log('  Connecting to relays and publishing capabilities...');

  const identity = ElisymIdentity.fromHex(loaded.secrets.nostr_secret_key);
  const relays = loaded.yaml.relays.length > 0 ? loaded.yaml.relays : [...RELAYS];
  const client = new ElisymClient({ relays });

  // -- Step 9: Resolve media URLs via cache (no SKILL.md mutation) --
  const media = new MediaService();
  const mediaCache = await readMediaCache(loaded.dir);
  let mediaCacheDirty = false;

  const pictureUrl = await resolveMediaField(
    loaded.yaml.picture,
    loaded.dir,
    mediaCache,
    media,
    identity,
    (updated) => (mediaCacheDirty = mediaCacheDirty || updated),
  );
  const bannerUrl = await resolveMediaField(
    loaded.yaml.banner,
    loaded.dir,
    mediaCache,
    media,
    identity,
    (updated) => (mediaCacheDirty = mediaCacheDirty || updated),
  );

  for (const skill of allSkills) {
    if (skill.image || !skill.imageFile) {
      continue;
    }
    const skillRoot = join(skillsDir, skill.name);
    const cacheKey = `./skills/${skill.name}/${skill.imageFile}`;
    const absPath = join(skillRoot, skill.imageFile);
    const url = await uploadOrReuse(
      cacheKey,
      absPath,
      mediaCache,
      media,
      identity,
      () => (mediaCacheDirty = true),
    );
    if (url) {
      skill.image = url;
    }
  }

  if (mediaCacheDirty) {
    await writeMediaCache(loaded.dir, mediaCache);
  }

  // -- Step 10: Publish kind:0 profile --
  try {
    await client.discovery.publishProfile(
      identity,
      agentName,
      loaded.yaml.description ?? '',
      pictureUrl,
      bannerUrl,
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
  const ledger = new JobLedger(paths.jobs);

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

/** Resolve a YAML media field (picture/banner) - URL returned as-is, local path uploaded via cache. */
async function resolveMediaField(
  value: string | undefined,
  agentDir: string,
  cache: MediaCache,
  media: MediaService,
  identity: ElisymIdentity,
  onCacheUpdate: (updated: boolean) => void,
): Promise<string | undefined> {
  if (!value) {
    return undefined;
  }
  if (isRemoteUrl(value)) {
    return value;
  }
  const absPath = isAbsolute(value) ? value : join(agentDir, value);
  return uploadOrReuse(value, absPath, cache, media, identity, () => onCacheUpdate(true));
}

/** Look up `cacheKey` in cache; if hit returns URL, else uploads and updates cache. */
async function uploadOrReuse(
  cacheKey: string,
  absPath: string,
  cache: MediaCache,
  media: MediaService,
  identity: ElisymIdentity,
  onCacheUpdate: () => void,
): Promise<string | undefined> {
  try {
    const cached = await lookupCachedUrl(cache, cacheKey, absPath);
    if (cached) {
      return cached;
    }
    console.log(`  Uploading ${basename(absPath)}...`);
    const data = readFileSync(absPath);
    const blob = new Blob([data]);
    const url = await media.upload(identity, blob, basename(absPath));
    const sha256 = await hashFile(absPath);
    cache[cacheKey] = newCacheEntry(url, sha256);
    onCacheUpdate();
    console.log(`  Uploaded: ${url}`);
    return url;
  } catch (e: any) {
    console.warn(`  ! Failed to upload ${basename(absPath)}: ${e.message}`);
    return undefined;
  }
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

const MAX_PASSPHRASE_ATTEMPTS = 3;

/**
 * Resolve the agent to start. Returns undefined when the user picked
 * "+ Create new agent" and the init wizard ran - the caller should exit.
 */
async function resolveStartAgentName(
  nameArg: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (nameArg) {
    return nameArg;
  }
  const agents = await listAgents(cwd);
  if (agents.length === 0) {
    console.log('No agents configured. Run `elisym init` first.');
    process.exit(1);
  }
  const { default: inquirer } = await import('inquirer');
  const choices = [
    ...agents.map((agent) => ({
      name: `${agent.name} (${agent.source}${agent.shadowsGlobal ? ' - shadows global' : ''})`,
      value: agent.name,
    })),
    { name: '+ Create new agent', value: '__new__' },
  ];
  const { selected } = await inquirer.prompt([
    { type: 'list', name: 'selected', message: 'Select agent to start', choices },
  ]);
  if (selected === '__new__') {
    const { cmdInit } = await import('./init.js');
    await cmdInit();
    return undefined;
  }
  return selected;
}

async function loadAgentWithPrompt(name: string, cwd: string): Promise<LoadedAgent> {
  const envPassphrase = process.env.ELISYM_PASSPHRASE;
  try {
    return await loadAgent(name, cwd, envPassphrase);
  } catch (e: any) {
    const isEncrypted = /encrypted secrets/i.test(e?.message ?? '');
    const isWrongPassphrase = /Decryption failed/i.test(e?.message ?? '');
    if (!isEncrypted && !isWrongPassphrase) {
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
      return await loadAgent(name, cwd, passphrase);
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
