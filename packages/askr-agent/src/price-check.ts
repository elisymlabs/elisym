import { type Answer, type CatalogItem, LIMITS, parseAddress } from '@elisym/askr';
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
  [/^(us[\s-]?dollars?|u\.s\.[\s-]?dollars?)$/i, ['USD']],
  [
    /^(dollars?|bucks?|dólar(es)?|доллар(а|ов|ы|ах|ам|ом|у|ами)?|долар(а|ів|и|ах|ам|ом|у)?|бакс(а|ов|ы|ах|ам)?)$/i,
    ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD'],
  ],
  [/^(euros?|евро)$/i, ['EUR']],
  [/^(quid|фунт(а|ов|ы|ів)?\s+стерл[иі]нг(а|ов|ів)?)$/i, ['GBP']],
  [/^(yens?|yenes|ienes|иен(а|ы)?|йен(а|ы)?|єн(а|и)?)$/i, ['JPY']],
  [/^(yuans?|yuanes|iuanes|юан(ь|я|ей|и|ів)?|рмб)$/i, ['CNY']],
  [/^(руб(\.|ль|ля|лей|ли|лях|лям|лём|лем|лю|лями)?|р\.?)$/i, ['RUB']],
  [/^(гривн(а|ы|я|е|у|ой|ею|ам|ах|ами|ями|і|ю)?|гривен|гривень|грн\.?)$/i, ['UAH']],
  // Singular "real" is an ordinary word ("real leather"); a BRL store still reads it as its own form.
  [/^(reais)$/i, ['BRL']],
  [/^(kron(or|er|e|a|ur|en))$/i, ['SEK', 'NOK', 'DKK', 'ISK']],
  [/^(korun[ay]?|korunas)$/i, ['CZK']],
  [/^(rupiah)$/i, ['IDR']],
  [/^(ringgit)$/i, ['MYR']],
  [/^(renminbi)$/i, ['CNY']],
  [/^(forints?)$/i, ['HUF']],
  [/^(shekels?|schekel)$/i, ['ILS']],
  [/^(złot(y|e|ych)|zlot(y|e|ych))$/i, ['PLN']],
  [/^(rupees?|рупи(и|й|я)?)$/i, ['INR']],
  [/^(rubles?|roubles?)$/i, ['RUB']],
  [/^(dolar(y|a|ów|ach|ami)?|dollar[oi])$/i, ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD']],
  [/^(євро)$/i, ['EUR']],
  [/^(sterlin[ae])$/i, ['GBP']],
  [/^(pesos?|песо)$/i, ['MXN', 'ARS', 'CLP', 'COP', 'UYU', 'PHP']],
  [
    /^((schweizer|swiss|zwitserse|швейцарск\p{L}*|швейцарськ\p{L}*)\s+(franken|francs?|frank|франк\p{L}*)|franken)$/iu,
    ['CHF'],
  ],
  [/^(francs?|francos?|franchi|frank(ów|i)?|франк(а|ов|и|ів|ах|ам)?)$/i, ['CHF', 'XOF', 'XAF']],
  [/^(hrywien|hrywn(a|y|ach)?|hryvnias?|hryvnya)$/i, ['UAH']],
  [
    /^((pounds?|pfund|livres?|libras?|pond)\s+(sterling|esterlinas?)|(british|britische[nr]?|britse|english|englische[nr]?|engelse|британск\p{L}*|британськ\p{L}*|английск\p{L}*|англійськ\p{L}*)\s+(pounds?|pfund|pond(en)?|фунт\p{L}*))$/iu,
    ['GBP'],
  ],
  [/^((japanese|японск\p{L}*|японськ\p{L}*)\s+(yen|иен\p{L}*|йен\p{L}*|єн\p{L}*))$/iu, ['JPY']],
  [/^((chinese|китайск\p{L}*|китайськ\p{L}*)\s+(yuan|юан\p{L}*))$/iu, ['CNY']],
  [/^(f?cfa)$/i, ['XOF', 'XAF']],
  [/^(rubel|rublos?|rubli|roebel|рублів)$/i, ['RUB']],
  [/^(злот(ый|ых|ого|ий|их|ого))$/i, ['PLN']],
  [/^(liras?|lirası)$/i, ['TRY']],
];
// cspell:enable

/** "Ft" reads as feet as often as forints: money only in a HUF store. */
const FORINT_RE = /^Ft$/;

/** "Fr." is a weekday abbreviation in German ("Mo.-Fr."): francs only in a CHF store. */
const FRANC_RE = /^Fr\.?$/;
const FRANC_SYMBOLS: ReadonlyArray<[string, readonly string[]]> = [
  ['Fr.', ['CHF']],
  ['SFr.', ['CHF']],
  ['SFr', ['CHF']],
];
/** "Mo.-Fr. 9", "Di.–Fr. 10": a weekday range, not francs. */
const WEEKDAY_BEFORE_RE = /(?:Mo|Di|Mi|Do|Sa|So|Lu|Ma|Me|Je|Ve)\.?\s?(?:[-–]|bis)\s?$/;
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
  ['kr.', ['SEK', 'NOK', 'DKK', 'ISK']],
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

/** Languages that put the currency noun after its qualifier ("Swiss francs", "российский рубль"). */
const NOUN_LAST_LANGUAGES = new Set([
  'en',
  'de',
  'nl',
  'ru',
  'uk',
  'cs',
  'sv',
  'da',
  'nb',
  'hu',
  'bg',
  'ko',
  'hi',
]);
/** An acronym or bracketed qualifier is never the noun ("дирхам ОАЭ", "US dollars"). */
const QUALIFIER_RE = /^(?:[\p{Lu}\p{N}.]+|\(.*\))$/u;

