import type { Policy } from '@elisym/askr';
import { useState } from 'react';

interface Props {
  policy: Policy;
  editable: boolean;
  /** Imported by the Shopify connector, which puts the shop's version back on each sync. */
  imported: boolean;
  /** Past the cap: the assistant does not read it. */
  unread: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}

/** One policy; deleting asks first. */
export function PolicyRow({ policy, editable, imported, unread, busy, onEdit, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  /** Shown in full; folded, the text shows its first two lines. */
  const [open, setOpen] = useState(false);
  let actions = null;
  if (editable && confirming) {
    actions = (
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-13 text-error">Delete it for visitors too?</span>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={busy}
          aria-label={`Delete ${policy.title} for good`}
          onClick={() => {
            setConfirming(false);
            void onDelete();
          }}
        >
          Delete for good
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
    );
  } else if (editable) {
    actions = (
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          aria-label={`Edit ${policy.title}`}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-danger btn-sm"
          disabled={busy}
          aria-label={`Delete ${policy.title}`}
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      </div>
    );
  }
  const bodyId = `policy-body-${policy.slug}`;
  return (
    <li className="flex flex-col gap-6 px-20 py-14">
      <div className="flex flex-wrap items-start justify-between gap-8">
        <button
          type="button"
          className="group flex min-w-0 flex-1 cursor-pointer items-start gap-10 text-left"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((shown) => !shown)}
        >
          <svg
            viewBox="0 0 16 16"
            className={`text-text-3 group-hover:text-text mt-3 size-14 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="m6 4 4 4-4 4" />
          </svg>
          <span className="flex min-w-0 flex-col">
            <span className="text-14 font-medium">{policy.title}</span>
            <span className="text-12 text-text-3">
              <span className="font-mono">{policy.slug}</span>
              {imported ? ' - from Shopify' : null}
              {unread ? ' - not read by the assistant' : null}
            </span>
          </span>
        </button>
        {actions}
      </div>
      <p
        id={bodyId}
        className={`text-13 text-text-2 pl-24 leading-relaxed whitespace-pre-line ${open ? '' : 'line-clamp-2'}`}
      >
        {policy.body}
      </p>
    </li>
  );
}
