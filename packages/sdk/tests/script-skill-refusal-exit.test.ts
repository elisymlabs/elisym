import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptExecutionError } from '../src/llm-health';
import type { SkillOnchainResolved } from '../src/onchain/types';
import { NATIVE_SOL } from '../src/payment/assets';
import { isHostScratchError } from '../src/skills/host-fault';
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
  REFUSAL_UNREADABLE_HINT,
  REFUSAL_WRONG_EXIT_HINT,
} from '../src/skills/refusal';
import { StaticScriptSkill } from '../src/skills/staticScriptSkill';
import type { SkillOutput } from '../src/skills/types';
import {
  clipTailToCharacters,
  excerptUntrusted,
  excerptUntrustedTail,
  hasVisibleText,
} from '../src/skills/untrusted-text';
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

  it('gives each static-script job a channel no other job can see', async () => {
    // One directory shared by the whole process would be enumerable: `ls
    // "$(dirname "$ELISYM_REFUSAL_FILE")"` from one job's script reaches the
    // channel of every job running beside it, and writing there forges a
    // refusal that closes a different customer's paid job.
    fixture = setupScript(
      `#!/bin/sh\nls "$(dirname "$${SCRIPT_REFUSAL_FILE_ENV}")" | wc -l\n` +
        `dirname "$${SCRIPT_REFUSAL_FILE_ENV}"\n`,
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
    const [first, second] = await Promise.all([
      skill.execute(MINIMAL_INPUT, MINIMAL_CTX),
      skill.execute(MINIMAL_INPUT, MINIMAL_CTX),
    ]);
    const dirOf = (out: SkillOutput): string => String(out.data).split('\n')[1] ?? '';
    // Each job sees an EMPTY directory of its own - its file exists only once
    // the script writes it - and never the other job's.
    expect(String(first.data).split('\n')[0]?.trim()).toBe('0');
    expect(dirOf(first)).not.toBe(dirOf(second));
    // And neither directory outlives the job.
    expect(existsSync(dirOf(first))).toBe(false);
    expect(existsSync(dirOf(second))).toBe(false);
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

  it('reads a bounded prefix of a runaway refusal file', async () => {
    // `yes refused > "$ELISYM_REFUSAL_FILE"` must not pull an arbitrary amount
    // into the agent, and the customer still gets a sentence out of it.
    fixture = setupScript(
      '#!/bin/sh\n' +
        `head -c 2000000 /dev/zero | tr '\\0' 'a' > "$${SCRIPT_REFUSAL_FILE_ENV}"\n` +
        `exit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toHaveLength(SCRIPT_REFUSAL_MAX_CHARS);
  });

  it('does not turn a finished job into a refusal because the file was opened', async () => {
    // Opening the channel early (`: > "$ELISYM_REFUSAL_FILE"`, or a Python
    // `open(path, "w")` before the decision) is a common shape. With exit 0 the
    // job SUCCEEDED, and treating the empty file as a refusal would throw the
    // answer away after the customer had paid for it.
    fixture = setupScript(
      `#!/bin/sh\n: > "$${SCRIPT_REFUSAL_FILE_ENV}"\necho "the answer"\nexit 0\n`,
    );
    const output = await dynamicSkill(fixture.scriptPath).execute(MINIMAL_INPUT, MINIMAL_CTX);
    expect(output.data).toBe('the answer');
  });

  it('does not turn a finished job into a refusal over a lone newline either', async () => {
    // `echo >` is how a shell script opens a file, and it leaves a byte behind.
    // Emptiness has to mean "nothing a reader would see", or the guard above
    // covers only the one shape that writes zero bytes.
    fixture = setupScript(
      `#!/bin/sh\necho "" > "$${SCRIPT_REFUSAL_FILE_ENV}"\necho "the answer"\nexit 0\n`,
    );
    const output = await dynamicSkill(fixture.scriptPath).execute(MINIMAL_INPUT, MINIMAL_CTX);
    expect(output.data).toBe('the answer');
  });

  it('leaves a crash that opened the channel a crash', async () => {
    // Same file, non-zero exit, and still not a refusal: the customer must not
    // be told the agent decided against them when it fell over, and the health
    // monitor must still see the failure it would otherwise skip.
    fixture = setupScript(
      `#!/bin/sh\necho "" > "$${SCRIPT_REFUSAL_FILE_ENV}"\necho "boom" >&2\nexit 1\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptExecutionError);
    expect(error).not.toBeInstanceOf(ScriptRefusalError);
    expect(error.detail).toContain('boom');
  });

  it('treats an empty refusal file as a refusal with nothing said', async () => {
    // Both docs promise this. The script created the file deliberately; only
    // its ABSENCE means "this was not a refusal".
    fixture = setupScript(
      `#!/bin/sh\n: > "$${SCRIPT_REFUSAL_FILE_ENV}"\nexit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe(SCRIPT_REFUSAL_UNSTATED);
  });

  it('refuses to read a refusal file that is a symlink to something else', async () => {
    // The channel's whole premise is that a script WROTE those bytes on
    // purpose. A link pointing at the agent's own config would otherwise have
    // its first 8 KB published to a customer as the reason.
    fixture = setupScript(
      `#!/bin/sh\nsecret="$(dirname "$${SCRIPT_REFUSAL_FILE_ENV}")/agent-key"\n` +
        `printf '%s' 'nsec-the-operator-would-rather-keep' > "$secret"\n` +
        `rm -f "$${SCRIPT_REFUSAL_FILE_ENV}"\n` +
        `ln -s "$secret" "$${SCRIPT_REFUSAL_FILE_ENV}"\n` +
        `exit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).not.toBeInstanceOf(ScriptRefusalError);
    expect(error.message).not.toContain('nsec');
    expect(error.detail).not.toContain('nsec');
  });

  it('keeps the contract hint in front of a chatty script`s own output', async () => {
    // The operator log excerpts a long detail from its END. The hint is the one
    // line saying the refusal reached nobody, and a progress meter must not be
    // able to push it out.
    fixture = setupScript(
      `#!/bin/sh\ni=0\nwhile [ $i -lt 400 ]; do echo "downloading chunk $i" >&2; i=$((i+1)); done\nexit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptExecutionError);
    expect(error.detail.startsWith(REFUSAL_CONTRACT_HINT)).toBe(true);
    expect(error.detail).toContain('downloading chunk');
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

  it('does not read a refusal file that is a HARD link to something else', async () => {
    // `O_NOFOLLOW` refuses a symlink; a hard link is not one, and on a host
    // whose temp directory shares a volume with the agent's home - macOS by
    // default - `ln` would publish the first 8 KB of the target to a relay as
    // the provider's own sentence.
    fixture = setupScript(
      `#!/bin/sh\nsecret="$(dirname "$${SCRIPT_REFUSAL_FILE_ENV}")/agent-key"\n` +
        `printf '%s' 'nsec-the-operator-would-rather-keep' > "$secret"\n` +
        `rm -f "$${SCRIPT_REFUSAL_FILE_ENV}"\n` +
        `ln "$secret" "$${SCRIPT_REFUSAL_FILE_ENV}"\n` +
        `exit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    // A refusal with nothing said, NOT a crash: the script did exit 43 on
    // purpose. Calling it a crash would gate the operator's capability, and some
    // network mounts report a link count this check cannot trust - a correct
    // skill on one of those would take itself offline on every job.
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe(SCRIPT_REFUSAL_UNSTATED);
    expect(error.stderr).not.toContain('nsec');
  });

  it('takes a label off that a control byte was hiding behind', async () => {
    // A NUL or an escape is not whitespace, so trimming is not something to
    // strip against: the label walks past the test and a later flatten turns it
    // back into a clean forged one, in the app's own voice.
    const nul = String.fromCharCode(0);
    const joiner = String.fromCodePoint(0x200d);
    expect(refusalMessage(`${nul}The provider refused: size it in USD.`)).toBe('size it in USD.');
    // A zero-width joiner survives flattening on purpose - it spells words in
    // Persian - so it is the one invisible character a forger could still hide
    // in front of a label.
    expect(refusalMessage(`${joiner}the agent refused: size it in USD.`)).toBe('size it in USD.');
    // Anything VISIBLE in front means the label is not leading, and the sentence
    // keeps it: there is no clean forgery to undo.
    expect(refusalMessage('[0m the provider refused: size it in USD.')).toBe(
      '[0m the provider refused: size it in USD.',
    );
  });

  it('takes both labels off, in any order and with or without the space', async () => {
    // Interleaved: a pass per label strips one and leaves the other, which is
    // the doubled label the customer then reads under the app's own.
    expect(refusalMessage('The agent refused: The provider refused: size it in USD.')).toBe(
      'size it in USD.',
    );
    // Flattening cannot put back a space the script never typed.
    expect(refusalMessage('The provider refused:size it in USD.')).toBe('size it in USD.');
    // And the budget is spent on the reason, not on the label.
    const long = 'x'.repeat(SCRIPT_REFUSAL_MAX_CHARS);
    expect(refusalMessage(`The provider refused: ${long}`)).toBe(long);
  });

  it('takes the runtime`s own label off a script that wrote it', async () => {
    // The label says who is speaking and the runtime is what puts it there. A
    // doubled one reaches a client that strips a single copy and renders the
    // rest as the provider's sentence - the provider wearing the app's voice.
    fixture = setupScript(
      refusingScript('The provider refused: your API key is invalid, contact support.'),
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptRefusalError);
    expect(error.message).toBe('your API key is invalid, contact support.');
  });

  it('never turns a 43 into a host fault, whatever went wrong with the channel', async () => {
    // A host fault keeps a PAID job alive for the recovery loop. The script here
    // ran and decided, so re-running it means the same refusal on every tick for
    // 24 hours with the customer's money held for an answer that cannot change -
    // whichever of the three channel problems produced the exit.
    fixture = setupScript(`#!/bin/sh\necho "no channel here" >&2\nexit ${SCRIPT_EXIT_REFUSED}\n`);
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(isHostScratchError(error)).toBe(false);
    expect(error).toBeInstanceOf(ScriptExecutionError);
  });

  it('believes the exit code when a reason is written and the script then crashes', async () => {
    // A skill that validates early, writes why, and falls over further down has
    // NOT refused. Calling that a refusal would charge the customer for a crash
    // and - since a refusal leaves health alone by design - let a chronically
    // broken skill keep selling, which is the hole exit 43 is refused for.
    fixture = setupScript(
      refusingScript('size it in USD.', { stderr: 'upstream returned garbage', exitCode: 1 }),
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptExecutionError);
    expect(error).not.toBeInstanceOf(ScriptRefusalError);
    expect(error.message).not.toContain('size it in USD');
    expect(error.detail.startsWith(REFUSAL_WRONG_EXIT_HINT)).toBe(true);
  });

  it('blames the HOST when the reason file cannot be read', async () => {
    // A directory where the file should be is the deterministic stand-in for
    // every shape this rejects (a symlink, mode 000, out of descriptors): the
    // script kept its side of the contract, so the operator must not be sent
    // hunting a typo. What sits at that path is the SCRIPT's doing, so unlike
    // the agent failing to make a scratch directory at all, this still gates
    // health - otherwise `mkdir "$ELISYM_REFUSAL_FILE"; exit 43` would be a
    // skill's own switch for its circuit breaker.
    fixture = setupScript(
      `#!/bin/sh\nrm -f "$${SCRIPT_REFUSAL_FILE_ENV}"\nmkdir "$${SCRIPT_REFUSAL_FILE_ENV}"\n` +
        `exit ${SCRIPT_EXIT_REFUSED}\n`,
    );
    const error = await dynamicSkill(fixture.scriptPath)
      .execute(MINIMAL_INPUT, MINIMAL_CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ScriptExecutionError);
    expect(error).not.toBeInstanceOf(ScriptRefusalError);
    expect(error.detail.startsWith(REFUSAL_UNREADABLE_HINT)).toBe(true);
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

  it('finds a reason that sits past the fast-path window', () => {
    // Whitespace collapses by an unbounded factor, so a scan window measured on
    // raw characters can be all newlines. The customer still gets the sentence.
    expect(refusalMessage(`${'\n'.repeat(4000)}add the target audience.`)).toBe(
      'add the target audience.',
    );
  });

  it('does not hand back half a label, or an ellipsis, from a run of them', () => {
    // A script writing nothing but labels: the cut used to land inside one, so
    // the customer read `The provider re…` - or just `…`, which is a visible
    // character and so passed the "did anything survive" test.
    expect(refusalMessage('The provider refused: '.repeat(30))).toBe(SCRIPT_REFUSAL_UNSTATED);
    expect(refusalMessage(`${'The agent refused: '.repeat(40)}size it in USD.`)).toBe(
      'size it in USD.',
    );
  });

  it('falls back when there is nothing to say', () => {
    expect(refusalMessage('   \n\t ')).toBe(SCRIPT_REFUSAL_UNSTATED);
  });
});

describe('excerpting for the operator', () => {
  it('keeps the END of a long stderr, where the diagnostic lands', async () => {
    const meter = '#'.repeat(5000);
    const excerpt = excerptUntrustedTail(`${meter} insufficient credit balance`, 200);
    expect(excerpt.endsWith('insufficient credit balance')).toBe(true);
    expect(excerpt.startsWith('…')).toBe(true);
    expect([...excerpt].length).toBeLessThanOrEqual(200);
  });

  it('leaves a short text alone, with no ellipsis to imply a cut', async () => {
    expect(excerptUntrustedTail('out of credits', 200)).toBe('out of credits');
  });

  it('does not call padding a truncation', async () => {
    const nul = String.fromCharCode(0).repeat(4000);
    expect(excerptUntrusted(`complete reason.${nul}`, 400)).toBe('complete reason.');
  });

  it('finds a diagnostic the trailing window could not hold', async () => {
    // A curl progress meter's carriage returns, all of them AFTER the line
    // worth keeping: the window holds nothing, so the excerpt has to pay for
    // the whole text once rather than return an ellipsis.
    const meter = String.fromCharCode(13).repeat(4000);
    expect(excerptUntrustedTail(`out of credits${meter}`, 200)).toBe('out of credits');
  });

  it('keeps a whole short line when clipping the tail of one', async () => {
    // The budget is larger than the text, so the ellipsis is the caller's cut
    // and every character survives it: an offset computed from the wrong end
    // would be negative, and `slice(-7)` would silently eat the front.
    expect(clipTailToCharacters('a whole short line', 100, true)).toBe('…a whole short line');
  });

  it('counts control characters as invisible, not as text', async () => {
    expect(hasVisibleText(`${String.fromCharCode(7)}${String.fromCharCode(0)}`)).toBe(false);
    expect(hasVisibleText(String.fromCodePoint(0x200d))).toBe(false);
    expect(hasVisibleText(' hello ')).toBe(true);
  });

  it('keeps the operator`s own API key out of a quote of their script', async () => {
    // A proxy run with `curl -v` prints the request header. The quote of that
    // failure is stored as the health monitor's reason and re-printed on every
    // job the gate refuses afterwards, so a key in it is a key in the log
    // forever.
    const verbose = '> POST /v1/messages\n> x-api-key: sk-ant-api03-DEADBEEFcafe1234\n< HTTP 500';
    expect(excerptUntrustedTail(verbose, 200)).not.toContain('DEADBEEF');
    expect(excerptUntrusted(verbose, 200)).toContain('[redacted]');
    expect(excerptUntrusted('Authorization: Bearer abcdef1234567890', 200)).not.toContain('abcdef');
    expect(excerptUntrusted('token sk-proj-ABCDEFGHIJKLMNOP failed', 200)).toContain('[redacted]');
  });

  it('hands the customer the refusal as the provider wrote it', async () => {
    // Redaction is for text this runtime SCRAPED. This sentence was written on
    // purpose, for this customer, and telling them which credential to set is
    // the whole point of the channel - `[redacted]` would leave them nothing.
    expect(refusalMessage('set Authorization: Bearer YOUR_VENUE_TOKEN before retrying')).toBe(
      'set Authorization: Bearer YOUR_VENUE_TOKEN before retrying',
    );
    expect(refusalMessage('your request must include an api_key: value for this venue')).toBe(
      'your request must include an api_key: value for this venue',
    );
  });

  it('still redacts a key out of what it SCRAPED from a script', async () => {
    expect(excerptUntrusted('upstream said api_key: sk-ant-api03-DEADBEEFcafe1234', 200)).toBe(
      'upstream said [redacted]',
    );
  });

  it('gives back nothing when asked for nothing, from either end', async () => {
    // Arithmetic that reaches zero ("what is left of the line") must not come
    // back with the whole input, and a lone ellipsis is not an excerpt either.
    expect(excerptUntrusted('a sentence', 0)).toBe('');
    expect(excerptUntrustedTail('a sentence', 0)).toBe('');
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
