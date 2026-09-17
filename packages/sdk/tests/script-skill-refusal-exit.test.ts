import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCRIPT_EXIT_REFUSED,
  SCRIPT_REFUSAL_MAX_CHARS,
  SCRIPT_REFUSAL_UNSTATED,
  ScriptExecutionError,
  ScriptRefusalError,
  refusalMessage,
} from '../src/llm-health';
import type { SkillOnchainResolved } from '../src/onchain/types';
import { NATIVE_SOL } from '../src/payment/assets';
import { DynamicScriptSkill } from '../src/skills/dynamicScriptSkill';
import { OnchainCallSkill } from '../src/skills/onchainCallSkill';
import { StaticScriptSkill } from '../src/skills/staticScriptSkill';

interface ScriptFixture {
  dir: string;
  scriptPath: string;
}

function setupScript(body: string): ScriptFixture {
  const dir = mkdtempSync(join(tmpdir(), 'elisym-script-'));
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(scriptPath, body, 'utf8');
  chmodSync(scriptPath, 0o755);
  return { dir, scriptPath };
}

function teardown(fixture: ScriptFixture): void {
  rmSync(fixture.dir, { recursive: true, force: true });
}

const MINIMAL_INPUT = {
  data: '',
  inputType: 'text/plain',
  tags: [],
  jobId: 'test-job',
};
const MINIMAL_CTX = { agentName: 'test-agent', agentDescription: '' };

function dynamicSkill(scriptPath: string): DynamicScriptSkill {
  return new DynamicScriptSkill({
    name: 'builder',
    description: 'builder',
    capabilities: ['builder'],
    priceSubunits: 1n,
    asset: NATIVE_SOL,
    scriptPath,
    scriptArgs: [],
  });
}

describe('script skills surface a refusal the customer can read', () => {
  let fixture: ScriptFixture | null = null;

  beforeEach(() => {
    fixture = null;
  });

  afterEach(() => {
    if (fixture) {
      teardown(fixture);
    }
  });

  it('DynamicScriptSkill turns exit 43 into the stdout sentence', async () => {
    fixture = setupScript(
      `#!/bin/sh\necho "this venue sizes positions in USD, so write it as \\"size 300 USD\\"."\n` +
        `echo "stack trace nobody should see" >&2\nexit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe('this venue sizes positions in USD, so write it as "size 300 USD".');
    // The operator still gets stderr, and the customer-facing message does not.
    expect(error.detail).toContain('stack trace');
    expect(error.message).not.toContain('stack trace');
  });

  it('StaticScriptSkill does the same', async () => {
    fixture = setupScript(`#!/bin/sh\necho "nothing to do today."\nexit ${SCRIPT_EXIT_REFUSED}\n`);
    const skill = new StaticScriptSkill({
      name: 'cron',
      description: 'cron',
      capabilities: ['cron'],
      priceSubunits: 1n,
      asset: NATIVE_SOL,
      scriptPath: fixture.scriptPath,
      scriptArgs: [],
    });
    const error = await skill.execute(MINIMAL_INPUT, MINIMAL_CTX).catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.exitCode).toBe(SCRIPT_EXIT_REFUSED);
    expect(error.message).toBe('nothing to do today.');
  });

  it('says so when the script refuses without a reason', async () => {
    fixture = setupScript(`#!/bin/sh\necho "quiet failure" >&2\nexit ${SCRIPT_EXIT_REFUSED}\n`);
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe(SCRIPT_REFUSAL_UNSTATED);
    expect(error.message).not.toContain('quiet failure');
  });

  it('reaches a mode: onchain capability too', async () => {
    // The docs promise this, and it holds only because OnchainCallSkill runs
    // its builder through DynamicScriptSkill. A refusal must arrive before the
    // envelope check, since a refusing builder emits no envelope at all.
    fixture = setupScript(
      `#!/bin/sh\necho "name your wallet after the word wallet."\nexit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const onchain: SkillOnchainResolved = {
      kind: 'perp-close',
      programs: ['Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo'],
      requires: [],
      params: [],
      token: 'sol',
      decimals: 9,
      max_per_call_subunits: '0',
      grants_authority: false,
      max_authority_subunits: '0',
    };
    const skill = new OnchainCallSkill({
      name: 'close',
      description: 'close',
      capabilities: ['onchain-call'],
      priceSubunits: 1n,
      asset: NATIVE_SOL,
      scriptPath: fixture.scriptPath,
      scriptArgs: [],
      onchain,
      network: 'mainnet',
    });
    const error = await skill.execute(MINIMAL_INPUT, MINIMAL_CTX).catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe('name your wallet after the word wallet.');
  });

  it('leaves a plain non-zero exit as a generic failure', async () => {
    fixture = setupScript('#!/bin/sh\necho "reason on stdout"\nexit 1\n');
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptExecutionError);
    expect(error).not.toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toMatch(/exit 1/);
    expect(error.message).not.toContain('reason on stdout');
  });
});

describe('refusalMessage', () => {
  it('flattens a multi-line refusal into one paragraph', () => {
    expect(refusalMessage('first line\n\n  second line  \n', SCRIPT_REFUSAL_MAX_CHARS)).toBe(
      'first line second line',
    );
  });

  it('drops control characters rather than forwarding them', () => {
    const esc = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    expect(refusalMessage(`${esc}[31mred${esc}[0m text${bell}`, SCRIPT_REFUSAL_MAX_CHARS)).toBe(
      '[31mred [0m text',
    );
  });

  it('caps a long refusal', () => {
    const capped = refusalMessage(
      'x'.repeat(SCRIPT_REFUSAL_MAX_CHARS * 2),
      SCRIPT_REFUSAL_MAX_CHARS,
    );
    expect(capped).toHaveLength(SCRIPT_REFUSAL_MAX_CHARS);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('cuts between characters, not through one', () => {
    // The emoji straddles the limit. Cutting by UTF-16 code unit keeps its
    // leading half, and a lone surrogate is not valid UTF-8 once the message is
    // serialized into the result event.
    const emoji = String.fromCodePoint(0x1f600);
    const capped = refusalMessage(
      `${'x'.repeat(SCRIPT_REFUSAL_MAX_CHARS - 2)}${emoji} tail`,
      SCRIPT_REFUSAL_MAX_CHARS,
    );
    expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
    expect([...capped].length).toBeLessThanOrEqual(SCRIPT_REFUSAL_MAX_CHARS);
  });

  it('falls back when there is nothing to say', () => {
    expect(refusalMessage('   \n\t ', SCRIPT_REFUSAL_MAX_CHARS)).toBe(SCRIPT_REFUSAL_UNSTATED);
  });
});

describe('SCRIPT_EXIT_REFUSED', () => {
  it('is the agreed convention value 43', () => {
    expect(SCRIPT_EXIT_REFUSED).toBe(43);
  });
});
