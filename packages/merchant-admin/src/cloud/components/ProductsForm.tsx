import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import {
  MAX_PRODUCT_BYTES,
  type ProductDraft,
  changedCount,
  draftOf,
  draftSet,
  draftText,
  fieldProblems,
  freeSlug,
  productBytes,
} from '../lib/product-form';
import { saveVerdict } from '../lib/save-wait';
import { PRODUCT_NAME_RE } from '../lib/snippet';
import { productsDigest } from '../lib/status';
import type { StoreStatus } from '../lib/status';
import type { KeptStore } from '../lib/use-kept-store';
import type { StoreStatusPoll } from '../lib/use-status';
import { ProductEditor } from './ProductEditor';

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

/**
 * The store's products as a form: edits collect in a draft and one save sends
 * the whole set (one change for the store). The save waits until the store
 * keeps that set (by its digest, never by a cycle id).
 */
export function ProductsForm({ api, tenantId, kept, status, poll, published, onSettled }: Props) {
  const { read } = kept;
  const [draft, setDraft] = useState<ProductDraft[] | undefined>(undefined);
  // The set the draft started from (or was last saved as): what "changes" count against.
  const [start, setStart] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [sent, setSent] = useState<{ digest: string; seq: number; set: Record<string, string> }>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const nextKey = useRef(0);

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

  const update = (key: string, next: ProductDraft) => {
    setDraft(
      draft.map((product) => {
        if (product.key !== key) {
          return product;
        }
        // A new product's id follows its title until the merchant types one.
        if (!next.nameTouched && next.fields !== undefined && !keptNames.has(product.name)) {
          const taken = new Set(
            draft.filter((other) => other.key !== key).map((other) => other.name),
          );
          return { ...next, name: freeSlug(next.fields.title, taken) };
        }
        return next;
      }),
    );
  };

  const add = () => {
    nextKey.current += 1;
    const taken = new Set(draft.map((product) => product.name));
    setDraft([
      ...draft,
      {
        key: `new-${nextKey.current}`,
        name: freeSlug('', taken),
        nameTouched: false,
        fields: { title: '', priceUsd: '', summary: '', description: '', onSale: true },
        text: '',
      },
    ]);
  };

  const save = async () => {
    if (inFlight.current) {
      return;
    }
    const found: string[] = [];
    const names = new Set<string>();
    for (const product of draft) {
      const label = product.fields?.title.trim() || product.name;
      if (!PRODUCT_NAME_RE.test(product.name)) {
        found.push(`${label}: its id is lowercase letters, digits and dashes.`);
      } else if (names.has(product.name)) {
        found.push(`${label}: another product has the id ${product.name}.`);
      }
      names.add(product.name);
      if (product.fields !== undefined) {
        found.push(...fieldProblems(product.fields).map((problem) => `${label}: ${problem}`));
      }
      if (productBytes(draftText(product)) > MAX_PRODUCT_BYTES) {
        found.push(`${label}: too long (shorten its description).`);
      }
    }
    if (draft.length === 0) {
      found.push('A store sells at least one product.');
    }
    if (published) {
      for (const name of keptNames) {
        if (set[name] === undefined) {
          found.push(`${name} is published: take it off sale instead of removing it.`);
        }
      }
    }
    if (draft.length > status.usage.products && draft.length > keptNames.size) {
      found.push(`Your plan takes ${status.usage.products.toLocaleString('en-US')} products.`);
    }
    setProblems(found);
    setError('');
    if (found.length > 0) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const answer = await api.request('POST', `/tenants/${tenantId}/products`, { products: set });
    inFlight.current = false;
    setBusy(false);
    if (answer.status === 200) {
      const digest = await productsDigest(set);
      kept.reload();
      setSent({ digest, seq: poll.watch(), set });
      return;
    }
    const detail = fieldOf(answer.body, 'detail');
    if (fieldOf(answer.body, 'error') === 'store_refused' && typeof detail === 'string') {
      setProblems(detail.split('\n'));
      return;
    }
    setError(explainAnswer(answer.body, answer.status));
  };

  const shownProblems =
    refused && problems.length === 0 ? (status.lastProblems.products ?? []) : problems;
  return (
    <div className="flex flex-col gap-16">
      <p className="text-13 text-text-3">
        {draft.length.toLocaleString('en-US')} of {status.usage.products.toLocaleString('en-US')}{' '}
        products on your plan.
      </p>
      {draft.length === 0 ? <p className="text-14 text-text-2">No products yet.</p> : null}
      {draft.map((product) => (
        <ProductEditor
          key={product.key}
          product={product}
          nameEditable={!keptNames.has(product.name)}
          published={published && keptNames.has(product.name)}
          onChange={(next) => update(product.key, next)}
          onRemove={
            published && keptNames.has(product.name)
              ? undefined
              : () => setDraft(draft.filter((other) => other.key !== product.key))
          }
        />
      ))}
      <Button onClick={add} className="self-start">
        Add a product
      </Button>
      {shownProblems.length === 0 ? null : (
        <ul role="alert" className="text-13 text-error list-disc pl-20">
          {shownProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
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
      {changes === 0 ? null : (
        <div className="border-line bg-surface sticky bottom-0 flex items-center justify-between gap-12 border-t py-12">
          <span className="text-14">
            {changes} unsaved change{changes === 1 ? '' : 's'}
          </span>
          <Button variant="primary" disabled={busy || waiting} onClick={() => void save()}>
            Save {changes} change{changes === 1 ? '' : 's'}
          </Button>
        </div>
      )}
    </div>
  );
}
