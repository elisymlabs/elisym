import type { ElisymIdentity } from '@elisym/sdk';
import type { ElisymConfig } from './environment';
import type { LlmClient, SkillRegistry } from './skills';

export type ElisymNetwork = 'devnet' | 'mainnet';

export interface ElisymState {
  config: ElisymConfig;
  identity?: ElisymIdentity;
  shuttingDown?: boolean;
  skills?: SkillRegistry;
  skillLlm?: LlmClient;
}

export type { ElisymConfig };
export type { ElisymIdentity } from '@elisym/sdk';
