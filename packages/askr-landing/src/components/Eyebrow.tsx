interface Props {
  children: string;
  tone?: 'paper' | 'ink';
}

export function Eyebrow({ children, tone = 'paper' }: Props) {
  const color = tone === 'ink' ? 'text-on-ink-accent' : 'text-accent-ink';
  return (
    <p
      className={`text-12 flex items-center gap-8 font-semibold tracking-[0.14em] uppercase ${color}`}
    >
      <span className="h-px w-24 bg-current" />
      {children}
    </p>
  );
}
