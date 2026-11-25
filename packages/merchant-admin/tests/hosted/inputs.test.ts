import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INPUT, KEY_INPUT, TEXT_INPUT } from '../../src/hosted/styles';

const COMPONENTS = join(process.cwd(), 'src', 'hosted', 'components');

describe('hosted input styles', () => {
  it('masks only the key field', () => {
    expect(KEY_INPUT.split(' ')).toContain('masked');
    expect(INPUT.split(' ')).not.toContain('masked');
    expect(TEXT_INPUT.split(' ')).not.toContain('masked');
  });

  it('uses the masked style in the owner key fields only: sign-in, and the new key of a move', () => {
    const users = readdirSync(COMPONENTS).filter((name) =>
      readFileSync(join(COMPONENTS, name), 'utf8').includes('KEY_INPUT'),
    );
    expect(users).toEqual(['MoveKeyChoice.tsx', 'SignIn.tsx']);
  });
});
