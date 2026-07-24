import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ElisymIdentity,
  type AgentExternalIdentity,
  type ExternalIdentityClaimInput,
  type ExternalIdentityClaimsResult,
  type IdentityVerifyStatus,
  type VerifiedIdentityResult,
  type VerifyIdentitiesOptions,
} from '@elisym/sdk';
import { newCacheEntry, hashFile, type MediaCache } from '@elisym/sdk/agent-store';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  buildIdentityClaimInputs,
  buildStatusRows,
  cmdIdentityLink,
  cmdIdentityStatus,
  cmdIdentityUnlink,
  identitiesFromYaml,
  parseGithubProofInput,
  parseIdentityPlatform,
  parseXProofInput,
  resolvePreservedMediaUrl,
  sweepStaleIdentityClaims,
  githubProofText,
  xProofText,
  websiteNostrJson,
  type IdentityPrompter,
  type IdentityPublisher,
} from '../src/commands/identity';

const GIST_ID = '9721ce4ee4fceb91c9711ca2a6c9a5ab';
const TWEET_ID = '1893471190424121782';

// --- Agent scaffold ---

interface TestAgent {
  root: string;
  dir: string;
  name: string;
  identity: ElisymIdentity;
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dirPath = cleanupDirs.pop();
    if (dirPath !== undefined) {
      await rm(dirPath, { recursive: true, force: true });
    }
  }
});

async function makeAgent(yamlExtra: Record<string, unknown> = {}): Promise<TestAgent> {
  const root = await mkdtemp(join(tmpdir(), 'elisym-identity-'));
  cleanupDirs.push(root);
  const name = 'ident-agent';
  const dir = join(root, '.elisym', name);
  await mkdir(dir, { recursive: true });
  const identity = ElisymIdentity.generate();
  const secretHex = Buffer.from(identity.secretKey).toString('hex');
  await writeFile(
    join(dir, '.secrets.json'),
    JSON.stringify({ nostr_secret_key: secretHex }),
    'utf-8',
  );
  await writeFile(
    join(dir, 'elisym.yaml'),
    YAML.stringify({ description: 'test agent', ...yamlExtra }),
    'utf-8',
  );
  return { root, dir, name, identity };
}

async function readAgentYaml(agent: TestAgent): Promise<Record<string, unknown>> {
  const raw = await readFile(join(agent.dir, 'elisym.yaml'), 'utf-8');
  return YAML.parse(raw) as Record<string, unknown>;
}

// --- Seams ---

function scriptedPrompter(script: { inputs?: string[]; confirms?: boolean[] }): IdentityPrompter {
  const inputs = [...(script.inputs ?? [])];
  const confirms = [...(script.confirms ?? [])];
  return {
    async input(message: string): Promise<string> {
      const next = inputs.shift();
      if (next === undefined) {
        throw new Error(`Unexpected input prompt: ${message}`);
      }
      return next;
    },
    async confirm(message: string): Promise<boolean> {
      const next = confirms.shift();
      if (next === undefined) {
        throw new Error(`Unexpected confirm prompt: ${message}`);
      }
      return next;
    },
    async select(message: string): Promise<string> {
      throw new Error(`Unexpected select prompt: ${message}`);
    },
  };
}

interface ProfilePublish {
  name: string;
  about: string;
  picture: string | undefined;
  banner: string | undefined;
  nip05: string | undefined;
}

interface PublisherRecorder {
  publisher: IdentityPublisher;
  identityPublishes: ExternalIdentityClaimInput[][];
  profilePublishes: ProfilePublish[];
  fetchCount: number;
  closed: boolean;
}

