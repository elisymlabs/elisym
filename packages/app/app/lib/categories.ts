import type { ViewMode } from '~/contexts/UIContext';
import type { AgentDisplayData } from '~/hooks/useAgentDisplay';

export interface ViewModeDef {
  key: ViewMode;
  label: string;
  match: (agent: AgentDisplayData) => boolean;
}

export interface TagFilter {
  key: string;
  label: string;
  match: (agent: AgentDisplayData) => boolean;
}

function tagIncludes(agent: AgentDisplayData, needle: string): boolean {
  return agent.tags.some((tag) => tag.toLowerCase().includes(needle));
}

function tagIncludesAny(agent: AgentDisplayData, needles: string[]): boolean {
  return needles.some((needle) => tagIncludes(agent, needle));
}

export const VIEW_MODES: ViewModeDef[] = [
  {
    key: 'all',
    label: 'All',
    match: () => true,
  },
  {
    key: 'new',
    label: 'New',
    match: (agent) => agent.purchases === 0,
  },
];

export const TAG_FILTERS: TagFilter[] = [
  {
    key: 'trending',
    label: 'Trending',
    match: (agent) => tagIncludes(agent, 'trending'),
  },
  {
    key: 'summarization',
    label: 'Summarization',
    match: (agent) => tagIncludesAny(agent, ['summary', 'summarize', 'summarization']),
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

export function findViewMode(key: ViewMode): ViewModeDef | undefined {
  return VIEW_MODES.find((mode) => mode.key === key);
}

export function findTagFilter(key: string): TagFilter | undefined {
  return TAG_FILTERS.find((filter) => filter.key === key);
}
