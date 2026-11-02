import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_AFTER_MS, ProductEditor } from '../../src/cloud/components/ProductEditor';
import type { ProductDraft } from '../../src/cloud/lib/product-form';
import { type Mounted, mount } from '../mount';

const PICTURE = 'https://shop.example/course.png';
const OTHER_PICTURE = 'https://shop.example/course-2.png';

function draftWith(image: string): ProductDraft {
  return {
    key: 'p1',
    name: 'course',
    nameTouched: true,
    fields: {
      title: 'Course',
      priceUsd: '10',
      summary: '',
      image,
      description: 'A course.',
      onSale: true,
    },
    text: '',
  };
}

function Editor({ image }: { image: string }) {
  const [product, setProduct] = useState(() => draftWith(image));
  return (
    <ProductEditor
      product={product}
      nameEditable={false}
      nameTaken={false}
      refused={[]}
      onChange={setProduct}
    />
  );
}

/** Types `value` into the picture field as a person would (React's own setter). */
async function type(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('#product-p1-image');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const preview = (container: HTMLElement) => container.querySelector('img');

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

describe("a product's picture in its editor", () => {
  it('shows a kept picture at once, with no referrer, and hides it when it does not load', async () => {
    mounted = await mount(<Editor image={PICTURE} />);
    const image = preview(mounted.container);
    expect(image?.getAttribute('src')).toBe(PICTURE);
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });
    expect(preview(mounted.container)).toBeNull();
  });

  it('loads a typed link only once it stays the same a moment, never a half-typed one', async () => {
    vi.useFakeTimers();
    mounted = await mount(<Editor image="" />);
    const { container } = mounted;
    await type(container, 'https://shop.example/c');
    await type(container, PICTURE);
    expect(preview(container)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_AFTER_MS - 1);
    });
    expect(preview(container)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(preview(container)?.getAttribute('src')).toBe(PICTURE);
    // A change hides it until the new link settles; a link the node refuses never shows.
    await type(container, OTHER_PICTURE);
    expect(preview(container)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_AFTER_MS);
    });
    expect(preview(container)?.getAttribute('src')).toBe(OTHER_PICTURE);
    await type(container, 'http://shop.example/course.png');
    expect(preview(container)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_AFTER_MS);
    });
    expect(preview(container)).toBeNull();
  });

  it('shows the link at once when the field is left', async () => {
    vi.useFakeTimers();
    mounted = await mount(<Editor image="" />);
    const { container } = mounted;
    await type(container, PICTURE);
    expect(preview(container)).toBeNull();
    await act(async () => {
      container
        .querySelector('#product-p1-image')
        ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(preview(container)?.getAttribute('src')).toBe(PICTURE);
  });
});