/**
 * The everyday noun of a multi-word currency name: "pesos mexicanos" → pesos,
 * "Schweizer Franken" → Franken, "дирхам ОАЭ" → дирхам. A language of unknown
 * word order fails closed: every word that is not a qualifier.
 */
function currencyNouns(name: string, language: string): string[] {
  const words = name.split(/\s+/u).filter((word) => word.length >= 3 && !QUALIFIER_RE.test(word));
  if (!name.includes(' ') || words.length === 0) {
    return [];
  }
  const allWords = name.split(/\s+/u);
  let ordered: string[] | undefined;
  if (NOUN_FIRST_LANGUAGES.has(language)) {
    ordered = allWords;
  } else if (NOUN_LAST_LANGUAGES.has(language)) {
    ordered = [...allWords].reverse();
  }
  if (ordered === undefined) {
    return words;
  }
  const noun = ordered.find((word) => word.length >= 3 && !QUALIFIER_RE.test(word));
  return noun === undefined ? [] : [noun];
}

function localeLanguage(locale: string): string {
  return locale.split('-')[0]?.toLowerCase() ?? '';
}

/**
 * The store currency's own written forms, from Intl (narrow symbol, symbol,
 * name in singular and plural) over the given locales: whatever form the model
 * uses in the catalog's or the visitor's language, it is read as money.
 */
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
            for (const noun of currencyNouns(normalized, localeLanguage(locale))) {
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
const THOUSANDS = String.raw`thousand|tausend|duizend|mille|mila|тысяч\p{L}*|тисяч\p{L}*|tysi\p{L}+|тыс|тис|tys|Tsd|mil|k`;
const MILLIONS = String.raw`millions?|millionen|millones|millón|milhões|milhão|milioni|milione|miljoen|milion\p{L}*|миллион\p{L}*|мільйон\p{L}*|млн|mln|Mill|Mio`;
const BILLIONS = String.raw`billions?|milliarden?|milliards?|miliard\p{L}*|miljarden|miljard|миллиард\p{L}*|мільярд\p{L}*|mil\s+millones|mil\s+milhões|bilh(?:ão|ões)|млрд|mrd|mld|bn`;
const MAGNITUDE_PATTERN = String.raw`(?:${BILLIONS}|${THOUSANDS}|${MILLIONS})(?![\p{L}])\.?`;
/** "2 millones de euros", "2 milioni di euro", "2 millions d'euros". */
const MAGNITUDE_LINK = String.raw`(?:\s+(?:de|di)(?=\s)|\s?d['’])?`;
const MAGNITUDES: ReadonlyArray<[RegExp, number]> = [
  [new RegExp(String.raw`^(?:${THOUSANDS})\.?$`, 'iu'), 1_000],
  [new RegExp(String.raw`^(?:${MILLIONS})\.?$`, 'iu'), 1_000_000],
  [new RegExp(String.raw`^(?:${BILLIONS})\.?$`, 'iu'), 1_000_000_000],
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
/** A single currency word ("dollars", "руб", "US-Dollar"). */
// cspell:disable
/**
 * Words that qualify a currency noun and the currency they pin ("Canadian dollars" is CAD,
 * "канадских долларов" too): nationality and place stems at a word start, and fixed place pairs.
 */
const QUALIFIERS: ReadonlyArray<[string, string]> = [
  [String.raw`(?:canad|kanad|канад)\p{L}*`, 'CAD'],
  [String.raw`(?:austral|австрал)\p{L}*`, 'AUD'],
  [String.raw`(?:hong[ \t]*kong|гонконг)\p{L}*|hk(?![\p{L}])`, 'HKD'],
  [String.raw`(?:new[ \t]+zealand|новозеланд)\p{L}*|nz(?![\p{L}])`, 'NZD'],
  [String.raw`new[ \t]+taiwan\p{L}*`, 'TWD'],
  [String.raw`south[ \t]+africa\p{L}*`, 'ZAR'],
  [String.raw`south[ \t]+korea\p{L}*`, 'KRW'],
  [String.raw`(?:united[ \t]+states|us|u\.s\.)(?![\p{L}])|(?:americ|amerik|америк)\p{L}*`, 'USD'],
  [String.raw`(?:mexic|mexik|мексик)\p{L}*`, 'MXN'],
  [String.raw`(?:singap|сингапур)\p{L}*`, 'SGD'],
  [String.raw`(?:brit|engl|британ|англ)\p{L}*`, 'GBP'],
  [String.raw`(?:swiss|schweiz|zwitser|швейцар)\p{L}*`, 'CHF'],
  [String.raw`(?:japan|japon|япон)\p{L}*`, 'JPY'],
  [String.raw`(?:chinese|chinesisch\p{L}*|chinees\p{L}*|китайск\p{L}*|китайськ\p{L}*)`, 'CNY'],
  [String.raw`(?:indian|indisch\p{L}*|indiase|индийск\p{L}*|індійськ\p{L}*)`, 'INR'],
  [String.raw`(?:russian|russisch\p{L}*|russische|российск\p{L}*)`, 'RUB'],
  [String.raw`(?:ukrain|україн|украин)\p{L}*`, 'UAH'],
  [String.raw`(?:polish|polnisch\p{L}*|poolse|польск\p{L}*|польськ\p{L}*)`, 'PLN'],
  [String.raw`(?:czech|tschech|tsjech|чешск|чеськ)\p{L}*`, 'CZK'],
  [String.raw`(?:swedish|schwedisch\p{L}*|zweedse|шведск\p{L}*|шведськ\p{L}*)`, 'SEK'],
  [String.raw`(?:norwegian|norwegisch\p{L}*|noorse|norsk[ae]?|норвежск\p{L}*)`, 'NOK'],
  [String.raw`(?:danish|dänisch\p{L}*|deense|dansk[ae]?|датск\p{L}*|датськ\p{L}*)`, 'DKK'],
  [String.raw`(?:hungar|ungar|hongaar)\p{L}*`, 'HUF'],
  [String.raw`(?:turkish|türkisch\p{L}*|turkse|турецк\p{L}*|турецьк\p{L}*)`, 'TRY'],
  [String.raw`(?:israel|израил|ізраїл)\p{L}*`, 'ILS'],
  [String.raw`(?:korean|koreanisch\p{L}*|koreaanse|корейск\p{L}*)`, 'KRW'],
  [String.raw`thai(?![\p{L}])`, 'THB'],
  [String.raw`indones\p{L}*`, 'IDR'],
  [String.raw`philippin\p{L}*`, 'PHP'],
  [String.raw`malays\p{L}*`, 'MYR'],
  [String.raw`argentin\p{L}*`, 'ARS'],
  [String.raw`chile(?:an|n)\p{L}*`, 'CLP'],
  [String.raw`(?:colombi|kolumbi)\p{L}*`, 'COP'],
  [String.raw`(?:brazil|brasil)\p{L}*`, 'BRL'],
];
/** Qualifiers after the noun in Romance languages and English ("dólares canadienses", "dollars Canadian"). */
const POSTPOSED_QUALIFIERS: ReadonlyArray<[string, string]> = [
  [String.raw`canadi(?:en|an|ens|ennes?|ense|enses|esi)|canadesi|canadenses`, 'CAD'],
  [String.raw`australi(?:ens?|ennes?|an|anos|anas|ani)`, 'AUD'],
  [String.raw`americ(?:ain|ains|an|anos|ani)|américains?|estadounidenses?`, 'USD'],
  [String.raw`mexica(?:in|ins|nos|n)|messicani`, 'MXN'],
  [String.raw`argentin(?:os|s|i|o)`, 'ARS'],
  [String.raw`chilen(?:os|i)|chiliens`, 'CLP'],
  [String.raw`colombi(?:anos|ens|ani)`, 'COP'],
  [String.raw`suisses?|suizos|svizzeri|suíços`, 'CHF'],
  [String.raw`polskich|polskie|polski|polacchi|polonais`, 'PLN'],
  [String.raw`brasileñ(?:os|as)|brasileiros|brésiliens`, 'BRL'],
];
/** Nouns that are money only after a qualifier ("South Korean won", not "the team won"). */
const QUALIFIED_NOUNS: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/^won$/i, ['KRW']],
  [/^baht$/i, ['THB']],
  [/^real$/i, ['BRL']],
  [/^(pounds?|pfund|фунт\p{L}*)$/iu, ['GBP']],
  [/^rands?$/i, ['ZAR']],
];
// cspell:enable
const QUALIFIER_PATTERN = QUALIFIERS.map(([pattern]) => pattern).join('|');
const QUALIFIER_RES: ReadonlyArray<[RegExp, string]> = QUALIFIERS.map(([pattern, currency]) => [
  new RegExp(String.raw`^(?:${pattern})[ \t]+`, 'iu'),
  currency,
]);
const POSTPOSED_PATTERN = POSTPOSED_QUALIFIERS.map(([pattern]) => pattern).join('|');
/** An all-caps ISO code right after a postfix currency word ("1200 dollars CAD"). */
const CODE_AFTER_RE = /^[ \t]+([A-Z]{3})(?![\p{L}])/u;
const POSTPOSED_AFTER_RE = new RegExp(
  String.raw`^[ \t]+(?:${POSTPOSED_PATTERN})(?![\p{L}])\.?`,
  'iu',
);
const POSTPOSED_RES: ReadonlyArray<[RegExp, string]> = POSTPOSED_QUALIFIERS.map(
  ([pattern, currency]) => [new RegExp(String.raw`[ \t]+(?:${pattern})\.?$`, 'iu'), currency],
);
/**
 * A multi-word currency token: one qualifier then the noun ("Hong Kong dollars"), or a fixed
 * pound-sterling pair ("pounds sterling", "фунтов стерлингов"). Ordinary words after a number
 * never join a token, so "4.99 EUR for all orders" stays EUR and "900 euros to 5000" keeps its
 * range word outside the token.
 */
