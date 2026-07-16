import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/constants';
import {
  DEFAULT_X402_MAX_INPUT_BYTES,
  loadSkillsFromDir,
  validateSkillFrontmatter,
} from '../src/skills/loader';
import type { SkillContext, SkillInput, X402Invoker } from '../src/skills/types';
import { X402ProxySkill } from '../src/skills/x402ProxySkill';

const base = {
  name: 'market-data',
  description: 'premium market data via x402',
  capabilities: ['market-data'],
  price: 0.05,
  token: 'usdc',
};

const x402Base = {
  ...base,
  mode: 'x402',
  x402_url: 'https://api.example.com/premium-data',
  x402_max_upstream: 10_000,
};

const withX402 = { allowX402Skills: true };

describe('validateSkillFrontmatter mode x402', () => {
  it('rejects mode x402 without the host opt-in', () => {
    expect(() => validateSkillFrontmatter(x402Base, '')).toThrow(/require the elisym CLI runtime/);
  });

  it('parses a minimal POST skill with defaults', () => {
    const parsed = validateSkillFrontmatter(x402Base, '', withX402);
    expect(parsed.mode).toBe('x402');
    expect(parsed.x402).toEqual({
      url: 'https://api.example.com/premium-data',
      method: 'POST',
      queryParam: undefined,
      maxUpstreamSubunits: 10_000n,
      maxInputBytes: DEFAULT_X402_MAX_INPUT_BYTES,
    });
    expect(parsed.noInput).toBe(false);
  });

  it('accepts a string x402_max_upstream and parses it as bigint', () => {
    const parsed = validateSkillFrontmatter(
      { ...x402Base, x402_max_upstream: '123456' },
      '',
      withX402,
    );
    expect(parsed.x402?.maxUpstreamSubunits).toBe(123_456n);
  });

  it('marks a GET skill without query param as noInput', () => {
    const parsed = validateSkillFrontmatter({ ...x402Base, x402_method: 'GET' }, '', withX402);
    expect(parsed.noInput).toBe(true);
    expect(parsed.x402?.method).toBe('GET');
  });

  it('accepts a GET skill with a query param (not noInput)', () => {
    const parsed = validateSkillFrontmatter(
      { ...x402Base, x402_method: 'GET', x402_query_param: 'q' },
      '',
      withX402,
    );
    expect(parsed.noInput).toBe(false);
    expect(parsed.x402?.queryParam).toBe('q');
  });

  it('accepts a custom x402_max_input_bytes up to the re-inline cap', () => {
    const parsed = validateSkillFrontmatter(
      { ...x402Base, x402_max_input_bytes: LIMITS.MAX_REINLINE_TEXT_BYTES },
      '',
      withX402,
    );
    expect(parsed.x402?.maxInputBytes).toBe(LIMITS.MAX_REINLINE_TEXT_BYTES);
  });

  it('rejects a non-https URL for remote hosts', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...x402Base, x402_url: 'http://api.example.com/data' },
        '',
        withX402,
      ),
    ).toThrow(/https/);
  });

  it('allows plain http for loopback hosts (local demo/test servers)', () => {
    for (const loopback of ['http://localhost:3000/data', 'http://127.0.0.1:8080/data']) {
      const parsed = validateSkillFrontmatter({ ...x402Base, x402_url: loopback }, '', withX402);
      expect(parsed.x402?.url).toBe(loopback);
    }
  });

  it('rejects a malformed URL', () => {
    expect(() =>
      validateSkillFrontmatter({ ...x402Base, x402_url: 'not a url' }, '', withX402),
    ).toThrow(/not a valid URL/);
  });

  it('rejects an unknown method', () => {
    expect(() =>
      validateSkillFrontmatter({ ...x402Base, x402_method: 'DELETE' }, '', withX402),
    ).toThrow(/x402_method/);
  });

  it('rejects x402_query_param on a POST skill', () => {
    expect(() =>
      validateSkillFrontmatter({ ...x402Base, x402_query_param: 'q' }, '', withX402),
    ).toThrow(/only valid with x402_method 'GET'/);
  });

  it('rejects a query param that collides with the URL query string', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          ...x402Base,
          x402_url: 'https://api.example.com/data?q=fixed',
          x402_method: 'GET',
          x402_query_param: 'q',
        },
        '',
        withX402,
      ),
    ).toThrow(/collides/);
  });

  it('requires x402_max_upstream', () => {
    expect(() =>
      validateSkillFrontmatter({ ...x402Base, x402_max_upstream: undefined }, '', withX402),
    ).toThrow(/x402_max_upstream/);
  });

  it('rejects zero, negative and non-integer x402_max_upstream', () => {
    for (const bad of [0, -5, 1.5, '12.5', 'abc']) {
      expect(() =>
        validateSkillFrontmatter({ ...x402Base, x402_max_upstream: bad }, '', withX402),
      ).toThrow(/x402_max_upstream/);
    }
  });

  it('rejects x402_max_input_bytes above the re-inline cap', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...x402Base, x402_max_input_bytes: LIMITS.MAX_REINLINE_TEXT_BYTES + 1 },
        '',
        withX402,
      ),
    ).toThrow(/x402_max_input_bytes/);
  });

  it('rejects provider/model on an x402 skill', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...x402Base, provider: 'anthropic', model: 'claude-sonnet-5' },
        '',
        withX402,
      ),
    ).toThrow(/not valid in mode 'x402'/);
  });

  it('rejects x402_* fields on non-x402 modes', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'dynamic-script', script: './run.sh', x402_url: 'https://x.example' },
        '',
        withX402,
      ),
    ).toThrow(/only valid in mode 'x402'/);
  });

  it('rejects tools on an x402 skill', () => {
    expect(() => validateSkillFrontmatter({ ...x402Base, tools: [] }, '', withX402)).toThrow(
      /only valid in mode 'llm'/,
    );
  });

  it('rejects script/output_file/input_mime on an x402 skill', () => {
    expect(() =>
      validateSkillFrontmatter({ ...x402Base, script: './run.sh' }, '', withX402),
    ).toThrow(/only valid in script modes/);
    expect(() =>
      validateSkillFrontmatter({ ...x402Base, output_file: './out.txt' }, '', withX402),
    ).toThrow(/only valid in mode 'static-file'/);
    expect(() => validateSkillFrontmatter({ ...x402Base, input_mime: '*' }, '', withX402)).toThrow(
      /only valid in mode 'dynamic-script'/,
    );
  });
});

