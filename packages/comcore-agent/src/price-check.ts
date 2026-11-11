import { type Answer, type CatalogItem, parseAddress } from '@elisym/comcore';
import Decimal from 'decimal.js-light';

/** Common currency symbols; `$` and `¥` are ambiguous and match any of their currencies. */
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
  ['руб', ['RUB']],
  ['р.', ['RUB']],
];

function isoCodes(): Set<string> {
  try {
    return new Set(Intl.supportedValuesOf('currency'));
  } catch {
    return new Set();
  }
}

const ISO_CODES = isoCodes();
const SYMBOL_PATTERN = SYMBOLS.map(([symbol]) => symbol.replace(/[.$]/g, '\\$&')).join('|');
const NUMBER_PATTERN = String.raw`\d[\d\s  .,']*\d|\d`;
const AMOUNT_RE = new RegExp(
  String.raw`(?:(${SYMBOL_PATTERN}|\b[A-Z]{3}\b)\s?(${NUMBER_PATTERN}))|(?:(${NUMBER_PATTERN})\s?(${SYMBOL_PATTERN}|\b[A-Z]{3}\b))`,
  'g',
);

export interface MoneyAmount {
  /** Candidate values: one per plausible number grammar. */
  values: Decimal[];
  /** Candidate currencies for the symbol or code. */
  currencies: readonly string[];
  raw: string;
}

function separatorsFor(locale: string): { group: string; decimal: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    return {
      group: parts.find((part) => part.type === 'group')?.value ?? ',',
      decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    };
  } catch {
    return { group: ',', decimal: '.' };
  }
}

function parseWith(raw: string, decimal: string): Decimal | undefined {
  const compact = raw.replace(/[\s  ']/g, '');
  const otherSeparators = decimal === '.' ? /,/g : /\./g;
  const normalized = compact.replace(otherSeparators, '').replace(decimal, '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return undefined;
  }
  return new Decimal(normalized);
}

function currenciesFor(token: string): readonly string[] | undefined {
  const symbol = SYMBOLS.find(([candidate]) => candidate === token);
  if (symbol) {
    return symbol[1];
  }
  return ISO_CODES.has(token) ? [token] : undefined;
}

/**
 * Money amounts in a string: a currency symbol or ISO 4217 code next to a
 * number, read with each locale's grammar (CLDR through Intl). Bare numbers
 * are not amounts (5.5).
 */
export function extractAmounts(text: string, locales: readonly string[]): MoneyAmount[] {
  const decimals = [...new Set(locales.map((locale) => separatorsFor(locale).decimal))];
  const amounts: MoneyAmount[] = [];
  for (const match of text.matchAll(AMOUNT_RE)) {
    const token = match[1] ?? match[4];
    const number = match[2] ?? match[3];
    if (token === undefined || number === undefined) {
      continue;
    }
    const currencies = currenciesFor(token);
    if (!currencies) {
      continue;
    }
    const values = decimals
      .map((decimal) => parseWith(number, decimal))
      .filter((value): value is Decimal => value !== undefined);
    if (values.length > 0) {
      amounts.push({ values, currencies, raw: match[0] });
    }
  }
  return amounts;
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
  /** Items by `d`, to resolve the answer's addresses. */
  items: ReadonlyMap<string, CatalogItem>;
  /** Every visitor message of the session. */
  visitorMessages: readonly string[];
  /** Policy passages returned this session. */
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

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;

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
  for (const items of perComponent) {
    if (items.length > 1) {
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
        if (left !== right) {
          base.push({
            value: new Decimal(left.price.amount).minus(right.price.amount).abs(),
            currency: context.storeCurrency,
          });
        }
      }
    }
  });
  const policyAmounts: Allowed[] = context.policyPassages.flatMap((passage) =>
    extractAmounts(passage, context.locales).flatMap((amount) =>
      amount.values.flatMap((value) => amount.currencies.map((currency) => ({ value, currency }))),
    ),
  );
  const visitorAmounts: Allowed[] = context.visitorMessages.flatMap((message) =>
    extractAmounts(message, context.locales).flatMap((amount) =>
      amount.values.flatMap((value) => amount.currencies.map((currency) => ({ value, currency }))),
    ),
  );
  const references = cited.flatMap((item) => [item.title.toLowerCase(), item.d.toLowerCase()]);
  const violations: PriceViolation[] = [];

  const checkString = (where: string, text: string, carriesId: boolean) => {
    const amounts = extractAmounts(text, context.locales);
    if (amounts.length === 0) {
      return;
    }
    const lower = text.toLowerCase();
    const mentionsProduct =
      carriesId ||
      references.some((reference) => reference.length > 2 && lower.includes(reference));
    const visitorRuleApplies = amounts.length === 1 && !mentionsProduct;
    for (const amount of amounts) {
      const inStoreCurrency = amount.currencies.includes(context.storeCurrency);
      const ok =
        (inStoreCurrency && matches(amount, base)) ||
        matches(amount, policyAmounts) ||
        (visitorRuleApplies && matches(amount, visitorAmounts));
      if (!ok) {
        violations.push({ where, text });
        return;
      }
    }
  };

  answer.text
    .split(SENTENCE_SPLIT_RE)
    .forEach((sentence, index) => checkString(`text#${index}`, sentence, false));
  answer.components.forEach((component, componentIndex) => {
    const prefix = `component#${componentIndex}`;
    switch (component.type) {
      case 'products':
        component.picks.forEach((pick, pickIndex) => {
          if (pick.reason) {
            checkString(`${prefix}.pick#${pickIndex}`, pick.reason, true);
          }
        });
        break;
      case 'comparison':
        // Row 0 is the server's price row (5.5): never model-written.
        component.rows
          .slice(1)
          .forEach((row, rowIndex) =>
            row.cells.forEach((cell, cellIndex) =>
              checkString(`${prefix}.row#${rowIndex + 1}.cell#${cellIndex}`, cell, true),
            ),
          );
        break;
      case 'plan':
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

/**
 * Remove whatever failed the check after the one corrective re-run (5.5):
 * sentences from the text, optional strings from components, chips; a guide
 * section or plan step that fails goes entirely.
 */
export function stripViolations(answer: Answer, violations: readonly PriceViolation[]): Answer {
  const failed = new Set(violations.map((violation) => violation.where));
  const text = answer.text
    .split(SENTENCE_SPLIT_RE)
    .filter((_sentence, index) => !failed.has(`text#${index}`))
    .join(' ')
    .trim();
  const components = answer.components
    .map((component, componentIndex) => {
      const prefix = `component#${componentIndex}`;
      switch (component.type) {
        case 'products':
          return {
            ...component,
            picks: component.picks.map((pick, pickIndex) =>
              failed.has(`${prefix}.pick#${pickIndex}`) ? { address: pick.address } : pick,
            ),
          };
        case 'comparison':
          return {
            ...component,
            rows: component.rows.map((row, rowIndex) => ({
              ...row,
              cells: row.cells.map((cell, cellIndex) =>
                failed.has(`${prefix}.row#${rowIndex}.cell#${cellIndex}`) ? '-' : cell,
              ),
            })),
          };
        case 'plan': {
          const steps = component.steps.filter(
            (_step, stepIndex) =>
              !failed.has(`${prefix}.step#${stepIndex}.label`) &&
              !failed.has(`${prefix}.step#${stepIndex}.detail`),
          );
          return steps.length > 0 ? { ...component, steps } : undefined;
        }
        case 'guide': {
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
