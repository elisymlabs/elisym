import { CopyButton } from '../../components/CopyButton';

interface Props {
  id: string;
  label: string;
  text: string;
}

/** Several lines to paste as they are, with a copy button. */
export function CodeBlock({ id, label, text }: Props) {
  return (
    <div className="flex flex-col gap-6">
      <span className="text-13 text-text-2 font-medium">{label}</span>
      <div className="rounded-10 border-line-2 bg-bg flex items-start gap-8 border px-12 py-10">
        <pre id={id} className="text-13 min-w-0 flex-1 font-mono break-all whitespace-pre-wrap">
          {text}
        </pre>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}
