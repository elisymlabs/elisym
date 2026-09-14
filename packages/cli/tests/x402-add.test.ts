import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, generateSolanaWallet, signerFromSecretKeyBase58, toDTag } from '@elisym/sdk';
import { parseSkillMd, validateSkillFrontmatter } from '@elisym/sdk/skills';
import { getBase58Encoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSkillMd,
  computeBridgePriceSubunits,
  parseImportedSecret,
  sanitizeUpstreamText,
  scanExistingSkills,
  slugFromUrl,
} from '../src/commands/x402-add.js';

describe('sanitizeUpstreamText', () => {
  it('strips control characters and newlines (frontmatter injection surface)', () => {
    const hostile = 'Nice name\nprice: 0\nx402_max_upstream: 999999';
    const sanitized = sanitizeUpstreamText(hostile, 64);
    expect(sanitized).not.toContain('\n');
    expect(sanitized).toBe('Nice name price: 0 x402_max_upstream: 999999'.slice(0, 64).trim());
  });

  it('replaces em dashes with hyphens (repo style rule)', () => {
    expect(sanitizeUpstreamText('data — premium', 64)).toBe('data - premium');
  });

  it('clamps to the given length', () => {
    expect(sanitizeUpstreamText('x'.repeat(600), LIMITS.MAX_DESCRIPTION_LENGTH)).toHaveLength(500);
  });
});

describe('slugFromUrl', () => {
  it('derives host-path slugs', () => {
    expect(slugFromUrl(new URL('https://api.example.com/premium-data'))).toBe('api-premium-data');
    expect(slugFromUrl(new URL('https://www.weather.io/'))).toBe('weather');
  });
});

describe('computeBridgePriceSubunits', () => {
  it('applies margin and gross-up for the protocol fee with ceil', () => {
    // quote 5000, margin 10%, fee 2.5%: 5000 * 11000 / 9750 = 5641.02... -> 5642
    expect(computeBridgePriceSubunits(5_000n, 1_000, 250)).toBe(5_642n);
  });

  it('is identity-ish at zero margin and zero fee', () => {
    expect(computeBridgePriceSubunits(5_000n, 0, 0)).toBe(5_000n);
  });

  it('guarantees net >= quote * (1 + margin) after the ceil fee', () => {
    for (const [quote, margin, fee] of [
      [1n, 0, 9_999],
      [999n, 1, 1],
      [123_457n, 777, 250],
    ] as const) {
      const price = computeBridgePriceSubunits(quote, margin, fee);
      // Mirror the runtime: fee = ceil(price * feeBps / 10000).
      const feeAmount = (price * BigInt(fee) + 9_999n) / 10_000n;
      const net = price - feeAmount;
      const target = (quote * BigInt(10_000 + margin)) / 10_000n;
      expect(net >= target).toBe(true);
    }
  });

  it('refuses a fee at or above 100%', () => {
    expect(() => computeBridgePriceSubunits(5_000n, 0, 10_000)).toThrow(/denominator/);
  });
});

describe('buildSkillMd', () => {
  const base = {
    skillName: 'Market Data',
    description: 'Premium market data via x402',
    capabilities: ['market-data'],
    priceDisplay: '0.005642',
    url: 'https://api.example.com/premium-data',
    method: 'POST' as const,
    queryParam: undefined,
    quote: 5_000n,
    marginPercent: '10',
    feePercent: '2.5',
    network: 'devnet' as const,
  };

  function parseGenerated(content: string) {
    const { frontmatter, systemPrompt } = parseSkillMd(content);
    return {
      frontmatter,
      systemPrompt,
      parsed: validateSkillFrontmatter(frontmatter, systemPrompt, {
        network: 'devnet',
        allowFreeSkills: false,
        allowX402Skills: true,
      }),
    };
  }

  it('round-trips through the real loader', () => {
    const { parsed } = parseGenerated(buildSkillMd(base));
    expect(parsed.mode).toBe('x402');
    expect(parsed.name).toBe('Market Data');
    expect(parsed.priceSubunits).toBe(5_642n);
    expect(parsed.asset.token).toBe('usdc');
    expect(parsed.x402?.url).toBe(base.url);
    expect(parsed.x402?.maxUpstreamSubunits).toBe(5_000n);
    expect(parsed.x402?.maxInputBytes).toBe(100_000);
  });

  it('is injection-proof: a hostile description cannot smuggle frontmatter keys', () => {
    const hostile = {
      ...base,
      description: "evil\nprice: '0'\nx402_max_upstream: 999999999",
    };
    const { frontmatter, parsed } = parseGenerated(buildSkillMd(hostile));
    // The whole hostile string must survive as ONE description value...
    expect(frontmatter.description).toBe("evil\nprice: '0'\nx402_max_upstream: 999999999");
    // ...and the money fields must be untouched.
    expect(parsed.priceSubunits).toBe(5_642n);
    expect(parsed.x402?.maxUpstreamSubunits).toBe(5_000n);
  });

  it('writes the input cap only for POST and the query param only when set', () => {
    const post = parseGenerated(buildSkillMd(base));
    expect(post.frontmatter.x402_max_input_bytes).toBe(100_000);
    const get = parseGenerated(buildSkillMd({ ...base, method: 'GET', queryParam: 'q' }));
    expect(get.frontmatter.x402_max_input_bytes).toBeUndefined();
    expect(get.parsed.x402?.queryParam).toBe('q');
    const noInput = parseGenerated(buildSkillMd({ ...base, method: 'GET' }));
    expect(noInput.parsed.noInput).toBe(true);
  });
});

