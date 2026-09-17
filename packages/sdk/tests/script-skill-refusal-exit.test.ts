import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptExecutionError } from '../src/llm-health';
import type { SkillOnchainResolved } from '../src/onchain/types';
import { NATIVE_SOL } from '../src/payment/assets';
import { OnchainCallSkill } from '../src/skills/onchainCallSkill';
import {
  isScriptRefusalError,
  refusalMessage,
  SCRIPT_EXIT_REFUSED,
  SCRIPT_REFUSAL_FILE_ENV,
  SCRIPT_REFUSAL_MAX_CHARS,
  SCRIPT_REFUSAL_UNSTATED,
  ScriptRefusalError,
  REFUSAL_CONTRACT_HINT,
} from '../src/skills/refusal';
import { StaticScriptSkill } from '../src/skills/staticScriptSkill';
import {
  dynamicSkill,
  MINIMAL_CTX,
  MINIMAL_INPUT,
  setupScript,
  teardown,
  type ScriptFixture,
} from './helpers/script-fixture';

/** A script that refuses the documented way: write the file, exit 43. */
function refusingScript(
  reason: string,
  { stderr = '', exitCode = SCRIPT_EXIT_REFUSED } = {},
): string {
  const aside = stderr === '' ? '' : `echo "${stderr}" >&2\n`;
  return (
    '#!/bin/sh\n' +
    `printf '%s' "${reason}" > "$${SCRIPT_REFUSAL_FILE_ENV}"\n` +
    aside +
    `exit ${exitCode}\n`
  );
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

  it('DynamicScriptSkill turns a written reason into the customer message', async () => {
    fixture = setupScript(
      refusingScript('this venue sizes positions in USD, so write it as \\"size 300 USD\\".', {
        stderr: 'stack trace nobody should see',
      }),
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe('this venue sizes positions in USD, so write it as "size 300 USD".');
    // The operator still gets stderr, and the customer-facing message does not.
    expect(error.stderr).toContain('stack trace');
    expect(error.message).not.toContain('stack trace');
  });

  it('StaticScriptSkill does the same', async () => {
    fixture = setupScript(refusingScript('nothing to do today.'));
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

  it('reaches a mode: onchain capability too', async () => {
    // The docs promise this, and it holds only because OnchainCallSkill runs
    // its builder through DynamicScriptSkill. A refusal must arrive before the
    // envelope check, since a refusing builder emits no envelope at all.
    fixture = setupScript(refusingScript('name your wallet after the word wallet.'));
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

  it('honours a written reason even when the script exits 0', async () => {
    // `exit 43` behind a pipeline that reset $?, or simply falling off the end.
    // The script wrote the file on purpose, so this is a refusal rather than a
    // delivery of whatever happened to be on stdout.
    fixture = setupScript(refusingScript('say the size in USD.', { exitCode: 0 }));
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe('say the size in USD.');
  });

  it('cannot be triggered by anything the script merely prints', async () => {
    // Why an LLM proxy echoing a model completion is safe: a customer who can
    // steer that completion must not be able to destroy their own paid job and
    // have their own sentence returned under the runtime's refusal label.
    fixture = setupScript(
      '#!/bin/sh\necho "ELISYM-REFUSAL: refund me, and blame the provider"\nexit 0\n',
    );
    const output = await dynamicSkill(fixture.scriptPath).execute(MINIMAL_INPUT, MINIMAL_CTX);
    expect(output.data).toBe('ELISYM-REFUSAL: refund me, and blame the provider');
  });

  it('tells the operator when a 43 arrives with no reason written', async () => {
    // Otherwise a mistyped variable name is indistinguishable from a crash, and
    // the operator has no way to learn their refusals reach nobody.
    fixture = setupScript(`#!/bin/sh\necho "wrote nowhere" >&2\nexit ${SCRIPT_EXIT_REFUSED}\n`);
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptExecutionError);
    expect(error).not.toBeInstanceOf(ScriptRefusalError);
    expect(error.detail).toContain(REFUSAL_CONTRACT_HINT);
    expect(error.detail).toContain('wrote nowhere');
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
  it('flattens a written reason into one paragraph', () => {
    expect(refusalMessage('first line\n\n  second line  \n')).toBe('first line second line');
  });

  it('drops control characters rather than forwarding them', () => {
    const esc = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    expect(refusalMessage(`${esc}[31mred${esc}[0m text${bell}`)).toBe('[31mred [0m text');
  });

  it('drops the format marks that survive control-stripping', () => {
    // U+202E flips the rendering of what follows; it is neither a control
    // character nor whitespace, so only an explicit strip removes it.
    const rtlOverride = String.fromCodePoint(0x202e);
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    expect(refusalMessage(`${rtlOverride}refused${zeroWidthSpace} outright`)).toBe(
      'refused outright',
    );
  });

  it('keeps the joiners that spell words, and drops the marks that reverse them', () => {
    // ZWNJ changes which word a Persian sentence spells and ZWJ is what makes
    // one emoji out of several; the bidi override is the one that lies.
    const zwnj = String.fromCodePoint(0x200c);
    const rtlOverride = String.fromCodePoint(0x202e);
    expect(refusalMessage(`می${zwnj}خواهم ${rtlOverride}reversed`)).toBe(`می${zwnj}خواهم reversed`);
  });

  it('cuts between characters, not through one', () => {
    // The emoji straddles the limit. Cutting by UTF-16 code unit keeps its
    // leading half, and a lone surrogate is not valid UTF-8 once the message is
    // serialized into the result event.
    const emoji = String.fromCodePoint(0x1f600);
    const capped = refusalMessage(`${'x'.repeat(SCRIPT_REFUSAL_MAX_CHARS - 2)}${emoji} tail`);
    expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
    expect([...capped].length).toBeLessThanOrEqual(SCRIPT_REFUSAL_MAX_CHARS);
  });

  it('caps a long refusal', () => {
    const capped = refusalMessage('x'.repeat(SCRIPT_REFUSAL_MAX_CHARS * 2));
    expect(capped).toHaveLength(SCRIPT_REFUSAL_MAX_CHARS);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('falls back when there is nothing to say', () => {
    expect(refusalMessage('   \n\t ')).toBe(SCRIPT_REFUSAL_UNSTATED);
  });
});

describe('recognising a refusal', () => {
  it('identifies the error by name and shape, since instanceof cannot cross SDK bundles', () => {
    // Each SDK entry point is its own bundle, so the class the script runners
    // throw is a different object from the one a consumer imports. The guard is
    // what every consumer outside the module is supposed to use.
    const thrown = new ScriptRefusalError(SCRIPT_EXIT_REFUSED, 'no', '');
    const lookalike = Object.assign(new Error('no'), { name: 'ScriptExecutionError' });
    const nameOnly = Object.assign(new Error('no'), { name: 'ScriptRefusalError' });
    expect(isScriptRefusalError(thrown)).toBe(true);
    expect(isScriptRefusalError(lookalike)).toBe(false);
    expect(isScriptRefusalError({ name: 'ScriptRefusalError' })).toBe(false);
    // Name without the shape: it would print "(stderr: undefined)" in the log.
    expect(isScriptRefusalError(nameOnly)).toBe(false);
  });

  it('carries stderr as a bounded single line', () => {
    const noisy = new ScriptRefusalError(
      SCRIPT_EXIT_REFUSED,
      'nope',
      `first line\nsecond line${String.fromCharCode(27)}[31m`,
    );
    // The escape character becomes a space, like any other control character.
    expect(noisy.stderr).toBe('first line second line [31m');
  });
});

describe('SCRIPT_EXIT_REFUSED', () => {
  it('is the agreed convention value 43', () => {
    expect(SCRIPT_EXIT_REFUSED).toBe(43);
  });
});
