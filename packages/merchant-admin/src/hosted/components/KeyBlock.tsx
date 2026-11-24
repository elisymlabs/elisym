import { CopyButton } from '../../components/CopyButton';

interface Props {
  label: string;
  text: string;
}

/** A key shown in full, with a copy button. */
export function KeyBlock({ label, text }: Props) {
  return (
    <div className="flex flex-col gap-6">
      <span className="text-13 text-text-2 font-medium">{label}</span>
      <div className="rounded-10 border-line-2 bg-bg flex items-start gap-8 border px-12 py-10">
        <code className="text-13 min-w-0 flex-1 font-mono break-all">{text}</code>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}
