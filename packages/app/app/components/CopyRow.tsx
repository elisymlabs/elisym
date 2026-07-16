import { cn } from '~/lib/cn';

interface Props {
  label: string;
  display: string;
  icon: React.ReactNode;
  copied: boolean;
  onCopy: () => void;
}

export function truncateMiddle(value: string, prefix = 4, suffix = 4) {
  if (value.length <= prefix + suffix + 1) {
    return value;
  }
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`;
}

export function CopyRow({ label, display, icon, copied, onCopy }: Props) {
  return (
    <button
      type="button"
      onClick={onCopy}
      title={`Copy ${label.toLowerCase()}`}
      className="group flex w-full min-w-0 items-center gap-12 border-0 bg-transparent px-20 py-14 text-left transition-colors hover:bg-black/[0.025]"
    >
      <span className="flex shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-text-2/80 uppercase">
          {label}
        </span>
        <span className="mt-2 truncate font-mono text-[13px] font-medium text-text">{display}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'flex size-28 shrink-0 items-center justify-center rounded-full transition-all',
          copied
            ? 'bg-green/10 text-green'
            : 'text-text-2/60 group-hover:bg-black/5 group-hover:text-text',
        )}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      className="size-14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2.5" ry="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="size-14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
