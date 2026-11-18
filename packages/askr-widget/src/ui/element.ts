import { type StoreConfig, assistantDisplayName, LIMITS } from '@elisym/askr';
import { HEX_PUBKEY_RE } from '@elisym/commerce';
import { decode } from 'nostr-tools/nip19';
import { type ChatClient, type ChatSnapshot, type ChatTurn } from '../client';
import { ELEMENT_NAME, PANEL_OPEN_PREFIX } from '../constants';
import { readItem, removeItem, storageArea, writeItem } from '../storage';
import { renderAnswer } from './answer-view';
import { element, httpsUrl } from './dom';
import { animateMark, createMark } from './mark';
import { STRINGS, applyLanguage, resolveLanguage } from './strings';
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
  private readonly headerMark: SVGSVGElement;
  private readonly statusMark: SVGSVGElement;
  private readonly name: HTMLElement;
  private readonly log: HTMLElement;
  private readonly greeting: HTMLElement;
  private readonly status: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly send: HTMLButtonElement;
  private readonly footer: HTMLElement;
  private readonly launcherLabel: HTMLElement;
  private readonly aiLabel: HTMLElement;
  private readonly close: HTMLButtonElement;
  private readonly poweredBy: HTMLElement;
  private language: string;
  private readonly turnViews = new Map<string, TurnView>();
  private config: StoreConfig | undefined;

  /**
   * @param languageHints the page's say on the language, strongest first (the snippet's
   *   `data-lang`, then the page's own `lang`); the store's language comes after them.
   */
  constructor(
    private readonly document: Document,
    private readonly client: () => ChatClient | undefined,
    onClose: () => void,
    private readonly languageHints: () => ReadonlyArray<string | null | undefined> = () => [],
  ) {
    this.language = resolveLanguage(languageHints());
    applyLanguage(this.language);
    this.launcher = element(document, 'button', 'launcher');
    this.launcher.type = 'button';
    this.launcherLabel = element(document, 'span', 'launcher-label');
    this.launcher.append(createMark(document, 'mark launcher-mark'), this.launcherLabel);

    this.panel = element(document, 'section', 'panel');
    this.panel.setAttribute('role', 'dialog');
    const header = element(document, 'div', 'header');
    this.avatar = element(document, 'img', 'avatar');
    this.avatar.alt = '';
    this.avatar.referrerPolicy = 'no-referrer';
    this.avatar.hidden = true;
    // The Askr mark stands in for an assistant without an avatar.
    this.headerMark = createMark(document, 'mark header-mark');
    const who = element(document, 'div', 'who');
    this.name = element(document, 'div', 'name');
    this.aiLabel = element(document, 'div', 'ai');
    who.append(this.name, this.aiLabel);
    this.close = element(document, 'button', 'close', '×');
    this.close.type = 'button';
    this.close.addEventListener('click', onClose);
    header.append(this.avatar, this.headerMark, who, this.close);

    this.log = element(document, 'div', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.greeting = element(document, 'div', 'bubble theirs');
    this.log.append(this.greeting);
    this.status = element(document, 'div', 'status');
    this.statusMark = createMark(document, 'mark status-mark');
    this.chips = element(document, 'div', 'chips');

    const composer = element(document, 'form', 'composer');
    this.input = element(document, 'input');
    this.input.type = 'text';
    this.input.maxLength = LIMITS.ASK_TEXT_CHARS;
    this.send = element(document, 'button');
    this.send.type = 'submit';
    composer.append(this.input, this.send);
    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.client()?.ask(this.input.value)) {
        this.input.value = '';
      }
    });
    // "Powered by Askr", with the mark, linking to Askr; centered under the composer.
    this.footer = element(document, 'div', 'footer');
    const link = element(document, 'a', 'powered');
    link.href = ASKR_SITE;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    this.poweredBy = element(document, 'span');
    link.append(
      this.poweredBy,
      createMark(document, 'mark footer-mark'),
      element(document, 'b', undefined, 'Askr'),
    );
    this.footer.append(link);
    this.panel.append(header, this.log, this.status, this.chips, composer, this.footer);
    this.applyTexts();
  }

  /** Every fixed text in the current language: run at start and when the language changes. */
  private applyTexts(): void {
    this.panel.lang = this.language;
    this.launcher.lang = this.language;
    this.launcherLabel.textContent = STRINGS.launcher;
    this.launcher.setAttribute('aria-label', STRINGS.open);
    this.aiLabel.textContent = STRINGS.aiLabel;
    this.close.setAttribute('aria-label', STRINGS.close);
    this.greeting.textContent = this.config?.greeting ?? STRINGS.greeting;
    this.input.placeholder = STRINGS.placeholder;
    this.send.textContent = STRINGS.send;
    this.poweredBy.textContent = STRINGS.poweredBy;
  }

  update(snapshot: ChatSnapshot): void {
    this.footer.hidden = !snapshot.branding;
    if (snapshot.config && snapshot.config !== this.config) {
      this.config = snapshot.config;
      this.name.textContent = assistantDisplayName(snapshot.config);
      const avatar = httpsUrl(snapshot.config.avatar);
      this.avatar.hidden = avatar === undefined;
      this.headerMark.classList.toggle('mark-off', avatar !== undefined);
      if (avatar !== undefined) {
        this.avatar.src = avatar;
      }
      // The store's language counts when the page says nothing the widget speaks.
      const language = resolveLanguage([...this.languageHints(), snapshot.config.language]);
      if (language !== this.language) {
        this.language = language;
        applyLanguage(language);
      }
      this.applyTexts();
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
      this.status.append(
        this.statusMark,
        element(document, 'span', undefined, turn?.status ?? STRINGS.thinking),
      );
      animateMark(this.statusMark);
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
    } else if (snapshot.phase === 'moved') {
      // A move past what the element follows reads as unavailable, with no link from the old
      // owner's config: a thief holding that key may have written it.
      this.status.append(element(document, 'span', undefined, STRINGS.unavailable));
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

/** Where "Powered by Askr" leads. */
const ASKR_SITE = 'https://askr.elisym.network';

/** Owner key moves (K21) the element follows per page at most: the gateway names the last one. */
const MAX_MOVES = 1;

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
    /** The owner key the store moved to (K21), followed at most MAX_MOVES times per page. */
    private movedTo: string | undefined;
    private moves = 0;
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
        () => [this.getAttribute('lang'), this.ownerDocument.documentElement.lang],
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
        this.startClient(this.movedTo ?? owner);
      }
    }

    private startClient(owner: string): void {
      const view = this.view;
      if (!view) {
        return;
      }
      const client = createClient(owner);
      this.client = client;
      this.unsubscribe = client.subscribe((snapshot) => {
        if (
          snapshot.phase === 'moved' &&
          snapshot.movedTo !== undefined &&
          this.moves < MAX_MOVES
        ) {
          // The client checked the new owner's config lists this page; start over as that store.
          const next = snapshot.movedTo;
          this.moves += 1;
          this.movedTo = next;
          this.unsubscribe?.();
          client.stop();
          this.client = undefined;
          this.startClient(next);
          return;
        }
        view.update(snapshot);
      });
      client.start();
    }
  }
  scope.customElements.define(ELEMENT_NAME, AskrChatElement);
}
