import type { PreviewScenario } from './mock-server';

const LABELS: Readonly<Record<keyof PreviewScenario, string>> = {
  ownerManages: 'Owner manages the store',
  replaceNextFinish: 'Next setup gets replaced',
  suspended: 'Store paused',
};

interface Props {
  scenario: PreviewScenario;
  page: 'app' | 'standalone';
  onChange: (next: PreviewScenario) => void;
  onPage: (page: 'app' | 'standalone') => void;
  onReset: () => void;
}

/** The preview's control bar: scenarios the fake server plays, never shown in Shopify. */
export function PreviewBar({ scenario, page, onChange, onPage, onReset }: Props) {
  const toggle = (field: keyof PreviewScenario) => (
    <label className="text-13 flex items-center gap-6">
      <input
        type="checkbox"
        checked={scenario[field]}
        onChange={(event) => onChange({ ...scenario, [field]: event.target.checked })}
      />
      {LABELS[field]}
    </label>
  );
  return (
    <div className="bg-surface-2 border-line flex flex-wrap items-center gap-16 border-b px-24 py-10">
      <strong className="text-13">Local preview (fake server, no Shopify)</strong>
      {toggle('ownerManages')}
      {toggle('replaceNextFinish')}
      {toggle('suspended')}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>
        Start over
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onPage(page === 'app' ? 'standalone' : 'app')}
      >
        {page === 'app' ? 'Show the standalone admin' : 'Back to the Shopify app'}
      </button>
    </div>
  );
}
