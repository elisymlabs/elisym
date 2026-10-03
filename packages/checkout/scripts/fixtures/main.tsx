/** Dev only: every checkout state side by side, for the manual visual pass. */
import '../../src/app/styles.css';
import './fixtures.css';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { type Actions, Checkout } from '../../src/app/Checkout';
import { cannedViews } from './canned';

const WIDTHS = [420, 375];
const THEMES = ['auto', 'light', 'dark'] as const;

const NOTHING: Actions = {
  confirm: () => undefined,
  choosePayout: () => undefined,
  confirmOldPrompt: async () => undefined,
  cancelOldPrompt: () => undefined,
  setEmail: () => undefined,
  pay: async () => undefined,
  retry: async () => undefined,
  startOver: async () => undefined,
};

function Fixtures() {
  const [width, setWidth] = useState(420);
  const [theme, setTheme] = useState<(typeof THEMES)[number]>('auto');
  document.documentElement.dataset.theme = theme;
  return (
    <>
      <nav class="fixtures-bar">
        {WIDTHS.map((each) => (
          <button type="button" key={each} onClick={() => setWidth(each)}>
            {each}px
          </button>
        ))}
        {THEMES.map((each) => (
          <button type="button" key={each} onClick={() => setTheme(each)}>
            {each}
          </button>
        ))}
      </nav>
      <div class="fixtures">
        {cannedViews().map((canned) => (
          <figure key={canned.name} class={width === 375 ? 'narrow' : 'wide'}>
            <figcaption>{canned.name}</figcaption>
            <Checkout
              screen={{ kind: 'loading' }}
              view={canned.view}
              banner={
                canned.name === 'review'
                  ? {
                      orderId: 'x',
                      state: 'completed',
                      text: 'https://shop.example/a',
                      link: 'https://shop.example/a',
                    }
                  : undefined
              }
              actions={NOTHING}
            />
          </figure>
        ))}
      </div>
    </>
  );
}

const root = document.getElementById('app');
if (root !== null) {
  render(<Fixtures />, root);
}
