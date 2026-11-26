import { type StoreConfig, type StorePrivateConfig, decryptPrivateConfigWith } from '@elisym/askr';
import { useEffect, useRef, useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { detectPayCore, hasPayCoreLayout } from '../lib/paycore';
import { newestConfig, saveSettings, savedMessage } from '../lib/save';
import { type AuthorityRead, readAuthority } from '../lib/store-data';
import { EMPTY_FORM, formOfConfig, withConnector, withPayCore } from '../lib/store-form';
import type { StoreView } from '../lib/types';
import { usePayCoreChoices } from '../lib/use-paycore-choices';
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
  const payCore = usePayCoreChoices(deps);

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
  // A catalog whose key the owner signed a 30490 for reads back as a PayCore store (C7).
  const payCoreStore =
    source === undefined || authorities === undefined
      ? undefined
      : detectPayCore(source, view.catalogKey, authorities.stores);
  // A config laid out like a PayCore store waits for the 30490 read: shown before it, it would
  // read as a merchant catalog, and a save would sign its store key as one.
  const heldForPayCore =
    source !== undefined && authorities === undefined && hasPayCoreLayout(source, view.catalogKey);
  const initial = withConnector(
    source === undefined
      ? EMPTY_FORM
      : withPayCore(formOfConfig(source, loaded.privatePart), payCoreStore),
    view.connector,
  );
  return (
    <div className="flex flex-col gap-16">
      {configUnreadableAt === undefined ? null : (
        <Notice tone="error">
          Your newest published settings could not be read.{' '}
          {source === undefined
            ? 'No older readable version was found, so the form starts empty.'
            : 'The form starts from the newest version that can be read.'}{' '}
          Saving replaces them.
        </Notice>
      )}
      {source === undefined && configUnreadableAt === undefined ? (
        <Notice tone="info">
          Your signed settings are kept on the server and published once your store is active, so
          they cannot be read back here yet. Saving now replaces them.
        </Notice>
      ) : null}
      {undecryptable ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">
            The private instructions could not be read, so the fields below are empty: they were
            sealed for another key.
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
      {heldForPayCore ? (
        <p className="text-14 text-text-2">
          {authority.state === 'failed'
            ? 'Whether these products come from your PayCore store could not be checked yet: the form opens once it is.'
            : 'Checking your PayCore store...'}
        </p>
      ) : (
        <StoreSettingsForm
          // Keyed on what the relay holds: this page's own save does not reset the form.
          key={`${config?.createdAt ?? 0}:${decryptAttempt}:${loaded.privatePart === undefined ? 'sealed' : 'open'}`}
          initial={initial}
          payCore={payCore}
          submitLabel="Sign and save"
          canSubmit={authorities !== undefined && (!undecryptable || replacePrivate)}
          onSubmit={async (form) => {
            setSaved('');
            if (authorities === undefined) {
              throw new Error('Your catalog key authorizations are not read yet. Retry above.');
            }
            const outcome = await saveSettings({
              deps,
              view,
              form,
              previousCreatedAt: Math.max(source?.createdAt ?? 0, configUnreadableAt ?? 0),
              authorized: authorities.keys,
              relayNewestAt: authorities.newestAt,
            });
            const message = savedMessage(view);
            setSaved(outcome.note === undefined ? message : `${message} ${outcome.note}`);
            await onSaved();
            if (outcome.connectorError !== undefined) {
              throw new Error(outcome.connectorError);
            }
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
      )}
    </div>
  );
}
