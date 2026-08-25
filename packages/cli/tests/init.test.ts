import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Drives `cmdInit` through the interactive wizard with a scripted inquirer:
 * each prompt is answered by name from `promptAnswers`; an un-scripted prompt
 * throws, so a test also asserts which prompts do NOT appear (e.g. the
 * network prompt is skipped when --network is flagged).
 */
const promptAnswers: Record<string, unknown> = {};

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(async (questions: Array<{ name: string }>) => {
      const question = questions[0];
      if (question === undefined || !(question.name in promptAnswers)) {
        throw new Error(`unexpected prompt: ${question?.name ?? '<none>'}`);
      }
      return { [question.name]: promptAnswers[question.name] };
    }),
  },
}));

import { cmdInit, parseNetworkOption } from '../src/commands/init.js';

const SOLANA_ADDRESS = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';

function scriptWizardAnswers(overrides: Record<string, unknown> = {}): void {
  for (const key of Object.keys(promptAnswers)) {
    delete promptAnswers[key];
  }
  Object.assign(
    promptAnswers,
    {
      description: 'network test agent',
      displayName: '',
      picture: '',
      banner: '',
      solanaAddress: SOLANA_ADDRESS,
      llmProvider: 'none',
    },
    overrides,
  );
}

describe('elisym init - network selection', () => {
  let projectDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function loggedText(): string {
    const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const warned = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    return `${logged}\n${warned}`;
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'elisym-init-test-'));
    // A .git marker makes --local resolve the project root to this temp dir.
    mkdirSync(join(projectDir, '.git'));
    originalCwd = process.cwd();
    process.chdir(projectDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes network: mainnet when --network mainnet is flagged (no network prompt)', async () => {
    // No 'network' answer scripted: the flag must skip the prompt entirely.
    scriptWizardAnswers();
    await cmdInit('net-test-mainnet', { local: true, network: 'mainnet', passphrase: '' });

    const yamlText = readFileSync(
      join(projectDir, '.elisym', 'net-test-mainnet', 'elisym.yaml'),
      'utf-8',
    );
    expect(yamlText).toContain('network: mainnet');
    expect(yamlText).toContain(`address: ${SOLANA_ADDRESS}`);
    // Real-funds warning printed; faucet copy is devnet-only.
    expect(loggedText()).toContain('MAINNET');
    expect(loggedText()).not.toContain('faucet.circle.com');
    // No passphrase on a mainnet agent -> strong recommendation (warn, not force).
    expect(loggedText()).toContain('passphrase');
  });

  it('writes network: devnet by default via the prompt, with the faucet copy', async () => {
    scriptWizardAnswers({ network: 'devnet' });
    await cmdInit('net-test-devnet', { local: true, passphrase: '' });

    const yamlText = readFileSync(
      join(projectDir, '.elisym', 'net-test-devnet', 'elisym.yaml'),
      'utf-8',
    );
    expect(yamlText).toContain('network: devnet');
    expect(loggedText()).toContain('faucet.circle.com');
  });

  it('mainnet chosen at the prompt also skips the faucet copy', async () => {
    scriptWizardAnswers({ network: 'mainnet' });
    await cmdInit('net-test-prompted', { local: true, passphrase: 'hunter2-passphrase' });

    const yamlText = readFileSync(
      join(projectDir, '.elisym', 'net-test-prompted', 'elisym.yaml'),
      'utf-8',
    );
    expect(yamlText).toContain('network: mainnet');
    expect(loggedText()).not.toContain('faucet.circle.com');
    expect(loggedText()).toContain('MAINNET');
  });

  it('rejects an unknown --network value', async () => {
    scriptWizardAnswers();
    await expect(cmdInit('net-test-bad', { local: true, network: 'testnet' })).rejects.toThrow(
      /--network must be "devnet" or "mainnet"/,
    );
  });
});

describe('parseNetworkOption', () => {
  it('passes through valid values and undefined', () => {
    expect(parseNetworkOption(undefined)).toBeUndefined();
    expect(parseNetworkOption('devnet')).toBe('devnet');
    expect(parseNetworkOption('mainnet')).toBe('mainnet');
  });

  it('throws on anything else', () => {
    expect(() => parseNetworkOption('testnet')).toThrow(/devnet/);
    expect(() => parseNetworkOption('MAINNET')).toThrow(/devnet/);
  });
});
