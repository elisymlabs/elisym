/**
 * Start command - run agent in provider mode.
 * Loads all skills from agentDir/skills/, publishes per-capability cards,
 * processes jobs with per-capability pricing, caches uploaded media URLs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  ElisymClient,
  ElisymIdentity,
  type BlossomService,
  createBlossomTransport,
  USDC_SOLANA_DEVNET,
  formatAssetAmount,
  formatSol,
  RELAYS,
  DEFAULTS,
  DEFAULT_KIND_OFFSET,
  KIND_LONG_FORM_ARTICLE,
  POLICY_D_TAG_PREFIX,
  POLICY_T_TAG,
  getProtocolConfig,
  getProtocolProgramId,
  jobRequestKind,
  signerFromSecretKeyBase58,
  toDTag,
  type CapabilityCard,
} from '@elisym/sdk';
import {
  agentPaths,
  ensureGitignoreHasIrohEntry,
  ensureGitignoreHasSessionsEntry,
  ensureGitignoreHasX402Entries,
  listAgents,
  loadAgent,
  loadPoliciesFromDir,
  lookupCachedUrl,
  newCacheEntry,
  readMediaCache,
  writeMediaCache,
  type LoadedAgent,
  type MediaCache,
} from '@elisym/sdk/agent-store';
import { LlmHealthMonitor, startLlmRecovery, type HeartbeatHandle } from '@elisym/sdk/llm-health';
import { createIrohTransport } from '@elisym/sdk/node';
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
import { createLogger, sanitizeForTerminal } from '../logging.js';
import { mimeFromPath } from '../mime.js';
import { AgentRuntime, type RuntimeConfig } from '../runtime.js';
import { SessionStore } from '../sessions.js';
import { SkillRegistry, type SkillContext, type SkillLlmOverride } from '../skill';
import type { LlmClient } from '../skill/index.js';
import { loadSkillsFromDir } from '../skill/loader.js';
import { NostrTransport } from '../transport/nostr.js';
import { startWatchdog } from '../watchdog.js';
import { X402Driver } from '../x402/driver.js';

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
        // FIX #10: a custom SOLANA_RPC_URL routinely carries an API key in its
        // userinfo / query / path - redact before printing to the banner.
        console.log(`     RPC      ${stripRpcSecrets(process.env.SOLANA_RPC_URL)} (custom)`);
      }
      console.log(`     SOL      ${formatSol(balance)} (${balance} lamports)`);
      console.log(`     USDC     ${formatAssetAmount(USDC_SOLANA_DEVNET, usdcBalance)}`);

      if (balance === 0) {
        console.log('  ! Wallet is empty. Get devnet SOL: https://faucet.solana.com');
      }
      console.log();
    } catch (e: any) {
      // `@solana/kit` transport errors routinely interpolate the request URL, which
      // can carry a Helius/Alchemy/QuickNode API key - scrub before it hits the banner.
      const message = typeof e?.message === 'string' ? e.message : String(e);
      console.warn(`  ! Wallet error: ${redactRpcUrlsInText(message)}\n`);
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
  // ELISYM_PASSPHRASE decrypts `.secrets.json` (Nostr + Solana secret keys) at rest.
  // A skill script - which may be third-party SKILL.md installed under the agent dir -
  // has no legitimate use for it, and leaking it would let the script read the on-disk
  // secrets and defeat the AES-256-GCM + scrypt at-rest encryption entirely. The
  // per-provider LLM keys added below ARE intentional (scripts proxy to LLMs); the
  // passphrase is not. (The LLM-tool subprocess path already strips secrets via
  // scriptSkill's SECRET_ENV_VARS; this closes the same gap on the script path.)
  delete scriptEnv.ELISYM_PASSPHRASE;
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
  //
  // Script-mode skills can also declare `provider` + `model` in SKILL.md to
  // register a health-monitor probe for the API key the script uses under
  // the hood. Those skills do NOT need an LlmClient (the script makes its
  // own HTTP calls), but they DO need: an API key resolved + verified at
  // startup, and a (provider, model) pair registered with the health
  // monitor so reactive markUnhealthy + lazy recovery works.
  const llmSkills = allSkills.filter((skill) => skill.mode === 'llm');
  const scriptDepSkills = allSkills.filter(
    (skill) => skill.mode !== 'llm' && skill.llmOverride?.provider && skill.llmOverride?.model,
  );
  // Pairs to register with the health monitor (any mode + declared provider+model).
  // Keyed by `provider::model`; deduplicated across skills so we don't probe
  // the same key twice when several skills share the same LLM dependency.
  const monitorPairs = new Map<string, { provider: LlmProvider; model: string }>();
  // `provider::model` keys whose model returned HTTP 404 at deep-verify (the
  // provider retired it). Skills bound to these are not advertised (Step 11) so
  // the gateway keeps serving its other models instead of offering a capability
  // that can never be fulfilled.
  const retiredModels = new Set<string>();
  // Triples to build LlmClient instances for (mode=llm only).
  const triplesByKey = new Map<string, ResolvedSkillLlm>();
  const dependentSkillsByProvider = new Map<LlmProvider, string[]>();
  let agentDefaultCacheKey: string | undefined;
  const llmClientCache = new Map<string, LlmClient>();
  const healthMonitor = new LlmHealthMonitor();

  if (llmSkills.length > 0 || scriptDepSkills.length > 0) {
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
      monitorPairs.set(`${result.provider}::${result.model}`, {
        provider: result.provider,
        model: result.model,
      });
      skill.resolvedTriple = {
        provider: result.provider,
        model: result.model,
        maxTokens: result.maxTokens,
      };
      const list = dependentSkillsByProvider.get(result.provider) ?? [];
      list.push(skill.name);
      dependentSkillsByProvider.set(result.provider, list);
    }

    // Script-mode skills: register their declared (provider, model) for
    // health monitoring. No LlmClient is built - the script does its own
    // HTTP. The all-or-nothing parse invariant guarantees both `provider`
    // and `model` are set when we reach this branch (validateLlmOverride).
    for (const skill of scriptDepSkills) {
      const provider = skill.llmOverride?.provider as LlmProvider;
      const model = skill.llmOverride?.model as string;
      monitorPairs.set(`${provider}::${model}`, { provider, model });
      const list = dependentSkillsByProvider.get(provider) ?? [];
      if (!list.includes(skill.name)) {
        list.push(skill.name);
      }
      dependentSkillsByProvider.set(provider, list);
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
    // which `/v1/models` cannot. Iterates `monitorPairs` so script-mode
    // skills that declared `provider`+`model` are probed too.
    for (const [, pair] of monitorPairs) {
      const apiKey = keyByProvider.get(pair.provider);
      if (!apiKey) {
        continue;
      }
      const envVar =
        getLlmProvider(pair.provider)?.envVar ?? `${pair.provider.toUpperCase()}_API_KEY`;
      process.stdout.write(`  Verifying ${pair.provider} ${pair.model}... `);
      const verification = await verifyLlmApiKeyDeep(pair.provider, apiKey, pair.model);
      const descriptor = getLlmProvider(pair.provider);
      const verifyFn = async (signal?: AbortSignal) =>
        descriptor
          ? descriptor.verifyKeyDeep(apiKey, pair.model, signal)
          : { ok: false as const, reason: 'unavailable' as const, error: 'no descriptor' };
      healthMonitor.register({
        provider: pair.provider,
        model: pair.model,
        verifyFn,
      });
      // A retired model (HTTP 404) is permanent and per-model. Do NOT seed it:
      // its skills are not advertised below, and seeding would only add a
      // misleading "temporarily unavailable" gate for any stale-card job.
      const modelRetired =
        !verification.ok && verification.reason === 'unavailable' && verification.status === 404;
      if (!modelRetired) {
        healthMonitor.seed(pair.provider, pair.model, verification);
      }
      if (verification.ok) {
        console.log('ok');
      } else if (verification.reason === 'invalid') {
        console.log('INVALID');
        console.error(`  ! ${pair.provider} rejected the API key (HTTP ${verification.status}).`);
        console.error(
          `    Update it via \`npx @elisym/cli profile ${agentName}\` or set ${envVar} to a valid key.\n`,
        );
        process.exit(1);
      } else if (verification.reason === 'billing') {
        console.log('BILLING');
        const detail = verification.body ? ` ${verification.body.slice(0, 200)}` : '';
        console.error(
          `  ! ${pair.provider} reports a billing/quota issue for ${pair.model}.${detail}`,
        );
        console.error(
          `    Top up the account at the provider console, or set ${envVar} to a key on a funded org.\n`,
        );
        process.exit(1);
      } else if (verification.status === 404) {
        console.log('retired');
        console.error(
          `  ! ${pair.provider} model "${pair.model}" no longer exists (HTTP 404). ` +
            `Update its model: in the SKILL.md / elisym.yaml. Skills using it will not be advertised.\n`,
        );
        retiredModels.add(`${pair.provider}::${pair.model}`);
      } else {
        console.log('unavailable');
        console.warn(
          `  ! Could not verify ${pair.provider} ${pair.model} (${verification.error}). Continuing - jobs will fail if the key is invalid.\n`,
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
    console.log('  No LLM-dependent skills loaded; skipping LLM key check.\n');
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

  // -- Step 7b: x402 bridge wiring (mode 'x402' skills) --
  // Startup check of the single-wallet invariant: revenue lands at
  // payments[].address, the upstream payer spends from solana_secret_key -
  // the float is self-refilling ONLY when they are the same wallet.
  // `elisym profile` can rewrite payments[] after `x402 add`, so a broken
  // invariant must surface loudly HERE, not one refused job at a time.
  const x402Skills = allSkills.filter((skill) => skill.mode === 'x402');
  let x402InvariantBroken: string | undefined;
  if (x402Skills.length > 0) {
    const solanaSecretKey = loaded.secrets.solana_secret_key;
    if (solanaSecretKey === undefined || solanaSecretKey.length === 0) {
      x402InvariantBroken = 'no solana_secret_key in .secrets.json';
    } else if (!solanaAddress) {
      x402InvariantBroken = 'no payments[] entry in elisym.yaml';
    } else {
      const bridgeSigner = await signerFromSecretKeyBase58(solanaSecretKey);
      if (bridgeSigner.address !== solanaAddress) {
        x402InvariantBroken = `payments[].address (${solanaAddress}) differs from the solana_secret_key address (${bridgeSigner.address})`;
      }
    }
    for (const skill of x402Skills) {
      if (skill.asset.mint !== USDC_SOLANA_DEVNET.mint) {
        console.warn(
          `  ! x402 skill "${skill.name}" is priced in ${skill.asset.symbol}, not devnet USDC - every job will be refused at preflight. Re-run \`npx @elisym/cli x402 add\`.`,
        );
      }
    }
    if (x402InvariantBroken !== undefined) {
      console.warn(`  ! x402 wallet invariant broken: ${x402InvariantBroken}.`);
      console.warn(
        '  ! x402 skills will NOT be advertised and their jobs will be refused before payment.',
      );
      console.warn('  ! Fix: re-run `npx @elisym/cli x402 add` or align elisym.yaml with the key.');
    }
    const x402RpcUrl = getRpcUrl(walletNetwork);
    async function fetchLiveFeeBps(): Promise<number> {
      const config = await getProtocolConfig(
        createSolanaRpc(x402RpcUrl),
        getProtocolProgramId('devnet'),
        { forceRefresh: true },
      );
      return config.feeBps;
    }
    skillCtx.x402Driver = new X402Driver({
      agentDir: loaded.dir,
      paymentsAddress: solanaAddress,
      solanaSecretKeyBase58: loaded.secrets.solana_secret_key,
      rpcUrl: x402RpcUrl,
      getFeeBps: fetchLiveFeeBps,
      log: (message) => console.log(`  ${message}`),
    });
  }

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
  // Uploads go to the Blossom relay (client.blossom), which falls back to nostr.build on failure.
  const mediaCache = await readMediaCache(loaded.dir);
  let mediaCacheDirty = false;

  const pictureUrl = await resolveMediaField(
    loaded.yaml.picture,
    loaded.dir,
    mediaCache,
    client.blossom,
    identity,
    (updated) => (mediaCacheDirty = mediaCacheDirty || updated),
  );
  const bannerUrl = await resolveMediaField(
    loaded.yaml.banner,
    loaded.dir,
    mediaCache,
    client.blossom,
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
      client.blossom,
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

  // -- Step 10.5: Publish agent policies (NIP-23 long-form articles, kind 30023) --
  // `localPolicyDTags` is built from disk before the publish loop so a transient
  // publish failure does not cause Step 10.6 to tombstone the prior good version
  // still on the relay. Mirrors the kind:31990 cleanup in Step 12 which builds
  // `skillDTags` upfront from `allSkills` - delete-on-disk = retract-from-relay,
  // not "delete-on-failed-publish".
  const policies = existsSync(paths.policies) ? loadPoliciesFromDir(paths.policies) : [];
  const localPolicyDTags = new Set(
    policies.map((policy) => `${POLICY_D_TAG_PREFIX}${policy.type}`),
  );

  // Fetch what is already on the relays once, up front. The result drives both
  // the unchanged-skip below (Step 10.5) and the orphan sweep (Step 10.6), so we
  // pay for a single querySync per start instead of re-publishing blind. A network
  // failure returns [] - we then re-publish everything (safe) and skip the sweep.
  async function fetchPublishedPolicies() {
    try {
      return await client.pool.querySync({
        kinds: [KIND_LONG_FORM_ARTICLE],
        authors: [identity.publicKey],
        '#t': [POLICY_T_TAG],
      });
    } catch {
      return [];
    }
  }
  const publishedPolicies = await fetchPublishedPolicies();

  // Latest event per d-tag (tombstones included), so the skip compares against
  // the true live version. A tombstone is the live "deleted" state - filtering
  // tombstones out here would let an older non-empty version shadow a newer
  // tombstone and wrongly skip re-publishing a re-added policy file.
  const latestPolicyByDTag = new Map<string, (typeof publishedPolicies)[number]>();
  for (const event of publishedPolicies) {
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1];
    if (!dTag) {
      continue;
    }
    const prev = latestPolicyByDTag.get(dTag);
    if (!prev || event.created_at > prev.created_at) {
      latestPolicyByDTag.set(dTag, event);
    }
  }

  for (const policy of policies) {
    const onRelay = latestPolicyByDTag.get(`${POLICY_D_TAG_PREFIX}${policy.type}`);
    const relayVersion = onRelay?.tags.find((tag) => tag[0] === 'policy_version')?.[1];
    // `onRelay.content` excludes a tombstoned latest (empty content): a deleted
    // policy that is back on disk must be re-published, not skipped.
    if (
      onRelay &&
      onRelay.content &&
      relayVersion === policy.version &&
      onRelay.content === policy.content
    ) {
      console.log(`  * Policy: ${policy.type}@${policy.version} (unchanged, skipped)`);
      continue;
    }
    try {
      const { naddr } = await client.policies.publishPolicy(identity, policy);
      console.log(`  * Policy: ${policy.type}@${policy.version} -> ${naddr}`);
      logger.debug(
        { event: 'publish_ack', kind: KIND_LONG_FORM_ARTICLE, policy: policy.type, naddr },
        'policy published',
      );
    } catch (e: any) {
      console.warn(`  ! Failed to publish policy "${policy.type}": ${e.message}`);
      logger.warn(
        {
          event: 'publish_failed',
          kind: KIND_LONG_FORM_ARTICLE,
          policy: policy.type,
          error: e.message,
        },
        'policy publish failed',
      );
    }
  }

  // -- Step 10.6: Tombstone orphan policies (file removed from disk) --
  for (const event of publishedPolicies) {
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1];
    if (!dTag || localPolicyDTags.has(dTag)) {
      continue;
    }
    // Skip already-tombstoned events (empty content) so we don't re-publish identical retractions every start.
    if (!event.content) {
      continue;
    }
    const type = event.tags.find((tag) => tag[0] === 'policy_type')?.[1];
    if (!type) {
      continue;
    }
    try {
      await client.policies.deletePolicy(identity, type);
      console.log(`  Removed stale policy: ${type}`);
    } catch {
      // non-fatal, will retry next start
    }
  }

  // -- Step 11: Publish per-skill capability cards (kind:31990) --
  const kinds = [jobRequestKind(DEFAULT_KIND_OFFSET)];

  function buildCard(skill: (typeof allSkills)[0]): CapabilityCard {
    // `noInput` covers an x402 GET bridge without a query param: it consumes
    // no buyer input, so the web app must hide its input box (`card.static`)
    // instead of silently dropping whatever the buyer typed.
    const isStatic =
      skill.mode === 'static-file' || skill.mode === 'static-script' || skill.noInput === true;
    return {
      name: skill.name,
      description: skill.description,
      capabilities: skill.capabilities,
      image: skill.image,
      ...(isStatic ? { static: true } : {}),
      // File-exchange hints (dynamic-script only). `inputMime` flags a file input;
      // `inputText` tells the web whether to also show its text box for that file job.
      ...(skill.inputMime ? { inputMime: skill.inputMime } : {}),
      ...(skill.inputText ? { inputText: skill.inputText } : {}),
      ...(skill.outputMime ? { outputMime: skill.outputMime } : {}),
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

  function retiredModelKeyForSkill(skill: (typeof allSkills)[0]): string | undefined {
    if (skill.resolvedTriple) {
      return `${skill.resolvedTriple.provider}::${skill.resolvedTriple.model}`;
    }
    if (skill.llmOverride?.provider && skill.llmOverride?.model) {
      return `${skill.llmOverride.provider}::${skill.llmOverride.model}`;
    }
    return undefined;
  }

  let cardsPublished = 0;
  for (const skill of allSkills) {
    const modelKey = retiredModelKeyForSkill(skill);
    if (modelKey && retiredModels.has(modelKey)) {
      console.warn(`  ! Not advertising "${skill.name}" - its model was retired (HTTP 404).`);
      logger.warn(
        { event: 'publish_skipped_retired', kind: 31990, skill: skill.name, model: modelKey },
        'capability not advertised - model retired',
      );
      continue;
    }
    if (skill.mode === 'x402' && x402InvariantBroken !== undefined) {
      console.warn(`  ! Not advertising "${skill.name}" - x402 wallet invariant broken.`);
      logger.warn(
        { event: 'publish_skipped_x402_invariant', kind: 31990, skill: skill.name },
        'capability not advertised - x402 wallet invariant broken',
      );
      continue;
    }
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
  // iroh blob transport for file results, bound to a persistent fs-store at
  // <agent-dir>/.iroh/ (the node is created lazily on the first transfer).
  const irohTransport = createIrohTransport({ storePath: join(loaded.dir, '.iroh') });
  // Migration: ensure a project-local .gitignore created before `.iroh/` became a
  // default ignore entry still excludes the (cleartext) blob store.
  await ensureGitignoreHasIrohEntry(dirname(loaded.dir));
  if (x402Skills.length > 0) {
    // Same migration for the x402 idempotency cache (customer inputs/results
    // + upstream payment history) - `x402 add` also ensures this, but a
    // hand-written x402 skill must not leave the cache committable.
    await ensureGitignoreHasX402Entries(dirname(loaded.dir));
  }

  // Conversation-session gitignore migration: session transcripts hold customer
  // inputs and LLM results in cleartext, same posture as the other stores. The
  // store itself is constructed below, once the diagnostics logger exists.
  const hasContextSkills = registry.all().some((skill) => skill.context === true);
  if (hasContextSkills) {
    await ensureGitignoreHasSessionsEntry(dirname(loaded.dir));
  }

  const runtimeConfig: RuntimeConfig = {
    paymentTimeoutSecs: DEFAULTS.PAYMENT_EXPIRY_SECS,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    recoveryMaxRetries: RECOVERY_MAX_RETRIES,
    recoveryIntervalSecs: RECOVERY_INTERVAL_SECS,
    network: walletNetwork,
    solanaAddress,
    // Agent-level default execution budget; per-skill `max_execution_secs`
    // overrides it. Undefined => unlimited (operator-owned, no protocol default).
    executionTimeoutSecs: loaded.yaml.execution_timeout_secs,
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
  if (monitorPairs.size > 0) {
    llmHeartbeat = startLlmRecovery({
      monitor: healthMonitor,
      log: diagLog,
    });
    diagLog('LLM health monitor armed (lazy recovery, 5min interval).');
  }

  // Encrypted Blossom transport for job file I/O (peer to iroh). Reuses the client's BlossomService
  // (so it shares the nostr.build fallback) and the provider identity for BUD-11 auth + NIP-44 wrap.
  const blossomTransport = createBlossomTransport({ blossom: client.blossom, identity });
  // Conversation-session store, wired only when at least one skill opted in.
  const sessionStore = hasContextSkills ? new SessionStore(loaded.dir, diagLog) : undefined;
  if (sessionStore) {
    diagLog('Conversation sessions enabled (context: true skills present).');
  }
  const runtime = new AgentRuntime(
    transport,
    registry,
    skillCtx,
    runtimeConfig,
    ledger,
    {
      onJobReceived: (job) => {
        // The capability tag is an attacker-controlled Nostr tag value; strip terminal
        // control chars before it reaches stdout. Never log job.input here - the
        // capability tag is the only descriptor needed.
        const cap = sanitizeForTerminal(job.tags.find((t) => t !== 'elisym') ?? 'unknown');
        process.stdout.write(`  [job] ${job.jobId.slice(0, 16)} | cap=${cap}\n`);
        logger.info({ event: 'job_received', jobId: job.jobId, capability: cap });
      },
      onJobCompleted: (jobId) => {
        process.stdout.write(`  [job] ${jobId.slice(0, 16)} | delivered\n`);
        logger.info({ event: 'job_delivered', jobId });
      },
      onJobError: (jobId, error) => {
        const safeError = sanitizeForTerminal(error);
        process.stderr.write(`  [job] ${jobId.slice(0, 16)} | error: ${safeError}\n`);
        logger.error({ event: 'job_error', jobId, error: safeError });
      },
      onLog: diagLog,
      onStop: () => {
        watchdog.stop();
        llmHeartbeat?.stop();
      },
    },
    healthMonitor,
    irohTransport,
    identity,
    blossomTransport,
    sessionStore,
  );

  // -- Step 15: Run --
  console.log('  * Running. Press Ctrl+C to stop.\n');
  await runtime.run();
}

/**
 * Public Solana RPC hosts whose URL path carries no secret. For these the
 * path is safe to keep; every other host is treated as a third-party RPC
 * (Helius/Alchemy/QuickNode) whose path may embed an API key.
 */