function recordingPublisher(fetchResult?: ExternalIdentityClaimsResult): PublisherRecorder {
  const recorder: PublisherRecorder = {
    identityPublishes: [],
    profilePublishes: [],
    fetchCount: 0,
    closed: false,
    publisher: {
      async fetchExternalIdentityClaims() {
        recorder.fetchCount += 1;
        if (fetchResult === undefined) {
          throw new Error('relay query failed');
        }
        return fetchResult;
      },
      async publishExternalIdentities(_identity, claims) {
        recorder.identityPublishes.push(claims);
        return 'identity-event-id';
      },
      async publishProfile(_identity, profileName, about, picture, banner, nip05) {
        recorder.profilePublishes.push({ name: profileName, about, picture, banner, nip05 });
        return 'profile-event-id';
      },
      close() {
        recorder.closed = true;
      },
    },
  };
  return recorder;
}

interface VerifyStub {
  verify: (
    pubkey: string,
    identities: AgentExternalIdentity[],
    opts?: VerifyIdentitiesOptions,
  ) => Promise<VerifiedIdentityResult[]>;
  calls: Array<{
    pubkey: string;
    identities: AgentExternalIdentity[];
    opts: VerifyIdentitiesOptions | undefined;
  }>;
}

function stubVerify(status: IdentityVerifyStatus): VerifyStub {
  const calls: VerifyStub['calls'] = [];
  return {
    calls,
    async verify(pubkey, identities, opts) {
      calls.push({ pubkey, identities, opts });
      return identities.map((identity) => ({ identity, status }));
    },
  };
}

// --- Pure helpers ---

describe('parseIdentityPlatform', () => {
  it('accepts the three platforms case-insensitively', () => {
    expect(parseIdentityPlatform('github')).toBe('github');
    expect(parseIdentityPlatform('X')).toBe('x');
    expect(parseIdentityPlatform(' Website ')).toBe('website');
  });

  it('rejects anything else', () => {
    expect(() => parseIdentityPlatform('twitter')).toThrow(/github, x, or website/);
    expect(() => parseIdentityPlatform('')).toThrow(/github, x, or website/);
  });
});

describe('proof templates', () => {
  it('emits the exact NIP-39 texts', () => {
    expect(githubProofText('npub1abc')).toBe(
      'Verifying that I control the following Nostr public key: npub1abc',
    );
    expect(xProofText('npub1abc')).toBe('Verifying my account on nostr My Public Key: "npub1abc"');
    expect(JSON.parse(websiteNostrJson('_', 'deadbeef'))).toEqual({
      names: { _: 'deadbeef' },
    });
  });
});

describe('parseGithubProofInput', () => {
  it('accepts a bare gist id and lowercases it', () => {
    expect(parseGithubProofInput(` ${GIST_ID.toUpperCase()} `)).toEqual({ proofId: GIST_ID });
  });

  it('accepts a full gist URL, extracting the lowercased username', () => {
    expect(parseGithubProofInput(`https://gist.github.com/Alice/${GIST_ID}`)).toEqual({
      proofId: GIST_ID,
      username: 'alice',
    });
  });

  it('tolerates extra path segments (raw/revision)', () => {
    expect(parseGithubProofInput(`https://gist.github.com/alice/${GIST_ID}/raw`)).toEqual({
      proofId: GIST_ID,
      username: 'alice',
    });
  });

  it('rejects http, wrong hosts, and garbage', () => {
    expect(parseGithubProofInput(`http://gist.github.com/alice/${GIST_ID}`)).toBeNull();
    expect(parseGithubProofInput(`https://evil.example/alice/${GIST_ID}`)).toBeNull();
    expect(parseGithubProofInput('not a gist')).toBeNull();
    expect(parseGithubProofInput('https://gist.github.com/alice')).toBeNull();
  });
});

describe('parseXProofInput', () => {
  it('accepts a bare status id', () => {
    expect(parseXProofInput(TWEET_ID)).toEqual({ proofId: TWEET_ID });
  });

  it('accepts x.com and twitter.com status URLs with query strings', () => {
    expect(parseXProofInput(`https://x.com/Alice_AI/status/${TWEET_ID}?s=20`)).toEqual({
      proofId: TWEET_ID,
      username: 'alice_ai',
    });
    expect(parseXProofInput(`https://twitter.com/alice_ai/status/${TWEET_ID}`)).toEqual({
      proofId: TWEET_ID,
      username: 'alice_ai',
    });
  });

  it('rejects non-status paths, foreign hosts, and oversize ids', () => {
    expect(parseXProofInput(`https://x.com/alice/likes/${TWEET_ID}`)).toBeNull();
    expect(parseXProofInput(`https://x.evil.example/alice/status/${TWEET_ID}`)).toBeNull();
    expect(parseXProofInput('9'.repeat(26))).toBeNull();
  });
});

