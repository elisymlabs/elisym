import { type CatalogItemInput, CatalogItemInputSchema, VISIBILITIES } from '@elisym/askr';
import Decimal from 'decimal.js-light';
import { useState } from 'react';
import {
  type KeyedOption,
  type VariantInput,
  listingPriceOf,
  rebuildVariants,
  rememberedKey,
} from '../lib/variants';
import { type AttrRow, AttrsEditor } from './AttrsEditor';
import { Notice } from './Notice';
import { type OptionRow, OptionsEditor } from './OptionsEditor';
import { SelectField } from './SelectField';
import { TextAreaField } from './TextAreaField';
import { TextField } from './TextField';
import { VariantsTable } from './VariantsTable';

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

const FREQUENCY_OPTIONS = [
  { value: '', label: 'One-time price' },
  { value: 'hour', label: 'Per hour' },
  { value: 'day', label: 'Per day' },
  { value: 'week', label: 'Per week' },
  { value: 'month', label: 'Per month' },
  { value: 'year', label: 'Per year' },
];

/** `kitchen, gifts` as topics: trimmed, empty ones dropped. */
function topicsOfText(text: string): string[] {
  return text
    .split(',')
    .map((topic) => topic.trim())
    .filter((topic) => topic !== '');
}

function optionRowsOf(item: CatalogItemInput | undefined): OptionRow[] {
  return (item?.options ?? []).map((option, index) => ({
    key: `row-${index}`,
    name: option.name,
    text: option.values.join(', '),
    values: option.values,
  }));
}

/** The options as typed, without rows left wholly empty. */
function optionsOf(rows: readonly OptionRow[]) {
  return rows
    .map((row) => ({ name: row.name.trim(), values: row.values }))
    .filter((option) => option.name !== '' || option.values.length > 0);
}

/** The rows that make variants: a name and at least one value. */
function completeOptionsOf(rows: readonly OptionRow[]): KeyedOption[] {
  return rows
    .map((row) => ({ key: row.key, name: row.name.trim(), values: row.values }))
    .filter((option) => option.name !== '' && option.values.length > 0);
}

function rememberedOf(
  options: readonly KeyedOption[],
  variants: readonly VariantInput[],
): Map<string, VariantInput> {
  return new Map(variants.map((variant) => [rememberedKey(options, variant.values), variant]));
}

/**
 * One product's fields, attributes, options and variants. Its connector source
 * id and anything else the form does not show are kept as they are.
 */
