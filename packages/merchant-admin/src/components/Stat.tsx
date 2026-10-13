interface Props {
  label: string;
  value: string;
  hint?: string;
  title?: string;
  tone?: 'plain' | 'accent' | 'warn';
}

const TONES = {
  plain: 'border-line bg-surface',
  accent: 'border-accent-ink/30 bg-accent-soft',
  warn: 'border-warn/30 bg-warn-bg',
};

export function Stat({ label, value, hint, title, tone = 'plain' }: Props) {
  return (
    <div className={`rounded-16 min-w-0 border p-16 ${TONES[tone]}`} title={title}>
      <p className="text-13 text-text-2 truncate">{label}</p>
      <p className="text-24 mt-6 truncate font-semibold tracking-tight">{value}</p>
      {hint !== undefined && (
        <p className={`text-12 mt-2 truncate ${tone === 'plain' ? 'text-text-3' : 'text-text-2'}`}>
          {hint}
        </p>
      )}
    </div>
  );
}