describe('parseImportedSecret', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-x402-import-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('imports a solana-keygen JSON file', async () => {
    const wallet = await generateSolanaWallet();
    const bytes = [...new Uint8Array(getBase58Encoder().encode(wallet.secretKeyBase58))];
    const keygenPath = join(dir, 'provider-wallet.json');
    await writeFile(keygenPath, JSON.stringify(bytes));
    const imported = await parseImportedSecret(keygenPath);
    expect(imported).toBe(wallet.secretKeyBase58);
    const signer = await signerFromSecretKeyBase58(imported);
    expect(signer.address).toBe(wallet.signer.address);
  });

  it('imports a raw base58 secret', async () => {
    const wallet = await generateSolanaWallet();
    await expect(parseImportedSecret(` ${wallet.secretKeyBase58} `)).resolves.toBe(
      wallet.secretKeyBase58,
    );
  });

  it('rejects a malformed keygen file and garbage input', async () => {
    const badPath = join(dir, 'bad.json');
    await writeFile(badPath, JSON.stringify([1, 2, 3]));
    await expect(parseImportedSecret(badPath)).rejects.toThrow(/64 bytes/);
    await expect(parseImportedSecret('definitely-not-base58!!!')).rejects.toThrow(
      /not a readable file/,
    );
  });
});

describe('scanExistingSkills', () => {
  let skillsDir: string;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'elisym-x402-scan-'));
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  async function writeSkill(folder: string, name: string, extra = ''): Promise<void> {
    await mkdir(join(skillsDir, folder));
    const content = [
      '---',
      `name: ${name}`,
      'description: existing',
      'capabilities:',
      '  - existing',
      'price: 0.05',
      'token: usdc',
      extra,
      '---',
      '',
    ].join('\n');
    await writeFile(join(skillsDir, folder, 'SKILL.md'), content);
  }

  it('detects a d-tag collision regardless of the folder name', async () => {
    await writeSkill('some-folder', 'WHOIS Lookup');
    const scan = scanExistingSkills(skillsDir, toDTag('whois-lookup'), 'https://x.example/a');
    expect(scan.dTagCollision).toBe('WHOIS Lookup');
  });

  it('recognizes an existing bridge for the same URL as the update flow', async () => {
    await writeSkill(
      'bridge-folder',
      'Old Bridge',
      ['mode: x402', 'x402_url: https://api.example.com/data', 'x402_max_upstream: 1000'].join(
        '\n',
      ),
    );
    const scan = scanExistingSkills(skillsDir, toDTag('New Name'), 'https://api.example.com/data');
    expect(scan.sameUrlDir).toBe(join(skillsDir, 'bridge-folder'));
    expect(scan.sameUrlName).toBe('Old Bridge');
    expect(scan.dTagCollision).toBeUndefined();
  });

  it('reports nothing for a clean directory', async () => {
    await writeSkill('other', 'Other Skill');
    const scan = scanExistingSkills(skillsDir, toDTag('fresh-name'), 'https://x.example/b');
    expect(scan).toEqual({});
  });
});
