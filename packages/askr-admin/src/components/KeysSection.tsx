import type { StoreConfig } from '@elisym/askr';
import type { SessionDeps } from '../lib/deps';
import type { StoreView } from '../lib/types';
import { CatalogKeys } from './CatalogKeys';
import { ForgetOnDevice } from './ForgetOnDevice';
import { ReplaceKey } from './ReplaceKey';
import { RotateAssistant } from './RotateAssistant';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  configError: string;
  onRetry: () => Promise<void>;
  onChanged: () => Promise<void>;
  onReplaceKey: () => void;
  /** The key on this device was forgotten. */
  onForgotten?: () => void;
}

/** The Advanced tab: the secret key, the assistant key, and keys that publish the catalog. */
export function KeysSection({
  deps,
  view,
  config,
  configError,
  onRetry,
  onChanged,
  onReplaceKey,
  onForgotten,
}: Props) {
  return (
    <div className="flex flex-col gap-32">
      <ReplaceKey onReplaceKey={onReplaceKey}>
        <ForgetOnDevice store={deps.signer.pubkey} onForgotten={onForgotten} />
      </ReplaceKey>
      <CatalogKeys deps={deps} view={view} config={config} />
      <RotateAssistant
        deps={deps}
        view={view}
        config={config}
        configError={configError}
        onRetry={onRetry}
        onChanged={onChanged}
      />
    </div>
  );
}
