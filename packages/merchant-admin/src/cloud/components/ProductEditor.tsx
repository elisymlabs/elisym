import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Input } from '../../components/Input';
import { describedBy } from '../../lib/field';
import {
  MAX_PRODUCT_BYTES,
  type ProductDraft,
  draftText,
  fieldProblems,
  productBytes,
} from '../lib/product-form';
import { PRODUCT_NAME_RE } from '../lib/snippet';

interface Props {
  product: ProductDraft;
  /** Its name may still change: it was never saved. */
  nameEditable: boolean;
  /** Shown as published: it can be taken off sale, never removed. */
  published: boolean;
  onChange: (next: ProductDraft) => void;
  /** Removes it from the draft; none when it cannot be removed. */
  onRemove: (() => void) | undefined;
}

/**
 * One product of the draft: its fields as a form (or its PRODUCT.md as text,
 * when the console did not write it), how much of the size limit it uses, and
 * a still picture of its buy button.
 */
export function ProductEditor({ product, nameEditable, published, onChange, onRemove }: Props) {
  const id = `product-${product.key}`;
  const bytes = productBytes(draftText(product));
  const problems = product.fields === undefined ? [] : fieldProblems(product.fields);
  const nameError =
    nameEditable && !PRODUCT_NAME_RE.test(product.name)
      ? 'Lowercase letters, digits and dashes, starting with a letter or digit.'
      : undefined;
  const fields = product.fields;
  // The problems of the fields, read out with the title and the price.
  const problemsId = problems.length === 0 ? undefined : `${id}-problems`;
  return (
    <div className="border-line flex flex-col gap-12 border-t pt-16">
      {fields === undefined ? (
        <Field
          id={`${id}-text`}
          label={`${product.name} (PRODUCT.md)`}
          hint="Written by hand: edited as its text."
        >
          <textarea
            id={`${id}-text`}
            value={product.text}
            rows={8}
            spellCheck={false}
            aria-describedby={describedBy(`${id}-text`, 'hint', undefined)}
            onChange={(event) => onChange({ ...product, text: event.target.value })}
            className="rounded-10 border-line-2 bg-bg text-13 border px-12 py-8 font-mono"
          />
        </Field>
      ) : (
        <>
          <Field id={`${id}-title`} label="Title">
            <Input
              id={`${id}-title`}
              aria-invalid={problemsId === undefined ? undefined : true}
              aria-describedby={problemsId}
              value={fields.title}
              maxLength={200}
              onChange={(event) =>
                onChange({
                  ...product,
                  fields: { ...fields, title: event.target.value },
                })
              }
            />
          </Field>
          <div className="grid gap-12 sm:grid-cols-2">
            <Field id={`${id}-price`} label="Price, USD" hint="Paid 1:1 in a stablecoin.">
              <Input
                id={`${id}-price`}
                inputMode="decimal"
                value={fields.priceUsd}
                aria-invalid={problemsId === undefined ? undefined : true}
                aria-describedby={[describedBy(`${id}-price`, 'hint', undefined), problemsId]
                  .filter((each) => each !== undefined)
                  .join(' ')}
                onChange={(event) =>
                  onChange({ ...product, fields: { ...fields, priceUsd: event.target.value } })
                }
              />
            </Field>
            <Field
              id={`${id}-name`}
              label="Product id"
              hint={nameEditable ? 'Its id in the snippet: fixed once saved.' : 'Fixed once saved.'}
              error={nameError}
            >
              <Input
                id={`${id}-name`}
                value={product.name}
                readOnly={!nameEditable}
                mono
                aria-describedby={describedBy(`${id}-name`, 'hint', nameError)}
                onChange={(event) =>
                  onChange({ ...product, name: event.target.value, nameTouched: true })
                }
              />
            </Field>
          </div>
          <Field id={`${id}-summary`} label="Summary (optional)" hint="One line under the title.">
            <Input
              id={`${id}-summary`}
              value={fields.summary}
              maxLength={1024}
              aria-describedby={describedBy(`${id}-summary`, 'hint', undefined)}
              onChange={(event) =>
                onChange({ ...product, fields: { ...fields, summary: event.target.value } })
              }
            />
          </Field>
          <Field id={`${id}-description`} label="Description">
            <textarea
              id={`${id}-description`}
              value={fields.description}
              rows={4}
              onChange={(event) =>
                onChange({ ...product, fields: { ...fields, description: event.target.value } })
              }
              className="rounded-10 border-line-2 bg-bg text-14 border px-12 py-8"
            />
          </Field>
          <label className="text-14 flex items-center gap-8">
            <input
              type="checkbox"
              checked={fields.onSale}
              onChange={(event) =>
                onChange({ ...product, fields: { ...fields, onSale: event.target.checked } })
              }
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
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-8">
        <span
          className={`text-12 ${bytes > MAX_PRODUCT_BYTES ? 'text-error' : 'text-text-3'}`}
          data-bytes={bytes}
        >
          {bytes.toLocaleString('en-US')} of {MAX_PRODUCT_BYTES.toLocaleString('en-US')} bytes
        </span>
        {onRemove === undefined && published ? (
          <span className="text-12 text-text-3">Published: take it off sale to stop selling.</span>
        ) : null}
        {onRemove === undefined ? null : (
          <Button size="sm" onClick={onRemove}>
            Remove {product.name || 'this product'}
          </Button>
        )}
      </div>
      {problems.length === 0 ? null : (
        <ul id={problemsId} className="text-13 text-error list-disc pl-20">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
