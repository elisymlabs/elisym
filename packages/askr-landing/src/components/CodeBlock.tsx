import { CopyButton } from './CopyButton';

interface Props {
  id: string;
  label: string;
  code: string;
}

/** A labeled block of code the merchant copies as it is. */
export function CodeBlock({ id, label, code }: Props) {
  return (
    <figure className="rounded-16 border-line-2 bg-surface min-w-0 overflow-hidden border">
      <figcaption className="border-line flex items-center justify-between gap-12 border-b py-8 pr-8 pl-16">
        <span className="text-13 text-text-2 font-medium">{label}</span>
        <CopyButton text={code} />
      </figcaption>
      <pre id={id} className="text-13 text-text-2 overflow-x-auto p-16 font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
