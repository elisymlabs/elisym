import { type Answer, type CatalogItem, parseAddress } from '@elisym/comcore';
import Decimal from 'decimal.js-light';
import { stripInvisible } from './fence';

/** Currency symbols; `$` and `¥` are ambiguous and match any of their currencies. */
const SYMBOLS: ReadonlyArray<[string, readonly string[]]> = [
  ['R$', ['BRL']],
  ['US$', ['USD']],
  ['C$', ['CAD']],
  ['A$', ['AUD']],
  ['$', ['USD', 'CAD', 'AUD', 'NZD', 'MXN', 'SGD', 'HKD', 'ARS', 'CLP', 'COP']],
  ['€', ['EUR']],
  ['£', ['GBP']],
  ['¥', ['JPY', 'CNY']],
  ['₽', ['RUB']],
  ['₴', ['UAH']],
  ['₹', ['INR']],
  ['₩', ['KRW']],
  ['₺', ['TRY']],
  ['₪', ['ILS']],
  ['₸', ['KZT']],
  ['zł', ['PLN']],
];

// cspell:disable
/** Currency words: a stem and its explicit endings only, so "buckles" or "рубашки" are not money. */
const WORDS: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/^(us\s?dollars?|u\.s\.\s?dollars?)$/i, ['USD']],
  [
    /^(dollars?|bucks?|dólar(es)?|доллар(а|ов|ы|ах|ам|ом|у|ами)?|долар(а|ів|и|ах|ам|ом|у)?|бакс(а|ов|ы|ах|ам)?)$/i,
    ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD'],
  ],
  [/^(euros?|евро)$/i, ['EUR']],
  [/^(quid|фунт(а|ов|ы)?\s?стерлинг(а|ов)?)$/i, ['GBP']],
  [/^(yen|yuan|иен(а|ы)?|юан(ь|я|ей)?|рмб)$/i, ['JPY', 'CNY']],
  [/^(руб(\.|ль|ля|лей|ли|лях|лям|лём|лем|лю|лями)?|р\.?)$/i, ['RUB']],
  [/^(гривн(а|ы|я|е|у|ой|ею|ам|ах|ами|ями|і|ю)?|гривен|грн\.?)$/i, ['UAH']],
  [/^(real|reais)$/i, ['BRL']],
  [/^(złot(y|e|ych)|zlot(y|e|ych))$/i, ['PLN']],
  [/^(rupees?|рупи(и|й|я)?)$/i, ['INR']],
  [/^(rubles?|roubles?)$/i, ['RUB']],
  [/^(liras?|lirası)$/i, ['TRY']],
];
// cspell:enable

/** "Ft" reads as feet as often as forints: money only in a HUF store. */
const FORINT_RE = /^Ft$/;

/** "Fr." is a weekday abbreviation in German ("Mo.-Fr."): francs only in a CHF store. */
const FRANC_RE = /^Fr\.?$/;
const FRANC_SYMBOLS: ReadonlyArray<[string, readonly string[]]> = [['Fr.', ['CHF']]];
/** "Mo.-Fr. 9", "Di.–Fr. 10": a weekday range, not francs. */
const WEEKDAY_BEFORE_RE = /(?:Mo|Di|Mi|Do|Sa|So|Lu|Ma|Me|Je|Ve)\.?\s?[-–]\s?$/;
/** "Fr. 9-18 Uhr", "Fr. 10 Uhr", "Fr. 9:30": opening hours, not francs. */
const HOURS_AFTER_RE = /^(?::\d{2}|\s*(?:[-–]\s*\d{1,2}(?:[.:]\d{2})?\s*)?(?:Uhr|h)\b)/u;

/** The words for pound are weights as often as money: they count only in a GBP store. */
// cspell:disable-next-line
const POUND_RE = /^(pounds?|фунт(а|ов|ы)?)$/i;

/** ISO codes that are also common uppercase words: read as a code only with a decimal amount. */
const WORD_LIKE_CODES = new Set([
  'ALL',
  'TOP',
  'SOS',
  'CUP',
  'MOP',
  'BOB',
  'GEL',
  'MAD',
  'PEN',
  'TRY',
  'SAR',
  'NAD',
  'BAM',
]);

/**
 * Active ISO 4217 codes, static: runtimes differ (Bun lists 300+ including
 * historical codes that are ordinary words, like ARM or SIT), and a check
 * must read the same text the same way everywhere.
 */
// cspell:disable
const ISO_CODES: ReadonlySet<string> = new Set([
  'AED',
  'AFN',
  'ALL',
  'AMD',
  'ANG',
  'AOA',
  'ARS',
  'AUD',
  'AWG',
  'AZN',
  'BAM',
  'BBD',
  'BDT',
  'BGN',
  'BHD',
  'BIF',
  'BMD',
  'BND',
  'BOB',
  'BRL',
  'BSD',
  'BTN',
  'BWP',
  'BYN',
  'BZD',
  'CAD',
  'CDF',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CRC',
  'CUC',
  'CUP',
  'CVE',
  'CZK',
  'DJF',
  'DKK',
  'DOP',
  'DZD',
  'EGP',
  'ERN',
  'ETB',
  'EUR',
  'FJD',
  'FKP',
  'GBP',
  'GEL',
  'GHS',
  'GIP',
  'GMD',
  'GNF',
  'GTQ',
  'GYD',
  'HKD',
  'HNL',
  'HTG',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'IQD',
  'IRR',
  'ISK',
  'JMD',
  'JOD',
  'JPY',
  'KES',
  'KGS',
  'KHR',
  'KMF',
  'KPW',
  'KRW',
  'KWD',
  'KYD',
  'KZT',
  'LAK',
  'LBP',
  'LKR',
  'LRD',
  'LSL',
  'LYD',
  'MAD',
  'MDL',
  'MGA',
  'MKD',
  'MMK',
  'MNT',
  'MOP',
  'MRU',
  'MUR',
  'MVR',
  'MWK',
  'MXN',
  'MYR',
  'MZN',
  'NAD',
  'NGN',
  'NIO',
  'NOK',
  'NPR',
  'NZD',
  'OMR',
  'PAB',
  'PEN',
  'PGK',
  'PHP',
  'PKR',
  'PLN',
  'PYG',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'RWF',
  'SAR',
  'SBD',
  'SCR',
  'SDG',
  'SEK',
  'SGD',
  'SHP',
  'SLE',
  'SLL',
  'SOS',
  'SRD',
  'SSP',
  'STN',
  'SVC',
  'SYP',
  'SZL',
  'THB',
  'TJS',
  'TMT',
  'TND',
  'TOP',
  'TRY',
  'TTD',
  'TWD',
  'TZS',
  'UAH',
  'UGX',
  'USD',
  'UYU',
  'UZS',
  'VES',
  'VND',
  'VUV',
  'WST',
  'XAF',
  'XCD',
  'XOF',
  'XPF',
  'YER',
  'ZAR',
  'ZMW',
  'ZWG',
  'XCG',
  'VED',
]);
// cspell:enable

