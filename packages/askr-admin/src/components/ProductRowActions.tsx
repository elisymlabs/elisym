import type { CatalogItemInput } from '@elisym/askr';
import { useState } from 'react';

/** A write about one product row, as the queue holds it. */
export type RowStatus =
  | { kind: 'pending'; text: string; onCancel?: () => void }
  | { kind: 'failed'; message: string; onRetry: () => void; onDismiss: () => void }
  | { kind: 'unknown'; onDismiss: () => void };

interface Props {
  item: CatalogItemInput;
  status: RowStatus | undefined;
  /** Edit and Remove are off: another action holds the list. */
  locked: boolean;
  /** Edit alone is off: the open editor's save is on its way. */
  editLocked?: boolean;
  onEdit: (d: string) => void;
  onRemove: (d: string) => void;
}

/** A row's Edit and Remove, Remove asking first; a write on its way or its failure instead. */
export function ProductRowActions({
  item,
  status,
  locked,
  editLocked = false,
  onEdit,
  onRemove,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  if (status?.kind === 'pending') {
    return (
      <span className="text-13 text-text-2 inline-flex items-center gap-8" role="status">
        {status.text}
        {status.onCancel === undefined ? null : (
          <button
            type="button"
            className="btn btn-sm"
            aria-label={`Cancel the change to ${item.title}`}
            onClick={status.onCancel}
          >
            Cancel
          </button>
        )}
      </span>
    );
  }
  if (status?.kind === 'failed') {
    return (
      <span
        className="text-13 text-error inline-flex flex-wrap items-center justify-end gap-8 whitespace-normal"
        role="alert"
      >
        {status.message}
        <button type="button" className="btn btn-sm" disabled={locked} onClick={status.onRetry}>
          Retry
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={status.onDismiss}>
          Dismiss
        </button>
      </span>
    );
  }
  if (status?.kind === 'unknown') {
    return (
      <span className="text-13 text-text-2 inline-flex items-center gap-8" role="status">
        Sent; press Refresh to check.
        <button type="button" className="btn btn-ghost btn-sm" onClick={status.onDismiss}>
          Dismiss
        </button>
      </span>
    );
  }
  if (confirming) {
    return (
      <span className="text-13 text-error inline-flex flex-wrap items-center justify-end gap-4 whitespace-normal">
        Remove {item.title}? It disappears from the chat.
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={locked}
          aria-label={`Remove ${item.title} for good`}
          onClick={() => {
            setConfirming(false);
            onRemove(item.d);
          }}
        >
          Remove
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
          Keep
        </button>
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={locked || editLocked}
        aria-label={`Edit ${item.title}`}
        onClick={() => onEdit(item.d)}
      >
        Edit
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-danger btn-sm"
        disabled={locked}
        aria-label={`Remove ${item.title}`}
        onClick={() => setConfirming(true)}
      >
        Remove
      </button>
    </>
  );
}
