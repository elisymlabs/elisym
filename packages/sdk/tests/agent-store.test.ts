import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import YAML from 'yaml';
import {
  ElisymYamlSchema,
  SecretsSchema,
  findProjectElisymDir,
  homeElisymDir,
  agentPaths,
  resolveAgent,
  listAgents,
  loadAgent,
  createAgentDir,
  ensureGitignoreHasIrohEntry,
  renderInitialYaml,
  writeYaml,
  writeYamlInitial,
  writeSecrets,
  readMediaCache,
  writeMediaCache,
  hashFile,
  lookupCachedUrl,
  newCacheEntry,
  type ElisymYaml,
  type Secrets,
} from '../src/agent-store';

let sandbox: string;
let fakeHome: string;
let work: string;
let originalHome: string | undefined;

function setHome(path: string) {
  originalHome = process.env.HOME;
  process.env.HOME = path;
  process.env.USERPROFILE = path;
}

function restoreHome() {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalHome;
  } else {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-agent-store-'));
  fakeHome = join(sandbox, 'home');
  work = join(sandbox, 'work');
  mkdirSync(fakeHome);
  mkdirSync(work);
  setHome(fakeHome);
});

afterEach(() => {
  restoreHome();
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('ElisymYamlSchema', () => {
  it('accepts a minimal YAML', () => {
    const parsed = ElisymYamlSchema.parse({ description: 'hi' });
    expect(parsed.description).toBe('hi');
    expect(parsed.relays).toEqual([]);
    expect(parsed.payments).toEqual([]);
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => ElisymYamlSchema.parse({ description: 'hi', extra: 1 })).toThrow();
  });

  it('rejects non-devnet networks until mainnet ships', () => {
    expect(() =>
      ElisymYamlSchema.parse({
        payments: [{ chain: 'solana', network: 'mainnet', address: 'abc' }],
      }),
    ).toThrow();
  });

  it('validates display_name length', () => {
    expect(() => ElisymYamlSchema.parse({ display_name: 'a'.repeat(65) })).toThrow();
  });
});

describe('ElisymYamlSchema identities', () => {
  const VALID_IDENTITIES = {
    github: { username: 'alice', gist: '9721ce4ee4fceb91c9711ca2a6c9a5ab' },
    x: { username: 'alice_ai', tweet: '1893471190424121782' },
    website: 'agent@example.com',
  };

  it('accepts a full identities section and round-trips through YAML', () => {
    const parsed = ElisymYamlSchema.parse({ description: 'hi', identities: VALID_IDENTITIES });
    expect(parsed.identities).toEqual(VALID_IDENTITIES);

    const reparsed = ElisymYamlSchema.parse(
      YAML.parse(YAML.stringify({ description: 'hi', identities: VALID_IDENTITIES })),
    );
    expect(reparsed.identities).toEqual(VALID_IDENTITIES);
  });

  it('accepts partial sections and a bare-domain website', () => {
    const parsed = ElisymYamlSchema.parse({
      description: 'hi',
      identities: { website: 'example.com' },
    });
    expect(parsed.identities?.website).toBe('example.com');
  });

  it('rejects a numeric tweet id (hand-edited unquoted scalar lost precision at YAML parse)', () => {
    // YAML parses the unquoted digits into a double BEFORE zod sees them -
    // the value is already corrupt (...121782 became ...121900 territory), so
    // the schema must fail loud instead of coercing.
    const fromYaml = YAML.parse(
      'identities:\n  x:\n    username: alice\n    tweet: 1893471190424121782\n',
    );
    expect(typeof fromYaml.identities.x.tweet).toBe('number');
    expect(() => ElisymYamlSchema.parse({ description: 'hi', ...fromYaml })).toThrow();
  });

  it('rejects a numeric gist id (all-digit or <digits>e<digits> YAML scalars)', () => {
    const fromYaml = YAML.parse(
      'identities:\n  github:\n    username: alice\n    gist: 123456789\n',
    );
    expect(() => ElisymYamlSchema.parse({ description: 'hi', ...fromYaml })).toThrow();
    const floatYaml = YAML.parse('identities:\n  github:\n    username: alice\n    gist: 123e45\n');
    expect(() => ElisymYamlSchema.parse({ description: 'hi', ...floatYaml })).toThrow();
  });

  it('rejects bad handles and proof ids (same regexes as the wire parser)', () => {
    expect(() =>
      ElisymYamlSchema.parse({
        identities: { github: { username: 'bad handle', gist: 'abc123' } },
      }),
    ).toThrow();
    expect(() =>
      ElisymYamlSchema.parse({
        identities: { github: { username: 'alice', gist: 'NOTHEX' } },
      }),
    ).toThrow();
    expect(() =>
      ElisymYamlSchema.parse({
        identities: { x: { username: 'way_too_long_for_x_', tweet: '123' } },
      }),
    ).toThrow();
  });

  it('rejects website IP literals and Unicode hosts', () => {
    expect(() => ElisymYamlSchema.parse({ identities: { website: '192.168.1.1' } })).toThrow();
    expect(() =>
      ElisymYamlSchema.parse({ identities: { website: 'agent@exämple.com' } }),
    ).toThrow();
  });

  it('rejects unknown keys inside identities (strict)', () => {
    expect(() =>
      ElisymYamlSchema.parse({ identities: { mastodon: { username: 'a', proof: 'b' } } }),
    ).toThrow();
  });
});

describe('SecretsSchema', () => {
  it('requires nostr_secret_key', () => {
    expect(() => SecretsSchema.parse({})).toThrow();
  });

  it('accepts optional solana and per-provider llm keys (llm_api_keys map)', () => {
    const parsed = SecretsSchema.parse({
      nostr_secret_key: 'a'.repeat(64),
      solana_secret_key: 'xyz',
      llm_api_keys: { anthropic: 'sk-ant', openai: 'sk-oai' },
    });
    expect(parsed.nostr_secret_key).toHaveLength(64);
    expect(parsed.llm_api_keys?.anthropic).toBe('sk-ant');
    expect(parsed.llm_api_keys?.openai).toBe('sk-oai');
  });

  it('rejects legacy top-level anthropic_api_key / openai_api_key fields', () => {
    expect(() =>
      SecretsSchema.parse({
        nostr_secret_key: 'a'.repeat(64),
        anthropic_api_key: 'sk-ant',
      }),
    ).toThrow();
  });

  it('rejects unknown secret fields (.strict guard)', () => {
    expect(() =>
      SecretsSchema.parse({
        nostr_secret_key: 'a'.repeat(64),
        cohere_api_key: 'unsupported',
      }),
    ).toThrow();
  });

  it('rejects the removed legacy llm_api_key field', () => {
    expect(() =>
      SecretsSchema.parse({
        nostr_secret_key: 'a'.repeat(64),
        llm_api_key: 'sk-legacy',
      }),
    ).toThrow();
  });
});

describe('findProjectElisymDir', () => {
  it('returns null when no .elisym/ or .git is found', () => {
    const found = findProjectElisymDir(work);
    expect(found).toBeNull();
  });

  it('finds .elisym/ in current dir', () => {
    const elisym = join(work, '.elisym');
    mkdirSync(elisym);
    const found = findProjectElisymDir(work);
    expect(found).toBe(elisym);
  });

  it('walks up to find .elisym/', () => {
    const elisym = join(work, '.elisym');
    mkdirSync(elisym);
    const nested = join(work, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const found = findProjectElisymDir(nested);
    expect(found).toBe(elisym);
  });

  it('stops at first .git and returns null if .elisym is above it', () => {
    const outerElisym = join(work, '.elisym');
    mkdirSync(outerElisym);
    const repo = join(work, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const found = findProjectElisymDir(repo);
    expect(found).toBeNull();
  });

  it('finds nearest .elisym/ when nested projects exist', () => {
    const outerElisym = join(work, '.elisym');
    mkdirSync(outerElisym);
    const innerRoot = join(work, 'sub');
    const innerElisym = join(innerRoot, '.elisym');
    mkdirSync(innerElisym, { recursive: true });
    const found = findProjectElisymDir(join(innerRoot, 'deep'));
    expect(found).toBe(innerElisym);
  });

  it('does not treat ~/.elisym/ as project-local when walking up hits $HOME', () => {
    mkdirSync(join(fakeHome, '.elisym'), { recursive: true });
    const found = findProjectElisymDir(fakeHome);
    expect(found).toBeNull();
  });
});

describe('homeElisymDir', () => {
  it('returns ~/.elisym/', () => {
    expect(homeElisymDir()).toBe(join(fakeHome, '.elisym'));
  });
});

describe('agentPaths', () => {
  it('returns all expected file paths', () => {
    const paths = agentPaths('/x/Bob');
    expect(paths.yaml).toBe('/x/Bob/elisym.yaml');
    expect(paths.secrets).toBe('/x/Bob/.secrets.json');
    expect(paths.mediaCache).toBe('/x/Bob/.media-cache.json');
    expect(paths.jobs).toBe('/x/Bob/.jobs.json');
    expect(paths.skills).toBe('/x/Bob/skills');
  });
});

describe('createAgentDir', () => {
  it('creates home layout', async () => {
    const result = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    expect(result.source).toBe('home');
    expect(existsSync(result.dir)).toBe(true);
    expect(existsSync(join(result.dir, 'skills'))).toBe(true);
  });

  it('creates project layout with .gitignore', async () => {
    const result = await createAgentDir({
      target: 'project',
      name: 'Bob',
      cwd: work,
      projectRoot: work,
    });
    expect(result.source).toBe('project');
    expect(result.createdNewElisymRoot).toBe(true);
    const gitignore = await readFile(join(work, '.elisym', '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.secrets.json');
    expect(gitignore).toContain('.media-cache.json');
    expect(gitignore).toContain('.jobs.json');
    // The iroh blob store holds cleartext job payloads - must be ignored.
    expect(gitignore).toContain('.iroh/');
  });

  it('reuses existing .elisym dir when creating additional agent', async () => {
    await createAgentDir({ target: 'project', name: 'Bob', cwd: work, projectRoot: work });
    const second = await createAgentDir({
      target: 'project',
      name: 'Eva',
      cwd: work,
      projectRoot: work,
    });
    expect(second.createdNewElisymRoot).toBe(false);
  });
});

describe('ensureGitignoreHasIrohEntry', () => {
  it('appends .iroh/ to an existing .gitignore that lacks it (migration)', async () => {
    const root = join(work, '.elisym');
    mkdirSync(root, { recursive: true });
    const gitignorePath = join(root, '.gitignore');
    writeFileSync(gitignorePath, '.secrets.json\n.jobs.json\n');

    await ensureGitignoreHasIrohEntry(root);

    const updated = await readFile(gitignorePath, 'utf-8');
    expect(updated).toContain('.iroh/');
    // Existing entries preserved.
    expect(updated).toContain('.secrets.json');
  });

  it('is idempotent and does not duplicate the entry', async () => {
    const root = join(work, '.elisym');
    mkdirSync(root, { recursive: true });
    const gitignorePath = join(root, '.gitignore');
    writeFileSync(gitignorePath, '.secrets.json\n.iroh/\n');

    await ensureGitignoreHasIrohEntry(root);

    const updated = await readFile(gitignorePath, 'utf-8');
    expect(updated.split('\n').filter((line) => line.trim() === '.iroh/').length).toBe(1);
  });

  it('is a no-op when no .gitignore exists (e.g. home-global)', async () => {
    const root = join(work, '.elisym');
    mkdirSync(root, { recursive: true });
    await ensureGitignoreHasIrohEntry(root);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });
});

describe('writeYaml + loadAgent round-trip', () => {
  const yaml: ElisymYaml = {
    display_name: 'Bobbert',
    description: 'YouTube summarizer',
    picture: './avatar.png',
    banner: undefined,
    relays: ['wss://relay.damus.io'],
    payments: [{ chain: 'solana', network: 'devnet', address: 'CYWTD...' }],
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', max_tokens: 4096 },
    security: {},
  };

  const secrets: Secrets = {
    nostr_secret_key: 'a'.repeat(64),
    llm_api_keys: { anthropic: 'sk-test-key' },
  };

  it('writes and reads YAML + secrets from home', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    await writeYaml(dir, yaml);
    await writeSecrets(dir, secrets);

    const loaded = await loadAgent('Bob', work);
    expect(loaded.name).toBe('Bob');
    expect(loaded.source).toBe('home');
    expect(loaded.yaml.display_name).toBe('Bobbert');
    expect(loaded.yaml.payments[0]?.address).toBe('CYWTD...');
    expect(loaded.secrets.nostr_secret_key).toBe('a'.repeat(64));
    expect(loaded.secrets.llm_api_keys?.anthropic).toBe('sk-test-key');
    expect(loaded.encrypted).toBe(false);
  });

  it('encrypts secrets when passphrase is provided, decrypts on load', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    await writeYaml(dir, yaml);
    await writeSecrets(dir, secrets, 'correct horse battery staple');

    const raw = JSON.parse(await readFile(join(dir, '.secrets.json'), 'utf-8'));
    expect(raw.nostr_secret_key).toMatch(/^encrypted:v1:/);
    expect(raw.llm_api_keys?.anthropic).toMatch(/^encrypted:v1:/);

    const loaded = await loadAgent('Bob', work, 'correct horse battery staple');
    expect(loaded.encrypted).toBe(true);
    expect(loaded.secrets.nostr_secret_key).toBe('a'.repeat(64));
    expect(loaded.secrets.llm_api_keys?.anthropic).toBe('sk-test-key');
  }, 15_000);

  it('throws if encrypted without passphrase', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    await writeYaml(dir, yaml);
    await writeSecrets(dir, secrets, 'pw');
    await expect(loadAgent('Bob', work)).rejects.toThrow(/encrypted secrets/);
  });

  it('loads project-local agent when .elisym/ is present', async () => {
    mkdirSync(join(work, 'proj', '.git'), { recursive: true });
    const cwd = join(work, 'proj');
    const { dir } = await createAgentDir({
      target: 'project',
      name: 'Bob',
      cwd,
      projectRoot: cwd,
    });
    await writeYaml(dir, yaml);
    await writeSecrets(dir, secrets);

    const loaded = await loadAgent('Bob', cwd);
    expect(loaded.source).toBe('project');
    expect(loaded.shadowsGlobal).toBe(false);
  });

  it('shadowsGlobal=true when project-local and home agents have same name', async () => {
    const home = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    await writeYaml(home.dir, yaml);
    await writeSecrets(home.dir, secrets);

    const proj = await createAgentDir({
      target: 'project',
      name: 'Bob',
      cwd: work,
      projectRoot: work,
    });
    await writeYaml(proj.dir, yaml);
    await writeSecrets(proj.dir, secrets);

    const loaded = await loadAgent('Bob', work);
    expect(loaded.source).toBe('project');
    expect(loaded.shadowsGlobal).toBe(true);
  });
});

describe('resolveAgent', () => {
  it('returns null when nothing found', () => {
    expect(resolveAgent('Bob', work)).toBeNull();
  });

  it('prefers project over home', async () => {
    const home = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    writeFileSync(join(home.dir, 'elisym.yaml'), 'description: home\n');
    const proj = await createAgentDir({
      target: 'project',
      name: 'Bob',
      cwd: work,
      projectRoot: work,
    });
    writeFileSync(join(proj.dir, 'elisym.yaml'), 'description: proj\n');

    const resolved = resolveAgent('Bob', work);
    expect(resolved?.source).toBe('project');
    expect(resolved?.shadowsGlobal).toBe(true);
  });
});

describe('listAgents', () => {
  it('lists home and project agents, project shadows home', async () => {
    const home1 = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    writeFileSync(join(home1.dir, 'elisym.yaml'), 'display_name: "Home Bob"\n');
    const home2 = await createAgentDir({ target: 'home', name: 'Eva', cwd: work });
    writeFileSync(join(home2.dir, 'elisym.yaml'), 'display_name: "Eva"\n');

    const proj = await createAgentDir({
      target: 'project',
      name: 'Bob',
      cwd: work,
      projectRoot: work,
    });
    writeFileSync(join(proj.dir, 'elisym.yaml'), 'display_name: "Project Bob"\n');

    const agents = await listAgents(work);
    expect(agents.map((agent) => agent.name).sort()).toEqual(['Bob', 'Eva']);
    const bob = agents.find((agent) => agent.name === 'Bob');
    expect(bob?.source).toBe('project');
    expect(bob?.shadowsGlobal).toBe(true);
    expect(bob?.displayName).toBe('Project Bob');
  });

  it('skips dotfile directories', async () => {
    mkdirSync(join(work, '.elisym', '.hidden'), { recursive: true });
    writeFileSync(join(work, '.elisym', '.hidden', 'elisym.yaml'), 'description: ignored\n');
    const agents = await listAgents(work);
    expect(agents).toEqual([]);
  });

  it('skips entries without elisym.yaml', async () => {
    mkdirSync(join(work, '.elisym', 'Ghost'), { recursive: true });
    const agents = await listAgents(work);
    expect(agents).toEqual([]);
  });
});

describe('media cache', () => {
  it('round-trips cache entries', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    const cache = { './avatar.png': newCacheEntry('https://x/a.png', 'a'.repeat(64)) };
    await writeMediaCache(dir, cache);
    const read = await readMediaCache(dir);
    expect(read['./avatar.png']?.url).toBe('https://x/a.png');
  });

  it('returns empty object when cache file missing', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    const read = await readMediaCache(dir);
    expect(read).toEqual({});
  });

  it('ignores corrupt cache', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    writeFileSync(join(dir, '.media-cache.json'), 'not json');
    const read = await readMediaCache(dir);
    expect(read).toEqual({});
  });

  it('lookupCachedUrl matches by sha256', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    const hash = await hashFile(file);
    const cache = { './a.txt': newCacheEntry('https://x/a.txt', hash) };
    const hit = await lookupCachedUrl(cache, './a.txt', file);
    expect(hit).toBe('https://x/a.txt');
  });

  it('lookupCachedUrl returns null when hash differs', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    const cache = { './a.txt': newCacheEntry('https://x/a.txt', 'b'.repeat(64)) };
    const hit = await lookupCachedUrl(cache, './a.txt', file);
    expect(hit).toBeNull();
  });
});