describe('yaml claim mapping', () => {
  const identities = {
    github: { username: 'alice', gist: GIST_ID },
    x: { username: 'alice_ai', tweet: TWEET_ID },
    website: 'example.com',
  };

  it('buildIdentityClaimInputs maps github/x only (website rides kind 0)', () => {
    expect(buildIdentityClaimInputs(identities)).toEqual([
      { platform: 'github', handle: 'alice', proofId: GIST_ID },
      { platform: 'x', handle: 'alice_ai', proofId: TWEET_ID },
    ]);
    expect(buildIdentityClaimInputs(undefined)).toEqual([]);
  });

  it('identitiesFromYaml builds SDK-shaped claims incl. the normalized website claim', () => {
    expect(identitiesFromYaml(identities)).toEqual([
      {
        platform: 'github',
        handle: 'alice',
        proofUrl: `https://gist.github.com/alice/${GIST_ID}`,
      },
      {
        platform: 'x',
        handle: 'alice_ai',
        proofUrl: `https://x.com/alice_ai/status/${TWEET_ID}`,
      },
      { platform: 'website', handle: '_@example.com', proofUrl: 'https://example.com' },
    ]);
    expect(identitiesFromYaml(undefined)).toEqual([]);
  });
});

describe('resolvePreservedMediaUrl', () => {
  it('passes remote URLs through and returns undefined when unconfigured', async () => {
    const agent = await makeAgent();
    const cache: MediaCache = {};
    expect(
      await resolvePreservedMediaUrl('https://cdn.example/p.png', agent.dir, cache, 'https://pub'),
    ).toBe('https://cdn.example/p.png');
    expect(await resolvePreservedMediaUrl(undefined, agent.dir, cache, 'https://pub')).toBe(
      undefined,
    );
  });

  it('returns the cached URL on a cache hit', async () => {
    const agent = await makeAgent();
    const avatarPath = join(agent.dir, 'avatar.png');
    await writeFile(avatarPath, 'fake-image-bytes', 'utf-8');
    const cache: MediaCache = {
      'avatar.png': newCacheEntry('https://blossom.example/abc', await hashFile(avatarPath)),
    };
    expect(
      await resolvePreservedMediaUrl('avatar.png', agent.dir, cache, 'https://pub/old.png'),
    ).toBe('https://blossom.example/abc');
  });

  it('falls back to the published URL on a cache miss or path escape', async () => {
    const agent = await makeAgent();
    expect(await resolvePreservedMediaUrl('avatar.png', agent.dir, {}, 'https://pub/old.png')).toBe(
      'https://pub/old.png',
    );
    expect(
      await resolvePreservedMediaUrl('../../etc/passwd', agent.dir, {}, 'https://pub/old.png'),
    ).toBe('https://pub/old.png');
  });
});

// --- link ---