/** Common forms Intl does not give in every locale; each maps to its currencies. */
// cspell:disable
const EXTRA_SYMBOLS: ReadonlyArray<[string, readonly string[]]> = [
  ['円', ['JPY']],
  ['元', ['CNY']],
  ['kr', ['SEK', 'NOK', 'DKK', 'ISK']],
  ['Kč', ['CZK']],
  ['lei', ['RON']],
  ['лв', ['BGN']],
  ['Rp', ['IDR']],
  ['RM', ['MYR']],
  ['₫', ['VND']],
  ['฿', ['THB']],
  ['₱', ['PHP']],
  ['₦', ['NGN']],
  ['₾', ['GEL']],
  ['₼', ['AZN']],
  ['৳', ['BDT']],
  ['₵', ['GHS']],
  ['₲', ['PYG']],
  ['S/', ['PEN']],
  ['TL', ['TRY']],
  ['Rs.', ['INR', 'PKR', 'LKR', 'NPR']],
  ['Rs', ['INR', 'PKR', 'LKR', 'NPR']],
  ['원', ['KRW']],
  ['ש"ח', ['ILS']],
  ['ש״ח', ['ILS']],
  ['บาท', ['THB']],
  ['ريال', ['SAR']],
  ['ر.س', ['SAR']],
  ['zl', ['PLN']],
];
// cspell:enable

/** Caches are keyed on bounded values only and capped: locales come from visitors. */
const MAX_CACHE_ENTRIES = 512;
const formsCache = new Map<string, Array<[string, readonly string[]]>>();

function remember<Value>(cache: Map<string, Value>, key: string, value: Value): Value {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.clear();
  }
  cache.set(key, value);
  return value;
}

/**
 * A locale reduced to bounded, supported tags: language-script-region (forms
 * differ by region, e.g. "$" in en-CA) and the bare language. Extensions and
 * private-use subtags are dropped, so the key space stays bounded.
 */
function localeTags(locale: string): string[] {
  try {
    const parsed = new Intl.Locale(locale);
    const full = [parsed.language, parsed.script, parsed.region]
      .filter((part): part is string => !!part)
      .join('-');
    return [full, parsed.language].filter(
      (tag) => Intl.NumberFormat.supportedLocalesOf([tag]).length > 0,
    );
  } catch {
    return [];
  }
}

/**
 * The store currency's own written forms, from Intl (narrow symbol, symbol,
 * name in singular and plural) over the given locales: whatever form the model
 * uses in the catalog's or the visitor's language, it is read as money.
 */
/** Languages that put the currency noun before its qualifier ("pesos mexicanos", "złoty polski"). */
const NOUN_FIRST_LANGUAGES = new Set([
  'es',
  'pt',
  'fr',
  'it',
  'ca',
  'ro',
  'pl',
  'id',
  'ms',
  'vi',
  'he',
  'ar',
]);

function localeLanguage(locale: string): string {
  return locale.split('-')[0]?.toLowerCase() ?? '';
}

