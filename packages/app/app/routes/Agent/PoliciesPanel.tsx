import type { AgentPolicy } from '@elisym/sdk';
import { useEffect, useState } from 'react';
import { useAgentPolicies } from '~/hooks/useAgentPolicies';
import { cn } from '~/lib/cn';
import { Markdown } from '~/lib/markdown';

interface Props {
  pubkey: string;
}

export function PoliciesPanel({ pubkey }: Props) {
  const { data: policies, isLoading, error } = useAgentPolicies(pubkey);
  const [selectedType, setSelectedType] = useState<string | null>(null);

  useEffect(() => {
    const first = policies?.[0];
    if (first && selectedType === null) {
      setSelectedType(first.type);
    }
  }, [policies, selectedType]);

  if (isLoading) {
    return <Skeleton />;
  }

  if (error) {
    return (
      <div className="py-32 text-center text-sm text-text-2">
        Failed to load policies. {error.message}
      </div>
    );
  }

  const fallback = policies?.[0];
  if (!policies || !fallback) {
    return (
      <div className="py-32 text-center text-sm text-text-2">
        This agent has not published any policies yet.
      </div>
    );
  }

  const selected = policies.find((policy) => policy.type === selectedType) ?? fallback;

  return (
    <div className="grid gap-24 sm:grid-cols-[180px_1fr] sm:gap-32">
      <PolicyNav
        policies={policies}
        selectedType={selected.type}
        onSelect={(type) => setSelectedType(type)}
      />
      <PolicyDocument policy={selected} />
    </div>
  );
}

interface PolicyNavProps {
  policies: AgentPolicy[];
  selectedType: string;
  onSelect: (type: string) => void;
}

function PolicyNav({ policies, selectedType, onSelect }: PolicyNavProps) {
  return (
    <nav className="flex flex-row gap-6 overflow-x-auto sm:flex-col sm:overflow-visible">
      {policies.map((policy) => {
        const active = policy.type === selectedType;
        return (
          <button
            key={policy.dTag}
            type="button"
            onClick={() => onSelect(policy.type)}
            className={cn(
              'inline-flex shrink-0 cursor-pointer items-center gap-6 rounded-12 border-0 px-12 py-8 text-left text-[13px] font-medium whitespace-nowrap transition-colors sm:whitespace-normal',
              active ? 'bg-tag-bg text-text' : 'bg-transparent text-text-2 hover:bg-tag-bg/60',
            )}
          >
            {policy.title}
          </button>
        );
      })}
    </nav>
  );
}

interface PolicyDocumentProps {
  policy: AgentPolicy;
}

function PolicyDocument({ policy }: PolicyDocumentProps) {
  return (
    <article>
      <header className="mb-20 flex flex-wrap items-baseline gap-12">
        <h2 className="text-xl font-semibold text-text">{policy.title}</h2>
        <span className="rounded-8 bg-surface-2 px-8 py-4 font-mono text-xs text-text-2">
          v{policy.version}
        </span>
      </header>
      {policy.summary ? (
        <p className="mb-20 text-sm leading-relaxed text-text-2">{policy.summary}</p>
      ) : null}
      <Markdown content={policy.content} />
    </article>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-12 py-32">
      <div className="h-20 w-2/3 animate-pulse rounded-8 bg-surface-2" />
      <div className="h-12 w-full animate-pulse rounded-8 bg-surface-2" />
      <div className="h-12 w-5/6 animate-pulse rounded-8 bg-surface-2" />
      <div className="h-12 w-3/4 animate-pulse rounded-8 bg-surface-2" />
    </div>
  );
}
