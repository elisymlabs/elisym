import { Button } from '../../components/Button';

interface Props {
  /** What confirming does, said once more. */
  consequence: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A step asked once more before it is sent: what it does, then Confirm or Cancel. */
export function ConfirmStep({ consequence, confirmLabel, busy, onConfirm, onCancel }: Props) {
  return (
    <div className="rounded-12 bg-surface-2 mt-12 flex flex-col gap-8 p-12">
      <p className="text-14">{consequence}</p>
      <div className="flex gap-8">
        <Button disabled={busy} onClick={onConfirm} variant="primary">
          {confirmLabel}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
