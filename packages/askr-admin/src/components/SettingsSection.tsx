import { type StoreConfig, type StorePrivateConfig, decryptPrivateConfigWith } from '@elisym/askr';
import { useEffect, useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { newestConfig, saveSettings, savedMessage } from '../lib/save';
import { npubOf } from '../lib/signer';
import { catalogKeysOf, readAuthority } from '../lib/store-data';
import { EMPTY_FORM, formOfConfig } from '../lib/store-form';
import type { StoreView } from '../lib/types';
import { ConfigUnreadable } from './ConfigUnreadable';
import { Notice } from './Notice';
import { Section } from './Section';
import { StoreSettingsForm } from './StoreSettingsForm';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  /** The relay's config. */
  config: StoreConfig | undefined;
  /** Set when the relay could not be read: then nothing may be saved over the unknown config. */
  configError: string;
  onRetry: () => Promise<void>;
  onSaved: () => Promise<void>;
}

interface Loaded {
  /** The config being edited: the relay's, or the newer one this session signed. */
  source: StoreConfig | undefined;
  privatePart: StorePrivateConfig | undefined;
  authorized: Set<string> | undefined;
}

/** Edit the config: read back, private part decrypted, re-signed dated after it (2.3). */
export function SettingsSection({ deps, view, config, configError, onRetry, onSaved }: Props) {
  const [loaded, setLoaded] = useState<Loaded>();
  const sourceDate = newestConfig(config, deps.journal)?.createdAt;

  useEffect(() => {
    let current = true;
    const load = async () => {
      const source = newestConfig(config, deps.journal);
      const privatePart =
        source === undefined
          ? undefined
          : await decryptPrivateConfigWith(source, deps.signer.decrypt);
      let authorized: Set<string> | undefined;
      try {
        authorized = catalogKeysOf(
          await readAuthority(deps.reader, deps.signer.pubkey, deps.now()),
        );
      } catch {
        authorized = undefined;
      }
      if (current) {
        setLoaded({ source, privatePart, authorized });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [config, deps, sourceDate]);

  if (configError !== '') {
    return (
      <Section title="Settings">
        <ConfigUnreadable error={configError} onRetry={onRetry} />
      </Section>
    );
  }
  if (loaded === undefined) {
    return <p className="text-14 text-text-2">Reading your settings...</p>;
  }
  const { source } = loaded;
  const initial = source === undefined ? EMPTY_FORM : formOfConfig(source, loaded.privatePart);
  return (
    <Section
      title="Settings"
      description="Every save is signed with your owner key and replaces the previous settings."
    >
      {source === undefined ? (
        <Notice tone="info">
          Your signed settings are kept on the server and published once your store is activated, so
          they cannot be read back here yet. Saving now replaces them.
        </Notice>
      ) : null}
      {source !== undefined && loaded.privatePart === undefined ? (
        <Notice tone="warn">
          The private instructions could not be decrypted. Saving replaces them with what is in the
          form below.
        </Notice>
      ) : null}
      <StoreSettingsForm
        key={source?.createdAt ?? 0}
        initial={initial}
        ownerNpub={npubOf(deps.signer.pubkey)}
        submitLabel="Sign and save"
        onSubmit={async (form) => {
          await saveSettings({
            deps,
            view,
            form,
            ...(source === undefined ? {} : { previousCreatedAt: source.createdAt }),
            ...(loaded.authorized === undefined ? {} : { authorized: loaded.authorized }),
          });
          await onSaved();
          return savedMessage(view);
        }}
      />
    </Section>
  );
}
