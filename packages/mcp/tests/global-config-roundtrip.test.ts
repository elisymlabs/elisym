/**
 * Round-trip tests for ~/.elisym/config.yaml through `loadGlobalConfig` /
 * `writeGlobalConfig`. Uses a temp HOME to avoid touching the real file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGlobalConfig, writeGlobalConfig } from '@elisym/sdk';
import { globalConfigPath } from '@elisym/sdk/agent-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('global config roundtrip', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'elisym-mcp-gcfg-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns {} when file is missing', async () => {
    const cfg = await loadGlobalConfig(globalConfigPath());
    expect(cfg).toEqual({});
  });

  it('roundtrips a SOL entry', async () => {
    await writeGlobalConfig(globalConfigPath(), {
      session_spend_limits: [{ chain: 'solana', token: 'sol', amount: 0.5 }],
    });
    const cfg = await loadGlobalConfig(globalConfigPath());
    expect(cfg.session_spend_limits).toEqual([{ chain: 'solana', token: 'sol', amount: 0.5 }]);
  });

  it('throws on malformed YAML', async () => {
    mkdirSync(join(tmpHome, '.elisym'), { recursive: true });
    writeFileSync(globalConfigPath(), 'session_spend_limits: [{chain:');
    await expect(loadGlobalConfig(globalConfigPath())).rejects.toThrow();
  });

  it('rejects schema violations (negative amount)', async () => {
    mkdirSync(join(tmpHome, '.elisym'), { recursive: true });
    writeFileSync(
      globalConfigPath(),
      'session_spend_limits:\n  - chain: solana\n    token: sol\n    amount: -1\n',
    );
    await expect(loadGlobalConfig(globalConfigPath())).rejects.toThrow();
  });
});
