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
  /** Set when the relay's newest config does not parse: a save is dated after it. */
  configUnreadableAt?: number;
  onRetry: () => Promise<void>;
  onSaved: () => Promise<void>;
}

interface Loaded {
  /** The config being edited: the relay's, or the newer one this session signed. */
  source: StoreConfig | undefined;
  privatePart: StorePrivateConfig | undefined;
}

type AuthorityState =
  | { state: 'reading' }
  | { state: 'failed' }
  | { state: 'read'; read: AuthorityRead };

/** Which config a read is for: a Refresh that reads the same one again starts no new decrypt. */
function identityOf(config: StoreConfig | undefined): string {
  return config === undefined
    ? ''
    : `${config.createdAt}:${config.assistant}:${config.privateContent}`;
}

/** Edit the config: read back, private part decrypted, re-signed dated after it (2.3). */
export function SettingsSection({
  deps,
  view,
  config,
  configError,
  configUnreadableAt,
  onRetry,
  onSaved,
}: Props) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [decryptAttempt, setDecryptAttempt] = useState(0);
  const [replacePrivate, setReplacePrivate] = useState(false);
  const [saved, setSaved] = useState('');
  const configNow = useRef(config);
  configNow.current = config;
  const sourceIdentity = identityOf(newestConfig(config, deps.journal));
  const [authority, setAuthority] = useState<AuthorityState>({ state: 'reading' });
  const [authorityAttempt, setAuthorityAttempt] = useState(0);

  // Consent to replace an undecryptable private part is for that config only.
  useEffect(() => {
    setReplacePrivate(false);
  }, [sourceIdentity]);

  // A save signs the source key's 30497 dated past its newest one: without a whole read of the
  // authorizations it could re-authorize a key revoked elsewhere, so it waits for one.
  useEffect(() => {
    let current = true;
    const read = async () => {
      setAuthority({ state: 'reading' });
      try {
        const authorities = await readAuthority(deps.reader, deps.signer.pubkey, deps.now());
        if (current) {
          setAuthority({ state: 'read', read: authorities });
        }
      } catch {
        if (current) {
          setAuthority({ state: 'failed' });
        }
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [deps, authorityAttempt]);

  useEffect(() => {
    let current = true;
    const load = async () => {
      const source = newestConfig(configNow.current, deps.journal);
      const privatePart =
        source === undefined
          ? undefined
          : await decryptPrivateConfigWith(source, deps.signer.decrypt);
      if (current) {
        setLoaded({ source, privatePart });
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
  const { source } = loaded;
  const authorities = authority.state === 'read' ? authority.read : undefined;
  const undecryptable = source !== undefined && loaded.privatePart === undefined;
  const initial = source === undefined ? EMPTY_FORM : formOfConfig(source, loaded.privatePart);
  return (
    <Section
      title="Settings"
      description="Every save is signed with your owner key and replaces the previous settings."
    >
      {configUnreadableAt === undefined ? null : (
        <Notice tone="error">
          Your newest published settings could not be read.{' '}
          {source === undefined
            ? 'No older readable version is on the relay, so the form starts empty.'
            : 'The form starts from the newest version that can be read.'}{' '}
          Saving replaces them.
        </Notice>
      )}
      {source === undefined && configUnreadableAt === undefined ? (
        <Notice tone="info">
          Your signed settings are kept on the server and published once your store is activated, so
          they cannot be read back here yet. Saving now replaces them.
        </Notice>
      ) : null}
      {undecryptable ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">
            The private instructions could not be decrypted, so the fields below are empty. If your
            extension asked to decrypt and you declined, try again; otherwise they were sealed for
            another key.
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
      {authority.state === 'failed' ? (
        <Notice tone="error">
          Your catalog key authorizations could not be read, so saving waits until they are.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => setAuthorityAttempt((attempt) => attempt + 1)}
          >
            Retry
          </button>
        </Notice>
      ) : null}
      {saved === '' ? null : <Notice tone="success">{saved}</Notice>}
      <StoreSettingsForm
        // Keyed on what the relay holds: this page's own save does not reset the form.
        key={`${config?.createdAt ?? 0}:${decryptAttempt}:${loaded.privatePart === undefined ? 'sealed' : 'open'}`}
        initial={initial}
        ownerNpub={npubOf(deps.signer.pubkey)}
        submitLabel="Sign and save"
        canSubmit={authorities !== undefined && (!undecryptable || replacePrivate)}
        onSubmit={async (form) => {
          setSaved('');
          if (authorities === undefined) {
            throw new Error('Your catalog key authorizations are not read yet. Retry above.');
          }
          await saveSettings({
            deps,
            view,
            form,
            previousCreatedAt: Math.max(source?.createdAt ?? 0, configUnreadableAt ?? 0),
            authorized: catalogKeysOf(authorities),
            relayNewestAt: authorities.newestAt,
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
