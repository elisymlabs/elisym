import type { CatalogItem } from '@elisym/askr';
import type { Answer, Component } from '@elisym/askr/chat';
import { componentAddresses } from '../cards';
import { type CardContext, renderCard } from './card-view';
import { element } from './dom';
import { renderText } from './render-text';
import { STRINGS } from './strings';

export interface AnswerContext extends CardContext {
  resolveCards: (addresses: readonly string[]) => Promise<Map<string, CatalogItem>>;
}

function cardRow(
  context: CardContext,
  items: readonly (CatalogItem | undefined)[],
): HTMLElement | undefined {
  const row = element(context.document, 'div', 'cards');
  for (const item of items) {
    if (item) {
      row.append(renderCard(context, item));
    }
  }
  return row.childElementCount > 0 ? row : undefined;
}

function titled(context: CardContext, title: string | undefined): HTMLElement {
  const box = element(context.document, 'div', 'component');
  if (title !== undefined) {
    box.append(element(context.document, 'div', 'component-title', title));
  }
  return box;
}

/** One component, with only the cards that resolved; nothing when none did and it needs them. */
function renderComponent(
  context: CardContext,
  component: Component,
  cards: Map<string, CatalogItem>,
): HTMLElement | undefined {
  const { document } = context;
  if (component.type === 'products') {
    const box = titled(context, component.title);
    const row = element(document, 'div', 'cards');
    for (const pick of component.picks) {
      const item = cards.get(pick.address);
      if (item) {
        row.append(renderCard(context, item, pick.reason));
      }
    }
    if (row.childElementCount === 0) {
      return undefined;
    }
    box.append(row);
    return box;
  }
  if (component.type === 'comparison') {
    const columns = component.addresses
      .map((address, index) => ({ address, index, item: cards.get(address) }))
      .filter((column) => column.item !== undefined);
    if (columns.length === 0) {
      return undefined;
    }
    const box = titled(context, component.title);
    const row = cardRow(
      context,
      columns.map((column) => column.item),
    );
    if (row) {
      box.append(row);
    }
    const table = element(document, 'table');
    const head = element(document, 'tr');
    head.append(element(document, 'th'));
    for (const column of columns) {
      const cell = element(document, 'th', undefined, column.item?.title ?? '');
      if (component.recommended === column.address) {
        cell.append(element(document, 'span', 'label recommended', STRINGS.recommended));
      }
      head.append(cell);
    }
    table.append(head);
    for (const comparisonRow of component.rows) {
      const tableRow = element(document, 'tr');
      tableRow.append(element(document, 'th', undefined, comparisonRow.dimension));
      for (const column of columns) {
        tableRow.append(
          element(document, 'td', undefined, comparisonRow.cells[column.index] ?? ''),
        );
      }
      table.append(tableRow);
    }
    box.append(table);
    return box;
  }
  if (component.type === 'plan') {
    const box = titled(context, component.title);
    const steps = element(document, 'ol', 'steps');
    for (const step of component.steps) {
      const entry = element(document, 'li');
      entry.append(element(document, 'div', undefined, step.label));
      if (step.detail !== undefined) {
        entry.append(element(document, 'div', 'detail', step.detail));
      }
      const row = cardRow(
        context,
        step.addresses.map((address) => cards.get(address)),
      );
      if (row) {
        entry.append(row);
      }
      steps.append(entry);
    }
    box.append(steps);
    return box;
  }
  const box = titled(context, component.title);
  for (const section of component.sections) {
    box.append(element(document, 'div', 'component-title', section.heading));
    const body = element(document, 'div', 'bubble theirs');
    body.append(renderText(document, section.body));
    box.append(body);
  }
  return box;
}

/**
 * An answer: its text in the 4.3 subset, then its components. Cards come
 * only from the widget's own catalog fetch, resolved once per answer.
 */
export function renderAnswer(context: AnswerContext, answer: Answer): HTMLElement {
  const { document } = context;
  const box = element(document, 'div', 'component');
  if (answer.text.trim().length > 0) {
    const bubble = element(document, 'div', 'bubble theirs');
    bubble.append(renderText(document, answer.text));
    box.append(bubble);
  }
  if (answer.components.length === 0) {
    return box;
  }
  const slot = element(document, 'div', 'component');
  box.append(slot);
  const fill = (cards: Map<string, CatalogItem>): void => {
    for (const component of answer.components) {
      const node = renderComponent(context, component, cards);
      if (node) {
        slot.append(node);
      }
    }
  };
  const addresses = componentAddresses(answer.components);
  if (addresses.length === 0) {
    fill(new Map());
    return box;
  }
  context.resolveCards(addresses).then(fill, () => fill(new Map()));
  return box;
}
