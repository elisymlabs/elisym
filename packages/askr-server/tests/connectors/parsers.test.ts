// cspell:ignore preorder lolz rsquo backorder
import { describe, expect, it } from 'vitest';
import {
  FeedFormatError,
  mapGoogleItem,
  parseFeedPrice,
  parseGoogleFeed,
} from '../../src/connectors/google-feed';
import { decodeHtmlEntities, htmlToText, metaContents } from '../../src/connectors/html';
import { fitDraft } from '../../src/connectors/listing';
import { XmlParseError, parseXml } from '../../src/connectors/xml';

const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Shop feed</title>
    <link>https://shop.example</link>
    <item>
      <g:id>TEE-1</g:id>
      <title>Cotton tee &amp; more</title>
      <description><![CDATA[<p>Soft <b>cotton</b>.</p>]]></description>
      <link>https://shop.example/tee</link>
      <g:image_link>https://cdn.example/tee.jpg</g:image_link>
      <g:additional_image_link>https://cdn.example/tee-2.jpg</g:additional_image_link>
      <g:price>25.00 USD</g:price>
      <g:sale_price>19.99 USD</g:sale_price>
      <g:availability>in_stock</g:availability>
      <g:brand>Acme</g:brand>
      <g:color>Blue</g:color>
      <g:product_type>Apparel &gt; Tops</g:product_type>
      <g:google_product_category>212</g:google_product_category>
      <g:shipping><g:country>US</g:country><g:price>5 USD</g:price></g:shipping>
    </item>
    <item>
      <g:id>chaussure été</g:id>
      <g:title>Summer shoe</g:title>
      <g:link>https://shop.example/shoe</g:link>
      <g:price>USD 80</g:price>
      <g:availability>out of stock</g:availability>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:gg="http://base.google.com/ns/1.0">
  <title>Atom feed</title>
  <entry>
    <gg:id>MUG-7</gg:id>
    <title>Mug</title>
    <summary>Holds coffee.</summary>
    <link href="https://shop.example/mug" rel="alternate"/>
    <gg:price>12 EUR</gg:price>
    <gg:availability>preorder</gg:availability>
  </entry>
</feed>`;

describe('parseXml', () => {
  it('parses elements, attributes, CDATA and namespaces', () => {
    const root = parseXml(
      '<a xmlns:x="urn:x"><x:b k="1 &gt; 0" q=\'a>b\'>t<![CDATA[<raw>]]></x:b><c/></a>',
    );
    const child = root.children[0];
    expect(child?.localName).toBe('b');
    expect(child?.namespace).toBe('urn:x');
    expect(child?.attrs.get('k')).toBe('1 > 0');
    expect(child?.attrs.get('q')).toBe('a>b');
    expect(child?.text).toBe('t<raw>');
    expect(root.children[1]?.name).toBe('c');
  });

  it('leaves a billion-laughs payload inert: entities are never expanded', () => {
    const lol = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
]>
<lolz>&lol9;</lolz>`;
    const root = parseXml(lol);
    expect(root.text).toBe('&lol9;');
  });

  it('leaves an external entity inert: nothing is read or fetched', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> <!ENTITY web SYSTEM "https://169.254.169.254/"> ]>
