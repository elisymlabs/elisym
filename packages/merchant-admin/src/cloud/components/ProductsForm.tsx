import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ProductPicture } from '../../components/ProductPicture';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { type ProblemText, problemText } from '../lib/problems';
import {
  type ProductDraft,
  changedCount,
  draftOf,
  draftSet,
  draftText,
  freeSlug,
  productIssues,
  shownImage,
} from '../lib/product-form';
import { saveVerdict } from '../lib/save-wait';
import { productsDigest } from '../lib/status';
import type { StoreStatus } from '../lib/status';
import type { KeptStore } from '../lib/use-kept-store';
import type { StoreStatusPoll } from '../lib/use-status';
import { ProblemList } from './ProblemList';
import { ProductEditor } from './ProductEditor';
import { ProductsCallout } from './ProductsCallout';
import { ProductSheet } from './ProductSheet';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  kept: KeptStore;
  status: StoreStatus;
  poll: StoreStatusPoll;
  /** Launched: what the store keeps is published, so a kept product is never removed. */
  published: boolean;
  /** The draft was saved and kept, with nothing left unsaved. */
  onSettled?: () => void;
}

/** The product a store refusal line is about (`products/<name>: ...`), if any. */
const REFUSED_PRODUCT = /^products\/([a-z0-9][a-z0-9-]*)/;

/** A product open in the sheet: which, and how it was when it opened. */
interface Open {
  key: string;
  /** As it was when the sheet opened; undefined for one added with it. */
  before: ProductDraft | undefined;
}

/** A product added with the sheet, before anything was typed in it. */
function blankProduct(product: ProductDraft): ProductDraft {
  return {
    ...product,
    fields: { title: '', priceUsd: '', summary: '', image: '', description: '', onSale: true },
  };
}

/** A product's name in the list: its title, else its button id. */
function labelOf(product: ProductDraft): string {
  return product.fields?.title.trim() || product.name;
}

/**
 * The store's products: a list (title, price, on sale) where each opens in a
 * side sheet to edit. Edits collect in a draft and one save sends the whole
 * set (one change for the store); the save waits until the store keeps that
 * set (by its digest, never by a cycle id).
 */
