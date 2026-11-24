// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMeta } from '../../src/hosted/lib/api';
import { OPERATOR_RE, readHostedConfig } from '../../src/hosted/lib/hosted-config';

/** The server's own rule, read from its source: the copy here must stay the same. */
function serverOperatorRule(): RegExp {
  const source = readFileSync(
    new URL('../../../paycore-server/src/config.ts', import.meta.url),
    'utf8',
  );
  const literal = /const OPERATOR_RE =\s*\/(.+)\/([a-z]*);/.exec(source);
  if (literal?.[1] === undefined) {
    throw new Error('no OPERATOR_RE in paycore-server/src/config.ts');
  }
  return new RegExp(literal[1], literal[2]);
}

const SAMPLES: [string, boolean][] = [
  ['paycore.example', true],
  ['api.pay-core.elisym.network', true],
  ['a.b', true],
  ['x1.example', true],
  ['PayCore.example', false],
  ['paycore.example.', false],
  ['paycore', false],
  ['127.0.0.1', true],
  ['[::1]', false],
  ['-paycore.example', false],
  ['paycore-.example', false],
  ['pay_core.example', false],
  ['paycore..example', false],
  ['https://paycore.example', false],
  ['paycore.example:443', false],
  ['', false],
  ['b'.repeat(64), false],
  [`${'a'.repeat(63)}.example`, true],
  [`${'a'.repeat(64)}.example`, false],
  [`${'a.'.repeat(125)}abc`, true],
  [`${'a.'.repeat(125)}abcd`, false],
];

describe('the operator rule', () => {
  it('is the server’s OPERATOR_RE, character for character', () => {
    const server = serverOperatorRule();
    expect(OPERATOR_RE.source).toBe(server.source);
    expect(OPERATOR_RE.flags).toBe(server.flags);
  });

  it.each(SAMPLES)('%s: the admin and the server agree (%s)', (operator, accepted) => {
    expect(serverOperatorRule().test(operator)).toBe(accepted);
    expect(OPERATOR_RE.test(operator)).toBe(accepted);
    const configured = readHostedConfig('https://api.paycore.example', operator).kind;
    expect(configured).toBe(accepted ? 'configured' : 'invalid');
    const meta = parseMeta({
      publicBase: 'https://api.paycore.example',
      operator,
      networks: {},
      inboxRelays: [],
      pendingMaxProducts: 20,
    });
    expect(meta === undefined).toBe(!accepted);
  });
});
