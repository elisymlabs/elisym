import { loadSkillsFromDir as sdkLoadSkillsFromDir, type Skill } from '@elisym/sdk/skills';
import { logger } from '../lib/logger';

export function loadSkillsFromDir(skillsDir: string): Skill[] {
  return sdkLoadSkillsFromDir(skillsDir, { logger });
}
