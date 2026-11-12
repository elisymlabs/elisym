// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { sinkProblems } from '../scripts/check-size';
import { parseBlocks, renderText } from '../src/ui/render-text';

function rendered(text: string): HTMLElement {
  const root = document.createElement('div');
  root.append(renderText(document, text));
  return root;
}

describe('renderText', () => {
  it('keeps HTML as text: no element from the model text ever exists', () => {
    const root = rendered('<img src=x onerror=alert(1)> <script>alert(1)</script> <b>bold</b>');
    expect(root.querySelector('img, script, b')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders no links or images: markdown links and URLs stay plain text', () => {
    const root = rendered(
      'See [the shop](https://evil.example) or ![x](https://evil.example/x.png) https://evil.example',
    );
    expect(root.querySelector('a, img')).toBeNull();
    expect(root.textContent).toContain('[the shop](https://evil.example)');
    expect(root.textContent).toContain('https://evil.example');
  });

  it('renders the subset: paragraphs, line breaks, headings, lists, bold, italic, code', () => {
    const root = rendered(
      '# Picks\nLine one\nLine two\n\n- **Scarf** in *wool*\n- `SKU-1`\n\n1. first\n2. second',
    );
    expect(root.querySelector('p.heading strong')?.textContent).toBe('Picks');
    expect(root.querySelectorAll('p br')).toHaveLength(1);
    expect(root.querySelector('ul li strong')?.textContent).toBe('Scarf');
    expect(root.querySelector('ul li em')?.textContent).toBe('wool');
    expect(root.querySelector('ul li code')?.textContent).toBe('SKU-1');
    expect(root.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('puts marked text through textContent too', () => {
    const root = rendered('**<i>x</i>**');
    expect(root.querySelector('i')).toBeNull();
    expect(root.querySelector('strong')?.textContent).toBe('<i>x</i>');
  });

  it('parses blocks without a DOM', () => {
    expect(parseBlocks('a\n\n- b')).toEqual([
      { type: 'paragraph', lines: [[{ text: 'a' }]] },
      { type: 'list', ordered: false, items: [[{ text: 'b' }]] },
    ]);
  });

  it('no source file writes HTML strings into the DOM', () => {
    expect(sinkProblems()).toEqual([]);
  });
});
