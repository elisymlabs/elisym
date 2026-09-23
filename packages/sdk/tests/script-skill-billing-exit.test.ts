import { NATIVE_SOL } from '@elisym/pay-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCRIPT_EXIT_BILLING_EXHAUSTED, ScriptBillingExhaustedError } from '../src/llm-health';
import { StaticScriptSkill } from '../src/skills/staticScriptSkill';
import {
  dynamicSkill,
  MINIMAL_CTX,
  MINIMAL_INPUT,
  setupScript,
  teardown,
  type ScriptFixture,
} from './helpers/script-fixture';

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
    await expect(
      dynamicSkill(fixture.scriptPath, 'proxy').execute(MINIMAL_INPUT, MINIMAL_CTX),
    ).rejects.toBeInstanceOf(ScriptBillingExhaustedError);
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
    const error = await dynamicSkill(fixture.scriptPath, 'fail')
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ScriptBillingExhaustedError);
    expect(error.message).toMatch(/exit 1/);
  });
});

describe('script skills reject empty output on exit 0', () => {
  let fixture: ScriptFixture | null = null;

  afterEach(() => {
    if (fixture) {
      teardown(fixture);
    }
  });

  it('DynamicScriptSkill throws on exit 0 with empty stdout', async () => {
    fixture = setupScript('#!/bin/sh\nexit 0\n');
    const error = await dynamicSkill(fixture.scriptPath, 'empty')
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ScriptBillingExhaustedError);
    expect(error.message).toMatch(/empty output/);
  });

  it('StaticScriptSkill throws on exit 0 with empty stdout', async () => {
    fixture = setupScript('#!/bin/sh\nexit 0\n');
    const skill = new StaticScriptSkill({
      name: 'empty',
      description: 'empty',
      capabilities: ['empty'],
      priceSubunits: 1n,
      asset: NATIVE_SOL,
      scriptPath: fixture.scriptPath,
      scriptArgs: [],
    });
    const error = await skill.execute(MINIMAL_INPUT, MINIMAL_CTX).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/empty output/);
  });

  it('treats whitespace-only output as empty', async () => {
    fixture = setupScript('#!/bin/sh\nprintf "   \\n"\n');
    const error = await dynamicSkill(fixture.scriptPath, 'blank')
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/empty output/);
  });

  it('still returns non-empty output unchanged', async () => {
    fixture = setupScript('#!/bin/sh\necho "ok"\n');
    const output = await dynamicSkill(fixture.scriptPath, 'ok').execute(MINIMAL_INPUT, MINIMAL_CTX);
    expect(output.data).toBe('ok');
  });
});

describe('SCRIPT_EXIT_BILLING_EXHAUSTED', () => {
  it('is the agreed convention value 42', () => {
    expect(SCRIPT_EXIT_BILLING_EXHAUSTED).toBe(42);
  });
});