describe('cmdIdentityLink github', () => {
  it('verifies live (cache bypassed), writes yaml, and publishes kind 10011', async () => {
    const agent = await makeAgent();
    const { verify, calls } = stubVerify('verified');
    const recorder = recordingPublisher();
    const prompter = scriptedPrompter({
      inputs: [`https://gist.github.com/Alice/${GIST_ID}`],
    });

    await cmdIdentityLink('github', agent.name, {
      cwd: agent.root,
      verify,
      prompter,
      createPublisher: () => recorder.publisher,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.pubkey).toBe(agent.identity.publicKey);
    expect(call?.opts?.bypassCache).toBe(true);
    expect(call?.identities).toEqual([
      {
        platform: 'github',
        handle: 'alice',
        proofUrl: `https://gist.github.com/alice/${GIST_ID}`,
      },
    ]);

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toEqual({ github: { username: 'alice', gist: GIST_ID } });

    expect(recorder.identityPublishes).toEqual([
      [{ platform: 'github', handle: 'alice', proofId: GIST_ID }],
    ]);
    expect(recorder.profilePublishes).toEqual([]);
    expect(recorder.closed).toBe(true);
  });

  it('prompts for the username when given a bare gist id', async () => {
    const agent = await makeAgent();
    const { verify } = stubVerify('verified');
    const recorder = recordingPublisher();
    const prompter = scriptedPrompter({ inputs: [GIST_ID, 'ALICE'] });

    await cmdIdentityLink('github', agent.name, {
      cwd: agent.root,
      verify,
      prompter,
      createPublisher: () => recorder.publisher,
    });

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toEqual({ github: { username: 'alice', gist: GIST_ID } });
  });

  it('aborts WITHOUT writing on a broken proof', async () => {
    const agent = await makeAgent();
    const { verify } = stubVerify('broken');
    const recorder = recordingPublisher();
    const prompter = scriptedPrompter({
      inputs: [`https://gist.github.com/alice/${GIST_ID}`],
    });

    await expect(
      cmdIdentityLink('github', agent.name, {
        cwd: agent.root,
        verify,
        prompter,
        createPublisher: () => recorder.publisher,
      }),
    ).rejects.toThrow(/Nothing was written/);

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toBeUndefined();
    expect(recorder.identityPublishes).toEqual([]);
  });

  it('requires explicit confirmation on an unverifiable proof - declined aborts', async () => {
    const agent = await makeAgent();
    const { verify } = stubVerify('unverifiable');
    const recorder = recordingPublisher();
    const prompter = scriptedPrompter({
      inputs: [`https://gist.github.com/alice/${GIST_ID}`],
      confirms: [false],
    });

    await expect(
      cmdIdentityLink('github', agent.name, {
        cwd: agent.root,
        verify,
        prompter,
        createPublisher: () => recorder.publisher,
      }),
    ).rejects.toThrow(/aborted/);

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toBeUndefined();
    expect(recorder.identityPublishes).toEqual([]);
  });

  it('unverifiable + confirmed writes and publishes anyway', async () => {
    const agent = await makeAgent();
    const { verify } = stubVerify('unverifiable');
    const recorder = recordingPublisher();
    const prompter = scriptedPrompter({
      inputs: [`https://gist.github.com/alice/${GIST_ID}`],
      confirms: [true],
    });

    await cmdIdentityLink('github', agent.name, {
      cwd: agent.root,
      verify,
      prompter,
      createPublisher: () => recorder.publisher,
    });

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toEqual({ github: { username: 'alice', gist: GIST_ID } });
    expect(recorder.identityPublishes).toHaveLength(1);
  });
});

describe('cmdIdentityLink x', () => {
  it('extracts the username from the tweet URL and keeps the id as a string', async () => {
    const agent = await makeAgent();
    const { verify, calls } = stubVerify('verified');
    const recorder = recordingPublisher();
    const prompter = scriptedPrompter({
      inputs: [`https://x.com/Alice_AI/status/${TWEET_ID}`],
    });

    await cmdIdentityLink('x', agent.name, {
      cwd: agent.root,
      verify,
      prompter,
      createPublisher: () => recorder.publisher,
    });

    expect(calls[0]?.identities[0]?.proofUrl).toBe(`https://x.com/alice_ai/status/${TWEET_ID}`);
    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toEqual({ x: { username: 'alice_ai', tweet: TWEET_ID } });
    expect(recorder.identityPublishes).toEqual([
      [{ platform: 'x', handle: 'alice_ai', proofId: TWEET_ID }],
    ]);
  });
});

describe('cmdIdentityLink website', () => {
  it('normalizes a bare domain, republishes kind 0 with nip05 and carried-over media', async () => {
    const agent = await makeAgent({ picture: 'avatar.png' });
    const { verify, calls } = stubVerify('verified');
    const recorder = recordingPublisher({
      identities: [],
      profile: { picture: 'https://cdn.example/pic.png' },
    });
    const prompter = scriptedPrompter({ inputs: ['Example.COM'], confirms: [true] });

    await cmdIdentityLink('website', agent.name, {
      cwd: agent.root,
      verify,
      prompter,
      createPublisher: () => recorder.publisher,
    });

    expect(calls[0]?.identities).toEqual([
      { platform: 'website', handle: '_@example.com', proofUrl: 'https://example.com' },
    ]);

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toEqual({ website: '_@example.com' });

    // kind 10011 still republished (empty - no github/x claims).
    expect(recorder.identityPublishes).toEqual([[]]);
    // kind 0: nip05 set, picture carried over from the published profile
    // (yaml picture is a local path with no media-cache entry).
    expect(recorder.fetchCount).toBe(1);
    expect(recorder.profilePublishes).toEqual([
      {
        name: agent.name,
        about: 'test agent',
        picture: 'https://cdn.example/pic.png',
        banner: undefined,
        nip05: '_@example.com',
      },
    ]);
  });

  it('stores the identifier as typed (lowercased, bare domain -> root), no www rewrite', async () => {
    // No www-stripping "canonicalization": rewriting is unsound without a
    // public-suffix list (`www.com` / `www.co.uk` are real apexes), and the
    // verifier consults only the exact claimed host. Whatever the user types
    // is what gets claimed, served, and displayed.
    const agent = await makeAgent({});
    const { verify } = stubVerify('verified');
    const recorder = recordingPublisher({ identities: [] });
    for (const [raw, expected] of [
      ['Example.com', '_@example.com'],
      ['agent@Example.com', 'agent@example.com'],
      // www. is preserved verbatim - a real apex like www.com must survive, and
      // the CLI cannot tell an apex from a www-prefixed subdomain.
      ['www.Example.com', '_@www.example.com'],
      ['www.com', '_@www.com'],
      ['agent@WWW.example.com', 'agent@www.example.com'],
    ] as const) {
      const prompter = scriptedPrompter({ inputs: [raw], confirms: [true] });
      await cmdIdentityLink('website', agent.name, {
        cwd: agent.root,
        verify,
        prompter,
        createPublisher: () => recorder.publisher,
      });
      const yaml = await readAgentYaml(agent);
      expect(yaml.identities, raw).toEqual({ website: expected });
    }
  });

  it('refuses the kind-0 republish instead of wiping an unresolvable avatar', async () => {
    // Local picture path, no media cache, and an empty relay read (the shape
    // a timed-out query produces): publishing would drop the avatar, so the
    // command must fail with the "linked locally" recovery hint instead.
    const agent = await makeAgent({ picture: 'avatar.png' });
    const { verify } = stubVerify('verified');
    const recorder = recordingPublisher({ identities: [], profile: {} });
    const prompter = scriptedPrompter({ inputs: ['example.com'], confirms: [true] });

    await expect(
      cmdIdentityLink('website', agent.name, {
        cwd: agent.root,
        verify,
        prompter,
        createPublisher: () => recorder.publisher,
      }),
    ).rejects.toThrow(/linked locally, but publishing failed:.*picture carry-over unavailable/);

    // Linked locally and kind 10011 published - only the kind-0 replace is off.
    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toEqual({ website: '_@example.com' });
    expect(recorder.identityPublishes).toEqual([[]]);
    expect(recorder.profilePublishes).toEqual([]);
  });

  it('an empty-string picture is "no avatar", not an unresolvable one - still publishes', async () => {
    // picture: '' means "no avatar" (same as start.ts), so there is nothing to
    // preserve and the wipe guard must NOT fire even with an empty relay read.
    const agent = await makeAgent({ picture: '' });
    const { verify } = stubVerify('verified');
    const recorder = recordingPublisher({ identities: [], profile: {} });
    const prompter = scriptedPrompter({ inputs: ['example.com'], confirms: [true] });

    await cmdIdentityLink('website', agent.name, {
      cwd: agent.root,
      verify,
      prompter,
      createPublisher: () => recorder.publisher,
    });

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toEqual({ website: '_@example.com' });
    expect(recorder.profilePublishes).toEqual([
      {
        name: agent.name,
        about: 'test agent',
        picture: undefined,
        banner: undefined,
        nip05: '_@example.com',
      },
    ]);
  });
});

// --- unlink ---

describe('cmdIdentityUnlink', () => {
  it('removes one entry and republishes kind 10011 with the remaining tags', async () => {
    const agent = await makeAgent({
      identities: {
        github: { username: 'alice', gist: GIST_ID },
        x: { username: 'alice_ai', tweet: TWEET_ID },
      },
    });
    const recorder = recordingPublisher();

    await cmdIdentityUnlink('github', agent.name, {
      cwd: agent.root,
      prompter: scriptedPrompter({}),
      createPublisher: () => recorder.publisher,
    });

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toEqual({ x: { username: 'alice_ai', tweet: TWEET_ID } });
    expect(recorder.identityPublishes).toEqual([
      [{ platform: 'x', handle: 'alice_ai', proofId: TWEET_ID }],
    ]);
    expect(recorder.profilePublishes).toEqual([]);
    expect(recorder.fetchCount).toBe(0);
    expect(recorder.closed).toBe(true);
  });

  it('drops the identities section entirely and publishes zero tags for the last entry', async () => {
    const agent = await makeAgent({
      identities: { github: { username: 'alice', gist: GIST_ID } },
    });
    const recorder = recordingPublisher();

    await cmdIdentityUnlink('github', agent.name, {
      cwd: agent.root,
      prompter: scriptedPrompter({}),
      createPublisher: () => recorder.publisher,
    });

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toBeUndefined();
    expect(recorder.identityPublishes).toEqual([[]]);
  });

  it('website unlink republishes kind 0 without nip05, preserving a remote picture', async () => {
    const agent = await makeAgent({
      picture: 'https://direct.example/p.png',
      identities: { website: 'agent@example.com' },
    });
    const recorder = recordingPublisher({
      identities: [],
      profile: { picture: 'https://cdn.example/pic.png', nip05: 'agent@example.com' },
    });

    await cmdIdentityUnlink('website', agent.name, {
      cwd: agent.root,
      prompter: scriptedPrompter({}),
      createPublisher: () => recorder.publisher,
    });

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toBeUndefined();
    expect(recorder.identityPublishes).toEqual([[]]);
    expect(recorder.profilePublishes).toEqual([
      {
        name: agent.name,
        about: 'test agent',
        picture: 'https://direct.example/p.png',
        banner: undefined,
        nip05: undefined,
      },
    ]);
  });

  it('is a no-op when the platform is not linked', async () => {
    const agent = await makeAgent();
    const recorder = recordingPublisher();

    await cmdIdentityUnlink('x', agent.name, {
      cwd: agent.root,
      prompter: scriptedPrompter({}),
      createPublisher: () => recorder.publisher,
    });

    const yaml = await readAgentYaml(agent);
    expect(yaml.identities).toBeUndefined();
    expect(recorder.identityPublishes).toEqual([]);
    expect(recorder.profilePublishes).toEqual([]);
  });
});

// --- status ---

describe('buildStatusRows', () => {
  const githubClaim: AgentExternalIdentity = {
    platform: 'github',
    handle: 'alice',
    proofUrl: `https://gist.github.com/alice/${GIST_ID}`,
  };
  const websiteClaim: AgentExternalIdentity = {
    platform: 'website',
    handle: '_@example.com',
    proofUrl: 'https://example.com',
  };

  it('flags claims that are linked locally but not published', () => {
    const rows = buildStatusRows(
      [
        { identity: githubClaim, status: 'verified' },
        { identity: websiteClaim, status: 'unverifiable' },
      ],
      [githubClaim],
    );
    expect(rows).toEqual([
      {
        platform: 'github',
        handle: 'alice',
        proofUrl: githubClaim.proofUrl,
        status: 'verified',
        published: true,
      },
      {
        platform: 'website',
        handle: '_@example.com',
        proofUrl: 'https://example.com',
        status: 'unverifiable',
        published: false,
      },
    ]);
  });

  it('matches published handles case-insensitively', () => {
    const publishedUppercase: AgentExternalIdentity = {
      platform: 'github',
      handle: 'Alice',
      proofUrl: `https://gist.github.com/Alice/${GIST_ID}`,
    };
    const rows = buildStatusRows(
      [{ identity: githubClaim, status: 'broken' }],
      [publishedUppercase],
    );
    expect(rows[0]?.published).toBe(true);
    expect(rows[0]?.status).toBe('broken');
  });

  it('reports published as undefined when the relay query failed', () => {
    const rows = buildStatusRows([{ identity: githubClaim, status: 'verified' }], undefined);
    expect(rows[0]?.published).toBeUndefined();
  });
});

describe('cmdIdentityStatus', () => {
  it('verifies live with the cache bypassed and queries the relays once', async () => {
    const agent = await makeAgent({
      identities: { github: { username: 'alice', gist: GIST_ID } },
    });
    const { verify, calls } = stubVerify('verified');
    const recorder = recordingPublisher({ identities: [], profile: {} });

    await cmdIdentityStatus(agent.name, {
      cwd: agent.root,
      verify,
      prompter: scriptedPrompter({}),
      createPublisher: () => recorder.publisher,
    });

    expect(recorder.fetchCount).toBe(1);
    expect(recorder.closed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.bypassCache).toBe(true);
    expect(calls[0]?.identities).toEqual([
      {
        platform: 'github',
        handle: 'alice',
        proofUrl: `https://gist.github.com/alice/${GIST_ID}`,
      },
    ]);
  });

  it('makes no proof fetches when nothing is linked', async () => {
    const agent = await makeAgent();
    const { verify, calls } = stubVerify('verified');
    const recorder = recordingPublisher({ identities: [], profile: {} });

    await cmdIdentityStatus(agent.name, {
      cwd: agent.root,
      verify,
      prompter: scriptedPrompter({}),
      createPublisher: () => recorder.publisher,
    });

    expect(calls).toHaveLength(0);
    expect(recorder.fetchCount).toBe(1);
  });
});

// --- retraction sweep (start.ts Step 10.2) ---

describe('sweepStaleIdentityClaims', () => {
  const identity = ElisymIdentity.generate();

  it('publishes an empty-tag replacement when the relays hold github/x claims', async () => {
    const recorder = recordingPublisher({
      identities: [
        {
          platform: 'github',
          handle: 'alice',
          proofUrl: `https://gist.github.com/alice/${GIST_ID}`,
        },
      ],
      profile: {},
    });
    const swept = await sweepStaleIdentityClaims(recorder.publisher, identity);
    expect(swept).toBe(true);
    expect(recorder.identityPublishes).toEqual([[]]);
  });

  it('does nothing when the relays hold no claims', async () => {
    const recorder = recordingPublisher({ identities: [], profile: {} });
    const swept = await sweepStaleIdentityClaims(recorder.publisher, identity);
    expect(swept).toBe(false);
    expect(recorder.identityPublishes).toEqual([]);
  });

  it('ignores a website-only claim set (nip05 rides kind 0, not kind 10011)', async () => {
    const recorder = recordingPublisher({
      identities: [
        { platform: 'website', handle: '_@example.com', proofUrl: 'https://example.com' },
      ],
      profile: { nip05: '_@example.com' },
    });
    const swept = await sweepStaleIdentityClaims(recorder.publisher, identity);
    expect(swept).toBe(false);
    expect(recorder.identityPublishes).toEqual([]);
  });

  it('swallows relay failures (retries on the next start)', async () => {
    const recorder = recordingPublisher();
    const swept = await sweepStaleIdentityClaims(recorder.publisher, identity);
    expect(swept).toBe(false);
    expect(recorder.identityPublishes).toEqual([]);
  });
});
