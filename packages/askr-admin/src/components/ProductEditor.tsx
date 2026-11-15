import {
  type CatalogItemInput,
  CatalogItemInputSchema,
  RESERVED_ATTRS,
  VISIBILITIES,
} from '@elisym/askr';
import Decimal from 'decimal.js-light';
import { useState } from 'react';
import {
  type VariantInput,
  listingPriceOf,
  renamedValue,
  variantProblems,
  withMissingCombinations,
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

/** The options as typed, one per row, in row order (the order of every variant's values). */
function optionsOf(rows: readonly OptionRow[]) {
  return rows.map((row) => ({ name: row.name.trim(), values: row.values }));
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
  // Every variant's values follow the option rows, in row order.
  const [variants, setVariants] = useState<VariantInput[]>(initial?.variants ?? []);
  // Ids the product's variants have had in this edit: a new variant never gets one, so an id
  // never moves to another choice while the product is edited.
  const [usedIds, setUsedIds] = useState<ReadonlySet<string>>(
    () => new Set((initial?.variants ?? []).map((variant) => variant.id)),
  );
  const [variantNotice, setVariantNotice] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const listingPrice = listingPriceOf(variants);
  // The last listing price the variants made, for when a price being typed is not a number.
  const [lastListingPrice, setLastListingPrice] = useState(listingPrice);

  const changeVariants = (next: VariantInput[]) => {
    const shown = listingPrice ?? lastListingPrice;
    if (next.length === 0 && shown !== undefined) {
      // The product goes back to one price: start from the last one it showed.
      setPrice(shown);
    }
    const nextListing = listingPriceOf(next);
    if (nextListing !== undefined) {
      setLastListingPrice(nextListing);
    }
    setVariants(next);
    setVariantNotice('');
  };

  /** Ids for new variants: numbers no variant of this edit has had. */
  const idMaker = () => {
    const taken = new Set([...usedIds, ...variants.map((variant) => variant.id)]);
    let next = 1;
    const made: string[] = [];
    const freshId = () => {
      while (taken.has(String(next))) {
        next += 1;
      }
      taken.add(String(next));
      made.push(String(next));
      return String(next);
    };
    const keep = () => setUsedIds(new Set([...usedIds, ...made]));
    return { freshId, keep };
  };

  // Editing the options never makes or drops a variant: a removed row takes its value out of
  // every variant and a new row asks each variant to pick one.
  const changeOptions = (rows: OptionRow[]) => {
    let made = rowsMade;
    const keyed = rows.map((row) => {
      if (row.key !== '') {
        return row;
      }
      made += 1;
      return { ...row, key: `row-${made}` };
    });
    setRowsMade(made);
    setVariants(
      variants.map((variant) => ({
        ...variant,
        values: keyed.map((row) => {
          const earlier = optionRows.findIndex((candidate) => candidate.key === row.key);
          return earlier === -1 ? '' : (variant.values[earlier] ?? '');
        }),
      })),
    );
    setOptionRows(keyed);
  };

  // A values field left with one value replaced by another (the same values otherwise, in
  // place): that value is renamed in the variants too. Judged against the field as it was
  // entered, so typing a new value in the middle of the list renames nothing.
  const valuesDone = (key: string, before: readonly string[], after: readonly string[]) => {
    const rename = renamedValue(before, after);
    const index = optionRows.findIndex((row) => row.key === key);
    if (rename === undefined || index === -1) {
      return;
    }
    setVariants(
      variants.map((variant) => ({
        ...variant,
        values: variant.values.map((value, valueIndex) =>
          valueIndex === index && value === rename.from ? rename.to : value,
        ),
      })),
    );
  };

  const addVariant = () => {
    const ids = idMaker();
    changeVariants([
      ...variants,
      {
        id: ids.freshId(),
        price: listingPrice ?? price.trim(),
        available: true,
        values: optionRows.map(() => ''),
      },
    ]);
    ids.keep();
  };

  const addMissing = () => {
    const ids = idMaker();
    const next = withMissingCombinations(
      optionsOf(optionRows),
      variants,
      listingPrice ?? price.trim(),
      ids.freshId,
    );
    if (!next.ok) {
      setVariantNotice(next.reason);
      return;
    }
    changeVariants(next.variants);
    ids.keep();
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
    const optionProblems = typed.flatMap((option, index) => {
      if (option.name === '' || option.values.length === 0) {
        return [`Option ${index + 1} needs a name and at least one value, or remove it.`];
      }
      const earlier = typed.findIndex((other) => other.name === option.name);
      return earlier < index
        ? [`Option ${index + 1}: option ${earlier + 1} is already called ${option.name}.`]
        : [];
    });
    const attrProblems = attrs.flatMap((attr, index) => {
      const attrName = attr.name.trim();
      if (attrName === '' && attr.value.trim() !== '') {
        return [`Attribute ${index + 1} needs a name.`];
      }
      if (attrName !== '' && attr.value.trim() === '') {
        return [`Attribute ${index + 1} (${attrName}) needs a value.`];
      }
      if (attrName === 'sku') {
        return [`Attribute ${index + 1}: use the SKU field for the SKU.`];
      }
      return RESERVED_ATTRS.includes(attrName)
        ? [`Attribute ${index + 1}: ${attrName} is kept for connectors, pick another name.`]
        : [];
    });
    const problems = [
      ...optionProblems,
      ...attrProblems,
      ...variantProblems(typed, variants, initial?.variants),
    ];
    if (problems.length > 0) {
      setErrors(problems);
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
    // A connector's "from" price stood for variants it could not list; edited variants say it themselves.
    if (JSON.stringify(variants) !== JSON.stringify(initial?.variants ?? [])) {
      candidate.priceFrom = undefined;
    }
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
      <OptionsEditor rows={optionRows} onChange={changeOptions} onValuesDone={valuesDone} />
      {optionRows.length === 0 && variants.length === 0 ? null : (
        <VariantsTable
          options={optionsOf(optionRows)}
          variants={variants}
          onChange={changeVariants}
          onAdd={addVariant}
          onAddMissing={addMissing}
        />
      )}
      {variantNotice === '' ? null : <Notice tone="error">{variantNotice}</Notice>}
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
            {errors.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
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
