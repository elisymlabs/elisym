/**
 * `elisym identity` - link, verify, and unlink external identities.
 * GitHub and X claims ride kind 10011 (NIP-39 `i` tags); the website claim is
 * the kind-0 `nip05` field (NIP-05). Claims are written to `elisym.yaml`
 * (source of truth) and published to the relays; proofs are verified live
 * with the TTL cache bypassed.
 */
import { relative, resolve, sep } from 'node:path';
import {
  ElisymClient,
  ElisymIdentity,
  GIST_ID_REGEX,
  GITHUB_USERNAME_REGEX,
  normalizeNip05Identifier,
  RELAYS,
  splitNip05Identifier,
  TWEET_ID_REGEX,
  verifyAgentIdentities,
  X_USERNAME_REGEX,
  type AgentExternalIdentity,
  type ExternalIdentityClaimInput,
  type ExternalIdentityClaimsResult,
  type IdentityVerifyStatus,
  type VerifiedIdentityResult,
  type VerifyIdentitiesOptions,
} from '@elisym/sdk';
import {
  listAgents,
  loadAgent,
  lookupCachedUrl,
  readMediaCache,
  writeYaml,
  type ElisymYaml,
  type IdentitiesEntry,
  type LoadedAgent,
  type MediaCache,
} from '@elisym/sdk/agent-store';

export type IdentityPlatform = 'github' | 'x' | 'website';

const IDENTITY_PLATFORMS: readonly IdentityPlatform[] = ['github', 'x', 'website'];

/** Hosts accepted when parsing a pasted tweet proof URL. */
const X_PROOF_URL_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

// --- Proof templates (exact NIP-39 phrasing - interop with Nostr clients) ---

/** GitHub gist proof body. No quotes around the npub. */
export function githubProofText(npub: string): string {
  return `Verifying that I control the following Nostr public key: ${npub}`;
}

/** X tweet proof body. Double quotes around the npub. */
export function xProofText(npub: string): string {
  return `Verifying my account on nostr My Public Key: "${npub}"`;
}

/** Ready-to-paste `/.well-known/nostr.json` mapping `local` to the agent's hex pubkey. */
export function websiteNostrJson(local: string, pubkeyHex: string): string {
  return JSON.stringify({ names: { [local]: pubkeyHex } }, null, 2);
}

// --- Input parsing ---

export function parseIdentityPlatform(raw: string): IdentityPlatform {
  const lowered = raw.trim().toLowerCase();
  const match = IDENTITY_PLATFORMS.find((platform) => platform === lowered);
  if (match === undefined) {
    throw new Error(`Unknown platform "${raw}". Expected github, x, or website.`);
  }
  return match;
}

export interface ParsedProofInput {
  proofId: string;
  /** Username extracted from a full proof URL (lowercased); absent for a bare id. */
  username?: string;
}

