import { describe, expect, it } from 'vitest';
import { createSteps } from '../../src/cloud/lib/create-steps';

describe("the create wizard's steps", () => {
  it('at each stage: the ones before done, it current, the ones after next and locked', () => {
    const shape = (stage: Parameters<typeof createSteps>[0]) =>
      createSteps(stage).map((step) => [step.key, step.state, step.locked]);
    expect(shape('plan')).toEqual([
      ['plan', 'current', false],
      ['key', 'next', true],
      ['signup', 'next', true],
    ]);
    expect(shape('key')).toEqual([
      ['plan', 'done', false],
      ['key', 'current', false],
      ['signup', 'next', true],
    ]);
    expect(shape('signup')).toEqual([
      ['plan', 'done', false],
      ['key', 'done', false],
      ['signup', 'current', false],
    ]);
  });

  it('names them in the merchant’s words', () => {
    expect(createSteps('plan').map((step) => step.label)).toEqual([
      'Plan',
      'Access key',
      'Terms and payment',
    ]);
  });
});
