import { describe, expect, it } from 'vitest';
import { parseSkillMd, validateSkillFrontmatter } from '../src/skills/loader';

function parseAndValidate(body: string) {
  const { frontmatter, systemPrompt } = parseSkillMd(body);
  return validateSkillFrontmatter(frontmatter, systemPrompt, {
    network: 'devnet',
    allowFreeSkills: true,
  });
}

describe('skill loader - context flag', () => {
  it('parses context: true on an llm-mode skill', () => {
    const parsed = parseAndValidate(`---
name: chat-assistant
description: A conversational assistant
capabilities: [chat]
price: 0.001
context: true
---
prompt`);
    expect(parsed.context).toBe(true);
    expect(parsed.mode).toBe('llm');
  });

  it('defaults to false when absent', () => {
    const parsed = parseAndValidate(`---
name: one-shot
description: one shot
capabilities: [text]
price: 0.001
---
prompt`);
    expect(parsed.context).toBe(false);
  });

  it('accepts an explicit context: false on an llm-mode skill', () => {
    const parsed = parseAndValidate(`---
name: no-chat
description: no chat
capabilities: [text]
price: 0.001
context: false
---
prompt`);
    expect(parsed.context).toBe(false);
  });

  it('parses context: true on a dynamic-script skill', () => {
    const parsed = parseAndValidate(`---
name: scripted-chat
description: scripted chat
capabilities: [tooling]
price: 0.001
mode: dynamic-script
script: run.sh
context: true
---
prompt`);
    expect(parsed.context).toBe(true);
    expect(parsed.mode).toBe('dynamic-script');
  });

  it('rejects context on a static-script skill at parse time', () => {
    expect(() =>
      parseAndValidate(`---
name: scripted
description: scripted
capabilities: [tooling]
price: 0.001
mode: static-script
script: run.sh
context: true
---
prompt`),
    ).toThrow(/"context" is only valid in modes 'llm' and 'dynamic-script'/);
  });

  it('rejects context on an x402-mode skill at parse time', () => {
    expect(() =>
      parseAndValidate(`---
name: bridge
description: bridge
capabilities: [bridge]
price: 0.01
token: usdc
mode: x402
x402_url: https://api.example.com/paid
x402_max_upstream: 10000
context: true
---
prompt`),
    ).toThrow(/"context" is only valid in modes 'llm' and 'dynamic-script'/);
  });

  it('rejects a non-boolean context value', () => {
    expect(() =>
      parseAndValidate(`---
name: stringy
description: stringy
capabilities: [text]
price: 0.001
context: "yes"
---
prompt`),
    ).toThrow(/"context" must be a boolean/);
  });
});