<rss><channel><item><title>&xxe;</title><description>&web;</description></item></channel></rss>`;
    const items = parseGoogleFeed(xxe);
    expect(items[0]?.get('title')).toEqual(['&xxe;']);
    expect(items[0]?.get('description')).toEqual(['&web;']);
  });

  it('decodes only the predefined entities and numeric references', () => {
    expect(parseXml('<a>&lt;&#65;&#x42;&#0;&nbsp;</a>').text).toBe('<AB�&nbsp;');
  });

  it.each([
    ['<a><b></a>', 'mismatched end tag'],
    ['<a>', 'unclosed root'],
    ['<a/><b/>', 'two roots'],
    ['text', 'no root'],
    ['<a b=1/>', 'unquoted attribute'],
    ['<!DOCTYPE x [ <a/>', 'unterminated doctype'],
  ])('rejects malformed XML (%s: %s)', (source) => {
    expect(() => parseXml(source)).toThrow(XmlParseError);
  });

  it('caps nesting depth', () => {
    const deep = `${'<a>'.repeat(100)}${'</a>'.repeat(100)}`;
    expect(() => parseXml(deep)).toThrow(/nested too deeply/u);
  });
});

describe('html', () => {
  it('strips tags, scripts, styles and comments, keeps paragraphs and list items', () => {
    const text = htmlToText(
      '<h4>Title</h4><p>One&nbsp;two &amp; three<br>four</p><script>alert(1)</script><style>p{}</style><!-- c --><ul><li>a</li><li>b</li></ul><meta charset="utf-8">',
    );
    expect(text).toBe('Title\n\nOne two & three\nfour\n\n- a\n- b');
  });

  it('decodes named and numeric entities', () => {
    expect(decodeHtmlEntities('you&#8217;re &rsquo; &#x1F600; &unknown; &amp;amp;')).toBe(
      'you’re ’ \u{1F600} &unknown; &amp;',
    );
  });

  it('finds verification meta tags in any attribute order and quoting', () => {
    const page = `<html><head>
      <META content='npub1abc' NAME="askr-verification">
      <meta name=askr-verification content=npub1def>
      <meta name="description" content="npub1zzz">
      <script>document.write('<meta name="askr-verification" content="npub1evil">')</script>
    </head></html>`;
    expect(metaContents(page, 'askr-verification')).toEqual(['npub1abc', 'npub1def']);
  });

  it('is linear on hostile input', () => {
    const hostile = '<script>'.repeat(50_000);
    const started = Date.now();
    htmlToText(hostile);
    metaContents(`${'<meta '.repeat(20_000)}`, 'x');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('Google feed', () => {
  const NOW_MS = Date.parse('2026-11-12T00:00:00Z');

  it('reads RSS 2.0 items with Google fields winning over plain ones', () => {
    const items = parseGoogleFeed(RSS_FEED);
    expect(items).toHaveLength(2);
    expect(items[0]?.get('id')).toEqual(['TEE-1']);
    expect(items[0]?.get('title')).toEqual(['Cotton tee & more']);
    expect(items[0]?.has('shipping')).toBe(false);
    expect(items[1]?.get('title')).toEqual(['Summer shoe']);
  });

  it('maps an item: sale price, attrs, topics, sku = id, hashed d for a Unicode id', () => {
    const [tee, shoe] = parseGoogleFeed(RSS_FEED).map((item) => mapGoogleItem(item, NOW_MS));
    if (!tee?.ok || !shoe?.ok) {
      throw new Error('expected both items to map');
    }
    expect(tee.draft).toMatchObject({
      sourceId: 'TEE-1',
      sku: 'TEE-1',
      title: 'Cotton tee & more',
      description: 'Soft cotton.',
      price: '19.99',
      currency: 'USD',
      visibility: 'on-sale',
      url: 'https://shop.example/tee',
      images: ['https://cdn.example/tee.jpg', 'https://cdn.example/tee-2.jpg'],
      topics: ['Apparel > Tops'],
      attrs: [
        { name: 'brand', value: 'Acme' },
        { name: 'color', value: 'Blue' },
      ],
    });
    expect(shoe.draft).toMatchObject({ price: '80', visibility: 'sold-out' });
    const fittedShoe = fitDraft(shoe.draft);
    expect(fittedShoe.ok && fittedShoe.listing.d).toMatch(/^google:h[A-Za-z0-9_-]{16}$/u);
    const fittedTee = fitDraft(tee.draft);
    expect(fittedTee.ok && fittedTee.listing.variants).toEqual([]);
  });

  it('applies sale_price only inside its effective dates', () => {
    const item = new Map([
      ['id', ['A']],
      ['title', ['A']],
      ['price', ['10 USD']],
      ['sale_price', ['8 USD']],
      ['sale_price_effective_date', ['2026-12-01T00:00:00Z/2026-12-31T00:00:00Z']],
    ]);
    const before = mapGoogleItem(item, NOW_MS);
    expect(before.ok && before.draft.price).toBe('10');
    const during = mapGoogleItem(item, Date.parse('2026-12-10T00:00:00Z'));
    expect(during.ok && during.draft.price).toBe('8');
  });

  it('maps availability, unknown values to sold-out', () => {
    const visibility = (availability: string): string | undefined => {
      const mapped = mapGoogleItem(
        new Map([
          ['id', ['A']],
          ['title', ['A']],
          ['price', ['1 USD']],
          ['availability', [availability]],
        ]),
        NOW_MS,
      );
      return mapped.ok ? mapped.draft.visibility : undefined;
    };
    expect(visibility('in stock')).toBe('on-sale');
    expect(visibility('backorder')).toBe('on-sale');
    expect(visibility('preorder')).toBe('pre-order');
    expect(visibility('out_of_stock')).toBe('sold-out');
    expect(visibility('whenever')).toBe('sold-out');
  });

  it('refuses items without id or a valid price', () => {
    expect(mapGoogleItem(new Map([['title', ['A']]]), NOW_MS).ok).toBe(false);
    expect(
      mapGoogleItem(
        new Map([
          ['id', ['A']],
          ['price', ['12,50 EUR']],
        ]),
        NOW_MS,
      ).ok,
    ).toBe(false);
  });

  it('parses prices in both orders, rejecting junk', () => {
    expect(parseFeedPrice('15.00 USD')).toEqual({ amount: '15.00', currency: 'USD' });
    expect(parseFeedPrice('USD 15')).toEqual({ amount: '15', currency: 'USD' });
    expect(parseFeedPrice('USD 15 EUR')).toBeUndefined();
    expect(parseFeedPrice('15')).toBeUndefined();
    expect(parseFeedPrice('-3 USD')).toBeUndefined();
  });

  it('reads Atom entries with any Google namespace prefix', () => {
    const [entry] = parseGoogleFeed(ATOM_FEED);
    expect(entry?.get('id')).toEqual(['MUG-7']);
    expect(entry?.get('link')).toEqual(['https://shop.example/mug']);
    expect(entry?.get('description')).toEqual(['Holds coffee.']);
    const mapped = entry ? mapGoogleItem(entry, NOW_MS) : undefined;
    expect(mapped?.ok && mapped.draft.visibility).toBe('pre-order');
  });

  it('reads TSV feeds with quoted cells and comma-separated extra images', () => {
    const tsv = [
      'id\ttitle\tdescription\tlink\tprice\tavailability\timage link\tadditional_image_link',
      'T1\t"Tee ""classic"""\tSoft\thttps://shop.example/t1\t9.50 USD\tin_stock\thttps://cdn.example/a.jpg\thttps://cdn.example/b.jpg,https://cdn.example/c.jpg',
      '',
    ].join('\r\n');
    const [item] = parseGoogleFeed(`${String.fromCodePoint(0xfeff)}${tsv}`);
    expect(item?.get('title')).toEqual(['Tee "classic"']);
    expect(item?.get('image_link')).toEqual(['https://cdn.example/a.jpg']);
    expect(item?.get('additional_image_link')).toEqual([
      'https://cdn.example/b.jpg',
      'https://cdn.example/c.jpg',
    ]);
  });

  it('rejects bodies that are not feeds', () => {
    expect(() => parseGoogleFeed('<html><body>hi</body></html>')).toThrow(FeedFormatError);
    expect(() => parseGoogleFeed('title\tprice\nA\t1 USD')).toThrow(FeedFormatError);
    expect(() => parseGoogleFeed('<rss><channel>')).toThrow(FeedFormatError);
  });
});
