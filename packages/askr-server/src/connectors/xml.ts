import { decodeXmlEntities } from './html';

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

export interface XmlElement {
  /** The qualified name as written, e.g. `g:price`. */
  name: string;
  localName: string;
  /** The resolved namespace URI, if any. */
  namespace: string | undefined;
  attrs: Map<string, string>;
  children: XmlElement[];
  /** Concatenated direct text and CDATA. */
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

const MAX_DEPTH = 64;
/** About 10k feed items: a cap on the tree kept in memory (every element is retained). */
const MAX_ELEMENTS = 200_000;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9._:-]*/u;
const ATTR_RE = /\s*([A-Za-z_][A-Za-z0-9._:-]*)\s*=\s*("([^"]*)"|'([^']*)')/uy;

interface OpenElement {
  element: XmlElement;
  scope: Map<string, string>;
  textParts: string[];
}

function splitName(name: string): {
  prefix: string | undefined;
  localName: string;
} {
  const colon = name.indexOf(':');
  return colon === -1
    ? { prefix: undefined, localName: name }
    : { prefix: name.slice(0, colon), localName: name.slice(colon + 1) };
}

function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const trimmed = source.trimEnd();
  let position = 0;
  while (position < trimmed.length) {
    ATTR_RE.lastIndex = position;
    const match = ATTR_RE.exec(trimmed);
    if (!match) {
      throw new XmlParseError('Malformed attribute');
    }
    const name = match[1] ?? '';
    if (!attrs.has(name)) {
      attrs.set(name, decodeXmlEntities(match[3] ?? match[4] ?? ''));
    }
    position = ATTR_RE.lastIndex;
  }
  return attrs;
}

/** The index of the `>` that ends a start tag, skipping any `>` inside a quoted attribute value. */
function startTagEnd(source: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < source.length; index++) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  throw new XmlParseError('Unterminated start tag');
}

/** Skip `<!DOCTYPE ...>` including an internal subset, honoring quotes. Nothing in it is read. */
function skipDoctype(source: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
    } else if (character === '>' && depth <= 0) {
      return index + 1;
    }
  }
  throw new XmlParseError('Unterminated DOCTYPE');
}

function findOrThrow(source: string, needle: string, from: number, what: string): number {
  const index = source.indexOf(needle, from);
  if (index === -1) {
    throw new XmlParseError(`Unterminated ${what}`);
  }
  return index;
}

/**
 * A minimal, non-validating XML parser for product feeds (RSS 2.0 / Atom).
 * Safe by construction: a DOCTYPE (and any internal subset) is skipped
 * unread, so no entity is ever declared, no external resource is ever
 * fetched, and only the five predefined entities and numeric references are
 * decoded; anything like `&lol9;` stays literal text. Linear scanning with
 * indexOf, a depth cap and an element cap; the input size is capped by the
 * fetch guard.
 */
export function parseXml(source: string): XmlElement {
  const text = source.startsWith(BYTE_ORDER_MARK) ? source.slice(1) : source;
  const rootScope = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);
  const stack: OpenElement[] = [];
  let root: XmlElement | undefined;
  let elements = 0;
  let position = 0;

  const appendText = (value: string): void => {
    const top = stack.at(-1);
    if (top) {
      top.textParts.push(value);
    } else if (value.trim() !== '') {
      throw new XmlParseError('Text outside the root element');
    }
  };

  while (position < text.length) {
    const open = text.indexOf('<', position);
    if (open === -1) {
      appendText(decodeXmlEntities(text.slice(position)));
      break;
    }
    if (open > position) {
      appendText(decodeXmlEntities(text.slice(position, open)));
    }
    if (text.startsWith('<!--', open)) {
      position = findOrThrow(text, '-->', open + 4, 'comment') + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const end = findOrThrow(text, ']]>', open + 9, 'CDATA section');
      appendText(text.slice(open + 9, end));
      position = end + 3;
    } else if (text.startsWith('<?', open)) {
      position = findOrThrow(text, '?>', open + 2, 'processing instruction') + 2;
    } else if (text.startsWith('<!DOCTYPE', open) || text.startsWith('<!doctype', open)) {
      position = skipDoctype(text, open + 9);
    } else if (text.startsWith('</', open)) {
      const end = findOrThrow(text, '>', open + 2, 'end tag');
      const name = text.slice(open + 2, end).trim();
      const top = stack.pop();
      if (!top || top.element.name !== name) {
        throw new XmlParseError(`Unexpected end tag ${name}`);
      }
      top.element.text = top.textParts.join('');
      position = end + 1;
    } else {
      const tagEnd = startTagEnd(text, open + 1);
      const inner = text.slice(open + 1, tagEnd);
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameMatch = NAME_RE.exec(body);
      if (!nameMatch) {
        throw new XmlParseError('Malformed start tag');
      }
      const name = nameMatch[0];
      const attrs = parseAttrs(body.slice(name.length));
      const parentScope = stack.at(-1)?.scope ?? rootScope;
      let scope = parentScope;
      for (const [attrName, value] of attrs) {
        if (attrName === 'xmlns' || attrName.startsWith('xmlns:')) {
          if (scope === parentScope) {
            scope = new Map(parentScope);
          }
          scope.set(attrName === 'xmlns' ? '' : attrName.slice(6), value);
        }
      }
      const { prefix, localName } = splitName(name);
      const element: XmlElement = {
        name,
        localName,
        namespace: scope.get(prefix ?? ''),
        attrs,
        children: [],
        text: '',
      };
      elements += 1;
      if (elements > MAX_ELEMENTS) {
        throw new XmlParseError('Too many elements');
      }
      const parent = stack.at(-1);
      if (parent) {
        parent.element.children.push(element);
      } else if (root) {
        throw new XmlParseError('More than one root element');
      } else {
        root = element;
      }
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) {
          throw new XmlParseError('Elements nested too deeply');
        }
        stack.push({ element, scope, textParts: [] });
      }
      position = tagEnd + 1;
    }
  }
  if (stack.length > 0 || !root) {
    throw new XmlParseError('Unexpected end of document');
  }
  return root;
}