describe('X402ProxySkill', () => {
  const params = {
    name: 'market-data',
    description: 'premium market data via x402',
    capabilities: ['market-data'],
    priceSubunits: 60_000n,
    asset: { chain: 'solana', symbol: 'USDC', decimals: 6 } as never,
    x402: {
      url: 'https://api.example.com/premium-data',
      method: 'POST' as const,
      queryParam: undefined,
      maxUpstreamSubunits: 10_000n,
      maxInputBytes: 100_000,
    },
  };

  const input: SkillInput = {
    data: 'hello',
    inputType: 'text',
    tags: ['market-data'],
    jobId: 'job-1',
  };

  const bareCtx: SkillContext = { agentName: 'bridge', agentDescription: 'test' };

  it('fails clearly when the context has no x402 driver', async () => {
    const skill = new X402ProxySkill(params);
    await expect(skill.execute(input, bareCtx)).rejects.toThrow(/require the elisym CLI runtime/);
    await expect(skill.preflight(input, bareCtx)).rejects.toThrow(/require the elisym CLI runtime/);
  });

  it('delegates preflight and execute to the injected driver', async () => {
    const invoker: X402Invoker = {
      preflight: vi.fn().mockResolvedValue(undefined),
      execute: vi
        .fn()
        .mockResolvedValue({ data: 'result', outputMime: 'image/png', filePath: '/tmp/f' }),
    };
    const controller = new AbortController();
    const ctx: SkillContext = { ...bareCtx, x402: invoker, signal: controller.signal };
    const skill = new X402ProxySkill(params);

    await skill.preflight(input, ctx);
    expect(invoker.preflight).toHaveBeenCalledWith(params.x402, input);

    const output = await skill.execute(input, ctx);
    expect(invoker.execute).toHaveBeenCalledWith(params.x402, input, controller.signal);
    expect(output).toEqual({ data: 'result', outputMime: 'image/png', filePath: '/tmp/f' });
    expect(output.cleanup).toBeUndefined();
  });

  it('computes noInput from method and query param', () => {
    expect(new X402ProxySkill(params).noInput).toBe(false);
    expect(new X402ProxySkill({ ...params, x402: { ...params.x402, method: 'GET' } }).noInput).toBe(
      true,
    );
    expect(
      new X402ProxySkill({
        ...params,
        x402: { ...params.x402, method: 'GET', queryParam: 'q' },
      }).noInput,
    ).toBe(false);
  });
});

describe('loadSkillsFromDir mode x402', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-x402-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const skillMd = [
    '---',
    'name: market-data',
    'description: premium market data via x402',
    'capabilities:',
    '  - market-data',
    'price: 0.05',
    'token: usdc',
    'mode: x402',
    'x402_url: https://api.example.com/premium-data',
    'x402_max_upstream: 10000',
    '---',
    '',
    'Operator notes.',
  ].join('\n');

  it('skips x402 skills with a warning when the host did not opt in', async () => {
    await mkdir(join(dir, 'market-data'));
    await writeFile(join(dir, 'market-data', 'SKILL.md'), skillMd);
    const warn = vi.fn();
    const skills = loadSkillsFromDir(dir, { logger: { warn } });
    expect(skills).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('loads an X402ProxySkill when the host opted in', async () => {
    await mkdir(join(dir, 'market-data'));
    await writeFile(join(dir, 'market-data', 'SKILL.md'), skillMd);
    const skills = loadSkillsFromDir(dir, { allowX402Skills: true });
    expect(skills).toHaveLength(1);
    const skill = skills[0];
    expect(skill).toBeInstanceOf(X402ProxySkill);
    expect(skill?.mode).toBe('x402');
    expect(skill?.priceSubunits).toBe(50_000n);
  });
});