const PUBLIC_SOLANA_RPC_HOSTS = new Set([
  'api.devnet.solana.com',
  'api.mainnet-beta.solana.com',
  'api.testnet.solana.com',
]);

/**
 * Return a log-safe representation of an RPC URL. Strips any userinfo and
 * query string so credentials embedded by third-party RPC providers
 * (Helius/Alchemy/QuickNode style `?api-key=...`) never land in verbose
 * stderr output or the startup banner.
 *
 * FIX #11: Alchemy/QuickNode embed the API key in the URL *path* (e.g.
 * `https://solana-mainnet.g.alchemy.com/v2/<APIKEY>`), so stripping only the
 * userinfo + query still leaks the key. For any host that is not a public
 * `api.*.solana.com` endpoint we therefore redact the path too, returning just
 * `protocol//host/***`. Public Solana hosts keep their (secret-free) path.
 */
export function stripRpcSecrets(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    if (!PUBLIC_SOLANA_RPC_HOSTS.has(parsed.hostname)) {
      // Third-party RPC: the path may carry an API key - drop it entirely.
      return `${parsed.protocol}//${parsed.host}/***`;
    }
    const marker = parsed.search.length > 0 ? '?***' : '';
    parsed.search = '';
    return `${parsed.toString()}${marker}`;
  } catch {
    return '[unparseable RPC URL]';
  }
}

/**
 * Redact any RPC URL embedded in free-form text (e.g. a thrown error message) by
 * routing every http(s) URL it contains through `stripRpcSecrets`. Used on error
 * messages that may interpolate the request URL (and thus an embedded API key)
 * while preserving the surrounding diagnostic text.
 */
export function redactRpcUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s)'"]+/g, (url) => stripRpcSecrets(url));
}

/** Resolve a YAML media field (picture/banner) - URL returned as-is, local path uploaded via cache. */
async function resolveMediaField(
  value: string | undefined,
  agentDir: string,
  cache: MediaCache,
  blossom: Pick<BlossomService, 'upload'>,
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
  return uploadOrReuse(value, absPath, cache, blossom, identity, () => onCacheUpdate(true));
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
export async function uploadOrReuse(
  cacheKey: string,
  absPath: string,
  cache: MediaCache,
  blossom: Pick<BlossomService, 'upload'>,
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
    const blob = new Blob([data], { type: mimeFromPath(absPath) });
    const descriptor = await blossom.upload(identity, blob);
    cache[cacheKey] = newCacheEntry(descriptor.url, sha256);
    onCacheUpdate();
    console.log(`  Uploaded: ${descriptor.url}`);
    return descriptor.url;
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