const MULTI_WORD_PATTERN = String.raw`(?:${QUALIFIER_PATTERN})[ \t]+[\p{L}]{1,15}(?![\p{L}])\.?|(?:pounds?|pfund|livres?|libras?|pond|фунт\p{L}*)[ \t]+(?:sterling|esterlinas?|стерл[иі]нг(?:а|ов|ів)?)(?![\p{L}])\.?|[\p{L}]{1,15}[ \t]+(?:${POSTPOSED_PATTERN})(?![\p{L}])\.?`;
/** A single currency word ("dollars", "руб", "US-Dollar"). */
const WORD_PATTERN = String.raw`(?:u\.?s\.?[ \t-]?)?[\p{L}]{1,15}\.?`;
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
      String.raw`(?<number>${NUMBER_PATTERN})(?:\s?(?<magnitude>${MAGNITUDE_PATTERN})${MAGNITUDE_LINK})?${GAP_PATTERN}(?<token>${symbolPattern}|${MULTI_WORD_PATTERN}|${CODE_PATTERN}|${WORD_PATTERN})`,
      'gdiu',
    ),
  };
  return remember(patternsCache, key, patterns);
}

export interface MoneyAmount {
  values: Decimal[];
  currencies: string[];
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

/**
 * Every currency a noun can name, over all readings: the store's own form, symbols, listed
 * words, ISO codes and the nouns that are money only after a qualifier.
 */
function nounCurrencies(
  noun: string,
  number: string,
  storeCurrency: string | undefined,
  symbols: ReadonlyArray<[string, readonly string[]]>,
  qualifierCurrency?: string,
): string[] {
  const token = noun.replace(/[.!?,;:]+$/u, '');
  // A qualifier-only noun counts for its own qualifier alone ("Brazilian real", not "Chinese real silk").
  const qualified = (QUALIFIED_NOUNS.find(([pattern]) => pattern.test(token))?.[1] ?? []).filter(
    (currency) => currency === qualifierCurrency,
  );
  const listed = WORDS.find(([pattern]) => pattern.test(token))?.[1] ?? [];
  const staticSymbols = SYMBOLS.filter(([candidate]) => candidate === token).flatMap(
    ([, currencies]) => currencies,
  );
  const read = currenciesFor(noun, number, storeCurrency, symbols) ?? [];
  return [...new Set([...qualified, ...listed, ...staticSymbols, ...read])];
}

/**
 * Currencies of a token. A whole token is read first ("pounds sterling", a store's own name such
 * as "South African rand"). A qualified token ("Canadian dollars", "dólares canadienses") names
 * its qualifier's currency when its noun can be that currency. A noun that is money but cannot
 * be it ("Indian dollars") gives an empty set, which matches nothing: the check fails closed.
 * A noun that is no money at all ("2 polished real brass") gives no amount.
 */
function currenciesForToken(
  rawToken: string,
  number: string,
  storeCurrency: string | undefined,
  symbols: ReadonlyArray<[string, readonly string[]]>,
): readonly string[] | undefined {
  const whole = currenciesFor(rawToken, number, storeCurrency, symbols);
  if (whole !== undefined) {
    return whole;
  }
  const before = QUALIFIER_RES.find(([pattern]) => pattern.test(rawToken));
  const after = before ? undefined : POSTPOSED_RES.find(([pattern]) => pattern.test(rawToken));
  const qualifier = before ?? after;
  if (qualifier === undefined) {
    return undefined;
  }
  const noun = rawToken.replace(qualifier[0], '');
  const named = nounCurrencies(noun, number, storeCurrency, symbols, qualifier[1]);
  if (named.length === 0) {
    return undefined;
  }
  // A qualifier the noun cannot be fails closed ("Indian dollars"); after a store noun matched as
  // a symbol, `scan` then reads the token alone ("19 € Suisse" is a shipping row).
  return named.includes(qualifier[1]) ? [qualifier[1]] : [];
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
      // Hyphen (NFKC folds the non-breaking one into it), figure dash, em dash,
      // bar, hyphen bullet and minus read as an en dash ("900\u20141200 ₽").
      .replace(/[\u2010\u2012\u2014\u2015\u2043\u2212]/gu, '–')
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
    // "1200 dólares canadienses": a qualifier after the token (even after a store's own noun,
    // matched as a symbol) joins it, so the qualifier's currency decides.
    const postposed =
      !tokenFirst && token !== undefined
        ? POSTPOSED_AFTER_RE.exec(
            text.slice(match.index + match[0].length, match.index + match[0].length + 32),
          )
        : null;
    const joined =
      postposed && token !== undefined && number !== undefined
        ? currenciesForToken(`${token}${postposed[0]}`, number, storeCurrency, symbols)
        : undefined;
    // The joined reading counts only when it names a currency; otherwise the token alone does.
    const joinedCounts = joined !== undefined && joined.length > 0;
    const alone =
      token === undefined || number === undefined
        ? undefined
        : currenciesForToken(token, number, storeCurrency, symbols);
    // "1200 dollars CAD": an ISO code after the noun pins it when the noun can be that currency.
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 8);
    const code = !tokenFirst && !joinedCounts ? CODE_AFTER_RE.exec(after) : null;
    const codeName = code?.[1];
    const pinned =
      codeName !== undefined &&
      token !== undefined &&
      number !== undefined &&
      nounCurrencies(token, number, storeCurrency, symbols, codeName).includes(codeName)
        ? [codeName]
        : undefined;
    // A known code the noun cannot be ("1200 dollars EUR") contradicts it: fail closed.
    const contradicted =
      codeName !== undefined &&
      pinned === undefined &&
      ISO_CODES.has(codeName) &&
      // "1200,00 € TOP Angebot": a word-like code (TOP, CUP, ALL) never contradicts a noun.
      !WORD_LIKE_CODES.has(codeName) &&
      alone !== undefined &&
      alone.length > 0;
    const currencies = joinedCounts ? joined : (pinned ?? (contradicted ? [] : alone));
    let raw = match[0];
    if (joinedCounts && postposed) {
      raw = `${match[0]}${postposed[0]}`;
    } else if (pinned && code) {
      raw = `${match[0]}${code[0]}`;
    }
    const numberIndex = numberSpan?.[0] ?? match.index;
    const tokenStart = tokenSpan?.[0] ?? match.index;
    const tokenEnd = tokenSpan?.[1] ?? numberIndex;
    const numberEnd = numberSpan?.[1] ?? tokenStart;
    const matchEnd = match.index + raw.length;
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
      currencies: [...currencies],
      raw,
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
  'tot en met',
  'aż do',
  'й до',
  'fino a',
  'fino ai',
  'и до',
  'і до',
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
    (opener) => !['von', 'de', 'da', 'du', 'dal', 'dai'].includes(opener),
  ),
]);
/** Hedges between an opener or range word and a bound: "zwischen ca. 900 und 1200 €". */
const HEDGE_PATTERN = String.raw`(?:(?:ca|approx|aprox|прибл|ок|ok)\.|about|around|roughly|approximately|circa|ca|etwa|rund|ungefähr|примерно|около|około|unos|unas|environ|cerca\s+de)`;
/** Articles between an opener or range word and a bound: "tussen de 1000 en 1200", "tra i 1000 e i 1200". */
const ARTICLE_PATTERN = String.raw`(?:de|den|het|the|i|gli|le|la|les|el|los|las|os|as)`;
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
function separatorOpens(
  separator: string,
  opener: string | undefined,
  romance: boolean,
  dutch: boolean,
): boolean {
  const word = separator.toLowerCase().replace(/\s+/gu, ' ');
  if (
    /^[-–~〜]$/.test(word) ||
    RANGE_WORDS.includes(word) ||
    (romance && ROMANCE_RANGE_WORDS.includes(word)) ||
    // Dutch writes "1.000 à 1.200 euro".
    (dutch && word === 'à')
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
  const dutch = locales.some((locale) => localeLanguage(locale) === 'nl');
  // An article after a range word only inside an opened range ("tussen de 1000 en de 1200"), never "to the".
  const hedges = String.raw`(?<article>${ARTICLE_PATTERN}\s+)?(?:${HEDGE_PATTERN}\s*){0,2}`;
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
      const upperRead = readValues(upper, decimals);
      const values = scaled(upperRead, tail.groups?.magnitude);
      const opener = openerBefore(text, amount.index);
      // "$1.2-1.5k": one reading only. The upper bound's magnitude is the lower
      // bound's too when the written lower number is below the written upper one.
      const upperFactor = magnitudeFactor(tail.groups?.magnitude);
      const shared =
        upperFactor !== undefined &&
        amount.scale === undefined &&
        isBelow(amount.values, upperRead);
      const lowerReading =
        shared && upperFactor !== undefined
          ? amount.values.map((value) => value.times(upperFactor))
          : amount.values;
      const edition = YEAR_RE.test(upper) && EDITION_AFTER_RE.test(after);
      if (
        !taken.has(offset) &&
        separatorOpens(tailWord, opener, romance, dutch) &&
        (tail.groups?.article === undefined || isOpener(opener)) &&
        isBelow(lowerReading, values) &&
        !NOT_MONEY_AFTER_RE.test(after) &&
        !edition
      ) {
        taken.add(offset);
        amount.values.splice(0, amount.values.length, ...lowerReading);
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
      const lowerRead = readValues(lower, decimals);
      // "1,2–1,5 тыс. ₽": one reading only, as on the tail side.
      const factor = amount.scale;
      const shared =
        factor !== undefined &&
        head.groups?.magnitude === undefined &&
        isBelow(
          lowerRead,
          amount.values.map((value) => value.div(factor)),
        );
      const values =
        shared && factor !== undefined
          ? lowerRead.map((value) => value.times(factor))
          : scaled(lowerRead, head.groups?.magnitude);
      const opened = opener !== undefined && RANGE_OPENERS.has(opener);
      const yearBeforeSpacedDash = YEAR_RE.test(lower) && /\s[-–]\s/.test(headGap);
      if (
        !taken.has(offset) &&
        separatorOpens(headWord, opener, romance, dutch) &&
        (head.groups?.article === undefined || isOpener(opener)) &&
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

/** Static abbreviations that are also ordinary words, so get no dotted form ("Grazie a lei."). */
const UNDOTTED_WORDS = new Set(['lei']);

function symbolsFor(
  storeCurrency: string | undefined,
  locales: readonly string[],
): Array<[string, readonly string[]]> {
  const base: Array<[string, readonly string[]]> = [
    ...SYMBOLS,
    ...EXTRA_SYMBOLS,
    ...(storeCurrency === 'CHF' ? FRANC_SYMBOLS : []),
    ...storeCurrencyForms(storeCurrency, locales),
  ];
  // "Rp. 15.000", "Ksh. 500", "лв. 20", "S/. 15": a static abbreviation of two or more
  // characters is also written with a dot. The store's Intl names are not, and the static lists
  // hold no codes ("Prices are in dollars. 3 colors" is no amount).
  const dotted = [...SYMBOLS, ...EXTRA_SYMBOLS]
    .filter(([symbol]) => /^(?:\p{L}{2,}|S\/)$/u.test(symbol) && !UNDOTTED_WORDS.has(symbol))
    .map(([symbol, currencies]): [string, readonly string[]] => [`${symbol}.`, currencies])
    .filter(([symbol]) => !base.some(([existing]) => existing === symbol));
  return [...base, ...dotted];
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
 * Whether a second reading of the same number restates its currency ("$1200 CAD", "R$ 1200
 * reais") rather than being an unrelated word after it ("$30.00 cup holder", "$1200 AMD
 * edition"): a trailing bare code must be, as written in capitals, one of the currencies the
 * first reading's symbol can mean (no symbol means a word-like code such as TOP or CUP).
 */
function restates(first: MoneyAmount, second: MoneyAmount): boolean {
  const tail = /(?:^|[^\p{L}])([A-Za-z]{3})\.?$/u.exec(second.raw)?.[1];
  if (tail === undefined || !ISO_CODES.has(tail.toUpperCase())) {
    return true;
  }
  const symbol = first.raw.slice(0, first.numberIndex - first.index).trim();
  const possible = new Set([
    ...first.currencies,
    ...[...SYMBOLS, ...EXTRA_SYMBOLS]
      .filter(([candidate]) => candidate.replace(/\.$/u, '') === symbol.replace(/\.$/u, ''))
      .flatMap(([, currencies]) => currencies),
  ]);
  return possible.has(tail);
}

/**
 * Money amounts in a string: a currency symbol (static, plus the store
 * currency's own forms from Intl), ISO 4217 code (any case, glued or spaced)
 * or currency word next to a number, read with each locale's decimal separator
 * (CLDR through Intl). Bare numbers are not amounts (5.5).
 */
// cspell:disable
/**
 * Amounts written with CJK numerals or magnitudes ("3.7万円", "3万7千円", "約三万七千円",
 * "¥3.7万", "3만 7천원", "3700元"): the token scanners above read none of them, so a
 * converted price would pass. Read here, fail closed: any such number next to a CJK
 * currency is an amount, and one whose value is not read exactly has no value, so it
 * matches nothing.
 */
const CJK_DIGITS: Readonly<Record<string, number>> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CJK_SMALL_UNITS: Readonly<Record<string, number>> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  백: 100,
  千: 1_000,
  仟: 1_000,
  천: 1_000,
};
const CJK_LARGE_UNITS: Readonly<Record<string, number>> = {
  万: 10_000,
  萬: 10_000,
  만: 10_000,
  億: 100_000_000,
  亿: 100_000_000,
  억: 100_000_000,
};
const CJK_CHARS = [
  ...Object.keys(CJK_DIGITS),
  ...Object.keys(CJK_SMALL_UNITS),
  ...Object.keys(CJK_LARGE_UNITS),
].join('');
const CJK_ARABIC = String.raw`\d+(?:[.,]\d+)*`;
/** At least one CJK numeral or magnitude, with Arabic digits around them. */
const CJK_EXPRESSION = String.raw`(?:${CJK_ARABIC}\s?)?(?:[${CJK_CHARS}]\s?(?:${CJK_ARABIC}\s?)?)+`;
const CJK_CURRENCIES: ReadonlyArray<[string, readonly string[]]> = [
  ['日元', ['JPY']],
  ['日圓', ['JPY']],
  ['人民币', ['CNY']],
  ['人民幣', ['CNY']],
  ['韩元', ['KRW']],
  ['韓元', ['KRW']],
  ['美元', ['USD']],
  ['ドル', ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD']],
  ['円', ['JPY']],
  ['圆', ['CNY']],
  ['圓', ['CNY']],
  ['元', ['CNY']],
  ['块', ['CNY']],
  ['塊', ['CNY']],
  ['원', ['KRW']],
  ['¥', ['JPY', 'CNY']],
  ['￥', ['JPY', 'CNY']],
  ['₩', ['KRW']],
];
const CJK_CURRENCY = CJK_CURRENCIES.map(([token]) => token).join('|');
/** Read by the token scanners when the number is plain digits ("37,000円"): left to them. */
const SCANNED_CJK_TOKENS: readonly string[] = ['円', '元', '원', '¥', '￥', '₩'];
const CJK_CHAR_RE = new RegExp(`[${CJK_CHARS}]`, 'u');
const CJK_RANGE = String.raw`\s?[〜~～–]\s?`;
/** A currency before the number may be followed by a particle ("円で3.7万"). */
const CJK_PREFIX_GAP = String.raw`[\s:：でにはが約约]{0,2}`;
const CJK_AMOUNT_RE = new RegExp(
  String.raw`(?:(?<before>${CJK_CURRENCY})${CJK_PREFIX_GAP})?(?<lower>${CJK_EXPRESSION}|${CJK_ARABIC})(?:${CJK_RANGE}(?<upper>${CJK_EXPRESSION}|${CJK_ARABIC}))?\s?(?<after>${CJK_CURRENCY})?`,
  'gu',
);
// cspell:enable

const TEN = 10;

/**
 * The exact value of one CJK expression, or undefined when it does not read cleanly: an
 * explicit zero before a unit ("0万"), a repeated or rising large unit, a comma, or a bare
 * number after a unit that convention may abbreviate ("三万五" is 35000 to a reader, "一千二"
 * 1200). After 万 / 億 only a full group of plain digits reads ("3万7000" is 37000), after 十
 * one digit ("十五" is 15).
 */
export function readCjkNumber(expression: string): Decimal | undefined {
  const tokens = expression.replace(/\s/g, '').match(new RegExp(`${CJK_ARABIC}|.`, 'gu')) ?? [];
  let total = new Decimal(0);
  let section = new Decimal(0);
  let sectionHasCoefficient = false;
  let pending: Decimal | undefined;
  let pendingToken = '';
  let lastLarge = Number.POSITIVE_INFINITY;
  let lastUnit: 'none' | 'small' | 'large' = 'none';
  let lastSmall = 0;
  for (const token of tokens) {
    const digit = CJK_DIGITS[token];
    const small = CJK_SMALL_UNITS[token];
    const large = CJK_LARGE_UNITS[token];
    if (/^\d/.test(token) || digit !== undefined) {
      // Only a plain decimal point reads: "3,7" or "1,000" next to a magnitude is ambiguous.
      if (pending !== undefined || (digit === undefined && !/^\d+(?:\.\d+)?$/.test(token))) {
        return undefined;
      }
      pending = new Decimal(digit ?? token);
      pendingToken = token;
    } else if (small !== undefined || large !== undefined) {
      if (pending?.isZero()) {
        return undefined;
      }
      if (small !== undefined) {
        section = section.plus((pending ?? new Decimal(1)).times(small));
        sectionHasCoefficient = true;
        lastUnit = 'small';
        lastSmall = small;
      } else if (large !== undefined) {
        // Larger units come first ("1億2千万"); a repeated or rising one does not read.
        if (large >= lastLarge) {
          return undefined;
        }
        lastLarge = large;
        const hasCoefficient = pending !== undefined || sectionHasCoefficient;
        total = total.plus(
          (hasCoefficient ? section.plus(pending ?? 0) : new Decimal(1)).times(large),
        );
        section = new Decimal(0);
        sectionHasCoefficient = false;
        lastUnit = 'large';
      }
      pending = undefined;
      pendingToken = '';
    } else {
      return undefined;
    }
  }
  if (pending !== undefined && lastUnit !== 'none') {
    const groupDigits = String(Math.log10(lastLarge));
    const fullGroup =
      lastUnit === 'large' && new RegExp(`^\\d{${groupDigits}}$`).test(pendingToken);
    // After 十 the bare digit can only be the ones ("十五" is 15).
    const ones = lastUnit === 'small' && lastSmall === TEN && /^\d$|^\D$/u.test(pendingToken);
    if (!fullGroup && !ones) {
      return undefined;
    }
  }
  return total.plus(section).plus(pending ?? 0);
}

function cjkValues(expression: string): Decimal[] {
  const value = readCjkNumber(expression);
  return value === undefined ? [] : [value];
}

function cjkCurrencies(token: string): readonly string[] {
  return CJK_CURRENCIES.find(([candidate]) => candidate === token)?.[1] ?? [];
}

/**
 * Add the CJK amounts and drop the token readings that overlap them ("¥3.7" of "¥3.7万").
 * Plain digits count only with a currency word the token scanners do not read ("199ドル").
 */
function scanCjk(text: string, found: MoneyAmount[], decimals: readonly string[]): void {
  const cjk: MoneyAmount[] = [];
  /** Where each CJK match starts, and where its numbers end: readings inside are replaced. */
  const covered: Array<{ start: number; end: number; numberStart: number; numberEnd: number }> = [];
  for (const match of text.matchAll(CJK_AMOUNT_RE)) {
    const groups = match.groups ?? {};
    const tokens = [groups.before, groups.after].filter(
      (token): token is string => token !== undefined,
    );
    const lower = groups.lower;
    if (tokens.length === 0 || lower === undefined) {
      continue;
    }
    // A currency on both sides must agree: "¥3万ドル" is no currency at all, so it matches nothing.
    const currencies = tokens
      .map(cjkCurrencies)
      .reduce((shared, next) => shared.filter((currency) => next.includes(currency)));
    const written = groups.upper === undefined ? lower : `${lower}${groups.upper}`;
    const plain = !CJK_CHAR_RE.test(written);
    if (plain && tokens.every((token) => SCANNED_CJK_TOKENS.includes(token))) {
      continue;
    }
    const start = match.index;
    const lowerAt = start + match[0].indexOf(lower);
    const bounds = groups.upper === undefined ? [lower] : [lower, groups.upper];
    for (const bound of bounds) {
      const values = plain ? readValues(bound.trim(), decimals) : cjkValues(bound);
      const numberIndex = bound === lower ? lowerAt : start + match[0].lastIndexOf(bound);
      covered.push({
        start,
        end: start + match[0].length,
        numberStart: numberIndex,
        numberEnd: numberIndex + bound.length,
      });
      cjk.push({
        values,
        currencies: [...currencies],
        raw: match[0],
        index: start,
        numberIndex,
        group: lowerAt,
      });
    }
  }
  if (cjk.length === 0) {
    return;
  }
  // Only a partial reading of the same amount ("¥3.7" of "¥3.7万", "7000円" of "3万7000円") is
  // replaced: it lies wholly inside the match and its number starts inside the CJK number. Every
  // other reading stays and must pass on its own.
  const kept = found.filter(
    (amount) =>
      !covered.some(
        (span) =>
          amount.index >= span.start &&
          amount.index + amount.raw.length <= span.end &&
          amount.numberIndex >= span.numberStart &&
          amount.numberIndex < span.numberEnd,
      ),
  );
  found.splice(0, found.length, ...kept, ...cjk);
}

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
  scanCjk(normalized, found, decimals);
  // One number read both ways ("$99 USD", "$1200 CAD") is one amount in the currencies both
  // readings allow; an empty intersection matches nothing, so the check fails closed. Done before
  // range bounds, which copy the amount's currencies.
  found.sort((left, right) => left.index - right.index);
  const byNumber = new Map<number, MoneyAmount>();
  for (const amount of found) {
    const first = byNumber.get(amount.numberIndex);
    if (first === undefined) {
      byNumber.set(amount.numberIndex, amount);
    } else if (restates(first, amount)) {
      first.currencies = first.currencies.filter((currency) =>
        amount.currencies.includes(currency),
      );
    }
  }
  found.splice(0, found.length, ...byNumber.values());
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
  /** The failing amount started in a symbol lent by the previous sentence ("costs Rs." + "1500."). */
  borrowed?: boolean;
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
    .map((productId) => (productId === undefined ? undefined : items.get(productId)))
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
  'ca|approx|inkl|zzgl|exkl|art|nr|z\\.b|bzw|ggf|vs|stk|ref|env|aprox|прибл|ок|арт';
/** Magnitude abbreviations end no sentence right after a number ("1,5 тыс. ₽", "2 Mio. €"). */
const MAGNITUDE_ABBREVIATIONS = 'tsd|mio|mill|mrd|mld|mln|tys|тыс|тис|млн|млрд';
/** Words whose dot ends a sentence ("It fits ok.") unless a number follows ("ok. 999 zł"). */
const HEDGE_ABBREVIATIONS = 'ok';
// cspell:enable
/** Splits sentences and keeps the separators, so stripping does not collapse markdown. */
const SENTENCE_SPLIT_RE = new RegExp(
  String.raw`((?<=[.!?])(?<!(?:^|[^\p{L}])(?:${ABBREVIATIONS})\.)(?<!\d[*_~\x60]*\s*(?:${MAGNITUDE_ABBREVIATIONS})\.)(?:(?<!(?:^|[^\p{L}])(?:${HEDGE_ABBREVIATIONS})\.)[ \t]+|[ \t]+(?!\d))|\n+)`,
  'iu',
);
/** A numbered-list marker alone in its sentence ("1.", "12)"). */
const LIST_MARKER_RE = /^\d{1,3}[.)]$/u;
/** The last dotted token of a sentence: it may be the symbol of the next sentence's number ("Rs. 999"). */
const DOTTED_TAIL_RE = /(?:^|\s)(\S{1,8}\.)$/u;

/** "U.S." ends no sentence when a lowercase word or a dollar word follows ("999 U.S. dollars"). */
const US_TAIL_RE = /(?:^|[^\p{L}])u\.s\.$/iu;
const US_CONTINUES_RE = /^\p{Ll}+(?![\p{L}\p{N}-])/u;
/** After "999 U.S." only a dollar word continues the amount. */
const US_DOLLAR_RE = /^dollars?(?![\p{L}])/iu;
/** A number right before "U.S." is an amount in two parts ("999 U.S. Dollars"): keep them together. */
const US_AMOUNT_TAIL_RE = /\d[\s:-]{0,3}u\.s\.$/iu;

function sentencesOf(text: string): { sentences: string[]; separators: string[] } {
  const parts = text.split(SENTENCE_SPLIT_RE);
  const sentences: string[] = [];
  const separators: string[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      const previous = sentences.at(-1);
      const separator = separators.at(-1);
      if (
        previous !== undefined &&
        separator !== undefined &&
        !separator.includes('\n') &&
        US_TAIL_RE.test(previous) &&
        (US_CONTINUES_RE.test(part) ||
          (US_AMOUNT_TAIL_RE.test(previous) && US_DOLLAR_RE.test(part)))
      ) {
        sentences[sentences.length - 1] = `${previous}${separator}${part}`;
        separators.pop();
      } else {
        sentences.push(part);
      }
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
  return [...items.values()].filter((item) => {
    // The model sees titles sanitized, and its text is sanitized too: compare like with like.
    const title = stripInvisible(item.title.normalize('NFKC'));
    return (
      (candidate(title) && mentions(text, title)) || (candidate(item.d) && mentions(text, item.d))
    );
  });
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

  const checkString = (
    where: string,
    text: string,
    carriesId: boolean,
    lead = '',
    leadSentence = '',
  ) => {
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
    // A lent symbol joins the sentence it came from ("The Jacket costs Rs." + "1200."): that
    // sentence's product names count too, but only when an amount here really starts in the lent
    // symbol; "Jacket: 1200 Rs. Boots: 1200 Rs." borrows nothing.
    const borrows = leadSentence !== '' && amounts.some((amount) => amount.index < leadLength);
    const named = namedProducts(borrows ? `${leadSentence}\n${text}` : text, context.items);
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
        violations.push(borrows ? { where, text, borrowed: true } : { where, text });
        return;
      }
    }
  };

  const { sentences, separators } = sentencesOf(answer.text);
  sentences.forEach((sentence, index) => {
    const previous = index > 0 ? sentences[index - 1] : undefined;
    // A numbered-list marker on a new line ("Rs.\n1. Pick a size") borrows no symbol.
    const listMarker =
      LIST_MARKER_RE.test(sentence) &&
      (separators[index - 1] ?? '').includes('\n') &&
      separators[index] !== undefined &&
      !separators[index].includes('\n');
    const tailToken =
      previous === undefined || listMarker ? undefined : DOTTED_TAIL_RE.exec(previous)?.[1];
    // Only a currency symbol is lent ("Rs." + "999"), never a word like "size.".
    const lead =
      tailToken !== undefined && isCurrencyToken(tailToken, context.storeCurrency, context.locales)
        ? tailToken
        : '';
    // A token that closes the previous sentence's own amount ("... 1200 Rs.") lends its symbol
    // but not that sentence's product names: it was never a prefix of a number here.
    const closesAmount =
      lead !== '' &&
      previous !== undefined &&
      /\d[\s:-]{0,3}$/.test(previous.slice(0, previous.length - lead.length));
    checkString(
      `text#${index}`,
      sentence,
      false,
      lead,
      lead && !closesAmount ? (previous ?? '') : '',
    );
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
  // A failing sentence whose amount borrowed the previous sentence's prefix symbol ("costs Rs."
  // + "1500.") is one sentence with that lender, so the lender goes too. Other sentences that
  // merely end in a symbol ("Mo. bis Fr.", "All prices are in Rs.") stay.
  const removed = new Set<number>();
  for (const violation of violations) {
    const index = /^text#(\d+)$/u.exec(violation.where)?.[1];
    if (index !== undefined) {
      removed.add(Number(index));
      if (violation.borrowed) {
        removed.add(Number(index) - 1);
      }
    }
  }
  let removedText = false;
  let text = '';
  sentences.forEach((sentence, index) => {
    if (removed.has(index)) {
      removedText = true;
    } else {
      text += sentence;
    }
    if (index < separators.length) {
      text += separators[index] ?? '';
    }
  });
  text = text.replace(/[ \t]+\n/g, '\n').trim();
  const pointer = cardsPointer(locale);
  if (removedText && !text.endsWith(pointer)) {
    // Room for the whole pointer within the answer cap, so it is never cut mid-word.
    const kept = text
      .slice(0, Math.max(0, LIMITS.ANSWER_TEXT_CHARS - pointer.length - 1))
      .trimEnd();
    text = `${kept}${kept.length > 0 ? ' ' : ''}${pointer}`;
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
