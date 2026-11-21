import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegalNotice } from '../src/components/LegalNotice';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** The NIF and address the mocked `legal` module gives, set per test. */
const NOTICE = vi.hoisted(() => ({ nif: '', address: '' }));

vi.mock('../src/legal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/legal')>();
  return {
    ...actual,
    get LEGAL_NIF() {
      return NOTICE.nif;
    },
    get LEGAL_ADDRESS() {
      return NOTICE.address;
    },
  };
});

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

/** The notice's rows as [term, value], rendered with the given NIF and address. */
async function rowsWith(nif: string, address: string): Promise<(string | null | undefined)[][]> {
  NOTICE.nif = nif;
  NOTICE.address = address;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<LegalNotice />));
  return [...container.querySelectorAll('dt')].map((term) => [
    term.textContent,
    term.nextElementSibling?.textContent,
  ]);
}

describe('the legal notice', () => {
  it('shows the NIF and the address when they are set', async () => {
    const rows = await rowsWith('X0000000T', 'Calle Example 1, Madrid');
    expect(rows).toContainEqual(['NIF', 'X0000000T']);
    expect(rows).toContainEqual(['Address', 'Calle Example 1, Madrid']);
  });

  it('leaves out a row whose value is empty', async () => {
    const rows = await rowsWith('', 'Calle Example 1, Madrid');
    expect(rows.map(([term]) => term)).not.toContain('NIF');
    expect(rows).toContainEqual(['Address', 'Calle Example 1, Madrid']);
    await act(async () => root?.unmount());
    container?.remove();
    const noAddress = await rowsWith('X0000000T', '');
    expect(noAddress.map(([term]) => term)).not.toContain('Address');
    expect(noAddress).toContainEqual(['NIF', 'X0000000T']);
  });
});
