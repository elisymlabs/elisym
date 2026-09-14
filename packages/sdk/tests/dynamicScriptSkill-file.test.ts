/**
 * File I/O contract for DynamicScriptSkill: a script receives a file INPUT via
 * `ELISYM_INPUT_FILE` and may emit a file RESULT by writing `ELISYM_OUTPUT_FILE`.
 * When it does, execute() returns `{ filePath, outputMime }` for the runtime to
 * seed via iroh; otherwise the original stdin -> stdout text behavior is intact.
 */
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NATIVE_SOL } from '../src/payment/assets';
import { DynamicScriptSkill } from '../src/skills/dynamicScriptSkill';

interface ScriptFixture {
  dir: string;
  scriptPath: string;
}

const fixtures: ScriptFixture[] = [];

function setupScript(body: string): ScriptFixture {
  const dir = mkdtempSync(join(tmpdir(), 'elisym-script-file-'));
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(scriptPath, body, 'utf8');
  chmodSync(scriptPath, 0o755);
  const fixture = { dir, scriptPath };
  fixtures.push(fixture);
  return fixture;
}

function makeSkill(scriptPath: string, outputMime?: string): DynamicScriptSkill {
  return new DynamicScriptSkill({
    name: 'file-skill',
    description: 'file skill',
    capabilities: ['file-skill'],
    priceSubunits: 1n,
    asset: NATIVE_SOL,
    scriptPath,
    scriptArgs: [],
    outputMime,
  });
}

const CTX = { agentName: 'test-agent', agentDescription: '' };
const baseInput = { inputType: 'application/octet-stream', tags: [], jobId: 'job-1' };

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

describe('DynamicScriptSkill file I/O contract', () => {
  it('passes the input file via ELISYM_INPUT_FILE and returns a file result', async () => {
    // Copy the input bytes through and append a marker, so we can assert both the
    // input was read AND the output was produced.
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        'cat "$ELISYM_INPUT_FILE" > "$ELISYM_OUTPUT_FILE"\n' +
        'printf -- "-PROCESSED" >> "$ELISYM_OUTPUT_FILE"\n' +
        'echo "background removed"\n',
    );
    const inputDir = mkdtempSync(join(tmpdir(), 'elisym-input-'));
    const inputPath = join(inputDir, 'in.bin');
    writeFileSync(inputPath, 'original-bytes');

    try {
      const output = await makeSkill(scriptPath, 'image/png').execute(
        { ...baseInput, data: '', filePath: inputPath },
        CTX,
      );

      expect(output.filePath).toBeDefined();
      expect(output.outputMime).toBe('image/png');
      expect(output.data).toBe('background removed');
      const resultPath = output.filePath ?? '';
      expect(existsSync(resultPath)).toBe(true);
      expect(readFileSync(resultPath, 'utf8')).toBe('original-bytes-PROCESSED');
    } finally {
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  it('returns a file result even when the script writes no stdout note (data is empty)', async () => {
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "RESULT" > "$ELISYM_OUTPUT_FILE"\n',
    );
    const output = await makeSkill(scriptPath, 'image/png').execute(
      { ...baseInput, data: '' },
      CTX,
    );
    expect(output.filePath).toBeDefined();
    expect(output.data).toBe('');
    expect(readFileSync(output.filePath!, 'utf8')).toBe('RESULT');
  });

  it('defaults outputMime to application/octet-stream when undeclared', async () => {
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "x" > "$ELISYM_OUTPUT_FILE"\n',
    );
    const output = await makeSkill(scriptPath).execute({ ...baseInput, data: '' }, CTX);
    expect(output.outputMime).toBe('application/octet-stream');
  });

  it('keeps the text path unchanged: no output file => stdout text result, no filePath', async () => {
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\ntr "[:lower:]" "[:upper:]"\n',
    );
    const output = await makeSkill(scriptPath, 'image/png').execute(
      { ...baseInput, data: 'hello' },
      CTX,
    );
    expect(output.data).toBe('HELLO');
    expect(output.filePath).toBeUndefined();
    expect(output.outputMime).toBeUndefined();
  });

  it('still throws on exit 0 with neither stdout nor an output file', async () => {
    const { scriptPath } = setupScript('#!/usr/bin/env bash\nexit 0\n');
    const error = await makeSkill(scriptPath)
      .execute({ ...baseInput, data: '' }, CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/empty output/);
  });

  it('treats a 0-byte output file as no file result (falls back to the text guard)', async () => {
    // Touch the output file but write nothing, and emit no stdout: a 0-byte
    // result is not deliverable, so it must hit the empty-output guard.
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\n: > "$ELISYM_OUTPUT_FILE"\n',
    );
    const error = await makeSkill(scriptPath)
      .execute({ ...baseInput, data: '' }, CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/empty output/);
  });
});