function storeCurrencyForms(
  currency: string | undefined,
  locales: readonly string[],
): Array<[string, readonly string[]]> {
  if (currency === undefined) {
    return [];
  }
  const languages = [...new Set([...locales, 'en'].flatMap(localeTags))].sort();
  const key = `${currency}|${languages.join(',')}`;
  const cached = formsCache.get(key);
  if (cached) {
    return cached;
  }
  const forms = new Set<string>();
  for (const locale of languages) {
    for (const currencyDisplay of ['narrowSymbol', 'symbol', 'name'] as const) {
      // Whole samples bring the plural forms ("5 korun", "5 рублей"); 2.5 the fractional one.
      for (const sample of [1, 2, 5, 2.5]) {
        try {
          const parts = new Intl.NumberFormat(locale, {
            style: 'currency',
            currency,
            currencyDisplay,
            ...(Number.isInteger(sample)
              ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
              : {}),
          }).formatToParts(sample);
          const form = parts.find((part) => part.type === 'currency')?.value.trim();
          if (form && !/^\d/.test(form)) {
            const normalized = form.normalize('NFKC');
            forms.add(normalized);
            // "pesos mexicanos", "Schweizer Franken": the everyday name is the noun,
            // never a qualifier ("New", "Swiss", "des", "российских").
            const words = normalized.split(/\s+/u);
            const noun = NOUN_FIRST_LANGUAGES.has(localeLanguage(locale)) ? words[0] : words.at(-1);
            if (words.length > 1 && noun !== undefined && noun.length >= 3) {
              forms.add(noun);
            }
          }
        } catch {
          continue;
        }
      }
    }
  }
  const result: Array<[string, readonly string[]]> = [...forms].map((form) => [form, [currency]]);
  return remember(formsCache, key, result);
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * A symbol as a pattern: one that starts or ends with a cased letter may not
 * touch another cased letter there, so "kraft", "rpm", "FORM" or "reviews"
 * are not "kr", "Rp", "RM" or "R". Kana and Han are not cased: "1500円です" reads.
 */
function symbolToPattern(symbol: string): string {
  const cased = /[\p{Lu}\p{Ll}]/u;
  const before = cased.test(symbol.slice(0, 1)) ? String.raw`(?<![\p{Lu}\p{Ll}])` : '';
  const after = cased.test(symbol.slice(-1)) ? String.raw`(?![\p{Lu}\p{Ll}])` : '';
  return `${before}${escapeForRegExp(symbol)}${after}`;
}

/**
 * A number: groups of exactly three digits after a separator (at most five
 * groups, so a long grouped run stays linear), then an optional decimal part.
 * It never starts inside another number, and "Under $120, 3 colors" reads 120.
 */
const NUMBER_PATTERN = String.raw`(?<!\d)(?<!\d[.,'’])(?:\d{1,2}(?:,\d{2}){1,4},\d{3}(?:\.\d+)?|\d{1,3}(?:[   ,.'’]\d{3}){1,5}(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?:[.,][-–])?`;
// cspell:disable
/** A magnitude between a number and its currency: "1,5 тыс. ₽", "1.5k USD", "2 mil reais". */
const THOUSANDS = String.raw`thousand|tausend|duizend|mille|mila|тысяч\p{L}*|тисяч\p{L}*|тыс|тис|tys|Tsd|mil|k`;
const MILLIONS = String.raw`millions?|millionen|millones|milhões|milioni|миллион\p{L}*|мільйон\p{L}*|млн|mln|Mio`;
const MAGNITUDE_PATTERN = String.raw`(?:${THOUSANDS}|${MILLIONS})(?![\p{L}])\.?`;
/** "2 millones de euros", "2 milioni di euro", "2 millions d'euros". */
const MAGNITUDE_LINK = String.raw`(?:\s+(?:de|di)(?=\s)|\s?d['’])?`;
const MAGNITUDES: ReadonlyArray<[RegExp, number]> = [
  [new RegExp(String.raw`^(?:${THOUSANDS})\.?$`, 'iu'), 1_000],
  [new RegExp(String.raw`^(?:${MILLIONS})\.?$`, 'iu'), 1_000_000],
];

function magnitudeFactor(magnitude: string | undefined): number | undefined {
  return magnitude === undefined
    ? undefined
    : MAGNITUDES.find(([pattern]) => pattern.test(magnitude))?.[1];
}
// cspell:enable

function scaled(values: readonly Decimal[], magnitude: string | undefined): Decimal[] {
  if (magnitude === undefined) {
    return [...values];
  }
  const factor = magnitudeFactor(magnitude);
  return factor === undefined ? [] : values.map((value) => value.times(factor));
}

/** A 3-letter code glued or spaced to the number: "USD99", "USD 99", "99usd". */
const CODE_PATTERN = String.raw`(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])`;
const WORD_PATTERN = String.raw`(?:u\.?s\.?\s?)?[\p{L}]{1,15}\.?`;
/** Between token and number: up to three spaces, colons or hyphens ("USD:99", "USD - 99"). */
const GAP_PATTERN = String.raw`[\s:-]{0,3}`;

const patternsCache = new Map<string, { prefix: RegExp; postfix: RegExp }>();

function patternsFor(symbols: ReadonlyArray<[string, readonly string[]]>) {
  const key = symbols.map(([symbol]) => symbol).join('\u0000');
  const cached = patternsCache.get(key);
  if (cached) {
    return cached;
  }
  // Longest first, so "R$" is tried before "$".
  const symbolPattern = [...new Set(symbols.map(([symbol]) => symbol))]
    .sort((left, right) => right.length - left.length)
    .map(symbolToPattern)
    .join('|');
  const patterns = {
    prefix: new RegExp(
      String.raw`(?<token>${symbolPattern}|${CODE_PATTERN})${GAP_PATTERN}(?<number>${NUMBER_PATTERN})(?:\s?(?<magnitude>${MAGNITUDE_PATTERN}))?`,
      'gdiu',
    ),
    postfix: new RegExp(
      String.raw`(?<number>${NUMBER_PATTERN})(?:\s?(?<magnitude>${MAGNITUDE_PATTERN})${MAGNITUDE_LINK})?${GAP_PATTERN}(?<token>${symbolPattern}|${CODE_PATTERN}|${WORD_PATTERN})`,
      'gdiu',
    ),
  };
  return remember(patternsCache, key, patterns);
}

export interface MoneyAmount {
  values: Decimal[];
  currencies: readonly string[];
  raw: string;
  index: number;
  /** Where the number itself starts: one number read two ways is one amount. */
  numberIndex: number;
  /** The two bounds of a range share it (the other bound's numberIndex); else numberIndex. */
  group: number;
  /** The magnitude factor written with the number ("1,5 тыс." is 1000), if any. */
  scale?: number;
}

function decimalSeparatorFor(locale: string): string {
  try {
    const decimal =
      new Intl.NumberFormat(locale).formatToParts(12345.6).find((part) => part.type === 'decimal')
        ?.value ?? '.';
    // Arabic separators are folded to ASCII before reading (normalizeForCheck).
    return foldSeparators(decimal);
  } catch {
    return '.';
  }
}

const SPACE_GROUP_SEPARATORS = [' ', ' ', ' ', "'", '’'];

/**
 * Read a number with one locale's decimal sign. Everything before it must be
 * plain digits, or groups of exactly three digits after one consistent group
 * separator: "1.299,00" reads 1299 with a decimal comma, but "1.20" never
 * reads 120 (a dot before two digits is not a group sign).
 */
function parseWith(raw: string, decimal: string): Decimal | undefined {
  // "99,-" / "99.–" (German retail): the dash says "no cents".
  raw = raw.replace(/[.,][-–]$/, '');
  // Indian grouping (en-IN, hi): 1,23,456 with a decimal point.
  if (decimal === '.' && /^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$/.test(raw)) {
    return new Decimal(raw.replace(/,/g, ''));
  }
  const parts = raw.split(decimal);
  if (parts.length > 2) {
    return undefined;
  }
  const [integerPart = '', fraction] = parts;
  if (fraction !== undefined && !/^\d+$/.test(fraction)) {
    return undefined;
  }
  const otherSeparator: Readonly<Record<string, string>> = { '.': ',', ',': '.' };
  const other = otherSeparator[decimal];
  const groupSeparators =
    other === undefined ? SPACE_GROUP_SEPARATORS : [...SPACE_GROUP_SEPARATORS, other];
  let integerDigits: string | undefined;
  if (/^\d+$/.test(integerPart)) {
    integerDigits = integerPart;
  } else {
    const separator = integerPart.match(/\D/)?.[0];
    if (separator !== undefined && groupSeparators.includes(separator)) {
      const grouped = new RegExp(`^\\d{1,3}(?:${escapeForRegExp(separator)}\\d{3})+$`);
      integerDigits = grouped.test(integerPart) ? integerPart.split(separator).join('') : undefined;
    }
  }
  if (integerDigits === undefined) {
    return undefined;
  }
  return new Decimal(fraction === undefined ? integerDigits : `${integerDigits}.${fraction}`);
}

function currenciesFor(
  rawToken: string,
  number: string,
  storeCurrency: string | undefined,
  symbols: ReadonlyArray<[string, readonly string[]]>,
): readonly string[] | undefined {
  // A word at the end of a sentence carries its punctuation ("99 dollars."): drop it.
  const token = /^\p{L}/u.test(rawToken) ? rawToken.replace(/[.!?,;:]+$/u, '') : rawToken;
  // Letter forms ("kr", "RM", "R") match case-sensitively: "rm" or "r" are not money.
  // The store currency's own forms match in any case: its prices must never slip by.
  const ownForm =
    storeCurrency !== undefined &&
    symbols.some(
      ([candidate, currencies]) =>
        currencies.length === 1 &&
        currencies[0] === storeCurrency &&
        (candidate.toLowerCase() === token.toLowerCase() ||
          candidate.toLowerCase() === rawToken.toLowerCase()),
    );
  if (ownForm && storeCurrency !== undefined) {
    return [storeCurrency];
  }
  // Symbols are matched as written too: "Fr." and "Rs." end in a dot.
  const matchingSymbols = symbols.filter(
    ([candidate]) => candidate === token || candidate === rawToken,
  );
  if (matchingSymbols.length > 0) {
    return [...new Set(matchingSymbols.flatMap(([, currencies]) => currencies))];
  }
  const word = WORDS.find(([pattern]) => pattern.test(token) || pattern.test(rawToken));
  if (word) {
    return word[1];
  }
  if (storeCurrency === 'GBP' && POUND_RE.test(token)) {
    return ['GBP'];
  }
  if (storeCurrency === 'HUF' && FORINT_RE.test(token)) {
    return ['HUF'];
  }
  if (storeCurrency === 'CHF' && (FRANC_RE.test(token) || FRANC_RE.test(rawToken))) {
    return ['CHF'];
  }
  const upper = token.toUpperCase();
  // The store's own code is always money, listed or not, word-like or not.
  if (storeCurrency !== undefined && upper === storeCurrency.toUpperCase()) {
    return [storeCurrency];
  }
  if (token.length !== 3 || !ISO_CODES.has(upper)) {
    return undefined;
  }
  // "TOP 5", "ALL 3": a code that is also a word needs a decimal amount to count.
  if (WORD_LIKE_CODES.has(upper) && !/[.,]\d/.test(number)) {
    return undefined;
  }
  return [upper];
}

/** Normalize a string before reading amounts: NFKC folds fullwidth digits and signs. */
/** Zero code points of decimal-digit blocks NFKC does not fold (Arabic-Indic, Persian, Indic, Thai...). */
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66,
  0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810,
];

