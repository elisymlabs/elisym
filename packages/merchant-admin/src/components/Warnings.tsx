import { Icon } from './Icon';

interface Props {
  texts: readonly string[];
}

export function Warnings({ texts }: Props) {
  if (texts.length === 0) {
    return null;
  }
  return (
    <div className="rounded-16 border-warn/30 bg-warn-bg text-warn flex gap-12 border p-16">
      <Icon name="alert" className="mt-1 size-18 shrink-0" />
      <ul id="warnings" className="text-14 flex flex-col gap-6">
        {texts.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  );
}