/** Accepts a bare gist id or a `https://gist.github.com/<user>/<id>[...]` URL. */
export function parseGithubProofInput(raw: string): ParsedProofInput | null {
  const trimmed = raw.trim();
  const bareId = trimmed.toLowerCase();
  if (GIST_ID_REGEX.test(bareId)) {
    return { proofId: bareId };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'gist.github.com') {
    return null;
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const [userSegment, gistSegment] = segments;
  if (userSegment === undefined || gistSegment === undefined) {
    return null;
  }
  const username = userSegment.toLowerCase();
  const gistId = gistSegment.toLowerCase();
  if (!GITHUB_USERNAME_REGEX.test(username) || !GIST_ID_REGEX.test(gistId)) {
    return null;
  }
  return { proofId: gistId, username };
}

/** Accepts a bare tweet status id or a `https://x.com/<user>/status/<id>` URL. */
export function parseXProofInput(raw: string): ParsedProofInput | null {
  const trimmed = raw.trim();
  if (TWEET_ID_REGEX.test(trimmed)) {
    return { proofId: trimmed };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !X_PROOF_URL_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const [userSegment, statusLiteral, idSegment] = segments;
  if (userSegment === undefined || statusLiteral !== 'status' || idSegment === undefined) {
    return null;
  }
  const username = userSegment.toLowerCase();
  if (!X_USERNAME_REGEX.test(username) || !TWEET_ID_REGEX.test(idSegment)) {
    return null;
  }
  return { proofId: idSegment, username };
}

// --- Yaml claim mapping ---

/** kind-10011 publish inputs from the yaml `identities` section (github/x only). */
export function buildIdentityClaimInputs(
  identities: IdentitiesEntry | undefined,
): ExternalIdentityClaimInput[] {
  const claims: ExternalIdentityClaimInput[] = [];
  if (identities?.github !== undefined) {
    claims.push({
      platform: 'github',
      handle: identities.github.username,
      proofId: identities.github.gist,
    });
  }
  if (identities?.x !== undefined) {
    claims.push({ platform: 'x', handle: identities.x.username, proofId: identities.x.tweet });
  }
  return claims;
}

/**
 * Verifiable claims (github/x/website) from the yaml `identities` section.
 * Proof URLs mirror the SDK's kind-10011 parser construction exactly, so a
 * locally-built claim compares equal to its published counterpart.
 */
export function identitiesFromYaml(
  identities: IdentitiesEntry | undefined,
): AgentExternalIdentity[] {
  const claims: AgentExternalIdentity[] = [];
  if (identities === undefined) {
    return claims;
  }
  if (identities.github !== undefined) {
    claims.push({
      platform: 'github',
      handle: identities.github.username,
      proofUrl: `https://gist.github.com/${encodeURIComponent(identities.github.username)}/${encodeURIComponent(identities.github.gist)}`,
    });
  }
  if (identities.x !== undefined) {
    claims.push({
      platform: 'x',
      handle: identities.x.username,
      proofUrl: `https://x.com/${encodeURIComponent(identities.x.username)}/status/${encodeURIComponent(identities.x.tweet)}`,
    });
  }
  if (identities.website !== undefined) {
    const identifier = normalizeNip05Identifier(identities.website);
    if (identifier !== null) {
      const { domain } = splitNip05Identifier(identifier);
      claims.push({ platform: 'website', handle: identifier, proofUrl: `https://${domain}` });
    }
  }
  return claims;
}

// --- Publisher / prompter seams ---

export interface IdentityPublisher {
  fetchExternalIdentityClaims(pubkey: string): Promise<ExternalIdentityClaimsResult>;
  publishExternalIdentities(
    identity: ElisymIdentity,
    claims: ExternalIdentityClaimInput[],
  ): Promise<string>;
  publishProfile(
    identity: ElisymIdentity,
    name: string,
    about: string,
    picture?: string,
    banner?: string,
    nip05?: string,
  ): Promise<string>;
  close(): void;
}

export interface IdentityPrompter {
  input(message: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  select(message: string, choices: Array<{ name: string; value: string }>): Promise<string>;
}

export interface IdentityCommandDeps {
  /** Test seam: working directory for agent resolution. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Test seam: proof verifier. Defaults to the SDK `verifyAgentIdentities`. */
  verify?: (
    pubkey: string,
    identities: AgentExternalIdentity[],
    opts?: VerifyIdentitiesOptions,
  ) => Promise<VerifiedIdentityResult[]>;
  /** Test seam: interactive prompts. Defaults to inquirer. */
  prompter?: IdentityPrompter;
  /** Test seam: relay publisher. Defaults to a fresh `ElisymClient`. */
  createPublisher?: (relays: string[]) => IdentityPublisher;
}

async function createInquirerPrompter(): Promise<IdentityPrompter> {
  const { default: inquirer } = await import('inquirer');
  return {
    async input(message: string): Promise<string> {
      const { value } = await inquirer.prompt([{ type: 'input', name: 'value', message }]);
      return String(value);
    },
    async confirm(message: string, defaultValue: boolean): Promise<boolean> {
      const { value } = await inquirer.prompt([
        { type: 'confirm', name: 'value', message, default: defaultValue },
      ]);
      return Boolean(value);
    },
    async select(message: string, choices: Array<{ name: string; value: string }>) {
      const { value } = await inquirer.prompt([{ type: 'list', name: 'value', message, choices }]);
      return String(value);
    },
  };
}

function createDefaultPublisher(relays: string[]): IdentityPublisher {
  const client = new ElisymClient({ relays });
  return {
    fetchExternalIdentityClaims: (pubkey) => client.discovery.fetchExternalIdentityClaims(pubkey),
    publishExternalIdentities: (identity, claims) =>
      client.discovery.publishExternalIdentities(identity, claims),
    publishProfile: (identity, name, about, picture, banner, nip05) =>
      client.discovery.publishProfile(identity, name, about, picture, banner, nip05),
    close: () => client.close(),
  };
}

// --- Shared helpers ---

async function resolveAndLoadAgent(
  nameArg: string | undefined,
  cwd: string,
  prompter: IdentityPrompter,
): Promise<{ name: string; loaded: LoadedAgent }> {
  let name = nameArg;
  if (!name) {
    const agents = await listAgents(cwd);
    if (agents.length === 0) {
      throw new Error('No agents found. Run `npx @elisym/cli init` first.');
    }
    name = await prompter.select(
      'Select agent:',
      agents.map((agent) => ({ name: `${agent.name} (${agent.source})`, value: agent.name })),
    );
  }
  const passphrase = process.env.ELISYM_PASSPHRASE;
  const loaded = await loadAgent(name, cwd, passphrase);
  return { name, loaded };
}

function relaysFor(yaml: ElisymYaml): string[] {
  return yaml.relays.length > 0 ? yaml.relays : [...RELAYS];
}

/**
 * Resolve a yaml picture/banner field for a kind-0 republish WITHOUT
 * uploading: remote URLs pass through, local paths resolve through
 * `.media-cache.json`, and a cache miss falls back to the currently-published
 * kind-0 URL so an identity command never wipes the agent's avatar.
 * `.media-cache.json` is per-machine state (a copied store has none); uploads
 * remain `elisym start`'s job (Step 9).
 */
export async function resolvePreservedMediaUrl(
  configured: string | undefined,
  agentDir: string,
  cache: MediaCache,
  publishedUrl: string | undefined,
): Promise<string | undefined> {
  if (!configured) {
    // Nothing configured locally: mirror `elisym start`, which publishes the
    // profile without the field - there is nothing to preserve.
    return undefined;
  }
  if (/^https?:\/\//i.test(configured)) {
    return configured;
  }
  const agentRoot = resolve(agentDir);
  const candidate = resolve(agentRoot, configured);
  const rel = relative(agentRoot, candidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return publishedUrl;
  }
  const cached = await lookupCachedUrl(cache, configured, candidate);
  return cached ?? publishedUrl;
}

/**
 * Republish kind 0 from the local yaml (name/about rebuilt like start.ts Step
 * 10), preserving picture/banner via the media cache with a fallback to the
 * currently-published profile. `nip05` comes from `yaml.identities.website` -
 * absent after a website unlink, present after a website link. Throws instead
 * of publishing when a configured picture/banner resolves to nothing (cache
 * miss plus no published URL - a timed-out relay read looks identical to an
 * empty profile): a kind-0 replace would silently wipe the avatar otherwise,
 * and the caller's recovery hint (`elisym start`) re-uploads the media.
 */
async function republishAgentProfile(
  publisher: IdentityPublisher,
  identity: ElisymIdentity,
  agentName: string,
  agentDir: string,
  yaml: ElisymYaml,
): Promise<void> {
  let publishedProfile: ExternalIdentityClaimsResult['profile'] | undefined;
  try {
    const published = await publisher.fetchExternalIdentityClaims(identity.publicKey);
    publishedProfile = published.profile;
  } catch {
    // Leave undefined - the unresolved-media guard below decides whether the
    // missing fallback actually matters for this yaml.
  }
  const mediaCache = await readMediaCache(agentDir);
  const picture = await resolvePreservedMediaUrl(
    yaml.picture,
    agentDir,
    mediaCache,
    publishedProfile?.picture,
  );
  const banner = await resolvePreservedMediaUrl(
    yaml.banner,
    agentDir,
    mediaCache,
    publishedProfile?.banner,
  );
  // Guard on the SAME truthiness `resolvePreservedMediaUrl` uses to decide a
  // field is set: an empty-string picture/banner (a hand-edited "clear the
  // avatar") resolves to undefined by design and must NOT trip the wipe guard.
  const unresolved: string[] = [];
  if (yaml.picture && picture === undefined) {
    unresolved.push('picture');
  }
  if (yaml.banner && banner === undefined) {
    unresolved.push('banner');
  }
  if (unresolved.length > 0) {
    throw new Error(
      `${unresolved.join(' and ')} carry-over unavailable (no media cache entry and no ` +
        'currently-published URL - the relay read may have failed), so republishing kind 0 ' +
        'would wipe it from the profile',
    );
  }
  await publisher.publishProfile(
    identity,
    yaml.display_name ?? agentName,
    yaml.description ?? '',
    picture,
    banner,
    yaml.identities?.website,
  );
}

/**
 * Retraction sweep for `elisym start`: when the yaml carries no `identities`
 * section but the relays still hold a non-empty kind 10011 (hand-edited
 * removal), publish an empty-tag replacement so the unlink propagates. Same
 * pattern as the policies orphan sweep (start.ts Step 10.6). Never throws -
 * a failed sweep retries on the next start. Returns true when a retraction
 * was published.
 */
export async function sweepStaleIdentityClaims(
  discovery: Pick<IdentityPublisher, 'fetchExternalIdentityClaims' | 'publishExternalIdentities'>,
  identity: ElisymIdentity,
): Promise<boolean> {
  try {
    const published = await discovery.fetchExternalIdentityClaims(identity.publicKey);
    // The website claim rides kind 0, not kind 10011 - only github/x claims
    // indicate a stale kind-10011 event worth retracting.
    const staleClaims = published.identities.filter((claim) => claim.platform !== 'website');
    if (staleClaims.length === 0) {
      return false;
    }
    await discovery.publishExternalIdentities(identity, []);
    return true;
  } catch {
    return false;
  }
}

// --- link ---

interface PromptedLink {
  nextIdentities: IdentitiesEntry;
}

async function promptGithubLink(
  loaded: LoadedAgent,
  npub: string,
  prompter: IdentityPrompter,
): Promise<PromptedLink> {
  console.log(
    '\n  1. Create a PUBLIC gist (https://gist.github.com/new) containing ONLY this' +
      '\n     single line (the proof statement - a standard NIP-39 text that any' +
      '\n     Nostr client can verify; do not paste these instructions):',
  );
  console.log(`\n     ${githubProofText(npub)}\n`);
  console.log('  2. Paste the gist URL (or its id) below.\n');
  const rawProof = await prompter.input('Gist URL or id:');
  const parsed = parseGithubProofInput(rawProof);
  if (parsed === null) {
    throw new Error('Expected a gist URL (https://gist.github.com/<user>/<id>) or a hex gist id.');
  }
  let username = parsed.username;
  if (username === undefined) {
    const rawUsername = await prompter.input('GitHub username:');
    username = rawUsername.trim().toLowerCase();
  }
  if (!GITHUB_USERNAME_REGEX.test(username)) {
    throw new Error(`Invalid GitHub username: "${username}" (alphanumeric or hyphen, 1-39 chars).`);
  }
  return {
    nextIdentities: {
      ...loaded.yaml.identities,
      github: { username, gist: parsed.proofId },
    },
  };
}

async function promptXLink(
  loaded: LoadedAgent,
  npub: string,
  prompter: IdentityPrompter,
): Promise<PromptedLink> {
  console.log(
    '\n  1. Post a tweet whose text is ONLY this line, including the double quotes' +
      '\n     (the proof statement - a standard NIP-39 text; the account you post' +
      '\n     from becomes the linked identity):',
  );
  console.log(`\n     ${xProofText(npub)}\n`);
  console.log('  2. Paste the tweet URL (or its status id) below.\n');
  const rawProof = await prompter.input('Tweet URL or id:');
  const parsed = parseXProofInput(rawProof);
  if (parsed === null) {
    throw new Error(
      'Expected a tweet URL (https://x.com/<user>/status/<id>) or a numeric status id.',
    );
  }
  let username = parsed.username;
  if (username === undefined) {
    const rawUsername = await prompter.input('X username (without @):');
    username = rawUsername.trim().replace(/^@/, '').toLowerCase();
  }
  if (!X_USERNAME_REGEX.test(username)) {
    throw new Error(`Invalid X username: "${username}" (alphanumeric or underscore, 1-15 chars).`);
  }
  return {
    nextIdentities: {
      ...loaded.yaml.identities,
      x: { username, tweet: parsed.proofId },
    },
  };
}

async function promptWebsiteLink(
  loaded: LoadedAgent,
  pubkeyHex: string,
  prompter: IdentityPrompter,
): Promise<PromptedLink> {
  const rawIdentifier = await prompter.input('NIP-05 identifier (name@domain or bare domain):');
  // Claimed exactly as typed - no www-stripping "canonicalization". Rewriting
  // is unsound without a public-suffix list (`www.com` and `www.co.uk` are
  // real apexes whose parent domain the operator does not own), and the
  // verifier consults only the exact claimed host (no www/apex twin), so the
  // stored claim must be the precise host that serves the proof.
  const identifier = normalizeNip05Identifier(rawIdentifier.trim());
  if (identifier === null) {
    throw new Error(
      `Invalid NIP-05 identifier: "${rawIdentifier.trim()}". Expected name@domain or a bare domain (ASCII hostname labels, no IP literals).`,
    );
  }
  const { local, domain } = splitNip05Identifier(identifier);
  console.log(`\n  Serve this JSON at https://${domain}/.well-known/nostr.json :\n`);
  for (const line of websiteNostrJson(local, pubkeyHex).split('\n')) {
    console.log(`     ${line}`);
  }
  console.log(
    `\n  It must answer https://${domain}/.well-known/nostr.json?name=${local} over https,`,
  );
  console.log('  without redirects - NIP-05 forbids following them. The verifier consults only');
  console.log(`  this exact host (no www/apex twin fallback), so the file must live at ${domain}.`);
  console.log('  Sending `Access-Control-Allow-Origin: *` is recommended (NIP-05), so browser');
  console.log('  clients can verify it too.\n');
  const live = await prompter.confirm('Is the file deployed and reachable? Verify now', true);
  if (!live) {
    throw new Error(
      'aborted - deploy the file, then re-run `npx @elisym/cli identity link website`. Nothing was written.',
    );
  }
  return {
    nextIdentities: {
      ...loaded.yaml.identities,
      website: identifier,
    },
  };
}

function describeBrokenProof(platform: IdentityPlatform, claim: AgentExternalIdentity): string {
  switch (platform) {
    case 'github':
      return `the gist at ${claim.proofUrl} is missing, belongs to another user, or does not contain the exact proof text with this agent's npub`;
    case 'x':
      return `the tweet at ${claim.proofUrl} is deleted, belongs to another account, or does not contain the exact proof text with this agent's npub`;
    case 'website':
      return `${claim.proofUrl}/.well-known/nostr.json does not map "${claim.handle}" to this agent's pubkey`;
  }
}

export async function cmdIdentityLink(
  platformArg: string,
  agentName: string | undefined,
  deps: IdentityCommandDeps = {},
): Promise<void> {
  const platform = parseIdentityPlatform(platformArg);
  const cwd = deps.cwd ?? process.cwd();
  const prompter = deps.prompter ?? (await createInquirerPrompter());
  const verify = deps.verify ?? verifyAgentIdentities;
  const { name, loaded } = await resolveAndLoadAgent(agentName, cwd, prompter);
  const identity = ElisymIdentity.fromHex(loaded.secrets.nostr_secret_key);

  console.log(`\n  Linking ${platform} to agent "${name}" (${identity.npub}).`);

  let prompted: PromptedLink;
  if (platform === 'github') {
    prompted = await promptGithubLink(loaded, identity.npub, prompter);
  } else if (platform === 'x') {
    prompted = await promptXLink(loaded, identity.npub, prompter);
  } else {
    prompted = await promptWebsiteLink(loaded, identity.publicKey, prompter);
  }

  const claim = identitiesFromYaml(prompted.nextIdentities).find(
    (candidate) => candidate.platform === platform,
  );
  if (claim === undefined) {
    throw new Error('Internal: failed to build the identity claim from the prompt input.');
  }

  console.log('\n  Verifying the proof (live, cache bypassed)...');
  const results = await verify(identity.publicKey, [claim], { bypassCache: true });
  const result = results[0];
  if (result === undefined) {
    throw new Error('Internal: the verifier returned no result.');
  }
  if (result.status === 'broken') {
    throw new Error(
      `proof check failed: ${describeBrokenProof(platform, claim)}. Nothing was written.`,
    );
  }
  if (result.status === 'unverifiable') {
    console.warn(
      '  ! Could not check the proof (network error, rate limit, or the proof is not reachable yet).',
    );
    console.warn('  ! This is neutral - the proof may be fine - but it was NOT verified.');
    const proceed = await prompter.confirm(
      'Link anyway (write elisym.yaml and publish the unverified claim)?',
      false,
    );
    if (!proceed) {
      throw new Error('aborted - nothing was written.');
    }
  } else {
    console.log('  Proof verified.');
  }

  const nextYaml: ElisymYaml = { ...loaded.yaml, identities: prompted.nextIdentities };
  await writeYaml(loaded.dir, nextYaml);
  console.log(`  Wrote identities.${platform} to elisym.yaml.`);

  const createPublisher = deps.createPublisher ?? createDefaultPublisher;
  const publisher = createPublisher(relaysFor(loaded.yaml));
  try {
    const claims = buildIdentityClaimInputs(prompted.nextIdentities);
    try {
      await publisher.publishExternalIdentities(identity, claims);
      console.log(`  Published identity claims (kind 10011, ${claims.length} tag(s)).`);
      if (platform === 'website') {
        await republishAgentProfile(publisher, identity, name, loaded.dir, nextYaml);
        console.log('  Republished profile (kind 0) with nip05.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `linked locally, but publishing failed: ${message}. Run \`npx @elisym/cli start ${name}\` to publish, or re-run this command.`,
      );
    }
  } finally {
    publisher.close();
  }

  console.log(`\n  Linked ${platform} to agent "${name}".\n`);
}

// --- unlink ---

function removeIdentityEntry(
  identities: IdentitiesEntry,
  platform: IdentityPlatform,
): IdentitiesEntry | undefined {
  const next: IdentitiesEntry = { ...identities };
  delete next[platform];
  const hasEntries =
    next.github !== undefined || next.x !== undefined || next.website !== undefined;
  return hasEntries ? next : undefined;
}

export async function cmdIdentityUnlink(
  platformArg: string,
  agentName: string | undefined,
  deps: IdentityCommandDeps = {},
): Promise<void> {
  const platform = parseIdentityPlatform(platformArg);
  const cwd = deps.cwd ?? process.cwd();
  const prompter = deps.prompter ?? (await createInquirerPrompter());
  const { name, loaded } = await resolveAndLoadAgent(agentName, cwd, prompter);
  const identity = ElisymIdentity.fromHex(loaded.secrets.nostr_secret_key);

  const current = loaded.yaml.identities;
  if (current === undefined || current[platform] === undefined) {
    console.log(`\n  ${platform} is not linked for agent "${name}" - nothing to unlink.\n`);
    return;
  }

  const nextIdentities = removeIdentityEntry(current, platform);
  const nextYaml: ElisymYaml = { ...loaded.yaml };
  if (nextIdentities === undefined) {
    delete nextYaml.identities;
  } else {
    nextYaml.identities = nextIdentities;
  }
  await writeYaml(loaded.dir, nextYaml);
  console.log(`\n  Removed identities.${platform} from elisym.yaml.`);

  const createPublisher = deps.createPublisher ?? createDefaultPublisher;
  const publisher = createPublisher(relaysFor(loaded.yaml));
  try {
    const remaining = buildIdentityClaimInputs(nextIdentities);
    try {
      await publisher.publishExternalIdentities(identity, remaining);
      console.log(
        `  Republished identity claims (kind 10011, ${remaining.length} tag(s) remaining).`,
      );
      if (platform === 'website') {
        await republishAgentProfile(publisher, identity, name, loaded.dir, nextYaml);
        console.log('  Republished profile (kind 0) without nip05.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `unlinked locally, but publishing the retraction failed: ${message}. Run \`npx @elisym/cli start ${name}\` to propagate it.`,
      );
    }
  } finally {
    publisher.close();
  }

  console.log(`\n  Unlinked ${platform} from agent "${name}".\n`);
}

// --- status ---

export interface IdentityStatusRow {
  platform: IdentityPlatform;
  handle: string;
  proofUrl: string;
  status: IdentityVerifyStatus;
  /** false = linked locally but not on the relays; undefined = relay query failed. */
  published: boolean | undefined;
}

function sameClaim(left: AgentExternalIdentity, right: AgentExternalIdentity): boolean {
  return (
    left.platform === right.platform &&
    left.handle.toLowerCase() === right.handle.toLowerCase() &&
    left.proofUrl.toLowerCase() === right.proofUrl.toLowerCase()
  );
}

export function buildStatusRows(
  results: VerifiedIdentityResult[],
  publishedClaims: AgentExternalIdentity[] | undefined,
): IdentityStatusRow[] {
  return results.map((result) => ({
    platform: result.identity.platform,
    handle: result.identity.handle,
    proofUrl: result.identity.proofUrl,
    status: result.status,
    published:
      publishedClaims === undefined
        ? undefined
        : publishedClaims.some((claim) => sameClaim(claim, result.identity)),
  }));
}

export async function cmdIdentityStatus(
  agentName: string | undefined,
  deps: IdentityCommandDeps = {},
): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const prompter = deps.prompter ?? (await createInquirerPrompter());
  const verify = deps.verify ?? verifyAgentIdentities;
  const { name, loaded } = await resolveAndLoadAgent(agentName, cwd, prompter);
  const identity = ElisymIdentity.fromHex(loaded.secrets.nostr_secret_key);

  const localClaims = identitiesFromYaml(loaded.yaml.identities);

  const createPublisher = deps.createPublisher ?? createDefaultPublisher;
  const publisher = createPublisher(relaysFor(loaded.yaml));
  let published: ExternalIdentityClaimsResult | undefined;
  try {
    published = await publisher.fetchExternalIdentityClaims(identity.publicKey);
  } catch {
    console.warn('  ! Could not query the relays for published claims - drift check skipped.');
  } finally {
    publisher.close();
  }

  if (localClaims.length === 0) {
    console.log(`\n  No identities linked in elisym.yaml for agent "${name}".`);
    console.log('  Link one: npx @elisym/cli identity link <github|x|website>\n');
    if (published !== undefined && published.identities.length > 0) {
      console.log(
        `  ! The relays still hold published identity claims - run \`npx @elisym/cli start ${name}\` to retract them.\n`,
      );
    }
    return;
  }

  console.log(`\n  Verifying ${localClaims.length} proof(s) (live, cache bypassed)...\n`);
  const results = await verify(identity.publicKey, localClaims, { bypassCache: true });
  const rows = buildStatusRows(results, published?.identities);

  console.log(`  Identities for agent "${name}" (${identity.npub}):\n`);
  for (const row of rows) {
    const displayHandle = row.handle.startsWith('_@') ? row.handle.slice(2) : row.handle;
    console.log(`  ${row.platform.padEnd(8)} ${row.status.padEnd(13)} ${displayHandle}`);
    console.log(`           proof: ${row.proofUrl}`);
    if (row.published === false) {
      console.log(
        `           ! linked locally but not published - run \`npx @elisym/cli start ${name}\` to publish`,
      );
    }
  }
  console.log();
}
