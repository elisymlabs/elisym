import { type StoreConfig, type StorePrivateConfig, decryptPrivateConfigWith } from '@elisym/askr';
import { useEffect, useRef, useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { newestConfig, saveSettings, savedMessage } from '../lib/save';
import { npubOf } from '../lib/signer';
import { type AuthorityRead, catalogKeysOf, readAuthority } from '../lib/store-data';
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
  authority: AuthorityRead | undefined;
}

/** Which config a read is for: a Refresh that reads the same one again starts no new decrypt. */
function identityOf(config: StoreConfig | undefined): string {
  return config === undefined
    ? ''
    : `${config.createdAt}:${config.assistant}:${config.privateContent}`;
}

/** Edit the config: read back, private part decrypted, re-signed dated after it (2.3). */
export function SettingsSection({ deps, view, config, configError, onRetry, onSaved }: Props) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [decryptAttempt, setDecryptAttempt] = useState(0);
  const [replacePrivate, setReplacePrivate] = useState(false);
  const [saved, setSaved] = useState('');
  const configNow = useRef(config);
  configNow.current = config;
  const sourceIdentity = identityOf(newestConfig(config, deps.journal));

  useEffect(() => {
    let current = true;
    const load = async () => {
      const source = newestConfig(configNow.current, deps.journal);
      const privatePart =
        source === undefined
          ? undefined
          : await decryptPrivateConfigWith(source, deps.signer.decrypt);
      let authority: AuthorityRead | undefined;
      try {
        authority = await readAuthority(deps.reader, deps.signer.pubkey, deps.now());
      } catch {
        authority = undefined;
      }
      if (current) {
        setLoaded({ source, privatePart, authority });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [deps, sourceIdentity, decryptAttempt]);

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
  const { source, authority } = loaded;
  const undecryptable = source !== undefined && loaded.privatePart === undefined;
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
      {undecryptable ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">
            The private instructions could not be decrypted, so the fields below are empty. If your
            extension asked to decrypt and you declined, try again.
          </Notice>
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => setDecryptAttempt((attempt) => attempt + 1)}
            >
              Try decrypting again
            </button>
          </div>
        </div>
      ) : null}
      {saved === '' ? null : <Notice tone="success">{saved}</Notice>}
      <StoreSettingsForm
        // Keyed on what the relay holds: this page's own save does not reset the form.
        key={`${config?.createdAt ?? 0}:${decryptAttempt}:${loaded.privatePart === undefined ? 'sealed' : 'open'}`}
        initial={initial}
        ownerNpub={npubOf(deps.signer.pubkey)}
        submitLabel="Sign and save"
        canSubmit={!undecryptable || replacePrivate}
        onSubmit={async (form) => {
          setSaved('');
          await saveSettings({
            deps,
            view,
            form,
            ...(source === undefined ? {} : { previousCreatedAt: source.createdAt }),
            ...(authority === undefined
              ? {}
              : { authorized: catalogKeysOf(authority), relayNewestAt: authority.newestAt }),
          });
          setSaved(savedMessage(view));
          await onSaved();
          return '';
        }}
      >
        {undecryptable ? (
          <label className="text-14 text-error flex items-center gap-8">
            <input
              type="checkbox"
              checked={replacePrivate}
              onChange={(event) => setReplacePrivate(event.target.checked)}
            />
            Replace the private voice, instructions and notes with what is in the form
          </label>
        ) : null}
      </StoreSettingsForm>
    </Section>
  );
}