/**
 * Metered charge channel: a script reports what the job actually cost by
 * writing subunits to `ELISYM_CHARGE_FILE`. The runtime clamps that figure into
 * the range the card published, so this layer only has to be honest about what
 * the script said - and silent when it said nothing usable.
 */
describe('DynamicScriptSkill metered charge channel', () => {
  it('returns the reported charge alongside a text result', async () => {
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        'printf "6100" > "$ELISYM_CHARGE_FILE"\nprintf "the answer"\n',
    );
    const out = await makeSkill(scriptPath).execute({ ...baseInput, data: 'q' }, CTX as never);
    expect(out.data).toBe('the answer');
    expect(out.chargeSubunits).toBe(6100n);
  });

  it('returns the reported charge alongside a single file result', async () => {
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        'printf "42" > "$ELISYM_CHARGE_FILE"\nprintf "FILE" > "$ELISYM_OUTPUT_FILE"\n',
    );
    const out = await makeSkill(scriptPath).execute({ ...baseInput, data: 'q' }, CTX as never);
    expect(out.filePath).toBeDefined();
    expect(out.chargeSubunits).toBe(42n);
    await out.cleanup?.();
  });

  it('returns the reported charge alongside a multi-file result', async () => {
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        'printf "7" > "$ELISYM_CHARGE_FILE"\n' +
        'printf "A" > "$ELISYM_OUTPUT_DIR/a.txt"\nprintf "B" > "$ELISYM_OUTPUT_DIR/b.txt"\n',
    );
    const out = await makeSkill(scriptPath).execute({ ...baseInput, data: 'q' }, CTX as never);
    expect(out.filePaths).toHaveLength(2);
    expect(out.chargeSubunits).toBe(7n);
    await out.cleanup?.();
  });

  it('never delivers the charge file to the buyer as an attachment', async () => {
    // The multi-file scan adopts every non-empty file under ELISYM_OUTPUT_DIR.
    // The charge file must therefore live OUTSIDE that directory, or a metered
    // text skill would ship its own accounting note as the result.
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "99" > "$ELISYM_CHARGE_FILE"\nprintf "text"\n',
    );
    const out = await makeSkill(scriptPath).execute({ ...baseInput, data: 'q' }, CTX as never);
    expect(out.filePaths).toBeUndefined();
    expect(out.filePath).toBeUndefined();
    expect(out.data).toBe('text');
  });

  it('treats a missing, empty or unparseable charge as no report', async () => {
    for (const body of [
      'printf "text"\n', // never written
      ': > "$ELISYM_CHARGE_FILE"\nprintf "text"\n', // zero bytes
      'printf "not-a-number" > "$ELISYM_CHARGE_FILE"\nprintf "text"\n',
      'printf -- "-5" > "$ELISYM_CHARGE_FILE"\nprintf "text"\n', // negative
      'printf "1.5" > "$ELISYM_CHARGE_FILE"\nprintf "text"\n', // decimal
    ]) {
      const { scriptPath } = setupScript(`#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
      const out = await makeSkill(scriptPath).execute({ ...baseInput, data: 'q' }, CTX as never);
      expect(out.chargeSubunits).toBeUndefined();
    }
  });

  it('refuses to read an oversized charge file even if it would trim to digits', async () => {
    // The size gate fires before the read, so an attacker cannot make the agent
    // pull an arbitrary file into memory by writing to the charge path. Padding
    // that trims away is exactly the case the regex alone would let through.
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        '{ printf "6100"; head -c 200 /dev/zero | tr "\\0" " "; } > "$ELISYM_CHARGE_FILE"\n' +
        'printf "text"\n',
    );
    const out = await makeSkill(scriptPath).execute({ ...baseInput, data: 'q' }, CTX as never);
    expect(out.chargeSubunits).toBeUndefined();
  });

  // Property test, not a guard test: `readFile` on a directory throws EISDIR and
  // is caught anyway, so the `isFile()` check is defence in depth. What matters
  // is that the job survives and reports nothing.
  it('ignores a directory at the charge path instead of throwing', async () => {
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p "$ELISYM_CHARGE_FILE"\nprintf "text"\n',
    );
    const out = await makeSkill(scriptPath).execute({ ...baseInput, data: 'q' }, CTX as never);
    expect(out.chargeSubunits).toBeUndefined();
    expect(out.data).toBe('text');
  });

  it('ignores a charge above the u64 ceiling rather than overflowing the pull', async () => {
    const { scriptPath } = setupScript(
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        'printf "99999999999999999999" > "$ELISYM_CHARGE_FILE"\nprintf "text"\n',
    );
    const out = await makeSkill(scriptPath).execute({ ...baseInput, data: 'q' }, CTX as never);
    expect(out.chargeSubunits).toBeUndefined();
  });
});
