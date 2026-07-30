import { cn } from '~/lib/cn';

interface Props {
  status: string;
}

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-feedback-positive-bg text-feedback-positive',
  error: 'bg-feedback-negative-bg text-feedback-negative',
  pending: 'bg-surface-2 text-text-2',
  'payment-completed': 'bg-surface-2 text-text-2',
  submitted: 'bg-surface-2 text-text-2',
};

const STATUS_LABELS: Record<string, string> = {
  completed: 'Completed',
  error: 'Failed',
  pending: 'In progress',
  'payment-completed': 'Paid',
  submitted: 'Submitted',
};

export function JobStatusChip({ status }: Props) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-8 px-8 py-2 text-[10px] font-semibold',
        STATUS_STYLES[status] ?? 'bg-surface-2 text-text-2',
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
