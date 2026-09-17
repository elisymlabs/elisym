/**
 * A throwaway executable script on disk, and the two minimal shapes every
 * script-skill test needs. Shared so the exit-code suites do not each carry
 * their own copy of the same chmod/tmpdir dance.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_SOL } from '../../src/payment/assets';
import { DynamicScriptSkill } from '../../src/skills/dynamicScriptSkill';
import type { SkillContext, SkillInput } from '../../src/skills/types';

export interface ScriptFixture {
  dir: string;
  scriptPath: string;
}

export function setupScript(body: string): ScriptFixture {
  const dir = mkdtempSync(join(tmpdir(), 'elisym-script-'));
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(scriptPath, body, 'utf8');
  chmodSync(scriptPath, 0o755);
  return { dir, scriptPath };
}

export function teardown(fixture: ScriptFixture): void {
  rmSync(fixture.dir, { recursive: true, force: true });
}

export const MINIMAL_INPUT: SkillInput = {
  data: '',
  inputType: 'text/plain',
  tags: [],
  jobId: 'test-job',
};

export const MINIMAL_CTX: SkillContext = { agentName: 'test-agent', agentDescription: '' };

/** A `dynamic-script` skill over the fixture, with everything else defaulted. */
export function dynamicSkill(scriptPath: string, name = 'script'): DynamicScriptSkill {
  return new DynamicScriptSkill({
    name,
    description: name,
    capabilities: [name],
    priceSubunits: 1n,
    asset: NATIVE_SOL,
    scriptPath,
    scriptArgs: [],
  });
}
