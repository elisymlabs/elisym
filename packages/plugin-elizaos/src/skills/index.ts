import type { Skill } from './types';

export * from './types';
export { loadSkillsFromDir } from './loader';
export { ScriptSkill } from './scriptSkill';
export { createAnthropicClient, createLlmClient, createOpenAIClient } from './llmClient';
export type { LlmClientConfig, LlmProvider } from './llmClient';

export class SkillRegistry {
  private skills: Skill[] = [];
  private byCapability = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.push(skill);
    for (const capability of skill.capabilities) {
      if (!this.byCapability.has(capability)) {
        this.byCapability.set(capability, skill);
      }
    }
  }

  findByCapability(capability: string): Skill | undefined {
    return this.byCapability.get(capability);
  }

  all(): readonly Skill[] {
    return this.skills;
  }

  isEmpty(): boolean {
    return this.skills.length === 0;
  }
}
