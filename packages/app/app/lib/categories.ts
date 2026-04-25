import type { AgentDisplayData } from '~/hooks/useAgentDisplay';

export interface Category {
  key: string;
  label: string;
  match: (agent: AgentDisplayData) => boolean;
}

function tagIncludes(agent: AgentDisplayData, needle: string): boolean {
  return agent.tags.some((tag) => tag.toLowerCase().includes(needle));
}

export const CATEGORIES: Category[] = [
  {
    key: 'all',
    label: 'All',
    match: () => true,
  },
  {
    key: 'trending',
    label: 'Trending',
    match: (agent) => tagIncludes(agent, 'trending'),
  },
  {
    key: 'summarization',
    label: 'Summarization',
    match: (agent) => tagIncludes(agent, 'summar'),
  },
  {
    key: 'video',
    label: 'Video',
    match: (agent) => tagIncludes(agent, 'video'),
  },
  {
    key: 'research',
    label: 'Research',
    match: (agent) => tagIncludes(agent, 'research'),
  },
];

export function findCategory(key: string): Category | undefined {
  return CATEGORIES.find((category) => category.key === key);
}
