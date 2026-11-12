import { type StoreConfig, type StorePrivateConfig, decryptPrivateConfigWith } from '@elisym/askr';
import { useEffect, useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { saveSettings, savedMessage } from '../lib/save';
import { npubOf } from '../lib/signer';
import { readAuthority } from '../lib/store-data';
import { EMPTY_FORM, formOfConfig } from '../lib/store-form';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { Section } from './Section';
import { StoreSettingsForm } from './StoreSettingsForm';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  onSaved: () => Promise<void>;
}

interface Loaded {
  privatePart: StorePrivateConfig | undefined;
  authorized: Set<string> | undefined;
}

/** Edit the published config: read back, private part decrypted, re-signed dated now (2.3). */
export function SettingsSection({ deps, view, config, onSaved }: Props) {
  const [loaded, setLoaded] = useState<Loaded>();

  useEffect(() => {
    let current = true;
    const load = async () => {
      const privatePart =
        config === undefined
          ? undefined
          : await decryptPrivateConfigWith(config, deps.signer.decrypt);
      let authorized: Set<string> | undefined;
      try {
        const authority = await readAuthority(deps.reader, deps.signer.pubkey);
        authorized = new Set(
          [...authority].filter(([, roles]) => roles.has('catalog')).map(([key]) => key),
        );
      } catch {
        authorized = undefined;
      }
      if (current) {
        setLoaded({ privatePart, authorized });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [config, deps]);

  if (loaded === undefined) {
    return <p className="text-14 text-text-2">Reading your settings...</p>;
  }
  const initial = config === undefined ? EMPTY_FORM : formOfConfig(config, loaded.privatePart);
  return (
    <Section
      title="Settings"
      description="Every save is signed with your owner key and replaces the previous settings."
    >
      {config === undefined ? (
        <Notice tone="info">
          Your signed settings are kept on the server and published once your store is activated, so
          they cannot be read back here yet. Saving now replaces them.
        </Notice>
      ) : null}
      {config !== undefined && loaded.privatePart === undefined ? (
        <Notice tone="warn">
          The private instructions could not be decrypted. Saving replaces them with what is in the
          form below.
        </Notice>
      ) : null}
      <StoreSettingsForm
        key={config?.createdAt ?? 0}
        initial={initial}
        ownerNpub={npubOf(deps.signer.pubkey)}
        submitLabel="Sign and save"
        onSubmit={async (form) => {
          await saveSettings({
            deps,
            view,
            form,
            ...(config === undefined ? {} : { previousCreatedAt: config.createdAt }),
            ...(loaded.authorized === undefined ? {} : { authorized: loaded.authorized }),
          });
          await onSaved();
          return savedMessage(view);
        }}
      />
    </Section>
  );
}
