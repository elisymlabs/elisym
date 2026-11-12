import { type StoreConfig, assistantDisplayName, LIMITS } from '@elisym/askr';
import { HEX_PUBKEY_RE } from '@elisym/commerce';
import { decode } from 'nostr-tools/nip19';
import { type ChatClient, type ChatSnapshot, type ChatTurn } from '../client';
import { ELEMENT_NAME, PANEL_OPEN_PREFIX } from '../constants';
import { readItem, removeItem, storageArea, writeItem } from '../storage';
import { renderAnswer } from './answer-view';
import { element, httpsUrl } from './dom';
import { STRINGS } from './strings';
import { widgetStyleSheet } from './styles';

/** O from the snippet: an npub, or 64 lowercase hex characters. */
export function parseStoreKey(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (HEX_PUBKEY_RE.test(trimmed)) {
    return trimmed;
  }
  try {
    const decoded = decode(trimmed);
    return decoded.type === 'npub' ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

export type ClientFactory = (owner: string) => ChatClient;

interface TurnView {
  root: HTMLElement;
  answered: boolean;
}

/** The parts of the widget the snapshot updates. */
export class WidgetView {
  readonly launcher: HTMLButtonElement;
  readonly panel: HTMLElement;
  private readonly avatar: HTMLImageElement;
  private readonly name: HTMLElement;
  private readonly log: HTMLElement;
  private readonly greeting: HTMLElement;
  private readonly status: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly send: HTMLButtonElement;
  private readonly footer: HTMLElement;
  private readonly turnViews = new Map<string, TurnView>();
  private config: StoreConfig | undefined;

  constructor(
    private readonly document: Document,
    private readonly client: () => ChatClient | undefined,
    onClose: () => void,
  ) {
    this.launcher = element(document, 'button', 'launcher', '\u{1F4AC}');
    this.launcher.type = 'button';
    this.launcher.setAttribute('aria-label', STRINGS.open);

    this.panel = element(document, 'section', 'panel');
    this.panel.setAttribute('role', 'dialog');
    const header = element(document, 'div', 'header');
    this.avatar = element(document, 'img', 'avatar');
    this.avatar.alt = '';
    this.avatar.referrerPolicy = 'no-referrer';
    this.avatar.hidden = true;
    const who = element(document, 'div', 'who');
    this.name = element(document, 'div', 'name');
    who.append(this.name, element(document, 'div', 'ai', STRINGS.aiLabel));
    const close = element(document, 'button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', STRINGS.close);
    close.addEventListener('click', onClose);
    header.append(this.avatar, who, close);

    this.log = element(document, 'div', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.greeting = element(document, 'div', 'bubble theirs', STRINGS.greeting);
    this.log.append(this.greeting);
    this.status = element(document, 'div', 'status');
    this.chips = element(document, 'div', 'chips');

    const composer = element(document, 'form', 'composer');
    this.input = element(document, 'input');
    this.input.type = 'text';
    this.input.maxLength = LIMITS.ASK_TEXT_CHARS;
    this.input.placeholder = STRINGS.placeholder;
    this.send = element(document, 'button', undefined, STRINGS.send);
    this.send.type = 'submit';
    composer.append(this.input, this.send);
    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.client()?.ask(this.input.value)) {
        this.input.value = '';
      }
    });
    this.footer = element(document, 'div', 'footer', STRINGS.byAskr);
    this.panel.append(header, this.log, this.status, this.chips, composer, this.footer);
  }

  update(snapshot: ChatSnapshot): void {
    this.footer.hidden = !snapshot.branding;
    if (snapshot.config && snapshot.config !== this.config) {
      this.config = snapshot.config;
      this.name.textContent = assistantDisplayName(snapshot.config);
      const avatar = httpsUrl(snapshot.config.avatar);
      this.avatar.hidden = avatar === undefined;
      if (avatar !== undefined) {
        this.avatar.src = avatar;
      }
      this.greeting.textContent = snapshot.config.greeting ?? STRINGS.greeting;
    }
    const before = this.log.scrollHeight;
    for (const turn of snapshot.turns) {
      this.log.append(this.turnView(turn).root);
    }
    this.renderStatus(snapshot);
    this.renderChips(snapshot);
    const ready = snapshot.phase === 'ready';
    this.input.disabled = !ready;
    this.send.disabled = !ready;
    if (this.log.scrollHeight !== before) {
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  private turnView(turn: ChatTurn): TurnView {
    let view = this.turnViews.get(turn.askId);
    if (!view) {
      const root = element(this.document, 'div', 'component');
      root.append(element(this.document, 'div', 'bubble mine', turn.text));
      view = { root, answered: false };
      this.turnViews.set(turn.askId, view);
    }
    const client = this.client();
    if (turn.answer && !view.answered && this.config && client) {
      view.answered = true;
      view.root.append(
        renderAnswer(
          {
            document: this.document,
            config: this.config,
            reportClick: (address) => client.reportClick(address),
            pageOrigin: globalThis.location?.origin,
            resolveCards: (addresses) => client.resolveCards(addresses),
          },
          turn.answer,
        ),
      );
    }
    return view;
  }

  private renderStatus(snapshot: ChatSnapshot): void {
    const { document } = this;
    this.status.replaceChildren();
    if (snapshot.phase === 'loading') {
      this.status.textContent = STRINGS.connecting;
    } else if (snapshot.phase === 'waiting') {
      const turn = snapshot.turns.find((candidate) => candidate.askId === snapshot.inFlightAskId);
      this.status.textContent = turn?.status ?? STRINGS.thinking;
    } else if (snapshot.phase === 'retry') {
      const retry = element(document, 'button', undefined, STRINGS.retry);
      retry.type = 'button';
      retry.addEventListener('click', () => this.client()?.retry());
      this.status.append(
        element(
          document,
          'span',
          undefined,
          snapshot.retryReason === 'error' ? STRINGS.failed : STRINGS.noReply,
        ),
        retry,
      );
    } else if (snapshot.phase === 'unavailable') {
      this.status.append(element(document, 'span', undefined, STRINGS.unavailable));
      const contact = httpsUrl(snapshot.config?.contact);
      if (contact !== undefined) {
        const link = element(document, 'a', undefined, STRINGS.contact);
        link.href = contact;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        this.status.append(link);
      }
    } else if (snapshot.phase === 'failed') {
      this.status.textContent = STRINGS.noAssistant;
    }
  }

  private renderChips(snapshot: ChatSnapshot): void {
    this.chips.replaceChildren();
    const last = snapshot.turns[snapshot.turns.length - 1];
    if (snapshot.phase !== 'ready' || !last?.answer) {
      return;
    }
    for (const chip of last.answer.chips) {
      const button = element(this.document, 'button', 'chip', chip);
      button.type = 'button';
      button.addEventListener('click', () => this.client()?.ask(chip));
      this.chips.append(button);
    }
  }
}

/**
 * Define `<askr-chat store="npub...">` (6): a web component in shadow DOM.
 * The client starts on the first open (no gateway session for a visitor who
 * never opens the chat), and again on reload while the panel was left open.
 */
export function defineAskrElement(
  scope: Window & typeof globalThis,
  createClient: ClientFactory,
): void {
  if (scope.customElements.get(ELEMENT_NAME)) {
    return;
  }
  class AskrChatElement extends scope.HTMLElement {
    private client: ChatClient | undefined;
    private view: WidgetView | undefined;
    private unsubscribe: (() => void) | undefined;

    connectedCallback(): void {
      if (this.view) {
        return;
      }
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
      shadow.adoptedStyleSheets = [widgetStyleSheet()];
      const view = new WidgetView(
        this.ownerDocument,
        () => this.client,
        () => this.setOpen(false),
      );
      view.launcher.addEventListener('click', () => this.setOpen(true));
      shadow.replaceChildren(view.launcher, view.panel);
      this.view = view;
      const owner = parseStoreKey(this.getAttribute('store'));
      if (
        owner &&
        readItem(storageArea('sessionStorage'), `${PANEL_OPEN_PREFIX}${owner}`) === '1'
      ) {
        this.setOpen(true);
      }
    }

    disconnectedCallback(): void {
      this.unsubscribe?.();
      this.client?.stop();
      this.client = undefined;
      this.unsubscribe = undefined;
      this.view = undefined;
    }

    private setOpen(open: boolean): void {
      const owner = parseStoreKey(this.getAttribute('store'));
      this.toggleAttribute('open', open);
      const session = storageArea('sessionStorage');
      if (owner === undefined) {
        return;
      }
      if (open) {
        writeItem(session, `${PANEL_OPEN_PREFIX}${owner}`, '1');
      } else {
        removeItem(session, `${PANEL_OPEN_PREFIX}${owner}`);
      }
      if (open && !this.client && this.view) {
        const view = this.view;
        this.client = createClient(owner);
        this.unsubscribe = this.client.subscribe((snapshot) => view.update(snapshot));
        this.client.start();
      }
    }
  }
  scope.customElements.define(ELEMENT_NAME, AskrChatElement);
}
