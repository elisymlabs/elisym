import { ASKR_KEY_COMMAND } from '../constants';
import { PLATFORM_OPTIONS, SOURCE_OPTIONS, platformOf, sourceKindOf } from '../lib/labels';
import { npubOf } from '../lib/signer';
import type { StoreForm } from '../lib/store-form';
import { SelectField } from './SelectField';
import { TextAreaField } from './TextAreaField';
import { TextField } from './TextField';

interface Props {
  form: StoreForm;
  onChange: (form: StoreForm) => void;
  /** The owner's npub, for the catalog key command. */
  ownerNpub: string;
}

/** Every field of the store's Askr config (2.3), public and private. */
export function StoreFields({ form, onChange, ownerNpub }: Props) {
  const set = <Key extends keyof StoreForm>(key: Key, value: StoreForm[Key]) =>
    onChange({ ...form, [key]: value });
  return (
    <div className="flex flex-col gap-20">
      <fieldset className="flex flex-col gap-12">
        <legend className="text-15 mb-8 font-semibold">Store</legend>
        <TextField
          id="store-name"
          label="Store name"
          value={form.name}
          onChange={(value) => set('name', value)}
        />
        <div className="grid gap-12 sm:grid-cols-2">
          <TextField
            id="store-language"
            label="Catalog language"
            value={form.language}
            hint="A language tag, like en, de or pt-BR"
            onChange={(value) => set('language', value)}
          />
          <TextField
            id="store-currency"
            label="Currency"
            value={form.currency}
            hint="Three letters, like USD or EUR"
            onChange={(value) => set('currency', value)}
          />
        </div>
        <TextAreaField
          id="store-origins"
          label="Allowed origins"
          value={form.origins}
          placeholder="https://shop.example"
          hint="The sites the chat may run on, one per line. Only these get answers."
          onChange={(value) => set('origins', value)}
        />
        <TextAreaField
          id="store-link-origins"
          label="Link origins (optional)"
          value={form.linkOrigins}
          hint="Other sites product links may point to, one per line."
          onChange={(value) => set('linkOrigins', value)}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-12">
        <legend className="text-15 mb-8 font-semibold">Assistant</legend>
        <TextField
          id="store-display-name"
          label="Assistant name (optional)"
          value={form.displayName}
          hint="Shown in the chat. By default it is your store name followed by assistant."
          onChange={(value) => set('displayName', value)}
        />
        <TextField
          id="store-avatar"
          label="Avatar URL (optional)"
          value={form.avatar}
          placeholder="https://..."
          onChange={(value) => set('avatar', value)}
        />
        <TextField
          id="store-greeting"
          label="Greeting (optional)"
          value={form.greeting}
          onChange={(value) => set('greeting', value)}
        />
        <TextField
          id="store-contact"
          label="Contact URL (optional)"
          value={form.contact}
          placeholder="https://shop.example/contact"
          hint="Shown when the assistant cannot answer."
          onChange={(value) => set('contact', value)}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-12">
        <legend className="text-15 mb-8 font-semibold">Products</legend>
        <SelectField
          id="store-source"
          label="Where your products come from"
          value={form.source}
          options={SOURCE_OPTIONS}
          onChange={(value) => set('source', sourceKindOf(value) ?? form.source)}
        />
        {form.keptPolicy !== undefined && form.keptPolicy.source !== form.source ? (
          <p className="text-13 text-warn">
            Your policies are read from {npubOf(form.keptPolicy.policyKey)}. With another product
            source they are read from that source's default key instead.
          </p>
        ) : null}
        {form.source === 'connector' ? (
          <>
            <SelectField
              id="store-platform"
              label="Platform"
              value={form.platform}
              options={PLATFORM_OPTIONS}
              onChange={(value) => set('platform', platformOf(value) ?? form.platform)}
            />
            {form.platform === 'google' ? null : (
              <TextField
                id="store-shop-url"
                label="Shop address"
                value={form.shopUrl}
                placeholder="https://shop.example"
                hint="Its origin must be one of the allowed origins, so the chat can add to the cart."
                onChange={(value) => set('shopUrl', value)}
              />
            )}
          </>
        ) : null}
        {form.source === 'catalog' ? (
          <TextField
            id="store-merchant-key"
            label="Your catalog key (npub or hex)"
            value={form.merchantKey}
            hint={`Print it with: ${ASKR_KEY_COMMAND} ${ownerNpub}`}
            onChange={(value) => set('merchantKey', value)}
          />
        ) : null}
        {form.source === 'paycore' ? (
          <TextField
            id="store-paycore-key"
            label="Pay Core store key (npub or hex)"
            value={form.paycoreKey}
            hint="Policies are then edited here in the admin."
            onChange={(value) => set('paycoreKey', value)}
          />
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-12">
        <legend className="text-15 mb-8 font-semibold">Private instructions</legend>
        <p className="text-13 text-text-3">Encrypted to your assistant. Visitors never see them.</p>
        <TextAreaField
          id="store-voice"
          label="Voice"
          value={form.voice}
          onChange={(value) => set('voice', value)}
        />
        <TextAreaField
          id="store-instructions"
          label="Instructions"
          rows={5}
          value={form.instructions}
          onChange={(value) => set('instructions', value)}
        />
        <TextAreaField
          id="store-notes"
          label="Notes"
          value={form.notes}
          onChange={(value) => set('notes', value)}
        />
      </fieldset>
    </div>
  );
}
