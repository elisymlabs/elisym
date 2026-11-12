import type { StoreConfig } from '@elisym/askr';
import type { SessionDeps } from '../lib/deps';
import type { StoreView } from '../lib/types';
import { CatalogKeys } from './CatalogKeys';
import { RotateAssistant } from './RotateAssistant';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  onChanged: () => Promise<void>;
}

export function KeysSection({ deps, view, config, onChanged }: Props) {
  return (
    <div className="flex flex-col gap-16">
      <CatalogKeys deps={deps} view={view} config={config} />
      <RotateAssistant deps={deps} view={view} config={config} onChanged={onChanged} />
    </div>
  );
}
