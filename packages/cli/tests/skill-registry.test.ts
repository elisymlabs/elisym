import { NATIVE_SOL } from '@elisym/sdk';
import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../src/skill/index.js';
import type { Skill, SkillInput, SkillOutput, SkillContext } from '../src/skill/index.js';

function makeSkill(name: string, capabilities: string[]): Skill {
  return {
    name,
    description: `${name} skill`,
    capabilities,
    priceSubunits: 0,
    asset: NATIVE_SOL,
    async execute(_input: SkillInput, _ctx: SkillContext): Promise<SkillOutput> {
      return { data: `result from ${name}` };
    },
  };
}

describe('SkillRegistry', () => {
  it('starts empty', () => {
    const reg = new SkillRegistry();
    expect(reg.isEmpty()).toBe(true);
    expect(reg.allCapabilities()).toEqual([]);
  });

  it('registers skills', () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill('summarizer', ['summarization']));
    expect(reg.isEmpty()).toBe(false);
    expect(reg.all()).toHaveLength(1);
  });

  it('routes by exact capability match', () => {
    const reg = new SkillRegistry();
    const s1 = makeSkill('summarizer', ['summarization']);
    const s2 = makeSkill('translator', ['translation']);
    reg.register(s1);
    reg.register(s2);

    expect(reg.route(['translation'])).toBe(s2);
    expect(reg.route(['summarization'])).toBe(s1);
  });

  it('requires exact capability match (no substring)', () => {
    const reg = new SkillRegistry();
    const s1 = makeSkill('youtube', ['youtube-summary', 'video-analysis']);
    reg.register(s1);

    // Partial match no longer works - falls back to default
    expect(reg.route(['youtube'])).toBe(s1); // fallback to first (default)
    // Exact match works
    expect(reg.route(['youtube-summary'])).toBe(s1);
    expect(reg.route(['video-analysis'])).toBe(s1);
  });

  it('falls back to default (first registered)', () => {
    const reg = new SkillRegistry();
    const s1 = makeSkill('general', ['general-assistant']);
    const s2 = makeSkill('youtube', ['youtube-summary']);
    reg.register(s1);
    reg.register(s2);

    expect(reg.route(['unknown-tag'])).toBe(s1);
  });

  it('returns null when empty', () => {
    const reg = new SkillRegistry();
    expect(reg.route(['anything'])).toBeNull();
  });

  it('collects all capabilities', () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill('s1', ['a', 'b']));
    reg.register(makeSkill('s2', ['c']));
    expect(reg.allCapabilities()).toEqual(['a', 'b', 'c']);
  });
});