export function ProductsForm({ api, tenantId, kept, status, poll, published, onSettled }: Props) {
  const { read } = kept;
  const [draft, setDraft] = useState<ProductDraft[] | undefined>(undefined);
  // The set the draft started from (or was last saved as): what "changes" count against.
  const [start, setStart] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<ProblemText[]>([]);
  // A save was tried with products that need a fix: their rows say so.
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState<{ digest: string; seq: number; set: Record<string, string> }>();
  // Each new product the store took a save of, by its key: the name it was saved under.
  const savedAs = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Open | undefined>(undefined);
  const inFlight = useRef(false);
  const nextKey = useRef(0);
  // What opened the sheet: focus goes back to it when the sheet closes.
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  // Filled once from the first read: the set still waiting when there is one, else the kept set.
  useEffect(() => {
    if (draft === undefined && read !== undefined) {
      const set = read.waitingProducts ?? read.products;
      setDraft(Object.entries(set).map(([name, text]) => draftOf(name, text)));
      setStart(set);
    }
  }, [draft, read]);

  const verdict = saveVerdict({
    sentSeq: sent?.seq,
    statusSeq: poll.statusSeq,
    kept: sent !== undefined && status.kept.productsDigest === sent.digest,
    pending: status.pending,
  });
  const applied = verdict === 'applied';
  const refused = verdict === 'refused';
  const waiting = verdict === 'waiting';

  // Kept: the draft's start moves to what was saved; settled (once per save) when nothing
  // changed since.
  const settledFor = useRef<typeof sent>(undefined);
  useEffect(() => {
    if (applied && sent !== undefined && settledFor.current !== sent) {
      settledFor.current = sent;
      setStart(sent.set);
      if (draft !== undefined && changedCount(sent.set, draftSet(draft)) === 0) {
        onSettled?.();
      }
    }
  }, [applied, sent, draft, onSettled]);

  if (draft === undefined) {
    return null;
  }
  // Every name the store keeps, or a save from here still on its way (and not refused) holds:
  // fixed once saved, and on a launched store published (or about to be), so never removed.
  // A set that only waited when the page opened is not here: it may yet be refused.
  const keptNames = new Set([
    ...Object.keys(read?.products ?? {}),
    ...(read?.productNames ?? []),
    ...(sent !== undefined && !refused ? Object.keys(sent.set) : []),
  ]);
  const set = draftSet(draft);
  const changes = changedCount(start, set);
  // This product is the one the store keeps under its name (or a save of it is on its way):
  // its id is fixed, and once published it is never removed. Any other product given that id
  // (a new one, or a waiting one renamed) is not: it is a clash to fix at its field.
  const isKept = (product: ProductDraft) =>
    keptNames.has(product.name) &&
    (product.key === `kept-${product.name}` || savedAs.current.get(product.key) === product.name);
  // The set a save of one product builds on: the one on its way, else the one kept.
  const base = sent !== undefined && !refused ? sent.set : start;
  /** The name a product is saved under, if any: a kept one's own, or a new one's once saved. */
  const ownName = (product: ProductDraft) =>
    product.key.startsWith('kept-')
      ? product.key.slice('kept-'.length)
      : savedAs.current.get(product.key);
  /**
   * The ids another product holds: in the draft, or saved and only removed in the draft
   * (a save of this product alone would overwrite it).
   */
  const takenBy = (product: ProductDraft) =>
    new Set([
      ...draft.filter((other) => other.key !== product.key).map((other) => other.name),
      ...Object.keys(base).filter((name) => name !== ownName(product)),
    ]);
  /** The published products a set leaves out: never removed, only taken off sale. */
  const unpublished = (next: Readonly<Record<string, string>>) =>
    published
      ? [...keptNames]
          .filter((name) => next[name] === undefined)
          .map((name) => `${name} is published: take it off sale instead of removing it.`)
      : [];

  const shownProblems =
    refused && problems.length === 0
      ? (status.lastProblems.products ?? []).map((line) => problemText(line))
      : problems;
  // A refusal about one product is said at that product; the rest at the page.
  const refusedOf = (name: string) =>
    shownProblems.filter((problem) => REFUSED_PRODUCT.exec(problem.raw)?.[1] === name);
  const pageProblems = shownProblems.filter((problem) => {
    const name = REFUSED_PRODUCT.exec(problem.raw)?.[1];
    return name === undefined || !draft.some((product) => product.name === name);
  });

  const update = (key: string, next: ProductDraft) => {
    setDraft(
      draft.map((product) => {
        if (product.key !== key) {
          return product;
        }
        // A new product's id follows its title until the merchant types one.
        if (!next.nameTouched && next.fields !== undefined && !isKept(product)) {
          return { ...next, name: freeSlug(next.fields.title, takenBy(product)) };
        }
        return next;
      }),
    );
  };

  /** Opens a product; `from` is what focus goes back to (Safari never focuses a clicked button). */
  const openSheet = (key: string, before: ProductDraft | undefined, from: HTMLElement | null) => {
    opener.current = from;
    setOpen({ key, before });
  };

  const closeSheet = () => {
    setOpen(undefined);
    const back = opener.current;
    // After React drops the sheet: the opener is back in a live (no longer inert) page.
    setTimeout(() => {
      (back?.isConnected === true ? back : addButton.current)?.focus();
    }, 0);
  };

  const discard = () => {
    if (open === undefined) {
      return;
    }
    const { before, key } = open;
    setDraft(
      before === undefined
        ? draft.filter((product) => product.key !== key)
        : draft.map((product) => (product.key === key ? before : product)),
    );
    closeSheet();
  };

  const add = () => {
    nextKey.current += 1;
    const key = `new-${nextKey.current}`;
    const taken = new Set([...draft.map((product) => product.name), ...Object.keys(base)]);
    setDraft([
      ...draft,
      {
        key,
        name: freeSlug('', taken),
        nameTouched: false,
        fields: { title: '', priceUsd: '', summary: '', image: '', description: '', onSale: true },
        text: '',
      },
    ]);
    openSheet(key, undefined, addButton.current);
  };

  const remove = (key: string) => {
    setDraft(draft.filter((product) => product.key !== key));
    closeSheet();
  };

  /** Saves the whole set; true once the store took it to apply. */
  const save = async (): Promise<boolean> => {
    if (inFlight.current) {
      return false;
    }
    const found: string[] = [];
    const broken = draft.filter(
      (product) => productIssues(product, draft, isKept(product)).length > 0,
    );
    if (broken.length > 0) {
      found.push(
        `Fix ${broken.length === 1 ? 'this product' : 'these products'} first: ${broken.map(labelOf).join(', ')}.`,
      );
    }
    if (draft.length === 0) {
      found.push('A store sells at least one product.');
    }
    found.push(...unpublished(set));
    if (draft.length > status.usage.products && draft.length > keptNames.size) {
      found.push(`Your plan takes ${status.usage.products.toLocaleString('en-US')} products.`);
    }
    // The form's own findings are words already: shown as they are.
    setProblems(found.map((text) => ({ field: 'products', text, raw: text })));
    setTried(broken.length > 0);
    setError('');
    if (found.length > 0) {
      // The first product that needs a fix opens, its fields saying why.
      const first = broken[0];
      if (first !== undefined && open?.key !== first.key) {
        openSheet(first.key, first, addButton.current);
      }
      return false;
    }
    inFlight.current = true;
    setBusy(true);
    const answer = await api.request('POST', `/tenants/${tenantId}/products`, { products: set });
    inFlight.current = false;
    setBusy(false);
    if (answer.status === 200) {
      const digest = await productsDigest(set);
      kept.reload();
      // A new product reaches the draft only by its own save (Save product records it): this
      // set names no product under a name not already recorded.
      setSent({ digest, seq: poll.watch(), set });
      return true;
    }
    const detail = fieldOf(answer.body, 'detail');
    if (fieldOf(answer.body, 'error') === 'store_refused' && typeof detail === 'string') {
      setProblems(detail.split('\n').map((line) => problemText(line)));
      return false;
    }
    setError(explainAnswer(answer.body, answer.status));
    return false;
  };

  /**
   * Saves one product: the set on its way (or kept) with this product's edit, and nothing
   * else of the draft (a toggle or removal in the list waits for its own save). True once
   * the store took it, or when there was nothing to save.
   */
  const saveOne = async (product: ProductDraft): Promise<boolean> => {
    if (inFlight.current) {
      return false;
    }
    const before = ownName(product);
    const next = { ...base };
    if (before !== undefined) {
      delete next[before];
    }
    next[product.name] = draftText(product);
    if (changedCount(base, next) === 0) {
      return true;
    }
    const fixed = isKept(product);
    const issues = productIssues(product, draft, fixed);
    if (!fixed && product.name !== before && base[product.name] !== undefined) {
      issues.push(`Another product has the button id ${product.name}.`);
    }
    const found: string[] = [];
    if (issues.length > 0) {
      found.push(`Fix this product first: ${labelOf(product)}.`);
    }
    found.push(...unpublished(next));
    const count = Object.keys(next).length;
    if (count > status.usage.products && count > keptNames.size) {
      found.push(`Your plan takes ${status.usage.products.toLocaleString('en-US')} products.`);
    }
    setProblems(found.map((text) => ({ field: 'products', text, raw: text })));
    setError('');
    if (found.length > 0) {
      return false;
    }
    inFlight.current = true;
    setBusy(true);
    const answer = await api.request('POST', `/tenants/${tenantId}/products`, { products: next });
    inFlight.current = false;
    setBusy(false);
    if (answer.status === 200) {
      const digest = await productsDigest(next);
      kept.reload();
      savedAs.current.set(product.key, product.name);
      setSent({ digest, seq: poll.watch(), set: next });
      return true;
    }
    const detail = fieldOf(answer.body, 'detail');
    if (fieldOf(answer.body, 'error') === 'store_refused' && typeof detail === 'string') {
      setProblems(detail.split('\n').map((line) => problemText(line)));
      return false;
    }
    setError(explainAnswer(answer.body, answer.status));
    return false;
  };

  const openProduct = open === undefined ? undefined : draft.find((each) => each.key === open.key);
  const saveLabel = `Save ${changes} change${changes === 1 ? '' : 's'}`;
  const statusLines = (
    <>
      {refused && shownProblems.length === 0 ? (
        <p role="alert" className="text-13 text-error">
          Something failed on our side; we have been alerted.
        </p>
      ) : null}
      {error === '' ? null : (
        <p role="alert" className="text-13 text-error">
          {error}
        </p>
      )}
      {waiting ? (
        <p role="status" className="text-13 text-text-2">
          {poll.expired ? 'Still applying, we keep trying.' : 'Saving...'}
        </p>
      ) : null}
      {applied && changes === 0 ? (
        <p role="status" className="text-13 text-text-2">
          Saved.
        </p>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-16">
        <p className="text-13 text-text-3">
          {draft.length.toLocaleString('en-US')} of {status.usage.products.toLocaleString('en-US')}{' '}
          products on your plan.
        </p>
        <ProductsCallout />
        {draft.length === 0 ? (
          <div className="rounded-16 border-line flex flex-col items-start gap-12 border p-20">
            <p className="text-14 text-text-2">
              No products yet. Add the first thing you sell: a title and a price are enough.
            </p>
          </div>
        ) : (
          <ul aria-label="Products" className="border-line rounded-16 divide-line divide-y border">
            {draft.map((product) => {
              const label = labelOf(product);
              const issues = tried ? productIssues(product, draft, isKept(product)) : [];
              const said = refusedOf(product.name);
              const { fields } = product;
              const picture = fields === undefined ? undefined : shownImage(fields);
              return (
                <li
                  key={product.key}
                  data-product={product.name}
                  className="flex flex-col gap-8 px-16 py-12"
                >
                  <div className="flex flex-wrap items-center gap-12">
                    {picture === undefined ? null : (
                      <ProductPicture
                        src={picture}
                        className="rounded-8 border-line bg-bg size-40 flex-none border object-cover"
                      />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-15 truncate font-medium">{label}</span>
                      <span className="text-13 text-text-2">
                        {fields === undefined
                          ? 'Written by hand'
                          : `$${fields.priceUsd.trim() || '0'}`}
                      </span>
                    </div>
                    {fields === undefined ? null : (
                      <label className="text-13 text-text-2 flex items-center gap-6">
                        <input
                          type="checkbox"
                          checked={fields.onSale}
                          aria-label={`${label} on sale`}
                          onChange={(event) =>
                            update(product.key, {
                              ...product,
                              fields: { ...fields, onSale: event.target.checked },
                            })
                          }
                        />
                        On sale
                      </label>
                    )}
                    <Button
                      size="sm"
                      aria-label={`Edit ${label}`}
                      onClick={(event) => openSheet(product.key, product, event.currentTarget)}
                    >
                      Edit
                    </Button>
                  </div>
                  {issues.length === 0 ? null : (
                    <p className="text-13 text-error">Needs a fix: {issues.join(' ')}</p>
                  )}
                  <ProblemList problems={said} />
                </li>
              );
            })}
          </ul>
        )}
        <Button ref={addButton} onClick={add} className="self-start">
          Add product
        </Button>
        <ProblemList problems={pageProblems} />
        {statusLines}
        {changes === 0 ? null : (
          <div className="border-line bg-surface sticky bottom-0 flex items-center justify-between gap-12 border-t py-12">
            <span className="text-14">
              {changes} unsaved change{changes === 1 ? '' : 's'}
            </span>
            <Button variant="primary" disabled={busy || waiting} onClick={() => void save()}>
              {saveLabel}
            </Button>
          </div>
        )}
      </div>
      {openProduct === undefined || open === undefined ? null : (
        <ProductSheet
          title={
            openProduct.fields?.title.trim() ||
            (open.before === undefined ? 'New product' : openProduct.name)
          }
          changed={
            open.before === undefined
              ? draftText(openProduct) !== draftText(blankProduct(openProduct))
              : draftText(open.before) !== draftText(openProduct) ||
                open.before.name !== openProduct.name
          }
          onDiscard={discard}
          onClose={open.before === undefined ? discard : closeSheet}
          actions={
            <>
              {published && isKept(openProduct) ? (
                <span className="text-12 text-text-3">
                  Published: take it off sale to stop selling.
                </span>
              ) : (
                <Button size="sm" onClick={() => remove(openProduct.key)}>
                  Remove {openProduct.name || 'this product'}
                </Button>
              )}
              <div className="flex flex-col items-end gap-6">
                <ProblemList problems={pageProblems} />
                {statusLines}
                <Button
                  variant="primary"
                  disabled={busy || waiting}
                  onClick={() => {
                    void saveOne(openProduct).then((taken) => {
                      if (taken) {
                        closeSheet();
                      }
                    });
                  }}
                >
                  Save product
                </Button>
              </div>
            </>
          }
        >
          <ProductEditor
            product={openProduct}
            nameEditable={!isKept(openProduct)}
            nameTaken={!isKept(openProduct) && takenBy(openProduct).has(openProduct.name)}
            refused={refusedOf(openProduct.name)}
            onChange={(next) => update(openProduct.key, next)}
          />
        </ProductSheet>
      )}
    </div>
  );
}
