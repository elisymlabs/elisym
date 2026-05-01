import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCRIPT_EXIT_BILLING_EXHAUSTED, ScriptBillingExhaustedError } from '../src/llm-health';
import { NATIVE_SOL } from '../src/payment/assets';
import { DynamicScriptSkill } from '../src/skills/dynamicScriptSkill';
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

describe('script skills surface billing-exhausted exit', () => {
  let fixture: ScriptFixture | null = null;

  beforeEach(() => {
    fixture = null;
  });

  afterEach(() => {
    if (fixture) {
      teardown(fixture);
    }
  });

  it('DynamicScriptSkill throws ScriptBillingExhaustedError on exit 42', async () => {
    fixture = setupScript(
      `#!/bin/sh\necho "credits gone" >&2\nexit ${SCRIPT_EXIT_BILLING_EXHAUSTED}\n`,
    );
    const skill = new DynamicScriptSkill({
      name: 'proxy',
      description: 'proxy',
      capabilities: ['proxy'],
      priceSubunits: 1n,
      asset: NATIVE_SOL,
      scriptPath: fixture.scriptPath,
      scriptArgs: [],
    });
    await expect(skill.execute(MINIMAL_INPUT, MINIMAL_CTX)).rejects.toBeInstanceOf(
      ScriptBillingExhaustedError,
    );
  });

  it('StaticScriptSkill throws ScriptBillingExhaustedError on exit 42', async () => {
    fixture = setupScript(
      `#!/bin/sh\necho "out of credits" >&2\nexit ${SCRIPT_EXIT_BILLING_EXHAUSTED}\n`,
    );
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
    expect(error).toBeInstanceOf(ScriptBillingExhaustedError);
    expect(error.exitCode).toBe(SCRIPT_EXIT_BILLING_EXHAUSTED);
    expect(error.stderr).toContain('out of credits');
  });

  it('keeps generic Error for non-42 non-zero exits', async () => {
    fixture = setupScript('#!/bin/sh\nexit 1\n');
    const skill = new DynamicScriptSkill({
      name: 'fail',
      description: 'fail',
      capabilities: ['fail'],
      priceSubunits: 1n,
      asset: NATIVE_SOL,
      scriptPath: fixture.scriptPath,
      scriptArgs: [],
    });
    const error = await skill.execute(MINIMAL_INPUT, MINIMAL_CTX).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ScriptBillingExhaustedError);
    expect(error.message).toMatch(/exit 1/);
  });
});

describe('SCRIPT_EXIT_BILLING_EXHAUSTED', () => {
  it('is the agreed convention value 42', () => {
    expect(SCRIPT_EXIT_BILLING_EXHAUSTED).toBe(42);
  });
});
