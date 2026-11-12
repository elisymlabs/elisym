// cspell:disable
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** The named HTML entities shop texts actually use; anything else stays as written. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  ...XML_ENTITIES,
  nbsp: ' ',
  ndash: '–',
  mdash: String.fromCodePoint(0x2014),
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  laquo: '«',
  raquo: '»',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
};

// cspell:enable

const REPLACEMENT_CHARACTER = '�';
const MAX_CODE_POINT = 0x10ffff;
const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/gu;

function codePointText(codePoint: number): string {
  const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  if (codePoint === 0 || surrogate || codePoint > MAX_CODE_POINT) {
    return REPLACEMENT_CHARACTER;
  }
  return String.fromCodePoint(codePoint);
}

function decodeWith(text: string, named: Readonly<Record<string, string>>): string {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(ENTITY_RE, (whole: string, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointText(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return codePointText(Number.parseInt(body.slice(1), 10));
    }
    return Object.hasOwn(named, body) ? (named[body] ?? whole) : whole;
  });
}

/**
 * Decode the five predefined XML entities and numeric references. Any other
 * `&name;` is left as written: no DTD-declared entity is ever expanded.
 */
export function decodeXmlEntities(text: string): string {
  return decodeWith(text, XML_ENTITIES);
}

export function decodeHtmlEntities(text: string): string {
  return decodeWith(text, HTML_ENTITIES);
}

export interface HtmlTag {
  /** Lower-case tag name; `/p` for a closing tag. */
  name: string;
  attrs: Map<string, string>;
}

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg']);

function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(ATTR_RE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name !== '' && !attrs.has(name)) {
      attrs.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ''));
    }
  }
  return attrs;
}

type HtmlToken = { kind: 'text'; text: string } | { kind: 'tag'; tag: HtmlTag };

/**
 * A linear HTML tokenizer (indexOf scanning, no backtracking): text runs and
 * tags. Comments, DOCTYPE declarations and the bodies of script/style-like elements are
 * skipped. Good enough for stripping and for finding a meta tag; not a DOM.
 */
export function* htmlTokens(html: string): Generator<HtmlToken> {
  const lower = html.toLowerCase();
  let position = 0;
  while (position < html.length) {
    const open = html.indexOf('<', position);
    if (open === -1) {
      yield { kind: 'text', text: html.slice(position) };
      return;
    }
    if (open > position) {
      yield { kind: 'text', text: html.slice(position, open) };
    }
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      position = end === -1 ? html.length : end + 3;
      continue;
    }
    const nameMatch = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/u.exec(html.slice(open, open + 64));
    if (!nameMatch) {
      if (html[open + 1] === '!' || html[open + 1] === '?') {
        const end = html.indexOf('>', open + 1);
        position = end === -1 ? html.length : end + 1;
      } else {
        yield { kind: 'text', text: '<' };
        position = open + 1;
      }
      continue;
    }
    const end = html.indexOf('>', open);
    if (end === -1) {
      return;
    }
    const closing = nameMatch[1] === '/';
    const name = (nameMatch[2] ?? '').toLowerCase();
    const attrSource = html.slice(open + nameMatch[0].length, end);
    yield {
      kind: 'tag',
      tag: {
        name: closing ? `/${name}` : name,
        attrs: closing ? new Map() : parseAttrs(attrSource),
      },
    };
    position = end + 1;
    if (!closing && RAW_TEXT_TAGS.has(name) && !attrSource.trimEnd().endsWith('/')) {
      const close = lower.indexOf(`</${name}`, position);
      if (close === -1) {
        return;
      }
      const closeEnd = html.indexOf('>', close);
      position = closeEnd === -1 ? html.length : closeEnd + 1;
    }
  }
}

const BREAK_TAGS = new Set([
  'br',
  'p',
  '/p',
  'div',
  '/div',
  'tr',
  '/tr',
  'ul',
  '/ul',
  'ol',
  '/ol',
  'table',
  '/table',
  'section',
  '/section',
  'blockquote',
  '/blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  '/h1',
  '/h2',
  '/h3',
  '/h4',
  '/h5',
  '/h6',
  'hr',
]);

/** Store HTML to plain text with paragraph breaks and `- ` list items (7.4: HTML stripped). */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  for (const token of htmlTokens(html)) {
    if (token.kind === 'text') {
      parts.push(decodeHtmlEntities(token.text).replace(/\s+/gu, ' '));
    } else if (token.tag.name === 'li') {
      parts.push('\n- ');
    } else if (BREAK_TAGS.has(token.tag.name)) {
      parts.push(token.tag.name.startsWith('/') || token.tag.name === 'br' ? '\n' : '\n\n');
    } else if (token.tag.name === 'td' || token.tag.name === 'th') {
      parts.push(' ');
    }
  }
  return parts
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** Inline text such as a title: tags removed, entities decoded, whitespace collapsed. */
export function inlineText(html: string): string {
  return htmlToText(html).replace(/\s+/gu, ' ').trim();
}

/** The `content` of every `<meta name="{name}">` in a page. */
export function metaContents(html: string, name: string): string[] {
  const wanted = name.toLowerCase();
  const contents: string[] = [];
  for (const token of htmlTokens(html)) {
    if (token.kind === 'tag' && token.tag.name === 'meta') {
      const metaName = token.tag.attrs.get('name');
      const content = token.tag.attrs.get('content');
      if (metaName?.toLowerCase() === wanted && content !== undefined) {
        contents.push(content.trim());
      }
    }
  }
  return contents;
}
