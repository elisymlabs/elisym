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
    /^(dollars?|bucks?|dólar(es)?|доллар(а|ов|ы)?|бакс(а|ов)?)$/i,
    ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD'],
  ],
  [/^(euros?|евро)$/i, ['EUR']],
  [/^(quid|фунт(а|ов)?\s?стерлинг(а|ов)?)$/i, ['GBP']],
  [/^(yen|yuan|иен(а|ы)?|юан(ь|я|ей)?|рмб)$/i, ['JPY', 'CNY']],
  [/^(руб(\.|ль|ля|лей|ли)?|р\.?)$/i, ['RUB']],
  [/^(гривн(а|ы|я)?|гривен|грн\.?)$/i, ['UAH']],
  [/^(real|reais)$/i, ['BRL']],
  [/^(rupees?|рупи(и|й|я)?)$/i, ['INR']],
];
// cspell:enable

/** "pound" is a weight as often as a currency: it is money only in a GBP store. */
const POUND_RE = /^pounds?$/i;

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
]);

function isoCodes(): Set<string> {
  try {
    return new Set(Intl.supportedValuesOf('currency'));
  } catch {
    return new Set();
  }
}

const ISO_CODES = isoCodes();
const SYMBOL_PATTERN = SYMBOLS.map(([symbol]) => symbol.replace(/[.$]/g, '\\$&')).join('|');
/**
 * A number: groups of exactly three digits after a separator, then an optional
 * decimal part. It never starts inside another number (the lookbehind keeps a
 * long digit run linear, not quadratic), and "Under $120, 3 colors" reads 120.
 */
const NUMBER_PATTERN = String.raw`(?<![\d.,])(?:\d{1,3}(?:[   ,.'’]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)`;
/** A 3-letter code glued or spaced to the number: "USD99", "USD 99", "99usd". */
const CODE_PATTERN = String.raw`(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])`;
const WORD_PATTERN = String.raw`(?:u\.?s\.?\s?)?[\p{L}]{1,15}\.?`;
/** Prefix form: a symbol or code, then the number. Postfix: the number, then a symbol, code or word. */
const PREFIX_RE = new RegExp(
  String.raw`(${SYMBOL_PATTERN}|${CODE_PATTERN})\s?(${NUMBER_PATTERN})`,
  'gu',
);
const POSTFIX_RE = new RegExp(
  String.raw`(${NUMBER_PATTERN})\s?(${SYMBOL_PATTERN}|${CODE_PATTERN}|${WORD_PATTERN})`,
  'giu',
);

export interface MoneyAmount {
  values: Decimal[];
  currencies: readonly string[];
  raw: string;
  index: number;
}

function decimalSeparatorFor(locale: string): string {
  try {
    return (
      new Intl.NumberFormat(locale).formatToParts(12345.6).find((part) => part.type === 'decimal')
        ?.value ?? '.'
    );
  } catch {
    return '.';
  }
}

function parseWith(raw: string, decimal: string): Decimal | undefined {
  const compact = raw.replace(/[\s  '’]/g, '');
  const otherSeparators = decimal === '.' ? /,/g : /\./g;
  const normalized = compact.replace(otherSeparators, '').replace(decimal, '.');
  return /^\d+(\.\d+)?$/.test(normalized) ? new Decimal(normalized) : undefined;
}

function currenciesFor(
  rawToken: string,
  number: string,
  storeCurrency: string | undefined,
): readonly string[] | undefined {
  // A word at the end of a sentence carries its punctuation ("99 dollars."): drop it.
  const token = /^\p{L}/u.test(rawToken) ? rawToken.replace(/[.!?,;:]+$/u, '') : rawToken;
  const symbol = SYMBOLS.find(([candidate]) => candidate === token);
  if (symbol) {
    return symbol[1];
  }
  const word = WORDS.find(([pattern]) => pattern.test(token) || pattern.test(rawToken));
  if (word) {
    return word[1];
  }
  if (storeCurrency === 'GBP' && POUND_RE.test(token)) {
    return ['GBP'];
  }
  const upper = token.toUpperCase();
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
export function normalizeForCheck(text: string): string {
  return stripInvisible(text.normalize('NFKC'));
}

/**
 * Run one amount pattern over the text. A candidate whose token is not a
 * currency ("now 99", "for 5") does not consume the number: the scan resumes
 * one character later, so "now 99 USD" still finds "99 USD".
 */
function scan(
  text: string,
  pattern: RegExp,
  tokenGroup: number,
  numberGroup: number,
  decimals: readonly string[],
  storeCurrency: string | undefined,
  found: MoneyAmount[],
): void {
  const regex = new RegExp(pattern.source, pattern.flags);
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    const token = match[tokenGroup];
    const number = match[numberGroup];
    const currencies =
      token === undefined || number === undefined
        ? undefined
        : currenciesFor(token, number, storeCurrency);
    if (!currencies || number === undefined) {
      regex.lastIndex = match.index + 1;
      continue;
    }
    const values = decimals
      .map((decimal) => parseWith(number, decimal))
      .filter((value): value is Decimal => value !== undefined);
    if (values.length > 0) {
      found.push({ values, currencies, raw: match[0], index: match.index });
    }
  }
}

/**
 * Money amounts in a string: a currency symbol, ISO 4217 code (any case, glued
 * or spaced) or currency word next to a number, read with each locale's
 * decimal separator (CLDR through Intl). Bare numbers are not amounts (5.5).
 */
export function extractAmounts(
  text: string,
  locales: readonly string[],
  storeCurrency?: string,
): MoneyAmount[] {
  const decimals = [...new Set(locales.map(decimalSeparatorFor))];
  const normalized = normalizeForCheck(text);
  const found: MoneyAmount[] = [];
  scan(normalized, PREFIX_RE, 1, 2, decimals, storeCurrency, found);
  scan(normalized, POSTFIX_RE, 2, 1, decimals, storeCurrency, found);
  // One number read both ways ("$99 USD") is one amount.
  found.sort((left, right) => left.index - right.index);
  return found.filter(
    (amount, index) =>
      !found.some(
        (other, otherIndex) =>
          otherIndex < index &&
          other.index <= amount.index &&
          amount.index < other.index + other.raw.length,
      ),
  );
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

/** Splits sentences and keeps the separators, so stripping does not collapse markdown. */
const SENTENCE_SPLIT_RE = /((?<=[.!?])[ \t]+|\n+)/;

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
  return [...items.values()].filter((item) => mentions(text, item.title) || mentions(text, item.d));
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

  const checkString = (where: string, text: string, carriesId: boolean) => {
    const amounts = extractAmounts(text, context.locales, context.storeCurrency);
    if (amounts.length === 0) {
      return;
    }
    const named = namedProducts(text, context.items);
    // A sentence that names a product may state that product's own prices.
    const allowed = [...base, ...named.flatMap(itemPrices)];
    const visitorRuleApplies = amounts.length === 1 && !carriesId && named.length === 0;
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

  sentencesOf(answer.text).sentences.forEach((sentence, index) =>
    checkString(`text#${index}`, sentence, false),
  );
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
            `${section.heading} ${section.body}`,
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
