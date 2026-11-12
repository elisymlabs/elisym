import { type Policy, PolicyInputSchema } from '@elisym/askr';
import { useState } from 'react';
import { errorMessage } from '../lib/errors';
import { Notice } from './Notice';
import { TextAreaField } from './TextAreaField';
import { TextField } from './TextField';

interface Props {
  /** The policy being edited, or undefined for a new one. */
  initial: Policy | undefined;
  /** Slugs already published: a new policy needs its own, or it would replace one. */
  takenSlugs: readonly string[];
  onSave: (policy: { slug: string; title: string; body: string }) => Promise<void>;
  onCancel: () => void;
}

export function PolicyEditor({ initial, takenSlugs, onSave, onCancel }: Props) {
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const checked = PolicyInputSchema.safeParse({ slug: slug.trim(), title: title.trim(), body });
    if (!checked.success) {
      setError(
        checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
      return;
    }
    if (initial === undefined && takenSlugs.includes(checked.data.slug)) {
      setError(
        `Short name: a policy named "${checked.data.slug}" already exists. Edit that one, or pick another name.`,
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave({ slug: checked.data.slug, title: checked.data.title, body: checked.data.body });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-line rounded-12 flex flex-col gap-12 border p-16">
      <TextField
        id="policy-slug"
        label="Short name"
        value={slug}
        readOnly={initial !== undefined}
        hint={
          initial === undefined
            ? 'Lowercase letters, digits and hyphens, like returns or shipping'
            : 'The short name cannot change.'
        }
        onChange={(value) => {
          if (initial === undefined) {
            setSlug(value);
          }
        }}
      />
      <TextField id="policy-title" label="Title" value={title} onChange={setTitle} />
      <TextAreaField id="policy-body" label="Text" rows={8} value={body} onChange={setBody} />
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      <div className="flex gap-8">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Publishing...' : 'Publish'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
