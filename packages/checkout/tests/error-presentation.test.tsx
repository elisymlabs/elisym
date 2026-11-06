import { USDC_SOLANA_DEVNET } from '@elisym/pay-core';
// @vitest-environment happy-dom
import { render, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { EndedStep } from '../src/app/ui/EndedStep';
import { ErrorIcon } from '../src/app/ui/ErrorIcon';
import { STOP_GLYPH } from '../src/app/ui/glyphs';
import { PaymentStageIcon } from '../src/app/ui/PaymentStageIcon';
import { ProblemNote } from '../src/app/ui/ProblemNote';
import { WalletSection } from '../src/app/ui/WalletSection';

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
});

describe('shared error presentation', () => {
  it('shows one actionable failed wallet and opens alternatives only when pressed', () => {
    const picked: string[] = [];
    const root = mount(
      <WalletSection
        wallets={[{ name: 'Browser wallet' }, { name: 'MetaMask' }]}
        problem={{ reason: 'tempo_unsupported', wallet: { name: 'Browser wallet' } }}
        asset={USDC_SOLANA_DEVNET}
        rail="tempo"
        phone={false}
        locked={false}
        onPay={(name) => picked.push(name)}
      />,
    );
    const failed = root.querySelector<HTMLButtonElement>('.wallet-select')!;
    expect(failed.textContent).toContain('Browser wallet');
    expect(failed.disabled).toBe(false);
    expect(failed.querySelector('.select-chevron')).not.toBeNull();
    expect(root.querySelectorAll('.wallet-select')).toHaveLength(1);
    expect(root.querySelector<HTMLButtonElement>('.wallet-pay')?.disabled).toBe(true);
    expect(root.textContent).not.toContain('MetaMask');
    expect(root.querySelector('.error-message')).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      'Selected wallet is not supported. Choose another one.',
    );
    act(() => failed.click());
    expect(failed.getAttribute('aria-expanded')).toBe('true');
    expect(picked).toEqual([]);
    const alternative = root.querySelector<HTMLElement>('[role="option"]')!;
    expect(alternative.textContent).toContain('MetaMask');
    act(() => alternative.click());
    expect(picked).toEqual([]);
    act(() => root.querySelector<HTMLButtonElement>('.wallet-pay')!.click());
    expect(picked).toEqual(['MetaMask']);
  });
  it('retains the failed wallet if it disappears from discovery without blaming the alternative', () => {
    const root = mount(
      <WalletSection
        wallets={[{ name: 'MetaMask' }]}
        problem={{ reason: 'tempo_unsupported', wallet: { name: 'Browser wallet' } }}
        asset={USDC_SOLANA_DEVNET}
        rail="tempo"
        phone={false}
        locked={false}
        onPay={() => {}}
      />,
    );
    expect(root.querySelectorAll('.wallet-select')).toHaveLength(1);
    expect(root.querySelector('.wallet-select')?.textContent).toContain('Browser wallet');
    act(() => root.querySelector<HTMLButtonElement>('.wallet-select')!.click());
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(root.querySelector('[role="option"]')?.textContent).toContain('MetaMask');
  });
  it('uses the same supplied artwork in inline, retry and final errors', () => {
    const standalone = mount(<ErrorIcon />)
      .querySelector('path')
      ?.getAttribute('d');
    const inline = mount(
      <ProblemNote problem={{ reason: 'rpc_error' }} asset={USDC_SOLANA_DEVNET} rail="solana" />,
    );
    const retry = mount(<PaymentStageIcon stage="error" />);
    const final = mount(
      <EndedStep glyph={STOP_GLYPH} title="Payment blocked" alert>
        <p>The money is held, not delivered.</p>
      </EndedStep>,
    );
    for (const root of [inline, retry, final]) {
      expect(root.querySelector('[data-error-icon] path')?.getAttribute('d')).toBe(standalone);
    }
  });
  it('does not turn an uncertain send into a no-payment claim', () => {
    const root = mount(
      <ProblemNote
        problem={{ reason: 'send_uncertain' }}
        asset={USDC_SOLANA_DEVNET}
        rail="eip3009"
      />,
    );
    expect(root.textContent).toContain('Transaction status unknown');
    expect(root.textContent).toContain('the payment may have been sent');
    expect(root.textContent).not.toContain('Nothing was paid');
  });
  it('retains the restriction on switching wallets after a blocked retry', () => {
    const root = mount(
      <ProblemNote
        problem={{ reason: 'retry_blocked', cause: 'token_blocked', chain: 'Base' }}
        asset={USDC_SOLANA_DEVNET}
        rail="eip3009"
      />,
    );
    expect(root.textContent).toContain('Your earlier payment may still arrive');
    expect(root.textContent).toContain('only once it provably expired unused');
  });
  it('keeps earlier payments as pending information with their check action', () => {
    let calls = 0;
    const root = mount(
      <ProblemNote
        problem={{ reason: 'earlier_payment', phase: 'confirming', checkWallet: true }}
        asset={USDC_SOLANA_DEVNET}
        rail="solana"
        onCheckWallet={() => calls++}
      />,
    );
    expect(root.querySelector('[data-error-icon]')).toBeNull();
    expect(root.textContent).toContain('still being confirmed');
    act(() => root.querySelector('button')!.click());
    expect(calls).toBe(1);
  });
  it('does not repeat the icon and heading inside a progress screen', () => {
    const root = mount(
      <ProblemNote
        detailOnly
        problem={{ reason: 'wrong_chain_after_sign', chain: 'Base' }}
        asset={USDC_SOLANA_DEVNET}
        rail="eip3009"
      />,
    );
    expect(root.querySelector('[data-error-icon]')).toBeNull();
    expect(root.querySelector('.error-message-title')).toBeNull();
    expect(root.textContent).toContain('Nothing was sent: send again');
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
  });
});
