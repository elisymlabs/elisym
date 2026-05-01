import { describe, expect, it } from 'vitest';
import { parseSkillMd, validateSkillFrontmatter } from '../src/skills/loader';

function parseAndValidate(body: string) {
  const { frontmatter, systemPrompt } = parseSkillMd(body);
  return validateSkillFrontmatter(frontmatter, systemPrompt, { allowFreeSkills: true });
}

describe('skill loader - llm override', () => {
  it('parses provider + model + max_tokens together', () => {
    const parsed = parseAndValidate(`---
name: cheap-summarizer
description: A cheap summarizer
capabilities: [summarization]
price: 0.001
provider: openai
model: gpt-5-mini
max_tokens: 1024
---
prompt`);
    expect(parsed.llmOverride).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      maxTokens: 1024,
    });
  });

  it('parses max_tokens-only override (no provider/model pair)', () => {
    const parsed = parseAndValidate(`---
name: tight-summarizer
description: tight
capabilities: [summarization]
price: 0.001
max_tokens: 256
---
prompt`);
    expect(parsed.llmOverride).toEqual({ maxTokens: 256 });
  });

  it('returns undefined llmOverride when no fields are declared', () => {
    const parsed = parseAndValidate(`---
name: vanilla
description: vanilla
capabilities: [text]
price: 0.001
---
prompt`);
    expect(parsed.llmOverride).toBeUndefined();
  });

  it('rejects provider without model (and vice versa)', () => {
    expect(() =>
      parseAndValidate(`---
name: half
description: half
capabilities: [text]
price: 0.001
provider: openai
---
prompt`),
    ).toThrow(/"provider" and "model" must be set together/);

    expect(() =>
      parseAndValidate(`---
name: half2
description: half2
capabilities: [text]
price: 0.001
model: gpt-5-mini
---
prompt`),
    ).toThrow(/"provider" and "model" must be set together/);
  });

  it('rejects empty provider value', () => {
    expect(() =>
      parseAndValidate(`---
name: bad
description: bad
capabilities: [text]
price: 0.001
provider: ''
model: command-r
---
prompt`),
    ).toThrow(/"provider" must be a non-empty string/);
  });

  it('accepts arbitrary provider id - runtime validation lives in the CLI registry', () => {
    expect(() =>
      parseAndValidate(`---
name: ok
description: ok
capabilities: [text]
price: 0.001
provider: cohere
model: command-r
---
prompt`),
    ).not.toThrow();
  });

  it('rejects empty model string', () => {
    expect(() =>
      parseAndValidate(`---
name: bad
description: bad
capabilities: [text]
price: 0.001
provider: openai
model: ''
---
prompt`),
    ).toThrow(/"model" must be a non-empty string/);
  });

  it('rejects non-positive max_tokens', () => {
    expect(() =>
      parseAndValidate(`---
name: bad
description: bad
capabilities: [text]
price: 0.001
max_tokens: 0
---
prompt`),
    ).toThrow(/"max_tokens" must be a positive integer/);
  });

  it('rejects max_tokens above the 200_000 limit', () => {
    expect(() =>
      parseAndValidate(`---
name: bad
description: bad
capabilities: [text]
price: 0.001
max_tokens: 250000
---
prompt`),
    ).toThrow(/"max_tokens" must be a positive integer/);
  });

  it('accepts provider+model on dynamic-script mode as a dependency declaration', () => {
    const parsed = parseAndValidate(`---
name: proxy-skill
description: proxies a Claude call via curl
capabilities: [text]
price: 0.05
token: usdc
mode: dynamic-script
script: ./proxy.sh
provider: anthropic
model: claude-haiku-4-5-20251001
---
ignored body for script modes`);
    expect(parsed.mode).toBe('dynamic-script');
    expect(parsed.llmOverride).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('accepts provider+model on static-script mode as a dependency declaration', () => {
    const parsed = parseAndValidate(`---
name: cron-skill
description: runs a fixed Claude call at every job
capabilities: [data]
price: 0.05
token: usdc
mode: static-script
script: ./run.sh
provider: anthropic
model: claude-haiku-4-5-20251001
---
ignored`);
    expect(parsed.llmOverride).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('rejects max_tokens for non-llm modes', () => {
    expect(() =>
      parseAndValidate(`---
name: bad-script
description: bad
capabilities: [data]
price: 0.05
token: usdc
mode: dynamic-script
script: ./run.sh
provider: anthropic
model: claude-haiku-4-5-20251001
max_tokens: 1024
---
ignored`),
    ).toThrow(/"max_tokens" is only valid in mode 'llm'/);
  });
});
