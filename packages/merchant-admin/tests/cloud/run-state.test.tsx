import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunStateLine } from '../../src/cloud/components/RunStateLine';

describe('the store state line', () => {
  it('says the state, and offers Check again only once the poll ran out', () => {
    const live = renderToStaticMarkup(<RunStateLine runState="live" onCheckAgain={undefined} />);
    expect(live).toContain('Live');
    expect(live).not.toContain('Check again');
    const stale = renderToStaticMarkup(
      <RunStateLine runState="starting" onCheckAgain={() => undefined} />,
    );
    expect(stale).toContain('Starting');
    expect(stale).toContain('Check again');
  });
});
