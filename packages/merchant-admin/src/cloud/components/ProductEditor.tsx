import { useState } from 'react';
import { Field } from '../../components/Field';
import { Input } from '../../components/Input';
import { describedBy } from '../../lib/field';
import type { ProblemText } from '../lib/problems';
import { type ProductDraft, draftText, fieldErrors, roomLeft } from '../lib/product-form';
import { PRODUCT_NAME_RE } from '../lib/snippet';
import { ProblemList } from './ProblemList';

interface Props {
  product: ProductDraft;
  /** Its button id may still change: it was never saved. */
  nameEditable: boolean;
  /** Another product of the set has this id. */
  nameTaken: boolean;
  /** What the store refused of this product on its last save, in words. */
  refused: readonly ProblemText[];
  onChange: (next: ProductDraft) => void;
}

/** The ids a control is described by, without the ones it does not show. */
function ids(...parts: (string | undefined)[]): string | undefined {
  const shown = parts.filter((part) => part !== undefined);
  return shown.length === 0 ? undefined : shown.join(' ');
}

/**
 * One product's fields, each with its own error (or its PRODUCT.md as text,
 * when the console did not write it), the button id it gets, the room left
 * near the size limit, and a still picture of its Buy button.
 */
export function ProductEditor({ product, nameEditable, nameTaken, refused, onChange }: Props) {
  const id = `product-${product.key}`;
  const [changingName, setChangingName] = useState(false);
  const left = roomLeft(draftText(product));
  const tooLong = left !== undefined && left < 0 ? 'Too long: shorten the description.' : undefined;
  let nameError: string | undefined;
  if (!PRODUCT_NAME_RE.test(product.name)) {
    nameError = 'Lowercase letters, digits and dashes, starting with a letter or digit.';
  } else if (nameTaken) {
    nameError = `Another product has the button id ${product.name}.`;
  }
  const refusedId = refused.length === 0 ? undefined : `${id}-refused`;
  const fields = product.fields;
  const room =
    left === undefined || left < 0 ? null : (
      <p id={`${id}-room`} className="text-13 text-warn">
        {`Almost full: about ${left.toLocaleString('en-US')} characters left in this product.`}
      </p>
    );
  if (fields === undefined) {
    return (
      <div className="flex flex-col gap-16">
        <Field
          id={`${id}-text`}
          label={`${product.name} (PRODUCT.md)`}
          hint="Written by hand: edited as its text."
          {...(tooLong === undefined ? {} : { error: tooLong })}
        >
          <textarea
            id={`${id}-text`}
            value={product.text}
            rows={12}
            spellCheck={false}
            aria-invalid={tooLong === undefined && refusedId === undefined ? undefined : true}
            aria-describedby={ids(describedBy(`${id}-text`, 'hint', tooLong), refusedId)}
            onChange={(event) => onChange({ ...product, text: event.target.value })}
            className="rounded-10 border-line-2 bg-bg text-13 border px-12 py-8 font-mono"
          />
        </Field>
        {room}
        <ProblemList problems={refused} {...(refusedId === undefined ? {} : { id: refusedId })} />
      </div>
    );
  }
  const errors = fieldErrors(fields);
  const set = (next: Partial<typeof fields>) =>
    onChange({ ...product, fields: { ...fields, ...next } });
  return (
    <div className="flex flex-col gap-16">
      <ProblemList problems={refused} {...(refusedId === undefined ? {} : { id: refusedId })} />
      <div className="flex flex-col gap-6">
        <Field id={`${id}-title`} label="Title" {...(errors.title ? { error: errors.title } : {})}>
          <Input
            id={`${id}-title`}
            aria-invalid={errors.title === undefined ? undefined : true}
            aria-describedby={ids(
              describedBy(`${id}-title`, undefined, errors.title),
              `${id}-name-line`,
            )}
            value={fields.title}
            maxLength={200}
            onChange={(event) => set({ title: event.target.value })}
          />
        </Field>
        <p id={`${id}-name-line`} className="text-13 text-text-2 flex flex-wrap items-center gap-6">
          <span>
            Button id: <code className="font-mono">{product.name}</code>
          </span>
          {nameEditable && !changingName ? (
            <button
              type="button"
              onClick={() => setChangingName(true)}
              className="text-text underline underline-offset-2"
            >
              Change
            </button>
          ) : null}
          {nameEditable ? null : <span className="text-text-3">(fixed once saved)</span>}
        </p>
        {nameEditable && (changingName || nameError !== undefined) ? (
          <Field
            id={`${id}-name`}
            label="Button id"
            hint="Lowercase letters, digits and dashes. Fixed once saved."
            {...(nameError === undefined ? {} : { error: nameError })}
          >
            <Input
              id={`${id}-name`}
              value={product.name}
              mono
              aria-invalid={nameError === undefined ? undefined : true}
              aria-describedby={describedBy(`${id}-name`, 'hint', nameError)}
              onChange={(event) =>
                onChange({ ...product, name: event.target.value, nameTouched: true })
              }
            />
          </Field>
        ) : null}
      </div>
      <Field
        id={`${id}-price`}
        label="Price, USD"
        hint="Buyers pay the same amount in a stablecoin."
        {...(errors.price ? { error: errors.price } : {})}
      >
        <Input
          id={`${id}-price`}
          inputMode="decimal"
          value={fields.priceUsd}
          aria-invalid={errors.price === undefined ? undefined : true}
          aria-describedby={describedBy(`${id}-price`, 'hint', errors.price)}
          onChange={(event) => set({ priceUsd: event.target.value })}
        />
      </Field>
      <Field
        id={`${id}-summary`}
        label="Short description (optional)"
        hint="One line under the title."
        {...(errors.summary ? { error: errors.summary } : {})}
      >
        <Input
          id={`${id}-summary`}
          value={fields.summary}
          maxLength={1024}
          aria-invalid={errors.summary === undefined ? undefined : true}
          aria-describedby={describedBy(`${id}-summary`, 'hint', errors.summary)}
          onChange={(event) => set({ summary: event.target.value })}
        />
      </Field>
      <Field
        id={`${id}-description`}
        label="Description"
        {...(tooLong === undefined ? {} : { error: tooLong })}
      >
        <textarea
          id={`${id}-description`}
          value={fields.description}
          rows={5}
          aria-invalid={tooLong === undefined ? undefined : true}
          aria-describedby={ids(
            describedBy(`${id}-description`, undefined, tooLong),
            left === undefined || left < 0 ? undefined : `${id}-room`,
          )}
          onChange={(event) => set({ description: event.target.value })}
          className="rounded-10 border-line-2 bg-bg text-14 border px-12 py-8"
        />
      </Field>
      {room}
      <label className="text-14 flex items-center gap-8">
        <input
          type="checkbox"
          checked={fields.onSale}
          onChange={(event) => set({ onSale: event.target.checked })}
        />
        On sale
      </label>
      <div
        aria-hidden="true"
        className="rounded-12 border-line bg-bg flex items-center justify-between gap-12 border p-12"
      >
        <div className="flex min-w-0 flex-col">
          <span className="text-14 truncate font-semibold">
            {fields.title.trim() === '' ? 'Your product' : fields.title}
          </span>
          <span className="text-13 text-text-2">
            {fields.onSale ? `$${fields.priceUsd.trim() || '0'}` : 'Sold out'}
          </span>
        </div>
        <span className="rounded-8 bg-accent text-13 text-accent-text px-12 py-6 font-semibold">
          Buy
        </span>
      </div>
    </div>
  );
}