function foldDigit(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const zero = DIGIT_ZEROS.find((start) => codePoint >= start && codePoint <= start + 9);
  return zero === undefined ? character : String(codePoint - zero);
}

/** The Arabic decimal and thousands signs as ASCII. */
function foldSeparators(text: string): string {
  return text.replace(/٫/g, '.').replace(/٬/g, ',');
}

/**
 * Normalize a string before reading amounts: NFKC folds fullwidth digits and
 * signs; native digits and Arabic separators become ASCII; markdown emphasis
 * ("$**99**", "$1**2**00") is dropped everywhere, since the check text is
 * never rendered; only a tilde between two digits stays ("1,500~2,000" is a range).
 */
export function normalizeForCheck(text: string): string {
  return (
    foldSeparators(stripInvisible(text.normalize('NFKC')).replace(/\p{Nd}/gu, foldDigit))
      // Hyphen, non-breaking hyphen, figure dash, em dash, bar, bullet and minus read as an en dash ("900—1200 ₽").
      .replace(/[\u2010\u2011\u2012\u2014\u2015\u2043\u2212]/gu, '–')
      .replace(/[*_`]+/g, '')
      .replace(/(?<!\d)~+|~+(?!\d)/g, '')
  );
}

/**
 * Run one amount pattern over the text. A candidate whose token is not a
 * currency ("now 99", "for 5") does not consume the number: the scan resumes
 * one character later, so "now 99 USD" still finds "99 USD".
 */
function scan(
  text: string,
  pattern: RegExp,
  tokenFirst: boolean,
  decimals: readonly string[],
  storeCurrency: string | undefined,
  symbols: ReadonlyArray<[string, readonly string[]]>,
  found: MoneyAmount[],
): void {
  const regex = new RegExp(pattern.source, pattern.flags);
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    const token = match.groups?.token;
    const number = match.groups?.number;
    const magnitude = match.groups?.magnitude;
    const tokenSpan = match.indices?.groups?.token;
    const numberSpan = match.indices?.groups?.number;
    const currencies =
      token === undefined || number === undefined
        ? undefined
        : currenciesFor(token, number, storeCurrency, symbols);
    const numberIndex = numberSpan?.[0] ?? match.index;
    const tokenStart = tokenSpan?.[0] ?? match.index;
    const tokenEnd = tokenSpan?.[1] ?? numberIndex;
    const numberEnd = numberSpan?.[1] ?? tokenStart;
    const matchEnd = match.index + match[0].length;
    // "1200 € - 2 Farben": a symbol that closes one number does not open the next across a dash.
    const closesPrevious =
      tokenFirst &&
      /[-–]/.test(text.slice(tokenEnd, numberIndex)) &&
      /\d[\s:]{0,3}$/.test(text.slice(Math.max(0, match.index - 4), match.index));
    const isHours =
      token !== undefined &&
      FRANC_RE.test(token) &&
      (WEEKDAY_BEFORE_RE.test(text.slice(Math.max(0, match.index - 8), match.index)) ||
        HOURS_AFTER_RE.test(text.slice(matchEnd, matchEnd + 24)));
    // "model 2024 - $45": a symbol that opens the next number does not close this one across a dash.
    const opensNext =
      !tokenFirst &&
      /[-–]/.test(text.slice(numberEnd, tokenStart)) &&
      /^\s*\d/.test(text.slice(matchEnd, matchEnd + 4));
    if (!currencies || number === undefined || isHours || closesPrevious || opensNext) {
      regex.lastIndex = match.index + 1;
      continue;
    }
    // A currency next to a number no grammar reads ("$1,20" in ar + en) is
    // still an amount: it can match nothing, so the check fails closed.
    found.push({
      values: scaled(readValues(number, decimals), magnitude),
      currencies,
      raw: match[0],
      index: match.index,
      numberIndex,
      group: numberIndex,
      ...(magnitudeFactor(magnitude) === undefined ? {} : { scale: magnitudeFactor(magnitude) }),
    });
  }
}

/** Range words that are unambiguous in any language. */
// cspell:disable
const RANGE_WORDS = [
  'to',
  'up to',
  'through',
  'thru',
  'bis',
  'bis zu',
  'tot',
  'até',
  'hasta',
  "jusqu'à",
  'jusqu’à',
  'до',
];
/** Range words only in Romance locales ("de $90 a 150"): in English "a" is an article. */
const ROMANCE_RANGE_WORDS = ['a', 'à'];
const ROMANCE_LANGUAGES = new Set(['es', 'pt', 'fr', 'it', 'ca']);
/**
 * Openers and the closing words that are a range separator only after them:
 * "between $90 and 150", "od 900 do 1200 zł"; "de", "da" and "von" also mean
 * "of" ("lot de 3"), so only they need their closing word to open a range.
 */
const PAIRED_OPENERS = new Map<string, readonly string[]>([
  ['between', ['and']],
  ['zwischen', ['und']],
  ['entre', ['y', 'e', 'et']],
  ['tra', ['e']],
  ['fra', ['e']],
  ['tussen', ['en']],
  ['między', ['a']],
  ['od', ['do']],
  ['між', ['та', 'і']],
  ['від', ['до']],
  ['между', ['и']],
  ['von', ['bis']],
  ['van', ['tot']],
  ['dal', ['al']],
  ['dai', ['ai']],
  ['de', ['a', 'à']],
  ['da', ['a']],
  ['du', ['à']],
]);
/** Openers that open a range before a lower bound whatever the separator. */
const RANGE_OPENERS = new Set([
  'from',
  'ab',
  'от',
  'desde',
  'vanaf',
  ...[...PAIRED_OPENERS.keys()].filter(
    (opener) => !['von', 'van', 'de', 'da', 'du', 'dal', 'dai'].includes(opener),
  ),
]);
/** Hedges between an opener or range word and a bound: "zwischen ca. 900 und 1200 €". */
const HEDGE_PATTERN = String.raw`(?:(?:ca|approx|aprox|прибл|ок|ok)\.|about|around|roughly|approximately|circa|ca|etwa|rund|ungefähr|примерно|около|około|unos|unas|environ|cerca\s+de)`;
/** Articles between an opener or range word and a bound: "tussen de 1000 en 1200", "tra i 1000 e i 1200". */
const ARTICLE_PATTERN = String.raw`(?:de|het|the|i|gli|le|les|los|las|os|as)`;
// cspell:enable
// cspell:disable
/** Month names and standard abbreviations, exact (a stem would also match "separately" or "market"). */
const MONTHS = [
  'january|february|march|april|may|june|july|august|september|october|november|december',
  'jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec',
  'januar|februar|märz|juni|juli|oktober|dezember|mär|okt|dez',
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|abr|ago|dic',
  'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|janv|févr|avr|juil|déc',
  'janeiro|fevereiro|março|maio|junho|julho|setembro|outubro|novembro|dezembro',
  'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|янв|фев|мар|апр|июн|июл|авг|сен|окт|ноя|дек',
].join('|');
/** Units, counts and durations, exact. One-letter units count only glued ("150m"), never spaced. */
const UNIT_WORDS = [
  "Uhr|o'clock|hours?|hrs?|часов|часа|час",
  'kg|km|cm|mm|ml|lbs?|oz|mAh|kW|GB|TB',
  'pcs|pieces?|items?|units?|unidades?|unités?|Stück|шт|people|persons?|personas?|pessoas?|personnes?|Personen|человек|guests?|Gäste',
  'days?|weeks?|months?|years?|Tagen?|Tage|Wochen?|Monaten?|Monate|Jahren?|Jahre|días?|dias?|jours?|дней|дня|день|недели|неделя|недель|месяцев|месяца|месяц|лет|года|год|semanas?|meses|mois|semaines?|años?|anos?',
].join('|');
/** Before a lower bound: a size, pack, model or article number, not money ("lot de 3 - 45 €", "Art. 900 - 1200 €"). */
const QUANTITY_BEFORE_RE =
  /(?:^|[^\p{L}])(?:(?:size|größe|grösse|taille|talla|tamanho|taglia|размер|pack|lot|set|kit|paquete|confezione|model|modell|modelo|modèle|version|option|sku|item|room|day|tag|día|dia|jour)(?:[ \t]+(?:de|da|von|of))?|(?:art|nr|no|ref)\.?)[ \t]*$|[#№][ \t]*$/iu;
/** A year upper bound before one of these is an edition, not a price ("$1200 - 2026 edition"). */
const EDITION_WORDS =
  'edition|model|collection|season|Edition|Kollektion|Modell|Saison|edición|colección|temporada|édition|modèle|коллекция|модель|сезон';
// cspell:enable
/** After an upper bound: a glued word or sign, a time, a unit or a day-month date means it is not money. */
const NOT_MONEY_AFTER_RE = new RegExp(
  String.raw`^(?:\s?[%‰°]|[\p{L}\d]|:\d|\.?\s*(?:${MONTHS})\.?(?![\p{L}])|\s*(?:${UNIT_WORDS})(?![\p{L}]))`,
  'iu',
);
const YEAR_RE = /^(?:19|20)\d{2}$/;
const EDITION_AFTER_RE = new RegExp(String.raw`^\s+(?:${EDITION_WORDS})(?![\p{L}])`, 'iu');
/** How far before an amount a lower bound is looked for. */
const RANGE_HEAD_CHARS = 64;

function isRomance(locales: readonly string[]): boolean {
  return locales.some((locale) => ROMANCE_LANGUAGES.has(locale.split('-')[0]?.toLowerCase() ?? ''));
}

function rangeSeparator(): string {
  const closers = [...PAIRED_OPENERS.values()].flat();
  const words = [...new Set([...RANGE_WORDS, ...ROMANCE_RANGE_WORDS, ...closers])]
    .sort((left, right) => right.length - left.length)
    .map((word) => word.replace(' ', String.raw`\s+`));
  return String.raw`(?<sep>[-–~〜]|(?:${words.join('|')})(?![\p{L}]))`;
}

const TRAILING_HEDGE_RE = new RegExp(String.raw`(?:^|[^\p{L}])${HEDGE_PATTERN}\s*$`, 'iu');
const TRAILING_ARTICLE_RE = new RegExp(String.raw`(?:^|[^\p{L}])${ARTICLE_PATTERN}\s+$`, 'iu');

function skipHedges(before: string): string {
  let rest = before;
  for (let skipped = 0; skipped < 2; skipped += 1) {
    const hedge = TRAILING_HEDGE_RE.exec(rest);
    if (!hedge) {
      break;
    }
    rest = rest.slice(0, hedge.index + (/^[^\p{L}]/u.test(hedge[0]) ? 1 : 0));
  }
  return rest;
}

function lastWord(text: string): string | undefined {
  return /(\p{L}+)\s*$/u.exec(text)?.[1]?.toLowerCase();
}

function isOpener(word: string | undefined): boolean {
  return word !== undefined && (RANGE_OPENERS.has(word) || PAIRED_OPENERS.has(word));
}

/**
 * The word right before a position, past up to two hedges ("between about
 * 900") and an article when an opener stands before it ("tussen de 1000"),
 * lowercased. "de" itself stays an opener when no opener precedes it.
 */
function openerBefore(text: string, position: number): string | undefined {
  const before = skipHedges(text.slice(Math.max(0, position - 48), position));
  const word = lastWord(before);
  const article = TRAILING_ARTICLE_RE.exec(before);
  if (article) {
    const beyond = lastWord(
      skipHedges(before.slice(0, article.index + (/^[^\p{L}]/u.test(article[0]) ? 1 : 0))),
    );
    if (isOpener(beyond)) {
      return beyond;
    }
  }
  return word;
}

/** A dash, tilde or range word is a separator on its own; a paired closer ("and") only after its opener. */
function separatorOpens(separator: string, opener: string | undefined, romance: boolean): boolean {
  const word = separator.toLowerCase().replace(/\s+/gu, ' ');
  if (
    /^[-–~〜]$/.test(word) ||
    RANGE_WORDS.includes(word) ||
    (romance && ROMANCE_RANGE_WORDS.includes(word))
  ) {
    return true;
  }
  return opener !== undefined && (PAIRED_OPENERS.get(opener)?.includes(word) ?? false);
}

function readValues(raw: string, decimals: readonly string[]): Decimal[] {
  return decimals
    .map((decimal) => parseWith(raw, decimal))
    .filter((value): value is Decimal => value !== undefined);
}

function isBelow(lower: readonly Decimal[], upper: readonly Decimal[]): boolean {
  return lower.some((low) => upper.some((high) => low.lessThan(high)));
}

/**
 * A range shares its currency with the bound that has none: "$90-150" and
 * "from $90 to 150" carry it forward, "999-1200 USD" and "от 999 до 1200 ₽"
 * back. A false negative lets an invented price through, so a range is
 * assumed unless there is exact evidence otherwise: the lower bound is not
 * below the upper; a glued word, sign, time, unit, count or day-month date
 * follows the upper bound; a year upper bound comes before an edition word;
 * the lower bound is glued to a model ("X900") or follows a size, pack,
 * model or article word ("lot de 3", "Art. 900"), or is a year before a
 * spaced dash ("Ski Jacket 2025 - $2400").
 */
function addRangeBounds(
  text: string,
  found: MoneyAmount[],
  decimals: readonly string[],
  locales: readonly string[],
): void {
  const separator = rangeSeparator();
  const romance = isRomance(locales);
  const hedges = String.raw`(?:${ARTICLE_PATTERN}\s+)?(?:${HEDGE_PATTERN}\s*){0,2}`;
  const tailRe = new RegExp(
    String.raw`(?<gap>\s*${separator}\s*${hedges})(?<number>${NUMBER_PATTERN})(?:\s?(?<magnitude>${MAGNITUDE_PATTERN}))?`,
    'iuy',
  );
  const headRe = new RegExp(
    String.raw`(?<![\p{L}\d.,'’])(?<number>${NUMBER_PATTERN})(?:\s?(?<magnitude>${MAGNITUDE_PATTERN}))?(?<gap>\s*${separator}\s*${hedges})$`,
    'iu',
  );
  const taken = new Set(found.map((amount) => amount.numberIndex));
  for (const amount of [...found]) {
    const end = amount.index + amount.raw.length;
    tailRe.lastIndex = end;
    const tail = tailRe.exec(text);
    const tailGap = tail?.groups?.gap;
    const tailWord = tail?.groups?.sep;
    const upper = tail?.groups?.number;
    if (tail && tailGap !== undefined && tailWord !== undefined && upper !== undefined) {
      const offset = end + tailGap.length;
      const after = text.slice(end + tail[0].length, end + tail[0].length + 32);
      const values = scaled(readValues(upper, decimals), tail.groups?.magnitude);
      // "$1.2-1.5k": the upper bound's magnitude may be the lower bound's too.
      const upperFactor = magnitudeFactor(tail.groups?.magnitude);
      if (upperFactor !== undefined && amount.scale === undefined) {
        amount.values.push(...amount.values.map((value) => value.times(upperFactor)));
      }
      const edition = YEAR_RE.test(upper) && EDITION_AFTER_RE.test(after);
      if (
        !taken.has(offset) &&
        separatorOpens(tailWord, openerBefore(text, amount.index), romance) &&
        isBelow(amount.values, values) &&
        !NOT_MONEY_AFTER_RE.test(after) &&
        !edition
      ) {
        taken.add(offset);
        found.push({
          values,
          currencies: amount.currencies,
          raw: upper,
          index: offset,
          numberIndex: offset,
          group: amount.numberIndex,
        });
      }
    }
    const before = text.slice(Math.max(0, amount.index - RANGE_HEAD_CHARS), amount.index);
    const head = headRe.exec(before);
    const lower = head?.groups?.number;
    const headGap = head?.groups?.gap;
    const headWord = head?.groups?.sep;
    if (head && lower !== undefined && headGap !== undefined && headWord !== undefined) {
      const offset = amount.index - before.length + head.index;
      const preceding = text.slice(Math.max(0, offset - 32), offset);
      const opener = openerBefore(text, offset);
      const values = scaled(readValues(lower, decimals), head.groups?.magnitude);
      // "1,2–1,5 тыс. ₽": the upper bound's magnitude may be the lower bound's too.
      if (amount.scale !== undefined && head.groups?.magnitude === undefined) {
        const factor = amount.scale;
        values.push(...values.map((value) => value.times(factor)));
      }
      const opened = opener !== undefined && RANGE_OPENERS.has(opener);
      const yearBeforeSpacedDash = YEAR_RE.test(lower) && /\s[-–]\s/.test(headGap);
      if (
        !taken.has(offset) &&
        separatorOpens(headWord, opener, romance) &&
        isBelow(values, amount.values) &&
        (opened || (!QUANTITY_BEFORE_RE.test(preceding) && !yearBeforeSpacedDash))
      ) {
        taken.add(offset);
        found.push({
          values,
          currencies: amount.currencies,
          raw: lower,
          index: offset,
          numberIndex: offset,
          group: amount.numberIndex,
        });
      }
    }
  }
}

function symbolsFor(
  storeCurrency: string | undefined,
  locales: readonly string[],
): Array<[string, readonly string[]]> {
  return [
    ...SYMBOLS,
    ...EXTRA_SYMBOLS,
    ...(storeCurrency === 'CHF' ? FRANC_SYMBOLS : []),
    ...storeCurrencyForms(storeCurrency, locales),
  ];
}

/** Whether a token alone is a currency ("Rs.", "Fr.", "руб."), for lending it to the next sentence. */
function isCurrencyToken(
  token: string,
  storeCurrency: string | undefined,
  locales: readonly string[],
): boolean {
  const normalized = normalizeForCheck(token);
  return (
    currenciesFor(normalized, '1', storeCurrency, symbolsFor(storeCurrency, locales)) !== undefined
  );
}

/**
 * Money amounts in a string: a currency symbol (static, plus the store
 * currency's own forms from Intl), ISO 4217 code (any case, glued or spaced)
 * or currency word next to a number, read with each locale's decimal separator
 * (CLDR through Intl). Bare numbers are not amounts (5.5).
 */
export function extractAmounts(
  text: string,
  locales: readonly string[],
  storeCurrency?: string,
): MoneyAmount[] {
  const decimals = [...new Set(locales.map(decimalSeparatorFor))];
  const symbols = symbolsFor(storeCurrency, locales);
  const { prefix, postfix } = patternsFor(symbols);
  const normalized = normalizeForCheck(text);
  const found: MoneyAmount[] = [];
  scan(normalized, prefix, true, decimals, storeCurrency, symbols, found);
  scan(normalized, postfix, false, decimals, storeCurrency, symbols, found);
  addRangeBounds(normalized, found, decimals, locales);
  // One number read both ways ("$99 USD") is one amount; different numbers stay apart.
  found.sort((left, right) => left.index - right.index);
  const seenNumbers = new Set<number>();
  return found.filter((amount) => {
    if (seenNumbers.has(amount.numberIndex)) {
      return false;
    }
    seenNumbers.add(amount.numberIndex);
    return true;
  });
}

interface Allowed {
  value: Decimal;
  currency: string;
}

function matches(amount: MoneyAmount, allowed: readonly Allowed[]): boolean {
  return amount.values.some((value) =>
    allowed.some(
      (entry) => amount.currencies.includes(entry.currency) && value.equals(entry.value),
    ),
  );
}

export interface PriceCheckContext {
  storeCurrency: string;
  /** The store's whole catalog by `d`: product mentions are matched against all of it. */
  items: ReadonlyMap<string, CatalogItem>;
  visitorMessages: readonly string[];
  policyPassages: readonly string[];
  locales: readonly string[];
}

export interface PriceViolation {
  where: string;
  text: string;
}

function itemPrices(item: CatalogItem): Allowed[] {
  const currency = item.price.currency;
  return [
    { value: new Decimal(item.price.amount), currency },
    ...item.variants.map((variant) => ({ value: new Decimal(variant.price), currency })),
  ];
}

function itemsOf(
  addresses: readonly string[],
  items: ReadonlyMap<string, CatalogItem>,
): CatalogItem[] {
  return addresses
    .map((address) => parseAddress(address)?.d)
    .map((d) => (d === undefined ? undefined : items.get(d)))
    .filter((item): item is CatalogItem => item !== undefined);
}

function componentAddresses(answer: Answer): string[][] {
  return answer.components.map((component) => {
    switch (component.type) {
      case 'products':
        return component.picks.map((pick) => pick.address);
      case 'comparison':
        return component.addresses;
      case 'plan':
        return component.steps.flatMap((step) => step.addresses);
      case 'guide':
        return [];
    }
  });
}

// cspell:disable
/** Abbreviations whose dot does not end a sentence ("ca. 1200 €", "Art. 900"). */
const ABBREVIATIONS =
  'ca|approx|inkl|zzgl|exkl|art|nr|z\\.b|bzw|ggf|vs|stk|ref|env|aprox|ok|прибл|ок|арт|tsd|mio|mrd|mld|mln|tys|тыс|тис|млн';
// cspell:enable
/** Splits sentences and keeps the separators, so stripping does not collapse markdown. */
const SENTENCE_SPLIT_RE = new RegExp(
  String.raw`((?<=[.!?])(?<!(?:^|[^\p{L}])(?:${ABBREVIATIONS})\.)[ \t]+|\n+)`,
  'iu',
);
/** The last dotted token of a sentence: it may be the symbol of the next sentence's number ("Rs. 999"). */
const DOTTED_TAIL_RE = /(?:^|\s)(\S{1,8}\.)$/u;

function sentencesOf(text: string): { sentences: string[]; separators: string[] } {
  const parts = text.split(SENTENCE_SPLIT_RE);
  const sentences: string[] = [];
  const separators: string[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      sentences.push(part);
    } else {
      separators.push(part);
    }
  });
  return { sentences, separators };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `text` contains `name` as a whole word sequence (Unicode-aware), case-insensitive. */
function mentions(text: string, name: string): boolean {
  return (
    name.length > 2 &&
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text)
  );
}

/** Products a string names, by title or `d` as whole words, from the whole catalog. */
function namedProducts(text: string, items: ReadonlyMap<string, CatalogItem>): CatalogItem[] {
  // A cheap substring test first: the word-boundary regex runs only for candidates.
  const lower = text.toLowerCase();
  const candidate = (name: string) => name.length > 2 && lower.includes(name.toLowerCase());
  return [...items.values()].filter(
    (item) =>
      (candidate(item.title) && mentions(text, item.title)) ||
      (candidate(item.d) && mentions(text, item.d)),
  );
}

/**
 * Check every model-written string of an answer against the allowed amounts
 * (5.5). Returns the violations; empty means the answer passes.
 */
export function checkPrices(answer: Answer, context: PriceCheckContext): PriceViolation[] {
  const perComponent = componentAddresses(answer).map((addresses) =>
    itemsOf(addresses, context.items),
  );
  const cited = [...new Map(perComponent.flat().map((item) => [item.d, item])).values()];
  const base: Allowed[] = cited.flatMap(itemPrices);
  // Sums and differences only over prices of the same frequency (5.2): never a
  // monthly price plus a one-off one.
  const sameFrequency = (left: CatalogItem, right: CatalogItem) =>
    (left.price.frequency ?? 'once') === (right.price.frequency ?? 'once');
  for (const items of perComponent) {
    const first = items[0];
    if (items.length > 1 && first && items.every((item) => sameFrequency(item, first))) {
      base.push({
        value: items.reduce((sum, item) => sum.plus(item.price.amount), new Decimal(0)),
        currency: context.storeCurrency,
      });
    }
  }
  answer.components.forEach((component, index) => {
    if (component.type !== 'comparison') {
      return;
    }
    const items = perComponent[index] ?? [];
    for (const left of items) {
      for (const right of items) {
        if (left !== right && sameFrequency(left, right)) {
          base.push({
            value: new Decimal(left.price.amount).minus(right.price.amount).abs(),
            currency: context.storeCurrency,
          });
        }
      }
    }
  });
  const allowedFrom = (texts: readonly string[]): Allowed[] =>
    texts.flatMap((text) =>
      extractAmounts(text, context.locales, context.storeCurrency).flatMap((amount) =>
        amount.values.flatMap((value) =>
          amount.currencies.map((currency) => ({ value, currency })),
        ),
      ),
    );
  const policyAmounts = allowedFrom(context.policyPassages);
  const visitorAmounts = allowedFrom(context.visitorMessages);
  const violations: PriceViolation[] = [];

  const checkString = (where: string, text: string, carriesId: boolean, lead = '') => {
    // A lead (the previous sentence's dotted tail) only lends its symbol: amounts must start here.
    const leadLength = lead ? normalizeForCheck(`${lead} `).length : 0;
    const amounts = extractAmounts(
      lead ? `${lead} ${text}` : text,
      context.locales,
      context.storeCurrency,
    ).filter((amount) => amount.numberIndex >= leadLength);
    if (amounts.length === 0) {
      return;
    }
    const named = namedProducts(text, context.items);
    // A sentence that names a product may state that product's own prices.
    const allowed = [...base, ...named.flatMap(itemPrices)];
    // One figure (or one range) only: a sentence of several is not the visitor's figure repeated.
    const figures = new Set(amounts.map((amount) => amount.group)).size;
    const visitorRuleApplies = figures === 1 && !carriesId && named.length === 0;
    for (const amount of amounts) {
      const inStoreCurrency = amount.currencies.includes(context.storeCurrency);
      const ok =
        (inStoreCurrency && matches(amount, allowed)) ||
        matches(amount, policyAmounts) ||
        (visitorRuleApplies && matches(amount, visitorAmounts));
      if (!ok) {
        violations.push({ where, text });
        return;
      }
    }
  };

  const { sentences } = sentencesOf(answer.text);
  sentences.forEach((sentence, index) => {
    const previous = index > 0 ? sentences[index - 1] : undefined;
    const tailToken = previous === undefined ? undefined : DOTTED_TAIL_RE.exec(previous)?.[1];
    // Only a currency symbol is lent ("Rs." + "999"), never a word like "size.".
    const lead =
      tailToken !== undefined && isCurrencyToken(tailToken, context.storeCurrency, context.locales)
        ? tailToken
        : '';
    checkString(`text#${index}`, sentence, false, lead);
  });
  answer.components.forEach((component, componentIndex) => {
    const prefix = `component#${componentIndex}`;
    switch (component.type) {
      case 'products':
        if (component.title) {
          checkString(`${prefix}.title`, component.title, true);
        }
        component.picks.forEach((pick, pickIndex) => {
          if (pick.reason) {
            checkString(`${prefix}.pick#${pickIndex}`, pick.reason, true);
          }
        });
        break;
      case 'comparison':
        if (component.title) {
          checkString(`${prefix}.title`, component.title, true);
        }
        // Row 0 is the server's price row (5.5): never model-written.
        component.rows.slice(1).forEach((row, rowOffset) => {
          const rowIndex = rowOffset + 1;
          checkString(`${prefix}.row#${rowIndex}.dimension`, row.dimension, true);
          row.cells.forEach((cell, cellIndex) =>
            checkString(`${prefix}.row#${rowIndex}.cell#${cellIndex}`, cell, true),
          );
        });
        break;
      case 'plan':
        checkString(`${prefix}.title`, component.title, false);
        component.steps.forEach((step, stepIndex) => {
          checkString(`${prefix}.step#${stepIndex}.label`, step.label, step.addresses.length > 0);
          if (step.detail) {
            checkString(
              `${prefix}.step#${stepIndex}.detail`,
              step.detail,
              step.addresses.length > 0,
            );
          }
        });
        break;
      case 'guide':
        checkString(`${prefix}.title`, component.title, false);
        component.sections.forEach((section, sectionIndex) => {
          checkString(
            `${prefix}.section#${sectionIndex}`,
            `${section.heading}\n${section.body}`,
            false,
          );
        });
        break;
    }
  });
  answer.chips.forEach((chip, chipIndex) => checkString(`chip#${chipIndex}`, chip, false));
  return violations;
}

/** Short pointers to the cards, appended when sentences were removed (5.5). */
// cspell:disable
const CARDS_POINTER: Readonly<Record<string, string>> = {
  en: 'See the cards for prices.',
  ru: 'Цены указаны в карточках.',
  uk: 'Ціни вказані в картках.',
  es: 'Consulta los precios en las tarjetas.',
  pt: 'Veja os preços nos cartões.',
  de: 'Die Preise stehen auf den Karten.',
  fr: 'Les prix figurent sur les fiches.',
  it: 'I prezzi sono nelle schede.',
};
// cspell:enable

export function cardsPointer(locale: string): string {
  const language = locale.split('-')[0]?.toLowerCase() ?? 'en';
  return CARDS_POINTER[language] ?? CARDS_POINTER.en ?? '';
}

/**
 * Remove whatever failed the check after the one corrective re-run (5.5):
 * failed sentences in place (separators kept, so lists and paragraphs stay),
 * optional strings from components, chips; a failing title goes, a guide
 * section, plan step or comparison row that fails goes entirely. When text was
 * removed, a pointer to the cards is appended.
 */
export function stripViolations(
  answer: Answer,
  violations: readonly PriceViolation[],
  locale = 'en',
): Answer {
  const failed = new Set(violations.map((violation) => violation.where));
  const { sentences, separators } = sentencesOf(answer.text);
  let removedText = false;
  let text = '';
  sentences.forEach((sentence, index) => {
    if (failed.has(`text#${index}`)) {
      removedText = true;
    } else {
      text += sentence;
    }
    if (index < separators.length) {
      text += separators[index] ?? '';
    }
  });
  text = text.replace(/[ \t]+\n/g, '\n').trim();
  if (removedText) {
    text = `${text}${text.length > 0 ? ' ' : ''}${cardsPointer(locale)}`;
  }
  const components = answer.components
    .map((component, componentIndex): Answer['components'][number] | undefined => {
      const prefix = `component#${componentIndex}`;
      const titleFailed = failed.has(`${prefix}.title`);
      switch (component.type) {
        case 'products': {
          const { title, ...rest } = component;
          const picks = component.picks.map((pick, pickIndex) =>
            failed.has(`${prefix}.pick#${pickIndex}`) ? { address: pick.address } : pick,
          );
          return titleFailed || title === undefined
            ? { ...rest, picks }
            : { ...rest, title, picks };
        }
        case 'comparison': {
          const { title, ...rest } = component;
          // A failing dimension drops its row; failing cells become "-". Row 0 is the server's.
          const rows = component.rows
            .map((row, rowIndex) => ({ row, rowIndex }))
            .filter(({ rowIndex }) => !failed.has(`${prefix}.row#${rowIndex}.dimension`))
            .map(({ row, rowIndex }) => ({
              ...row,
              cells: row.cells.map((cell, cellIndex) =>
                failed.has(`${prefix}.row#${rowIndex}.cell#${cellIndex}`) ? '-' : cell,
              ),
            }));
          return titleFailed || title === undefined ? { ...rest, rows } : { ...rest, title, rows };
        }
        case 'plan': {
          if (titleFailed) {
            return undefined;
          }
          const steps = component.steps.filter(
            (_step, stepIndex) =>
              !failed.has(`${prefix}.step#${stepIndex}.label`) &&
              !failed.has(`${prefix}.step#${stepIndex}.detail`),
          );
          return steps.length > 0 ? { ...component, steps } : undefined;
        }
        case 'guide': {
          if (titleFailed) {
            return undefined;
          }
          const sections = component.sections.filter(
            (_section, sectionIndex) => !failed.has(`${prefix}.section#${sectionIndex}`),
          );
          return sections.length > 0 ? { ...component, sections } : undefined;
        }
      }
    })
    .filter((component): component is Answer['components'][number] => component !== undefined);
  const chips = answer.chips.filter((_chip, chipIndex) => !failed.has(`chip#${chipIndex}`));
  return { ...answer, text, components, chips };
}
