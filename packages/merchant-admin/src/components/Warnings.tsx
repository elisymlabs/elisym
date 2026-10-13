interface Props {
  texts: readonly string[];
}

export function Warnings({ texts }: Props) {
  if (texts.length === 0) {
    return null;
  }
  return (
    <ul id="warnings" className="rounded-12 bg-warn-bg text-14 text-warn flex flex-col gap-6 p-14">
      {texts.map((text) => (
        <li key={text}>{text}</li>
      ))}
    </ul>
  );
}
