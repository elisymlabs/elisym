/**
 * Start command - run agent in provider mode.
 * Loads all skills from agentDir/skills/, publishes per-capability cards,
 * processes jobs with per-capability pricing, caches uploaded media URLs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  ElisymClient,
  ElisymIdentity,
  MediaService,
  USDC_SOLANA_DEVNET,
  formatAssetAmount,
  formatSol,
  RELAYS,
  DEFAULTS,
  DEFAULT_KIND_OFFSET,
  jobRequestKind,
  toDTag,
  type CapabilityCard,
} from '@elisym/sdk';
import {
  agentPaths,
  listAgents,
  loadAgent,
  lookupCachedUrl,
  newCacheEntry,
  readMediaCache,
  writeMediaCache,
  type LoadedAgent,
  type MediaCache,
} from '@elisym/sdk/agent-store';
import { LlmHealthMonitor, startLlmHeartbeat, type HeartbeatHandle } from '@elisym/sdk/llm-health';
import { address, createSolanaRpc } from '@solana/kit';
import { probeRelays } from '../diagnostics.js';
import {
  fetchUsdcBalance,
  getRpcUrl,
  MAX_CONCURRENT_JOBS,
  RECOVERY_MAX_RETRIES,
  RECOVERY_INTERVAL_SECS,
} from '../helpers.js';
import { JobLedger } from '../ledger.js';
import {
  createLlmClient,
  getLlmProvider,
  listLlmProviders,
  verifyLlmApiKeyDeep,
  type LlmConfig,
  type LlmProvider,
} from '../llm';
import { cacheKeyFor, resolveTripleForOverride } from '../llm/cache.js';
import { resolveProviderApiKey } from '../llm/keys.js';
import { resolveSkillLlm, type ResolvedSkillLlm } from '../llm/resolve.js';
import { createLogger } from '../logging.js';
import { AgentRuntime, type RuntimeConfig } from '../runtime.js';
import { SkillRegistry, type SkillContext, type SkillLlmOverride } from '../skill';
import type { LlmClient } from '../skill/index.js';
import { loadSkillsFromDir } from '../skill/loader.js';
import { NostrTransport } from '../transport/nostr.js';
import { startWatchdog } from '../watchdog.js';

export interface StartOptions {
  verbose?: boolean;
}

export async function cmdStart(
  nameArg: string | undefined,
  options: StartOptions = {},
): Promise<void> {
  const cwd = process.cwd();

  // -- Step 1: Resolve agent name --
  const agentName = await resolveStartAgentName(nameArg, cwd);
  if (!agentName) {
    return;
  }

  // -- Step 2: Load agent (with optional passphrase for encrypted keys) --
  const loaded = await loadAgentWithPrompt(agentName, cwd);

  // -- Step 2b: Set up structured logger early so publish / config
  //   debug events fire before connectivity is established.
  const verbose =
    options.verbose === true ||
    process.env.ELISYM_DEBUG === '1' ||
    process.env.LOG_LEVEL === 'debug';
  const { logger, logWithIndent } = createLogger({
    verbose,
    tty: Boolean(process.stdout.isTTY),
  });

  // -- Step 3: Banner --
  console.log(`\n  Starting agent ${agentName} (${loaded.source})...\n`);
  if (loaded.shadowsGlobal) {
    console.log(
      `  ! Using project-local ${agentName} (shadows global agent in ~/.elisym/${agentName}/)\n`,
    );
  }
  if (verbose) {
    console.log('  [debug] Verbose logging enabled. Structured diagnostics -> stderr.');
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
      const [{ value: balanceLamports }, usdcBalance] = await Promise.all([
        rpc.getBalance(walletAddress).send(),
        fetchUsdcBalance(rpc, walletAddress),
      ]);
      const balance = Number(balanceLamports);

      console.log('  Wallet');
      console.log(`     Network  ${walletNetwork}`);
      console.log(`     Address  ${solanaAddress}`);
      if (process.env.SOLANA_RPC_URL) {
        console.log(`     RPC      ${process.env.SOLANA_RPC_URL} (custom)`);
      }
      console.log(`     SOL      ${formatSol(balance)} (${balance} lamports)`);
      console.log(`     USDC     ${formatAssetAmount(USDC_SOLANA_DEVNET, usdcBalance)}`);

      if (balance === 0) {
        console.log('  ! Wallet is empty. Get devnet SOL: https://faucet.solana.com');
      }
      console.log();
    } catch (e: any) {
      console.warn(`  ! Wallet error: ${e.message}\n`);
    }
  }

  // -- Step 5: Load and register all skills --
  // Skills load before the LLM check so a fully-non-LLM agent can start
  // without an API key. The LLM block below runs only when at least one
  // skill has `mode === 'llm'`.
  //
  // `scriptEnv` propagates decrypted per-provider keys (e.g. ANTHROPIC_API_KEY)
  // into `dynamic-script` / `static-script` subprocesses, so script skills get
  // the same secret access LLM-mode skills already have. Existing process.env
  // values win when no per-agent secret is set, matching the priority used by
  // resolveProviderApiKey for LLM-mode skills.
  const scriptEnv: NodeJS.ProcessEnv = { ...process.env };
  const llmKeys = loaded.secrets.llm_api_keys ?? {};
  for (const descriptor of listLlmProviders()) {
    const secretValue = llmKeys[descriptor.id];
    if (typeof secretValue === 'string' && secretValue.length > 0) {
      scriptEnv[descriptor.envVar] = secretValue;
    }
  }
  const paths = agentPaths(loaded.dir);
  const skillsDir = paths.skills;
  const allSkills = loadSkillsFromDir(skillsDir, { scriptEnv });

  if (allSkills.length === 0) {
    console.error(`  ! No skills found in ${skillsDir}\n`);
    console.error('  Create a skill directory with a SKILL.md to get started.');
    console.error(`  Example: ${skillsDir}/my-skill/SKILL.md\n`);
    process.exit(1);
  }

  const registry = new SkillRegistry();
  for (const skill of allSkills) {
    registry.register(skill);
    const price =
      skill.priceSubunits > 0
        ? formatAssetAmount(skill.asset, BigInt(skill.priceSubunits))
        : 'free';
    console.log(`  * Skill: ${skill.name} [${skill.capabilities.join(', ')}] - ${price}`);
  }
  console.log();

  // Validate that paid skills have a Solana address configured.
  const hasPaid = allSkills.some((s) => s.priceSubunits > 0);
  if (hasPaid && !solanaAddress) {
    console.error(
      '  ! Paid skills require a Solana address. Run `npx @elisym/cli profile` to configure.\n',
    );
    process.exit(1);
  }

  // -- Step 6: LLM check (only when at least one skill needs it) --
  // Per-skill LLM resolution. Each `mode: 'llm'` skill resolves to a concrete
  // (provider, model, maxTokens) triple. Agent-level `llm` in elisym.yaml is
  // the fallback for skills that don't override; if every LLM skill overrides,
  // agent-level `llm` may be omitted entirely.
  const llmSkills = allSkills.filter((skill) => skill.mode === 'llm');
  const triplesByKey = new Map<string, ResolvedSkillLlm>();
  const dependentSkillsByProvider = new Map<LlmProvider, string[]>();
  let agentDefaultCacheKey: string | undefined;
  const llmClientCache = new Map<string, LlmClient>();
  const healthMonitor = new LlmHealthMonitor();

  if (llmSkills.length > 0) {
    const resolutionErrors: string[] = [];

    for (const skill of llmSkills) {
      const skillMdPath = join(skillsDir, skill.name, 'SKILL.md');
      const result = resolveSkillLlm(
        { skillName: skill.name, skillMdPath, llmOverride: skill.llmOverride },
        loaded.yaml.llm,
      );
      if ('error' in result) {
        resolutionErrors.push(result.error);
        continue;
      }
      const cacheKey = cacheKeyFor(result);
      triplesByKey.set(cacheKey, result);
      skill.resolvedTriple = {
        provider: result.provider,
        model: result.model,
        maxTokens: result.maxTokens,
      };
      const list = dependentSkillsByProvider.get(result.provider) ?? [];
      list.push(skill.name);
      dependentSkillsByProvider.set(result.provider, list);
    }

    if (resolutionErrors.length > 0) {
      for (const message of resolutionErrors) {
        console.error(`  ! ${message}`);
      }
      console.error('');
      process.exit(1);
    }

    if (loaded.yaml.llm) {
      const agentDefaultTriple: ResolvedSkillLlm = {
        provider: loaded.yaml.llm.provider as LlmProvider,
        model: loaded.yaml.llm.model,
        maxTokens: loaded.yaml.llm.max_tokens,
      };
      const agentKey = cacheKeyFor(agentDefaultTriple);
      if (triplesByKey.has(agentKey)) {
        agentDefaultCacheKey = agentKey;
      }
    }

    // Resolve + verify each provider's API key once.
    const keyByProvider = new Map<LlmProvider, string>();
    const keyErrors: string[] = [];
    for (const [provider, dependents] of dependentSkillsByProvider) {
      const keyResult = resolveProviderApiKey({
        provider,
        secrets: loaded.secrets,
        dependentSkills: dependents,
      });
      if ('error' in keyResult) {
        keyErrors.push(keyResult.error);
        continue;
      }
      keyByProvider.set(provider, keyResult.apiKey);
    }
    if (keyErrors.length > 0) {
      for (const message of keyErrors) {
        console.error(`  ! ${message}`);
      }
      console.error('');
      process.exit(1);
    }

    // Deep-verify each unique (provider, model) pair the agent will use.
    // Deep verification consumes one billing token per probe (~$0.00001
    // on Haiku) but distinguishes valid keys from billing-exhausted ones,
    // which `/v1/models` cannot.
    for (const [, triple] of triplesByKey) {
      const apiKey = keyByProvider.get(triple.provider);
      if (!apiKey) {
        continue;
      }
      const envVar =
        getLlmProvider(triple.provider)?.envVar ?? `${triple.provider.toUpperCase()}_API_KEY`;
      process.stdout.write(`  Verifying ${triple.provider} ${triple.model}... `);
      const verification = await verifyLlmApiKeyDeep(triple.provider, apiKey, triple.model);
      const descriptor = getLlmProvider(triple.provider);
      const verifyFn = async (signal?: AbortSignal) =>
        descriptor
          ? descriptor.verifyKeyDeep(apiKey, triple.model, signal)
          : { ok: false as const, reason: 'unavailable' as const, error: 'no descriptor' };
      healthMonitor.register({
        provider: triple.provider,
        model: triple.model,
        verifyFn,
      });
      healthMonitor.seed(triple.provider, triple.model, verification);
      if (verification.ok) {
        console.log('ok');
      } else if (verification.reason === 'invalid') {
        console.log('INVALID');
        console.error(`  ! ${triple.provider} rejected the API key (HTTP ${verification.status}).`);
        console.error(
          `    Update it via \`npx @elisym/cli profile ${agentName}\` or set ${envVar} to a valid key.\n`,
        );
        process.exit(1);
      } else if (verification.reason === 'billing') {
        console.log('BILLING');
        const detail = verification.body ? ` ${verification.body.slice(0, 200)}` : '';
        console.error(
          `  ! ${triple.provider} reports a billing/quota issue for ${triple.model}.${detail}`,
        );
        console.error(
          `    Top up the account at the provider console, or set ${envVar} to a key on a funded org.\n`,
        );
        process.exit(1);
      } else {
        console.log('unavailable');
        console.warn(
          `  ! Could not verify ${triple.provider} ${triple.model} (${verification.error}). Continuing - jobs will fail if the key is invalid.\n`,
        );
      }
    }

    // Eager client construction. One LlmClient per unique triple.
    for (const [cacheKey, triple] of triplesByKey) {
      const apiKey = keyByProvider.get(triple.provider);
      if (!apiKey) {
        // Should never happen - keyByProvider is built from the same provider
        // set as the triples. Defensive guard for type narrowing.
        console.error(`  ! Internal error: no API key for provider "${triple.provider}".\n`);
        process.exit(1);
      }
      const config: LlmConfig = {
        provider: triple.provider,
        apiKey,
        model: triple.model,
        maxTokens: triple.maxTokens,
        logUsage: true,
      };
      llmClientCache.set(cacheKey, createLlmClient(config));
    }
  } else {
    console.log('  No LLM skills loaded; skipping LLM key check.\n');
  }

  const agentDefaultClient =
    agentDefaultCacheKey !== undefined ? llmClientCache.get(agentDefaultCacheKey) : undefined;

  const getLlm = (override?: SkillLlmOverride): LlmClient | undefined => {
    const triple = resolveTripleForOverride(override, loaded.yaml.llm);
    if (!triple) {
      return undefined;
    }
    return llmClientCache.get(cacheKeyFor(triple));
  };

  const skillCtx: SkillContext = {
    llm: agentDefaultClient,
    getLlm,
    agentName,
    agentDescription: loaded.yaml.description ?? '',
  };

  // -- Step 8: Connect to relays --
  console.log('  Connecting to relays and publishing capabilities...');

  const identity = ElisymIdentity.fromHex(loaded.secrets.nostr_secret_key);
  const relays = loaded.yaml.relays.length > 0 ? loaded.yaml.relays : [...RELAYS];
  const client = new ElisymClient({ relays });

  // Opt-in DNS + TCP connectivity probe for WSL / Windows / corporate
  // firewall troubleshooting. Runs once before publish so the operator
  // sees the result in the startup banner.
  if (process.env.ELISYM_NET_DIAG === '1') {
    console.log('  [net-diag] Probing relay DNS + TCP connectivity...');
    const results = await probeRelays(relays, logger);
    for (const result of results) {
      const ipSummary = result.ips.length > 0 ? result.ips.join(',') : '-';
      if (result.tcpOpenMs !== undefined) {
        console.log(`  [net-diag] ${result.url} -> ${ipSummary} TCP open in ${result.tcpOpenMs}ms`);
      } else {
        console.log(`  [net-diag] ${result.url} -> ${ipSummary} FAILED: ${result.error ?? '?'}`);
      }
    }
  }

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
    if (skill.image || !skill.imageFile || !skill.dir) {
      continue;
    }
    const skillRoot = skill.dir;
    const folderName = basename(skillRoot);
    const cacheKey = `./skills/${folderName}/${skill.imageFile}`;
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
  let profilePublished = false;
  try {
    await client.discovery.publishProfile(
      identity,
      loaded.yaml.display_name ?? agentName,
      loaded.yaml.description ?? '',
      pictureUrl,
      bannerUrl,
    );
    profilePublished = true;
    logger.debug({ event: 'publish_ack', kind: 0 }, 'profile published');
  } catch (e: any) {
    console.warn(`  ! Failed to publish profile: ${e.message}`);
    logger.warn({ event: 'publish_failed', kind: 0, error: e.message }, 'profile publish failed');
  }

  // -- Step 11: Publish per-skill capability cards (kind:31990) --
  const kinds = [jobRequestKind(DEFAULT_KIND_OFFSET)];

  function buildCard(skill: (typeof allSkills)[0]): CapabilityCard {
    const isStatic = skill.mode === 'static-file' || skill.mode === 'static-script';
    return {
      name: skill.name,
      description: skill.description,
      capabilities: skill.capabilities,
      image: skill.image,
      ...(isStatic ? { static: true } : {}),
      payment: solanaAddress
        ? {
            chain: 'solana',
            network: walletNetwork,
            address: solanaAddress,
            job_price: skill.priceSubunits,
            token: skill.asset.token,
            ...(skill.asset.mint ? { mint: skill.asset.mint } : {}),
            decimals: skill.asset.decimals,
            symbol: skill.asset.symbol,
          }
        : undefined,
    };
  }

  let cardsPublished = 0;
  for (const skill of allSkills) {
    try {
      await client.discovery.publishCapability(identity, buildCard(skill), kinds);
      cardsPublished += 1;
      logger.debug(
        { event: 'publish_ack', kind: 31990, skill: skill.name },
        'capability card published',
      );
    } catch (e: any) {
      console.warn(`  ! Failed to publish "${skill.name}": ${e.message}`);
      logger.warn(
        { event: 'publish_failed', kind: 31990, skill: skill.name, error: e.message },
        'capability publish failed',
      );
    }
  }

  // -- Step 12: Clean up stale capabilities from relay --
  try {
    const existingEvents = await client.pool.querySync({
      kinds: [31990],
      authors: [identity.publicKey],
      '#t': ['elisym'],
    });
    // Compare by d-tag, not card.name. toDTag() is lossy (e.g. "WHOIS Lookup"
    // and "whois-lookup" collapse to the same d-tag), so name-based comparison
    // can flag a card whose d-tag actually matches an active skill - the
    // resulting deletion event then replaces the freshly-published card on the
    // relay (kind:31990 is replaceable by author+kind+d-tag).
    const skillDTags = new Set(allSkills.map((s) => toDTag(s.name)));
    for (const ev of existingEvents) {
      const dTag = ev.tags.find((t: string[]) => t[0] === 'd')?.[1];
      if (!dTag || skillDTags.has(dTag)) {
        continue;
      }
      try {
        const card = JSON.parse(ev.content);
        if (card.name) {
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
  if (verbose) {
    console.log(
      `  [debug] Published: profile=${profilePublished ? 'ok' : 'FAILED'} + ${cardsPublished}/${allSkills.length} capability cards (kind:31990)`,
    );
    console.log(`  [debug] Relays: ${relays.length} configured (${relays.join(', ')})`);
  }

  // -- Step 13: Prepare ping responder (watchdog owns the subscription) --
  const onPing = (senderPubkey: string, nonce: string): void => {
    client.ping.sendPong(identity, senderPubkey, nonce).catch(() => {});
  };

  // -- Step 14: Build transport + ledger + runtime --
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

  // Custom SOLANA_RPC_URL values (Helius, Alchemy, QuickNode) routinely
  // embed API keys in the query string. Strip query + auth before logging
  // so `--verbose` never publishes a third-party RPC credential.
  const rpcUrlForLog = stripRpcSecrets(process.env.SOLANA_RPC_URL ?? getRpcUrl(walletNetwork));
  logger.debug(
    {
      event: 'config_resolved',
      agent: agentName,
      source: loaded.source,
      network: walletNetwork,
      relays,
      solanaAddress,
      rpcUrl: rpcUrlForLog,
    },
    'config resolved',
  );

  // Tee: banner-style indent line on stdout (existing UX) + structured
  // stderr pino entry with shared redact paths (defence against future
  // slips where a diagnostic string might embed user input).
  const diagLog = (msg: string): void => {
    logWithIndent(msg);
    logger.info({ event: 'runtime_diag' }, msg);
  };

  const watchdog = startWatchdog({
    client,
    identity,
    transport,
    onPing,
    log: diagLog,
    logger,
  });

  let llmHeartbeat: HeartbeatHandle | undefined;
  if (llmSkills.length > 0) {
    llmHeartbeat = startLlmHeartbeat({
      monitor: healthMonitor,
      log: diagLog,
    });
    diagLog('LLM health monitor armed (10min TTL, 10min heartbeat).');
  }

  const runtime = new AgentRuntime(
    transport,
    registry,
    skillCtx,
    runtimeConfig,
    ledger,
    {
      onJobReceived: (job) => {
        const cap = job.tags.find((t) => t !== 'elisym') ?? 'unknown';
        // Never log job.input here - capability tag is the only descriptor needed.
        process.stdout.write(`  [job] ${job.jobId.slice(0, 16)} | cap=${cap}\n`);
        logger.info({ event: 'job_received', jobId: job.jobId, capability: cap });
      },
      onJobCompleted: (jobId) => {
        process.stdout.write(`  [job] ${jobId.slice(0, 16)} | delivered\n`);
        logger.info({ event: 'job_delivered', jobId });
      },
      onJobError: (jobId, error) => {
        process.stderr.write(`  [job] ${jobId.slice(0, 16)} | error: ${error}\n`);
        logger.error({ event: 'job_error', jobId, error });
      },
      onLog: diagLog,
      onStop: () => {
        watchdog.stop();
        llmHeartbeat?.stop();
      },
    },
    healthMonitor,
  );

  // -- Step 15: Run --
  console.log('  * Running. Press Ctrl+C to stop.\n');
  await runtime.run();
}

/**
 * Return a log-safe representation of an RPC URL. Strips any userinfo
 * and query string so credentials embedded by third-party RPC
 * providers (Helius/Alchemy/QuickNode style `?api-key=...`) never land
 * in verbose stderr output.
 */
export function stripRpcSecrets(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    const marker = parsed.search.length > 0 ? '?***' : '';
    parsed.search = '';
    return `${parsed.toString()}${marker}`;
  } catch {
    return '[unparseable RPC URL]';
  }
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
  const absPath = resolveInsideAgentDir(value, agentDir);
  if (!absPath) {
    console.warn(`  ! Skipping media field "${value}": path must stay inside the agent directory.`);
    return undefined;
  }
  return uploadOrReuse(value, absPath, cache, media, identity, () => onCacheUpdate(true));
}

/**
 * Resolve a YAML-supplied path against `agentDir` and reject anything that
 * escapes the agent directory (`..` segments, absolute paths outside it).
 * Returns null on rejection so callers can warn and skip the field.
 */
function resolveInsideAgentDir(value: string, agentDir: string): string | null {
  const agentRoot = resolve(agentDir);
  const candidate = resolve(agentRoot, value);
  const rel = relative(agentRoot, candidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return null;
  }
  return candidate;
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
    const sha256 = createHash('sha256').update(data).digest('hex');
    const blob = new Blob([data]);
    const url = await media.upload(identity, blob, basename(absPath));
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
    console.log('No agents configured. Run `npx @elisym/cli init` first.');
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
