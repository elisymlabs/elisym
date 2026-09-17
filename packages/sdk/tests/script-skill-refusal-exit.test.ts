import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptExecutionError } from '../src/llm-health';
import type { SkillOnchainResolved } from '../src/onchain/types';
import { NATIVE_SOL } from '../src/payment/assets';
import { OnchainCallSkill } from '../src/skills/onchainCallSkill';
import {
  isRefusal,
  isScriptRefusalError,
  refusalMessage,
  SCRIPT_EXIT_REFUSED,
  SCRIPT_REFUSAL_MARKER,
  SCRIPT_REFUSAL_MAX_CHARS,
  SCRIPT_REFUSAL_UNSTATED,
  ScriptRefusalError,
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

/** A script that refuses the documented way: the marker, then the reason. */
function refusingScript(reason: string, stderr = ''): string {
  const aside = stderr === '' ? '' : `echo "${stderr}" >&2\n`;
  return `#!/bin/sh\necho "${SCRIPT_REFUSAL_MARKER} ${reason}"\n${aside}exit ${SCRIPT_EXIT_REFUSED}\n`;
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

  it('DynamicScriptSkill turns a marked exit 43 into the stdout sentence', async () => {
    fixture = setupScript(
      refusingScript(
        'this venue sizes positions in USD, so write it as \\"size 300 USD\\".',
        'stack trace nobody should see',
      ),
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

  it('says so when the script marks a refusal but states no reason', async () => {
    fixture = setupScript(refusingScript('', 'quiet failure'));
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe(SCRIPT_REFUSAL_UNSTATED);
    expect(error.message).not.toContain('quiet failure');
  });

  it('treats an UNMARKED exit 43 as the failure it is', async () => {
    // 43 is curl's CURLE_BAD_FUNCTION_ARGUMENT, so a `set -e` script inherits
    // it without meaning to refuse anything. Without the marker the skill must
    // stay on the failure path: generic message, health gate intact.
    fixture = setupScript(
      `#!/bin/sh\necho "partial API body"\necho "curl: (43) bad argument" >&2\nexit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptExecutionError);
    expect(error).not.toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toMatch(/exit 43/);
    expect(error.message).not.toContain('partial API body');
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
  const marked = (reason: string): string => `${SCRIPT_REFUSAL_MARKER} ${reason}`;

  it('reads the marker line and stops at its end', () => {
    // What follows the refusal line is the script talking to its operator: a
    // debug dump there is not something to forward to a paying stranger.
    expect(
      refusalMessage(marked('write the size in USD.\nDEBUG token=sk-secret host=internal')),
    ).toBe('write the size in USD.');
  });

  it('drops control characters rather than forwarding them', () => {
    const esc = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    expect(refusalMessage(marked(`${esc}[31mred${esc}[0m text${bell}`))).toBe('[31mred [0m text');
  });

  it('drops the format marks that survive control-stripping', () => {
    // U+202E flips the rendering of what follows; it is neither a control
    // character nor whitespace, so only an explicit strip removes it.
    const rtlOverride = String.fromCodePoint(0x202e);
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    expect(refusalMessage(marked(`${rtlOverride}refused${zeroWidthSpace} outright`))).toBe(
      'refused outright',
    );
  });

  it('cuts between characters, not through one', () => {
    // The emoji straddles the limit. Cutting by UTF-16 code unit keeps its
    // leading half, and a lone surrogate is not valid UTF-8 once the message is
    // serialized into the result event.
    const emoji = String.fromCodePoint(0x1f600);
    const capped = refusalMessage(
      marked(`${'x'.repeat(SCRIPT_REFUSAL_MAX_CHARS - 2)}${emoji} tail`),
    );
    expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
    expect([...capped].length).toBeLessThanOrEqual(SCRIPT_REFUSAL_MAX_CHARS);
  });

  it('caps a long refusal', () => {
    const capped = refusalMessage(marked('x'.repeat(SCRIPT_REFUSAL_MAX_CHARS * 2)));
    expect(capped).toHaveLength(SCRIPT_REFUSAL_MAX_CHARS);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('caps a megabyte of stdout the same way', () => {
    const capped = refusalMessage(marked('y'.repeat(1_000_000)));
    expect(capped).toHaveLength(SCRIPT_REFUSAL_MAX_CHARS);
  });

  it('keeps the joiners that spell words, and drops the marks that reverse them', () => {
    // ZWNJ changes which word a Persian sentence spells and ZWJ is what makes
    // one emoji out of several; the bidi override is the one that lies.
    const zwnj = String.fromCodePoint(0x200c);
    const rtlOverride = String.fromCodePoint(0x202e);
    expect(refusalMessage(marked(`می${zwnj}خواهم ${rtlOverride}reversed`))).toBe(
      `می${zwnj}خواهم reversed`,
    );
  });

  it('keeps a reason that starts after a long padded block', () => {
    // The scan window is measured from the first real character, not from the
    // marker: a heredoc that indents its reason past the window would otherwise
    // be reported as a refusal with no reason - the one outcome this channel
    // exists to prevent.
    const padded = `${SCRIPT_REFUSAL_MARKER}${' '.repeat(40_000)}write the size in USD.`;
    expect(refusalMessage(padded)).toBe('write the size in USD.');
  });

  it('never cuts the scan window through a character', () => {
    // The window ends mid-emoji; keeping its leading half would hand the result
    // event a lone surrogate, which is not valid UTF-8.
    const emoji = String.fromCodePoint(0x1f600);
    const atWindowEdge = `${SCRIPT_REFUSAL_MARKER} ${'x'.repeat(SCRIPT_REFUSAL_MAX_CHARS * 8 - 1)}${emoji}`;
    const message = refusalMessage(atWindowEdge);
    expect(Buffer.from(message, 'utf8').toString('utf8')).toBe(message);
  });

  it('falls back when there is nothing to say', () => {
    expect(refusalMessage(marked('   \n\t '))).toBe(SCRIPT_REFUSAL_UNSTATED);
  });
});

describe('recognising a refusal', () => {
  it('needs the marker, not just any first word', () => {
    expect(isRefusal(`  ${SCRIPT_REFUSAL_MARKER} because`)).toBe(true);
    expect(isRefusal('refused: because')).toBe(false);
    expect(isRefusal('')).toBe(false);
  });

  it('identifies the error by name, since instanceof cannot cross SDK bundles', () => {
    // Each SDK entry point is its own bundle, so the class the script runners
    // throw is a different object from the one a consumer imports. The guard is
    // what every consumer outside the module is supposed to use.
    const thrown = new ScriptRefusalError(SCRIPT_EXIT_REFUSED, `${SCRIPT_REFUSAL_MARKER} no`, '');
    const lookalike = Object.assign(new Error('no'), { name: 'ScriptExecutionError' });
    expect(isScriptRefusalError(thrown)).toBe(true);
    expect(isScriptRefusalError(lookalike)).toBe(false);
    expect(isScriptRefusalError({ name: 'ScriptRefusalError' })).toBe(false);
  });

  it('carries stderr as a bounded single line', () => {
    const noisy = new ScriptRefusalError(
      SCRIPT_EXIT_REFUSED,
      `${SCRIPT_REFUSAL_MARKER} nope`,
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