export function ProductEditor({ initial, currency, takenIds, onSave, onCancel }: Props) {
  const [d, setD] = useState(initial?.d ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [price, setPrice] = useState(initial?.price.amount ?? '');
  const [priceCurrency, setPriceCurrency] = useState(initial?.price.currency ?? currency);
  const [frequency, setFrequency] = useState<string>(initial?.price.frequency ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [images, setImages] = useState((initial?.images ?? []).join('\n'));
  const [topicsText, setTopicsText] = useState((initial?.topics ?? []).join(', '));
  // Read from the text only once it is edited, so a topic with a comma stays whole.
  const [topics, setTopics] = useState<string[]>(initial?.topics ?? []);
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [visibility, setVisibility] = useState<string>(initial?.visibility ?? 'on-sale');
  const [attrs, setAttrs] = useState<AttrRow[]>(
    (initial?.attrs ?? []).map((attr) => ({ name: attr.name, value: attr.value })),
  );
  const [optionRows, setOptionRows] = useState<OptionRow[]>(optionRowsOf(initial));
  const [rowsMade, setRowsMade] = useState(initial?.options?.length ?? 0);
  // The options the variants were last built for, by row: a change is compared with these.
  const [appliedOptions, setAppliedOptions] = useState(completeOptionsOf(optionRowsOf(initial)));
  const [variants, setVariants] = useState<VariantInput[]>(initial?.variants ?? []);
  // Every variant this edit has seen, by its values per option row: a combination that comes
  // back (a value retyped, an option name cleared and typed again) gets its price, stock and
  // id back, and no id is ever handed to another combination.
  const [remembered, setRemembered] = useState<ReadonlyMap<string, VariantInput>>(() =>
    rememberedOf(completeOptionsOf(optionRowsOf(initial)), initial?.variants ?? []),
  );
  const [optionProblem, setOptionProblem] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const listingPrice = listingPriceOf(variants);

  const changeVariants = (next: VariantInput[], options: readonly KeyedOption[]) => {
    setVariants(next);
    setRemembered(new Map([...remembered, ...rememberedOf(options, next)]));
  };

  const changeOptions = (rows: OptionRow[]) => {
    // A new row gets its own key: renames and removals are told by row, never guessed.
    let made = rowsMade;
    const keyed = rows.map((row) => {
      if (row.key !== '') {
        return row;
      }
      made += 1;
      return { ...row, key: `row-${made}` };
    });
    setRowsMade(made);
    setOptionRows(keyed);
    // A row still being typed (a name and no values, or values and no name) makes no
    // variants yet; a remembered combination comes back once it is complete again.
    const complete = completeOptionsOf(keyed);
    const next = rebuildVariants({
      previous: appliedOptions,
      next: complete,
      variants,
      remembered,
      price: listingPrice ?? price.trim(),
    });
    if (!next.ok) {
      setOptionProblem(next.reason);
      return;
    }
    if (next.variants.length === 0 && listingPrice !== undefined) {
      // The product goes back to one price: start from the one it showed.
      setPrice(listingPrice);
    }
    setAppliedOptions(complete);
    changeVariants(next.variants, complete);
    setOptionProblem('');
  };

  /** The listing price with variants; an untouched equal amount keeps its spelling (`20.0`). */
  const variantListingAmount = () => {
    const initialAmount = initial?.price.amount;
    if (
      listingPrice !== undefined &&
      initialAmount !== undefined &&
      /^\d+(\.\d+)?$/u.test(initialAmount) &&
      new Decimal(initialAmount).equals(listingPrice)
    ) {
      return initialAmount;
    }
    return listingPrice ?? '';
  };

  const save = () => {
    const id = d.trim();
    if (initial === undefined && takenIds.includes(id)) {
      setErrors([`ID: another product already uses "${id}".`]);
      return;
    }
    const typed = optionsOf(optionRows);
    if (typed.some((option) => option.name === '' || option.values.length === 0)) {
      setErrors(['options: each option needs a name and at least one value.']);
      return;
    }
    if (optionProblem !== '') {
      // The variants are those of the last options that made sense: fix the options first.
      setErrors([`options: ${optionProblem}`]);
      return;
    }
    const candidate: Record<string, unknown> = {
      ...initial,
      d: id,
      title: title.trim(),
      price: {
        ...initial?.price,
        // With variants the listing carries the lowest in-stock variant price (2.1).
        amount: variants.length > 0 ? variantListingAmount() : price.trim(),
        currency: priceCurrency.trim().toUpperCase(),
        frequency: frequency === '' ? undefined : frequency,
      },
      description,
      images: images
        .split(/\s+/u)
        .map((image) => image.trim())
        .filter((image) => image !== ''),
      topics,
      attrs: attrs
        .map((attr) => ({ name: attr.name.trim(), value: attr.value.trim() }))
        .filter((attr) => attr.name !== '' || attr.value !== ''),
      options: typed,
      variants,
      visibility,
    };
    candidate.summary = summary.trim() === '' ? undefined : summary.trim();
    candidate.url = url.trim() === '' ? undefined : url.trim();
    candidate.sku = sku.trim() === '' ? undefined : sku.trim();
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
      <div className="grid gap-12 sm:grid-cols-3">
        {variants.length > 0 ? (
          <TextField
            id="product-price"
            label="Price"
            value={listingPrice ?? ''}
            readOnly
            hint="The lowest in-stock variant price, from the variants below."
            onChange={() => undefined}
          />
        ) : (
          <TextField
            id="product-price"
            label="Price"
            value={price}
            placeholder="19.90"
            onChange={setPrice}
          />
        )}
        <TextField
          id="product-currency"
          label="Currency"
          value={priceCurrency}
          onChange={setPriceCurrency}
        />
        <SelectField
          id="product-frequency"
          label="Billing"
          value={frequency}
          options={FREQUENCY_OPTIONS}
          hint="Per month and the like for a subscription."
          onChange={setFrequency}
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
      <div className="grid gap-12 sm:grid-cols-2">
        <TextField
          id="product-topics"
          label="Topics (optional)"
          value={topicsText}
          placeholder="tents, camping"
          hint="Words shoppers search by, separated by commas."
          onChange={(text) => {
            setTopicsText(text);
            setTopics(topicsOfText(text));
          }}
        />
        <TextField id="product-sku" label="SKU (optional)" value={sku} onChange={setSku} />
      </div>
      <AttrsEditor rows={attrs} onChange={setAttrs} />
      <OptionsEditor rows={optionRows} onChange={changeOptions} />
      {optionProblem === '' ? null : <Notice tone="error">{optionProblem}</Notice>}
      {variants.length === 0 ? null : (
        <VariantsTable
          variants={variants}
          onChange={(next) => changeVariants(next, appliedOptions)}
        />
      )}
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
