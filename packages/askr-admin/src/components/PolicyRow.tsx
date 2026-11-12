import type { Policy } from '@elisym/askr';
import { useState } from 'react';

interface Props {
  policy: Policy;
  editable: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}

/** One policy; deleting asks first. */
export function PolicyRow({ policy, editable, busy, onEdit, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  let actions = null;
  if (editable && confirming) {
    actions = (
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-13 text-error">Delete it for visitors too?</span>
        <button
          type="button"
          className="btn btn-danger text-13"
          disabled={busy}
          aria-label={`Delete ${policy.title} for good`}
          onClick={() => {
            setConfirming(false);
            void onDelete();
          }}
        >
          Delete for good
        </button>
        <button type="button" className="btn text-13" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
    );
  } else if (editable) {
    actions = (
      <div className="flex gap-4">
        <button
          type="button"
          className="btn text-13"
          disabled={busy}
          aria-label={`Edit ${policy.title}`}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn-danger text-13"
          disabled={busy}
          aria-label={`Delete ${policy.title}`}
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      </div>
    );
  }
  return (
    <li className="border-line rounded-10 flex flex-wrap items-center justify-between gap-8 border p-12">
      <div className="flex min-w-0 flex-col">
        <span className="text-14 font-medium">{policy.title}</span>
        <span className="text-12 text-text-3 font-mono">{policy.slug}</span>
      </div>
      {actions}
    </li>
  );
}
