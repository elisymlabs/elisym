// @vitest-environment happy-dom
import { render, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoWallet } from '../src/app/ui/NoWallet';
import { WalletPicker } from '../src/app/ui/WalletPicker';

const roots: HTMLDivElement[] = [];
function mount(children: ComponentChildren) {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  act(() => render(children, root));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => render(null, root));
    root.remove();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function click(root: HTMLElement, selector: string) {
  act(() => root.querySelector<HTMLElement>(selector)!.click());
}
function key(root: HTMLElement, selector: string, value: string, type = 'keydown') {
  act(() => {
    root
      .querySelector(selector)!
      .dispatchEvent(new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true }));
  });
}

describe('wallet dropdown and explicit payment', () => {
  it('keeps an inert panel during closing and ignores its options until removed', () => {
    vi.useFakeTimers();
    const paid = vi.fn();
    const root = mount(
      <WalletPicker wallets={[{ name: 'One' }, { name: 'Two' }]} disabled={false} onPay={paid} />,
    );
    click(root, '.wallet-select');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(root.querySelector('.wallet-popover')?.hasAttribute('data-open')).toBe(true);
    click(root, '.wallet-select');
    const panel = root.querySelector('.wallet-popover');
    expect(panel?.hasAttribute('inert')).toBe(true);
    expect(panel?.hasAttribute('data-open')).toBe(false);
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    click(root, '.wallet-option:last-child');
    expect(root.querySelector('.select-value')?.textContent).toBe('Select wallet');
    expect(paid).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(root.querySelector('.wallet-popover')).toBeNull();
  });
  it('reverses a close when reopened without a stale timer removing the list', () => {
    vi.useFakeTimers();
    const root = mount(
      <WalletPicker
        wallets={[{ name: 'One' }, { name: 'Two' }]}
        disabled={false}
        onPay={() => {}}
      />,
    );
    click(root, '.wallet-select');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    click(root, '.wallet-select');
    act(() => {
      vi.advanceTimersByTime(80);
    });
    click(root, '.wallet-select');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(root.querySelector('[role="listbox"]')).not.toBeNull();
    expect(root.querySelector('.wallet-popover')?.hasAttribute('data-open')).toBe(true);
    expect(root.querySelector('.wallet-popover')?.hasAttribute('inert')).toBe(false);
  });
  it('closes immediately when reduced motion is requested', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const root = mount(
      <WalletPicker wallets={[{ name: 'One' }]} disabled={false} onPay={() => {}} />,
    );
    click(root, '.wallet-select');
    expect(root.querySelector('.wallet-popover')?.hasAttribute('data-open')).toBe(true);
    click(root, '.wallet-select');
    expect(root.querySelector('.wallet-popover')).toBeNull();
  });
  it('selects without payment, then pays only the chosen wallet', () => {
    const paid: string[] = [];
    const root = mount(
      <WalletPicker
        wallets={[{ name: 'Phantom' }, { name: 'Solflare' }]}
        disabled={false}
        onPay={(name) => paid.push(name)}
      />,
    );
    expect(root.querySelector<HTMLButtonElement>('.wallet-pay')?.disabled).toBe(true);
    click(root, '.wallet-select');
    click(root, '[role="option"]:last-child');
    expect(paid).toEqual([]);
    expect(root.querySelector('.wallet-select .select-value')?.textContent).toBe('Solflare');
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    click(root, '.wallet-pay');
    expect(paid).toEqual(['Solflare']);
  });
  it('searches forty wallets without losing the chosen action', () => {
    const paid: string[] = [];
    const root = mount(
      <WalletPicker
        wallets={Array.from({ length: 40 }, (_, i) => ({ name: 'Wallet ' + (i + 1) }))}
        disabled={false}
        onPay={(name) => paid.push(name)}
      />,
    );
    click(root, '.wallet-select');
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(40);
    const search = root.querySelector<HTMLInputElement>('.wallet-search')!;
    act(() => {
      search.value = 'Wallet 40';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(1);
    click(root, '[role="option"]');
    expect(paid).toEqual([]);
    click(root, '.wallet-pay');
    expect(paid).toEqual(['Wallet 40']);
  });
  it('supports keyboard navigation, Escape and selection without auto-paying', () => {
    const paid: string[] = [];
    const root = mount(
      <WalletPicker
        wallets={[{ name: 'One' }, { name: 'Two' }]}
        disabled={false}
        onPay={(name) => paid.push(name)}
      />,
    );
    key(root, '.wallet-select', 'ArrowDown');
    key(root, '[role="listbox"]', 'End');
    key(root, '[role="listbox"]', ' ');
    key(root, '[role="listbox"]', ' ', 'keyup');
    expect(root.querySelector('.wallet-select .select-value')?.textContent).toBe('Two');
    expect(paid).toEqual([]);
    click(root, '.wallet-select');
    key(root, '[role="listbox"]', 'Escape');
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('.wallet-select'));
  });
  it('locks both selection and Pay while a request runs', () => {
    const paid: string[] = [];
    const root = mount(
      <WalletPicker wallets={[{ name: 'One' }]} disabled onPay={(name) => paid.push(name)} />,
    );
    click(root, '.wallet-select');
    click(root, '.wallet-pay');
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    expect(paid).toEqual([]);
  });
  it('cannot pay through a wallet removed by discovery', () => {
    const paid: string[] = [];
    const root = mount(
      <WalletPicker
        wallets={[{ name: 'One' }]}
        disabled={false}
        onPay={(name) => paid.push(name)}
      />,
    );
    act(() =>
      render(
        <WalletPicker
          wallets={[{ name: 'Two' }]}
          disabled={false}
          onPay={(name) => paid.push(name)}
        />,
        root,
      ),
    );
    expect(root.querySelector<HTMLButtonElement>('.wallet-pay')?.disabled).toBe(true);
    click(root, '.wallet-pay');
    expect(paid).toEqual([]);
  });
  it('shows centered installation actions with bundled logos and no reload instruction', () => {
    const root = mount(<NoWallet chain="solana" phone={false} />);
    expect(root.querySelectorAll('.no-wallet .install a.secondary img')).toHaveLength(2);
    expect([...root.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Phantom',
      'Solflare',
    ]);
    expect(root.textContent).not.toContain('Reload');
    for (const image of root.querySelectorAll('img')) {
      expect(image.src).toMatch(/^data:image\/svg\+xml;base64,/);
    }
  });
});
