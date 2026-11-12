import { act, type ReactElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';

declare global {
  // React's flag for a test that wraps its updates in `act`.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export interface Mounted {
  container: HTMLElement;
  rerender: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function mount(element: ReactElement): Promise<Mounted> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    rerender: async (next: ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Let the session's reads and React's updates settle. */
export async function settle(until: () => boolean, rounds = 200): Promise<void> {
  for (let round = 0; round < rounds && !until(); round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  if (!until()) {
    throw new Error('did not settle');
  }
}

export function byId(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector(`#${id}`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`no #${id}`);
  }
  return found;
}

export function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  );
  if (found === undefined) {
    throw new Error(`no button "${text}"`);
  }
  return found;
}

/** Type into a React-controlled field: the native setter, then the event React listens to. */
export async function typeInto(field: HTMLElement, value: string): Promise<void> {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter === undefined) {
    throw new Error('no value setter');
  }
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}
