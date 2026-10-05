import { act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { ElisymBuy, type ElisymBuyProps } from '../src';

declare global {
  // React's flag for a test that wraps its updates in `act`.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export interface Mounted {
  container: HTMLElement;
  element: () => HTMLElement;
  render: (props: ElisymBuyProps) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function mount(props: ElisymBuyProps): Promise<Mounted> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = async (next: ElisymBuyProps): Promise<void> => {
    await act(async () => {
      root.render(createElement(ElisymBuy, next));
    });
  };
  await render(props);
  return {
    container,
    element: () => {
      const found = container.querySelector('elisym-buy');
      if (!(found instanceof HTMLElement)) {
        throw new Error('no <elisym-buy> rendered');
      }
      return found;
    },
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export function loaderScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll('script')];
}

export const OLDER_LOADER_WARNING =
  'elisym: customer-ref needs the v3 loader; another loader defined <elisym-buy> first';

/** The calls that were the older-loader warning (happy-dom also logs the script it will not load). */
export function olderLoaderWarnings(calls: unknown[][]): unknown[][] {
  return calls.filter((call) => call[0] === OLDER_LOADER_WARNING);
}

export function resetDocument(): void {
  document.head.replaceChildren();
  document.body.replaceChildren();
}

/** Mounts inside a shadow root, as a design system's own component would. */
export async function mountInShadowRoot(
  props: ElisymBuyProps,
): Promise<Mounted & { shadow: ShadowRoot }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const container = document.createElement('div');
  shadow.append(container);
  const root: Root = createRoot(container);
  const render = async (next: ElisymBuyProps): Promise<void> => {
    await act(async () => {
      root.render(createElement(ElisymBuy, next));
    });
  };
  await render(props);
  return {
    shadow,
    container,
    element: () => {
      const found = container.querySelector('elisym-buy');
      if (!(found instanceof HTMLElement)) {
        throw new Error('no <elisym-buy> rendered');
      }
      return found;
    },
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}
