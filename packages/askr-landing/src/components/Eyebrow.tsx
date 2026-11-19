interface Props {
  children: string;
}

export function Eyebrow({ children }: Props) {
  return (
    <p className="text-12 text-accent-ink flex items-center gap-8 font-semibold tracking-[0.14em] uppercase">
      <span className="h-px w-24 bg-current" />
      {children}
    </p>
  );
}
