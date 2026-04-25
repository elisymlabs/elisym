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

  it('matches by skill name (canonical tag from toDTag(skill.name))', () => {
    const reg = new SkillRegistry();
    const s1 = makeSkill('usdc-summarize', ['summarization']);
    reg.register(s1);

    // Tag is the skill name - must match even if capabilities don't list it.
    expect(reg.route(['usdc-summarize'])).toBe(s1);
    // Capability tag still works.
    expect(reg.route(['summarization'])).toBe(s1);
  });

  it('prefers name match over capability match', () => {
    const reg = new SkillRegistry();
    const s1 = makeSkill('alpha', ['shared']);
    const s2 = makeSkill('beta', ['alpha']);
    reg.register(s1);
    reg.register(s2);

    // 'alpha' hits s1 by name before s2 by capability.
    expect(reg.route(['alpha'])).toBe(s1);
  });

  it('requires exact capability match (no substring)', () => {
    const reg = new SkillRegistry();
    const s1 = makeSkill('youtube', ['youtube-summary', 'video-analysis']);
    reg.register(s1);

    // 'youtube' matches by name.
    expect(reg.route(['youtube'])).toBe(s1);
    // Exact capability match works.
    expect(reg.route(['youtube-summary'])).toBe(s1);
    expect(reg.route(['video-analysis'])).toBe(s1);
  });

  it('rejects specific unknown tags - no silent fallback to default', () => {
    const reg = new SkillRegistry();
    const s1 = makeSkill('general', ['general-assistant']);
    const s2 = makeSkill('youtube', ['youtube-summary']);
    reg.register(s1);
    reg.register(s2);

    // A job carrying a specific unknown capability must not slip through
    // to a cheaper default - that was a payment-bypass vector.
    expect(reg.route(['unknown-tag'])).toBeNull();
  });

  it('falls back to default only for untargeted jobs', () => {
    const reg = new SkillRegistry();
    const s1 = makeSkill('general', ['general-assistant']);
    reg.register(s1);

    // Only the protocol marker = untargeted broadcast -> default skill.
    expect(reg.route(['elisym'])).toBe(s1);
    expect(reg.route([])).toBe(s1);
  });

  it('routes a human-readable skill name via its toDTag form', () => {
    const reg = new SkillRegistry();
    // Display name is Title Case with a space; the SDK publishes capability
    // cards under `toDTag(name) === 'whois-lookup'`, so incoming tags arrive
    // d-tag-shaped. Before the fix `route(['whois-lookup'])` returned null
    // because raw `skill.name === tag` missed and no capability listed it.
    const skill = makeSkill('WHOIS Lookup', ['domain-info']);
    reg.register(skill);

    expect(reg.route(['whois-lookup'])).toBe(skill);
  });

  it('still routes kebab-case names by their canonical tag', () => {
    const reg = new SkillRegistry();
    const skill = makeSkill('youtube-summary', ['video-analysis']);
    reg.register(skill);

    expect(reg.route(['youtube-summary'])).toBe(skill);
  });

  it('falls back to capability match when the name does not normalize to the tag', () => {
    const reg = new SkillRegistry();
    // toDTag('X') === 'x', so 'some-cap' must hit via capabilities.
    const skill = makeSkill('X', ['some-cap']);
    reg.register(skill);

    expect(reg.route(['some-cap'])).toBe(skill);
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
