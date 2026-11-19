/**
 * The 4.3 markdown subset, rendered from model text into DOM nodes built with
 * `textContent` only: paragraphs, line breaks, headings (shown as strong
 * lines), bullet and numbered lists, `**bold**`, `*italic*` / `_italic_` and
 * `` `code` ``. No raw HTML, no links, no images: anything else, URLs and
 * `[text](url)` included, stays plain text.
 */

/** One inline run of text and the marks on it. */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type TextBlock =
  | { type: 'paragraph'; lines: InlineRun[][] }
  | { type: 'heading'; runs: InlineRun[] }
  | { type: 'list'; ordered: boolean; items: InlineRun[][] };

const BULLET_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED_RE = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(_[^_\s][^_\n]*_)/g;

/** Inline marks, one level deep: the subset needs no nesting. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) {
      runs.push({ text: text.slice(last, index) });
    }
    const token = match[0];
    if (match[1] !== undefined) {
      runs.push({ text: token.slice(1, -1), code: true });
    } else if (match[2] !== undefined || match[3] !== undefined) {
      runs.push({ text: token.slice(2, -2), bold: true });
    } else {
      runs.push({ text: token.slice(1, -1), italic: true });
    }
    last = index + token.length;
  }
  if (last < text.length) {
    runs.push({ text: text.slice(last) });
  }
  return runs;
}

export function parseBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: InlineRun[][] | undefined;
  let list: { ordered: boolean; items: InlineRun[][] } | undefined;
  const flush = (): void => {
    if (paragraph) {
      blocks.push({ type: 'paragraph', lines: paragraph });
      paragraph = undefined;
    }
    if (list) {
      blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
      list = undefined;
    }
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    const heading = HEADING_RE.exec(line);
    const bullet = BULLET_RE.exec(line);
    const numbered = NUMBERED_RE.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', runs: parseInline(heading[1] ?? '') });
    } else if (bullet || numbered) {
      const ordered = numbered !== null;
      if (paragraph || (list && list.ordered !== ordered)) {
        flush();
      }
      list ??= { ordered, items: [] };
      list.items.push(parseInline((bullet ?? numbered)?.[1] ?? ''));
    } else {
      if (list) {
        flush();
      }
      paragraph ??= [];
      paragraph.push(parseInline(line.trim()));
    }
  }
  flush();
  return blocks;
}

function appendRuns(parent: Element, runs: readonly InlineRun[]): void {
  const document = parent.ownerDocument;
  for (const run of runs) {
    let tag: string | undefined;
    if (run.code) {
      tag = 'code';
    } else if (run.bold) {
      tag = 'strong';
    } else if (run.italic) {
      tag = 'em';
    }
    if (tag === undefined) {
      parent.append(document.createTextNode(run.text));
    } else {
      const node = document.createElement(tag);
      node.textContent = run.text;
      parent.append(node);
    }
  }
}

/** Render model text into a fragment of plain elements; no markup from the text is ever parsed. */
export function renderText(document: Document, text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseBlocks(text)) {
    if (block.type === 'heading') {
      const node = document.createElement('p');
      node.className = 'heading';
      const strong = document.createElement('strong');
      appendRuns(strong, block.runs);
      node.append(strong);
      fragment.append(node);
    } else if (block.type === 'list') {
      const node = document.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) {
        const entry = document.createElement('li');
        appendRuns(entry, item);
        node.append(entry);
      }
      fragment.append(node);
    } else {
      const node = document.createElement('p');
      block.lines.forEach((line, index) => {
        if (index > 0) {
          node.append(document.createElement('br'));
        }
        appendRuns(node, line);
      });
      fragment.append(node);
    }
  }
  return fragment;
}