describe('YAML on-disk format', () => {
  it('writes valid YAML that round-trips', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    const yaml: ElisymYaml = ElisymYamlSchema.parse({
      description: 'hi',
      relays: ['wss://relay.damus.io'],
    });
    await writeYaml(dir, yaml);
    const raw = await readFile(join(dir, 'elisym.yaml'), 'utf-8');
    const parsed = YAML.parse(raw);
    expect(parsed.description).toBe('hi');
    expect(parsed.relays).toEqual(['wss://relay.damus.io']);
  });
});

describe('renderInitialYaml', () => {
  it('emits commented-out examples for unset optional fields', () => {
    const yaml = ElisymYamlSchema.parse({
      description: 'hi',
      relays: ['wss://relay.damus.io'],
    });
    const text = renderInitialYaml(yaml);

    expect(text).toMatch(/^description: hi$/m);
    expect(text).toMatch(/^# display_name:/m);
    expect(text).toMatch(/^# picture:/m);
    expect(text).toMatch(/^# banner:/m);
    expect(text).toMatch(/^# payments:/m);
    expect(text).toMatch(/^# llm:/m);
  });

  it('emits set fields uncommented', () => {
    const yaml = ElisymYamlSchema.parse({
      display_name: 'Bob',
      description: 'hi',
      picture: './a.png',
      relays: ['wss://relay.damus.io'],
      payments: [{ chain: 'solana', network: 'devnet', address: 'XYZ' }],
      llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', max_tokens: 4096 },
    });
    const text = renderInitialYaml(yaml);

    expect(text).toMatch(/^display_name: Bob$/m);
    expect(text).toMatch(/^picture: \.\/a\.png$/m);
    expect(text).toMatch(/^payments:$/m);
    expect(text).toMatch(/^llm:$/m);
    expect(text).not.toMatch(/^# display_name:/m);
    expect(text).not.toMatch(/^# picture:/m);
    expect(text).not.toMatch(/^# llm:/m);
    expect(text).not.toMatch(/^# payments:/m);
  });

  it('always writes both security flags with explicit booleans', () => {
    const yaml = ElisymYamlSchema.parse({ description: 'hi' });
    const text = renderInitialYaml(yaml);
    expect(text).toContain('withdrawals_enabled: false');
    expect(text).toContain('agent_switch_enabled: false');
  });

  it('round-trips through YAML.parse + ElisymYamlSchema (comments dropped)', () => {
    const yaml = ElisymYamlSchema.parse({
      description: 'hi',
      relays: ['wss://relay.damus.io'],
      payments: [{ chain: 'solana', network: 'devnet', address: 'AAA' }],
    });
    const text = renderInitialYaml(yaml);
    const reparsed = ElisymYamlSchema.parse(YAML.parse(text));

    expect(reparsed.description).toBe('hi');
    expect(reparsed.payments[0]?.address).toBe('AAA');
    expect(reparsed.display_name).toBeUndefined();
    expect(reparsed.picture).toBeUndefined();
    expect(reparsed.llm).toBeUndefined();
  });

  it('emits NOTHING for identities when unset - no commented placeholder', () => {
    const yaml = ElisymYamlSchema.parse({ description: 'hi' });
    const text = renderInitialYaml(yaml);
    expect(text).not.toContain('identities');
  });

  it('passes identities through when set (schema-valid operator template must not be dropped)', () => {
    const identities = {
      github: { username: 'alice', gist: '9721ce4ee4fceb91c9711ca2a6c9a5ab' },
      x: { username: 'alice_ai', tweet: '1893471190424121782' },
      website: 'agent@example.com',
    };
    const yaml = ElisymYamlSchema.parse({ description: 'hi', identities });
    const text = renderInitialYaml(yaml);

    expect(text).toMatch(/^identities:$/m);
    const reparsed = ElisymYamlSchema.parse(YAML.parse(text));
    expect(reparsed.identities).toEqual(identities);
    // The numeric-looking tweet id survives as a string (yaml lib quotes it).
    expect(typeof YAML.parse(text).identities.x.tweet).toBe('string');
  });
});

describe('writeYamlInitial', () => {
  it('writes a yaml with descriptive comments at agent creation time', async () => {
    const { dir } = await createAgentDir({ target: 'home', name: 'Bob', cwd: work });
    const yaml = ElisymYamlSchema.parse({
      description: 'hi',
      relays: ['wss://relay.damus.io'],
    });
    await writeYamlInitial(dir, yaml);

    const raw = await readFile(join(dir, 'elisym.yaml'), 'utf-8');
    expect(raw).toContain('description: hi');
    expect(raw).toMatch(/^# llm:/m);
    expect(raw).toMatch(/^# display_name:/m);

    const reparsed = ElisymYamlSchema.parse(YAML.parse(raw));
    expect(reparsed.description).toBe('hi');
    expect(reparsed.llm).toBeUndefined();
    expect(reparsed.display_name).toBeUndefined();
  });
});
