/** Designer gallery of real components with simulated data. Never sends a payment. */
import '../../src/app/styles.css';
import './review.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Checkout, type Actions } from '../../src/app/Checkout';
import { cannedSource, type CannedView } from './canned';
import { reviewFixture } from './review-data';
import { REVIEW_GROUPS, REVIEW_RESULT_SECTIONS, entriesForGroup, initialReviewEntry, type ReviewEntry, type ReviewGroup } from './review-catalog';

const params = new URLSearchParams(location.search);
const initial = initialReviewEntry(params);
document.documentElement.dataset.capture = String(params.get('capture') === '1');
document.documentElement.dataset.preview = 'true';
document.documentElement.dataset.display = 'modal';

function ReviewedCheckout({ canned, actions, reset }: { canned: CannedView; actions: Actions; reset(): void }) {
  const [view, setView] = useState(canned.view);
  useEffect(() => { setView(canned.next ?? canned.view); }, [canned]);
  return (
    <Checkout
      screen={{ kind: 'loading' }}
      view={view}
      actions={actions}
      onClose={reset}
      {...canned.props}
      hintAfterMs={canned.props?.hintAfterMs ?? 3_600_000}
      unansweredHintMs={canned.props?.unansweredHintMs ?? (canned.name.includes('unanswered') ? 0 : 3_600_000)}
      purchases={canned.props?.purchases ?? cannedSource([])}
    />
  );
}

function Review() {
  const [selected, setSelected] = useState<ReviewEntry>(initial);
  const [theme, setTheme] = useState(params.get('theme') === 'dark' ? 'dark' : 'light');
  const [playing, setPlaying] = useState(false);
  const run = useRef(0);
  const remembered = useRef<Partial<Record<ReviewGroup, ReviewEntry>>>({ [initial.group]: initial });
  document.documentElement.dataset.theme = theme;
  const group = REVIEW_GROUPS.find((group) => group.id === selected.group)!;
  const groupEntries = entriesForGroup(selected.group);
  const entries = selected.group === 'results' ? groupEntries.filter((entry) => entry.section === selected.section) : groupEntries;
  const position = entries.findIndex((entry) => entry.id === selected.id);
  const sections = [...new Set(entries.map((entry) => entry.section))];
  const canned = useMemo(() => reviewFixture(selected.fixture), [selected.id]);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.delete('screen');
    url.searchParams.delete('font');
    url.searchParams.set('state', selected.id);
    url.searchParams.set('theme', theme);
    history.replaceState(null, '', url);
  }, [selected.id, theme]);
  useEffect(() => () => { run.current++; }, []);

  const choose = (entry: ReviewEntry) => {
    run.current++;
    setPlaying(false);
    remembered.current[entry.group] = entry;
    setSelected(entry);
  };
  const chooseGroup = (group: ReviewGroup) => choose(remembered.current[group] ?? entriesForGroup(group)[0]!);
  const reset = async () => choose(entriesForGroup('flow')[0]!);
  const actions: Actions = {
    choosePayout: () => {}, setEmail: () => {}, pay: reset, retry: reset,
    signAgain: reset, resend: reset, startOver: reset, cancel: reset,
    checkInWallet: reset, confirmOldPrompt: reset, cancelOldPrompt: () => {},
  };
  const play = async () => {
    if (playing) { run.current++; setPlaying(false); return; }
    const token = ++run.current;
    setPlaying(true);
    for (const entry of entriesForGroup('flow').slice(1)) {
      if (run.current !== token) {return;}
      setSelected(entry);
      remembered.current.flow = entry;
      await new Promise((resolve) => setTimeout(resolve, 2400));
    }
    if (run.current === token) {setPlaying(false);}
  };
  const progress = selected.group === 'flow' && canned.view !== undefined &&
    ['working', 'waiting_payment', 'waiting_store'].includes(canned.view.kind);
  return (
    <>
      <header class="review-header">
        <div><h1>Галерея виджета</h1><p>Демонстрационные данные · платежи не отправляются</p></div>
        <div class="review-theme" role="group" aria-label="Тема">
          <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>Light</button>
          <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </header>
      <nav class="review-groups" aria-label="Группы экранов">
        {REVIEW_GROUPS.map((group) => <button type="button" key={group.id} aria-pressed={selected.group === group.id} onClick={() => chooseGroup(group.id)}>{group.label}</button>)}
      </nav>
      <div class="review-navigation">
        <p class="review-group-description">{group.description}</p>
        {selected.group === 'results' ? (
          <nav class="review-result-sections" aria-label="Тип ошибки">
            {REVIEW_RESULT_SECTIONS.map((section) => <button type="button" key={section} aria-pressed={selected.section === section} onClick={() => choose(groupEntries.find((entry) => entry.section === section)!)}>{section}</button>)}
          </nav>
        ) : null}
        <div class="review-picker">
          <button type="button" class="review-arrow" aria-label="Предыдущий экран" disabled={position === 0} onClick={() => choose(entries[position - 1]!)}>←</button>
          <label class="review-select-label"><span class="visually-hidden">Экран</span>
            <select aria-label="Экран" value={selected.id} onChange={(event) => choose(entries.find((entry) => entry.id === event.currentTarget.value)!)}>
              {selected.group === 'extra' ? sections.map((section) => <optgroup key={section} label={section}>{entries.filter((entry) => entry.section === section).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</optgroup>) : entries.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {entry.label}</option>)}
            </select>
          </label>
          <button type="button" class="review-arrow" aria-label="Следующий экран" disabled={position === entries.length - 1} onClick={() => choose(entries[position + 1]!)}>→</button>
          <span class="review-count">{position + 1} / {entries.length}</span>
        </div>
        <p class="review-explanation" aria-live="polite">{selected.description}</p>
        {selected.group === 'flow' ? <button type="button" class="review-play" onClick={() => void play()}>{playing ? 'Остановить просмотр' : 'Посмотреть путь оплаты'}</button> : null}
      </div>
      <main class="review-window" aria-label="Предпросмотр виджета">
        <div class="review-chrome"><span aria-hidden="true">×</span></div>
        <ReviewedCheckout key={progress ? 'progress' : selected.id} canned={canned} actions={actions} reset={() => void reset()} />
      </main>
    </>
  );
}
render(<Review />, document.getElementById('app')!);
