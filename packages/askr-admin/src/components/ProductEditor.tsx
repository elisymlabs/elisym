import { type CatalogItemInput, CatalogItemInputSchema, VISIBILITIES } from '@elisym/askr';
import { useState } from 'react';
import { Notice } from './Notice';
import { SelectField } from './SelectField';
import { TextAreaField } from './TextAreaField';
import { TextField } from './TextField';

interface Props {
  /** The product being edited, or undefined for a new one. */
  initial: CatalogItemInput | undefined;
  currency: string;
  /** `d`s already in the catalog: a new product needs its own. */
  takenIds: readonly string[];
  onSave: (item: CatalogItemInput) => void;
  onCancel: () => void;
}

const VISIBILITY_OPTIONS = VISIBILITIES.map((visibility) => ({
  value: visibility,
  label: visibility.replace('-', ' '),
}));

/** One product's main fields; anything else it carries (variants, attributes) is kept as is. */
export function ProductEditor({ initial, currency, takenIds, onSave, onCancel }: Props) {
  const [d, setD] = useState(initial?.d ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [price, setPrice] = useState(initial?.price.amount ?? '');
  const [priceCurrency, setPriceCurrency] = useState(initial?.price.currency ?? currency);
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [images, setImages] = useState((initial?.images ?? []).join('\n'));
  const [visibility, setVisibility] = useState<string>(initial?.visibility ?? 'on-sale');
  const [errors, setErrors] = useState<string[]>([]);

  const save = () => {
    const id = d.trim();
    if (initial === undefined && takenIds.includes(id)) {
      setErrors([`ID: another product already uses "${id}".`]);
      return;
    }
    const candidate: Record<string, unknown> = {
      ...initial,
      d: id,
      title: title.trim(),
      price: {
        ...initial?.price,
        amount: price.trim(),
        currency: priceCurrency.trim().toUpperCase(),
      },
      description,
      images: images
        .split(/\s+/u)
        .map((image) => image.trim())
        .filter((image) => image !== ''),
      visibility,
    };
    candidate.summary = summary.trim() === '' ? undefined : summary.trim();
    candidate.url = url.trim() === '' ? undefined : url.trim();
    const checked = CatalogItemInputSchema.safeParse(candidate);
    if (!checked.success) {
      setErrors(
        checked.error.issues.map(
          (issue) => `${issue.path.join('.') || 'product'}: ${issue.message}`,
        ),
      );
      return;
    }
    setErrors([]);
    onSave(checked.data);
  };

  return (
    <div className="border-line rounded-12 flex flex-col gap-12 border p-16">
      <h3 className="text-15 font-semibold">
        {initial === undefined ? 'New product' : `Edit ${initial.title}`}
      </h3>
      <TextField
        id="product-d"
        label="ID"
        value={d}
        readOnly={initial !== undefined}
        hint={
          initial === undefined
            ? 'Your SKU or another short ID: letters, digits, . _ : -'
            : 'The ID cannot change.'
        }
        onChange={(value) => {
          if (initial === undefined) {
            setD(value);
          }
        }}
      />
      <TextField id="product-title" label="Title" value={title} onChange={setTitle} />
      <div className="grid gap-12 sm:grid-cols-2">
        <TextField
          id="product-price"
          label="Price"
          value={price}
          placeholder="19.90"
          onChange={setPrice}
        />
        <TextField
          id="product-currency"
          label="Currency"
          value={priceCurrency}
          onChange={setPriceCurrency}
        />
      </div>
      <TextField
        id="product-summary"
        label="Summary (optional)"
        value={summary}
        onChange={setSummary}
      />
      <TextAreaField
        id="product-description"
        label="Description"
        value={description}
        rows={4}
        onChange={setDescription}
      />
      <TextField
        id="product-url"
        label="Product page (optional)"
        value={url}
        placeholder="https://..."
        onChange={setUrl}
      />
      <TextAreaField
        id="product-images"
        label="Image URLs (one per line)"
        value={images}
        onChange={setImages}
      />
      <SelectField
        id="product-visibility"
        label="Availability"
        value={visibility}
        options={VISIBILITY_OPTIONS}
        onChange={setVisibility}
      />
      {errors.length === 0 ? null : (
        <Notice tone="error">
          <ul>
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="flex gap-8">
        <button type="button" className="btn btn-primary" onClick={save}>
          Keep this product
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
