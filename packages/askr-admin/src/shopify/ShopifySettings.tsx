import { LIMITS } from '@elisym/askr';
import { useEffect, useState } from 'react';
import { Notice } from '../components/Notice';
import { Section } from '../components/Section';
import { errorMessage } from '../lib/errors';
import type { ShopifyApi } from './api';
import { SettingsField } from './SettingsField';
import type { SettingsInput } from './types';

interface Props {
  api: ShopifyApi;
}

interface Form {
  name: string;
  greeting: string;
  launcherText: string;
  language: string;
  currency: string;
  /** Extra storefront domains, one per line (Q6); the shop's own are kept by the server. */
  origins: string;
  voice: string;
  instructions: string;
  notes: string;
}

const EMPTY: Form = {
  name: '',
  greeting: '',
  launcherText: '',
  language: 'en',
  currency: 'USD',
  origins: '',
  voice: '',
  instructions: '',
  notes: '',
};

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The settings the app keeps for the store (askr-shopify 3.4), signed by the app's delegate. */
export function ShopifySettings({ api }: Props) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [kept, setKept] = useState<{
    linkOrigins: string[];
    contact?: string;
    displayName?: string;
  }>({
    linkOrigins: [],
  });
  const [inCharge, setInCharge] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string }>();

  useEffect(() => {
    let live = true;
    api.settings().then(
      (read) => {
        if (!live) {
          return;
        }
        const config = read.config;
        setInCharge(read.inCharge);
        if (config !== null) {
          setForm({
            name: config.name,
            greeting: config.greeting ?? '',
            launcherText: config.launcherText ?? '',
            language: config.language,
            currency: config.currency,
            origins: config.origins.join('\n'),
            voice: read.private?.voice ?? '',
            instructions: read.private?.instructions ?? '',
            notes: read.private?.notes ?? '',
          });
          setKept({
            linkOrigins: config.linkOrigins,
            ...(config.contact === undefined ? {} : { contact: config.contact }),
            ...(config.displayName === undefined ? {} : { displayName: config.displayName }),
          });
        }
        setLoaded(true);
      },
      (caught: unknown) => {
        if (live) {
          setMessage({ tone: 'error', text: errorMessage(caught) });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const set = (field: keyof Form) => (value: string) => setForm({ ...form, [field]: value });

  const save = async () => {
    setBusy(true);
    setMessage(undefined);
    const input: SettingsInput = {
      origins: lines(form.origins),
      linkOrigins: kept.linkOrigins,
      name: form.name.trim(),
      language: form.language.trim(),
      currency: form.currency.trim().toUpperCase(),
      private: { voice: form.voice, instructions: form.instructions, notes: form.notes },
      ...(form.greeting.trim() === '' ? {} : { greeting: form.greeting.trim() }),
      ...(form.launcherText.trim() === '' ? {} : { launcherText: form.launcherText.trim() }),
      ...(kept.contact === undefined ? {} : { contact: kept.contact }),
      ...(kept.displayName === undefined ? {} : { displayName: kept.displayName }),
    };
    try {
      await api.saveSettings(input);
      setMessage({ tone: 'success', text: 'Saved. Your assistant uses the new settings shortly.' });
    } catch (caught) {
      setMessage({ tone: 'error', text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return message === undefined ? (
      <p className="text-14">Loading...</p>
    ) : (
      <Notice tone="error">{message.text}</Notice>
    );
  }
  const readOnly = !inCharge || busy;
  const fieldProps = (name: keyof Form) => ({
    value: form[name],
    disabled: readOnly,
    onChange: set(name),
  });
  return (
    <div className="flex flex-col gap-24">
      {inCharge ? null : (
        <Notice tone="info">
          You manage this store with your own owner key, so these settings are read only here.
          Change them in the Askr admin.
        </Notice>
      )}
      <Section title="Assistant">
        <SettingsField label="Store name" max={LIMITS.TITLE_CHARS} {...fieldProps('name')} />
        <SettingsField label="Greeting" max={LIMITS.GREETING_CHARS} {...fieldProps('greeting')} />
        <SettingsField
          label="Button text"
          max={LIMITS.LAUNCHER_TEXT_CHARS}
          {...fieldProps('launcherText')}
        />
        <SettingsField
          label="Language (like en or de)"
          max={LIMITS.LOCALE_CHARS}
          {...fieldProps('language')}
        />
        <SettingsField label="Currency (like USD)" max={3} {...fieldProps('currency')} />
      </Section>
      <Section
        title="Storefront domains"
        description="Your shop's own domains are always kept. Add any other domain your storefront runs on, one per line."
      >
        <SettingsField label="Domains" max={4000} multiline {...fieldProps('origins')} />
      </Section>
      <Section title="How it answers" description="Only your assistant reads these.">
        <SettingsField
          label="Voice"
          max={LIMITS.CONFIG_VOICE_CHARS}
          multiline
          {...fieldProps('voice')}
        />
        <SettingsField
          label="Instructions"
          max={LIMITS.CONFIG_INSTRUCTIONS_CHARS}
          multiline
          {...fieldProps('instructions')}
        />
        <SettingsField
          label="Notes"
          max={LIMITS.CONFIG_NOTES_CHARS}
          multiline
          {...fieldProps('notes')}
        />
      </Section>
      {message === undefined ? null : <Notice tone={message.tone}>{message.text}</Notice>}
      {inCharge ? (
        <div>
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
