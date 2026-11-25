// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { WidgetView } from '../src/ui/element';

function view(): WidgetView {
  return new WidgetView(
    document,
    () => undefined,
    () => undefined,
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('entrances play once', () => {
  it('a turn already in the log is not put in again on the next update', async () => {
    const widget = view();
    document.body.append(widget.panel);
    const log = widget.panel.querySelector('.log');
    if (!log) {
      throw new Error('no log');
    }
    const turns = [{ askId: 'a1', askedAt: 0, text: 'Tents?' }];
    widget.update({ phase: 'waiting', branding: true, notes: [], inFlightAskId: 'a1', turns });
    const added: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        added.push(...record.addedNodes);
      }
    });
    observer.observe(log, { childList: true });
    widget.update({ phase: 'waiting', branding: true, notes: [], inFlightAskId: 'a1', turns });
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    expect(added).toHaveLength(0);
  });

  it('the status line is left alone while it says the same', () => {
    const widget = view();
    const turns = [{ askId: 'a1', askedAt: 0, text: 'Tents?', status: 'Looking' }];
    widget.update({ phase: 'waiting', branding: true, notes: [], inFlightAskId: 'a1', turns });
    const first = widget.panel.querySelector('.status span');
    widget.update({ phase: 'waiting', branding: true, notes: [], inFlightAskId: 'a1', turns });
    expect(widget.panel.querySelector('.status span')).toBe(first);
    widget.update({
      phase: 'waiting',
      branding: true,
      notes: [],
      inFlightAskId: 'a1',
      turns: [{ ...turns[0], askId: 'a1', askedAt: 0, text: 'Tents?', status: 'Comparing' }],
    });
    expect(widget.panel.querySelector('.status span')).not.toBe(first);
  });
});
