import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../src/components/Button';
import { CopyField } from '../src/components/CopyField';
import { Field } from '../src/components/Field';
import { Input } from '../src/components/Input';
import { Stepper } from '../src/components/Stepper';
import { ToneBadge } from '../src/components/ToneBadge';
import { describedBy } from '../src/lib/field';

let mounted: { root: Root; host: HTMLElement } | undefined;
afterEach(() => {
  act(() => mounted?.root.unmount());
  mounted?.host.remove();
  mounted = undefined;
});

function mount(element: React.ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(element));
  return host;
}

function element(markup: string): Element {
  const host = document.createElement('div');
  host.innerHTML = markup;
  const first = host.firstElementChild;
  if (first === null) {
    throw new Error('nothing rendered');
  }
  return first;
}

describe('Button', () => {
  it('is a plain button unless told, secondary and medium by default', () => {
    const button = element(renderToStaticMarkup(<Button>Save</Button>));
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('border-line-2');
    expect(button.className).toContain('text-14');
    expect(button.className).not.toContain('bg-accent');
    expect(button.className).not.toContain('w-full');
    // A disabled button never answers the pointer.
    expect(button.className).toContain('enabled:hover:bg-surface-2');
    expect(button.className).not.toMatch(/(^| )hover:/);
  });

  it('wears the accent as the primary action, in its size and width, with extra layout kept', () => {
    const button = element(
      renderToStaticMarkup(
        <Button variant="primary" size="lg" full type="submit" className="mt-16" disabled>
          Launch
        </Button>,
      ),
    );
    expect(button.getAttribute('type')).toBe('submit');
    expect(button.hasAttribute('disabled')).toBe(true);
    for (const part of ['bg-accent', 'text-accent-text', 'text-15', 'w-full', 'mt-16']) {
      expect(button.className).toContain(part);
    }
    expect(button.className).toContain('enabled:hover:brightness-95');
    expect(button.className).not.toMatch(/(^| )hover:/);
    expect(element(renderToStaticMarkup(<Button size="sm">x</Button>)).className).toContain(
      'text-13',
    );
  });
});

describe('Input and Field', () => {
  it('labels the control, and gives its hint and error ids to describe it by', () => {
    const field = element(
      renderToStaticMarkup(
        <Field id="name" label="Store name" hint="As buyers see it" error="Required">
          <Input id="name" aria-describedby="name-hint name-error" mono />
        </Field>,
      ),
    );
    expect(field.querySelector('label')?.getAttribute('for')).toBe('name');
    expect(field.querySelector('#name-hint')?.textContent).toBe('As buyers see it');
    expect(field.querySelector('#name-error')?.getAttribute('role')).toBe('alert');
    expect(field.querySelector('input')?.className).toContain('font-mono');
  });

  it('shows no hint or error when there is none', () => {
    const field = element(
      renderToStaticMarkup(
        <Field id="name" label="Store name" error="">
          <Input id="name" />
        </Field>,
      ),
    );
    expect(field.querySelector('[role="alert"]')).toBeNull();
    expect(field.querySelector('p')).toBeNull();
    expect(field.querySelector('input')?.className).not.toContain('font-mono');
    const bare = element(
      renderToStaticMarkup(
        <Field id="name" label="Store name">
          <Input id="name" className="w-full" />
        </Field>,
      ),
    );
    expect(bare.querySelector('[role="alert"]')).toBeNull();
    expect(bare.querySelector('input')?.className).toContain('w-full');
  });

  it('names the hint and error ids a control is described by, only those shown', () => {
    expect(describedBy('name', 'As buyers see it', 'Required')).toBe('name-hint name-error');
    expect(describedBy('name', undefined, 'Required')).toBe('name-error');
    expect(describedBy('name', 'As buyers see it', '')).toBe('name-hint');
    expect(describedBy('name', undefined, undefined)).toBeUndefined();
  });
});

describe('ToneBadge', () => {
  it('says the state in words, its tone a hint only', () => {
    const pill = element(renderToStaticMarkup(<ToneBadge tone="ok">Live</ToneBadge>));
    expect(pill.textContent).toBe('Live');
    expect(pill.getAttribute('data-tone')).toBe('ok');
    expect(pill.className).toContain('text-ok');
    const tones = [
      ['wait', 'text-text-2'],
      ['warn', 'text-warn'],
      ['off', 'text-text-3'],
    ] as const;
    for (const [tone, text] of tones) {
      expect(
        element(renderToStaticMarkup(<ToneBadge tone={tone}>x</ToneBadge>)).className,
      ).toContain(text);
    }
  });
});

describe('Stepper', () => {
  it('marks the current step and says which are done', () => {
    const host = element(
      renderToStaticMarkup(
        <Stepper
          steps={[
            { key: 'pay', label: 'Pay', state: 'done' },
            { key: 'name', label: 'Name your store', state: 'current' },
            { key: 'launch', label: 'Launch', state: 'next' },
          ]}
        />,
      ),
    );
    const steps = [...host.querySelectorAll('li')];
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(steps[0]?.textContent).toContain('Pay (done)');
    expect(steps[1]?.textContent).toBe('2Name your store');
    expect(steps[2]?.className).toContain('text-text-3');
    // The badge is drawn only: the list position and "(done)" say it.
    const badges = steps.map((step) => step.querySelector('span'));
    expect(badges.map((badge) => badge?.getAttribute('aria-hidden'))).toEqual([
      'true',
      'true',
      'true',
    ]);
    expect(badges[0]?.textContent).toBe('✓');
  });
});

describe('CopyField', () => {
  it('shows the value whole and copies it, saying so', async () => {
    const copied: string[] = [];
    const host = mount(
      <CopyField
        label="the snippet"
        value="<elisym-buy></elisym-buy>"
        copy={async (text) => {
          copied.push(text);
        }}
      />,
    );
    expect(host.querySelector('code')?.textContent).toBe('<elisym-buy></elisym-buy>');
    const button = host.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('Copy the snippet');
    await act(async () => button?.click());
    expect(copied).toEqual(['<elisym-buy></elisym-buy>']);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied');
  });

  it('says how to copy by hand when the clipboard refuses', async () => {
    const host = mount(
      <CopyField
        label="the snippet"
        value="x"
        copy={async () => {
          throw new Error('denied');
        }}
      />,
    );
    await act(async () => host.querySelector('button')?.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Copy failed: select it and copy by hand',
    );
  });

  it('says nothing of a value it has not copied yet', async () => {
    const copy = async () => undefined;
    const host = mount(<CopyField label="the snippet" value="one" copy={copy} />);
    await act(async () => host.querySelector('button')?.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied');
    act(() => mounted?.root.render(<CopyField label="the snippet" value="two" copy={copy} />));
    expect(host.querySelector('code')?.textContent).toBe('two');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it("copies with the page's clipboard, and says so when there is none", async () => {
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => void written.push(text) },
      });
      const host = mount(<CopyField label="the snippet" value="x" />);
      await act(async () => host.querySelector('button')?.click());
      expect(written).toEqual(['x']);
      expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      await act(async () => host.querySelector('button')?.click());
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Copy failed: select it and copy by hand',
      );
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(navigator, 'clipboard');
      } else {
        Object.defineProperty(navigator, 'clipboard', original);
      }
    }
  });
});
