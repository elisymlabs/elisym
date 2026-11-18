import { HELP } from '../lib/help';
import { PLATFORM_OPTIONS, SOURCE_OPTIONS, platformOf, sourceKindOf } from '../lib/labels';
import { npubOf } from '../lib/signer';
import type { StoreForm } from '../lib/store-form';
import { FieldGroup } from './FieldGroup';
import { InfoTip } from './InfoTip';
import { SelectField } from './SelectField';
import { TextAreaField } from './TextAreaField';
import { TextField } from './TextField';

interface Props {
  form: StoreForm;
  onChange: (form: StoreForm) => void;
}

/** Every field of the store's Askr config (2.3), public and private. */
export function StoreFields({ form, onChange }: Props) {
  const set = <Key extends keyof StoreForm>(key: Key, value: StoreForm[Key]) =>
    onChange({ ...form, [key]: value });
  return (
    <div className="flex flex-col gap-32">
      <FieldGroup id="group-store" title="Store">
        <TextField
          id="store-name"
          info={HELP.storeName}
          label="Store name"
          value={form.name}
          onChange={(value) => set('name', value)}
        />
        <TextField
          id="store-language"
          info={HELP.catalogLanguage}
          label="Catalog language"
          value={form.language}
          hint="A language tag, like en, de or pt-BR"
          onChange={(value) => set('language', value)}
        />
        <TextField
          id="store-currency"
          info={HELP.currency}
          label="Currency"
          value={form.currency}
          hint="Three letters, like USD or EUR"
          onChange={(value) => set('currency', value)}
        />
        <TextAreaField
          id="store-origins"
          info={HELP.allowedOrigins}
          label="Allowed origins"
          value={form.origins}
          placeholder="https://shop.example"
          hint="The sites the chat may run on, one per line. Only these get answers."
          onChange={(value) => set('origins', value)}
        />
        <TextAreaField
          id="store-link-origins"
          info={HELP.linkOrigins}
          label="Link origins (optional)"
          value={form.linkOrigins}
          hint="Other sites product links may point to, one per line."
          onChange={(value) => set('linkOrigins', value)}
        />
      </FieldGroup>

      <FieldGroup id="group-assistant" title="Assistant">
        <TextField
          id="store-display-name"
          info={HELP.assistantName}
          label="Assistant name (optional)"
          value={form.displayName}
          hint="Shown in the chat. By default it is your store name followed by assistant."
          onChange={(value) => set('displayName', value)}
        />
        <TextField
          id="store-greeting"
          info={HELP.greeting}
          label="Greeting (optional)"
          value={form.greeting}
          onChange={(value) => set('greeting', value)}
        />
        <TextField
          id="store-contact"
          info={HELP.contact}
          label="Contact URL (optional)"
          value={form.contact}
          placeholder="https://shop.example/contact"
          hint="Shown when the assistant is unavailable."
          onChange={(value) => set('contact', value)}
        />
      </FieldGroup>

      <FieldGroup id="group-products" title="Products">
        <SelectField
          id="store-source"
          info={HELP.productSource}
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
              info={HELP.platform}
              label="Platform"
              value={form.platform}
              options={PLATFORM_OPTIONS}
              onChange={(value) => set('platform', platformOf(value) ?? form.platform)}
            />
            {form.platform === 'google' ? (
              <TextField
                id="store-feed-url"
                info={HELP.feedUrl}
                label="Feed address"
                value={form.feedUrl}
                placeholder="https://shop.example/feed.xml"
                hint="Your Google product feed. Every site its products link to must be an allowed or link origin."
                onChange={(value) => set('feedUrl', value)}
              />
            ) : (
              <TextField
                id="store-shop-url"
                info={HELP.shopUrl}
                label="Shop address"
                value={form.shopUrl}
                placeholder="https://shop.example"
                hint="It must be one of your allowed sites, so the chat can add to its cart."
                onChange={(value) => set('shopUrl', value)}
              />
            )}
            <TextField
              id="store-connector-currency"
              info={HELP.currencyOverride}
              label="Currency override (optional)"
              value={form.connectorCurrency}
              hint="Shopify only: if the shop reports another currency than it sells in."
              onChange={(value) => set('connectorCurrency', value)}
            />
            {form.platform === 'shopify' ? (
              <div className="flex items-center gap-6">
                <label className="text-14 flex items-center gap-8">
                  <input
                    type="checkbox"
                    checked={form.importPolicies}
                    onChange={(event) => set('importPolicies', event.target.checked)}
                  />
                  Import the shop&apos;s refund, shipping, privacy and terms pages as policies
                </label>
                <InfoTip help={HELP.importPolicies} about="Import policies" />
              </div>
            ) : null}
            <p className="text-13 text-text-2">
              Saving sets up the connector; preview and turn on syncing in the Connector tab.
            </p>
          </>
        ) : null}
        {form.source === 'catalog' ? (
          <TextField
            id="store-merchant-key"
            info={HELP.catalogKey}
            label="Your catalog key (npub1...)"
            value={form.merchantKey}
            hint="The public key your backend, SDK or MCP server publishes your products with."
            onChange={(value) => set('merchantKey', value)}
          />
        ) : null}
      </FieldGroup>

      <FieldGroup
        id="group-private"
        title="Private instructions"
        info={HELP.privateInstructions}
        description="Encrypted to your assistant. Visitors never see them."
      >
        <TextAreaField
          id="store-voice"
          info={HELP.voice}
          label="Voice"
          value={form.voice}
          onChange={(value) => set('voice', value)}
        />
        <TextAreaField
          id="store-instructions"
          info={HELP.instructions}
          label="Instructions"
          rows={5}
          value={form.instructions}
          onChange={(value) => set('instructions', value)}
        />
        <TextAreaField
          id="store-notes"
          info={HELP.notes}
          label="Notes"
          value={form.notes}
          onChange={(value) => set('notes', value)}
        />
      </FieldGroup>
    </div>
  );
}
