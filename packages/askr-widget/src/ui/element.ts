import { type StoreConfig, assistantDisplayName, LIMITS } from '@elisym/askr';
import { HEX_PUBKEY_RE } from '@elisym/commerce';
import { decode } from 'nostr-tools/nip19';
import { type ChatClient, type ChatSnapshot, type ChatTurn } from '../client';
import { ELEMENT_NAME, PANEL_OPEN_PREFIX } from '../constants';
import { readItem, removeItem, storageArea, writeItem } from '../storage';
import type { StoreVisibility } from '../store-check';
import { renderAnswer } from './answer-view';
import { element, httpsUrl } from './dom';
import { animateMark, createMark } from './mark';
import { STRINGS, applyLanguage, resolveLanguage } from './strings';
import { widgetStyleSheet } from './styles';
import { createWordmark } from './wordmark';

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

/** Whether the widget shows for a store at all, asked before its launcher appears (B). */
export type StoreChecker = (owner: string) => Promise<StoreVisibility>;

/** Logged once per element when it shows nothing for its store. */
export const HIDDEN_NOTICE =
  'Askr: this store is not active yet (its plan is pending), so the chat is not shown. A visitor sees it on their next page load, at most 5 minutes after the store is active.';

interface TurnView {
  root: HTMLElement;
  answered: boolean;
}

/** The parts of the widget the snapshot updates. */
export class WidgetView {
  readonly launcher: HTMLButtonElement;
  readonly panel: HTMLElement;
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
  private readonly launcherHint: HTMLElement;
  private readonly aiLabel: HTMLElement;
  private readonly close: HTMLButtonElement;
  private readonly poweredBy: HTMLElement;
  private readonly header: HTMLElement;
  private readonly composer: HTMLFormElement;
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
    // The mark, "Ask AI" and a line that says what it does.
    this.launcherLabel = element(document, 'span', 'launcher-label');
    this.launcherHint = element(document, 'span', 'launcher-hint');
    const words = element(document, 'span', 'launcher-text');
    words.append(this.launcherLabel, this.launcherHint);
    this.launcher.append(createMark(document, 'mark launcher-mark'), words);

    this.panel = element(document, 'section', 'panel');
    this.panel.setAttribute('role', 'dialog');
    const header = element(document, 'div', 'header');
    this.header = header;
    const who = element(document, 'div', 'who');
    this.name = element(document, 'div', 'name');
    this.aiLabel = element(document, 'div', 'ai');
    who.append(this.name, this.aiLabel);
    this.close = element(document, 'button', 'close');
    this.close.type = 'button';
    this.close.append(closeIcon(document));
    this.close.addEventListener('click', onClose);
    header.append(who, this.close);

    this.log = element(document, 'div', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.greeting = element(document, 'div', 'bubble theirs');
    this.log.append(this.greeting);
    this.status = element(document, 'div', 'status');
    this.statusMark = createMark(document, 'mark status-mark');
    this.chips = element(document, 'div', 'chips');

    const composer = element(document, 'form', 'composer');
    this.composer = composer;
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
      createWordmark(document, 'wordmark'),
      element(document, 'span', 'visually-hidden', ' Askr'),
    );
    this.footer.append(link);
    this.panel.append(header, this.log, this.status, this.chips, composer, this.footer);
    this.applyTexts();
  }

  /** Every fixed text in the current language: run at start and when the language changes. */
  private applyTexts(): void {
    // Only the widget's own texts carry its language: the store's greeting and the answers
    // keep the page's, which is what they are written in more often.
    for (const own of [this.launcher, this.header, this.status, this.composer, this.footer]) {
      own.lang = this.language;
    }
    this.launcherLabel.textContent = STRINGS.launcher;
    this.launcherHint.textContent = STRINGS.launcherHint;
    this.aiLabel.textContent = STRINGS.aiLabel;
    this.close.setAttribute('aria-label', STRINGS.close);
    this.greeting.textContent = this.config?.greeting ?? STRINGS.greeting;
    this.input.placeholder = STRINGS.placeholder;
    this.send.textContent = STRINGS.send;
    this.poweredBy.textContent = STRINGS.poweredBy;
  }

  update(snapshot: ChatSnapshot): void {
    // The texts object is one per page: take this widget's language back before drawing.
    applyLanguage(this.language);
    this.footer.hidden = !snapshot.branding;
    if (snapshot.config && snapshot.config !== this.config) {
      this.config = snapshot.config;
      this.name.textContent = assistantDisplayName(snapshot.config);
      // The store's language counts when the page says nothing the widget speaks.
      const language = resolveLanguage([...this.languageHints(), snapshot.config.language]);
      if (language !== this.language) {
        this.language = language;
        applyLanguage(language);
      }
      this.applyTexts();
    }
    const before = this.log.scrollHeight;
    // The first turns to land (a chat opened on its history) jump into place; later ones glide.
    // Every turn view is appended to the log as it is made, so any view means turns are shown.
    const hadTurns = this.turnViews.size > 0;
    for (const turn of snapshot.turns) {
      // Appended once: moving a node already in place would replay its entrance.
      const { root } = this.turnView(turn);
      if (root.parentNode !== this.log) {
        this.log.append(root);
      }
    }
    this.renderStatus(snapshot);
    this.renderChips(snapshot);
    const ready = snapshot.phase === 'ready';
    this.input.disabled = !ready;
    this.send.disabled = !ready;
    if (this.log.scrollHeight !== before) {
      scrollToNewest(this.log, hadTurns);
    }
  }

  /** Put the newest message in view at once: the panel just opened, so nothing should glide. */
  jumpToNewest(): void {
    this.log.scrollTop = this.log.scrollHeight;
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
            reportClick: (address, kind) => client.reportClick(address, kind),
            pageOrigin: globalThis.location?.origin,
            resolveCards: (addresses) => client.resolveCards(addresses),
            language: this.language,
          },
          turn.answer,
        ),
      );
    }
    return view;
  }

  /** What the status line shows: unchanged, it is left alone so its entrance never replays. */
  private statusKey = '';
  private chipsKey = '';

  private renderStatus(snapshot: ChatSnapshot): void {
    const { document } = this;
    const turn = snapshot.turns.find((candidate) => candidate.askId === snapshot.inFlightAskId);
    const key = [
      snapshot.phase,
      this.language,
      turn?.status ?? '',
      snapshot.retryReason ?? '',
      snapshot.config?.contact ?? '',
    ].join('\u0000');
    if (key === this.statusKey) {
      return;
    }
    this.statusKey = key;
    this.status.replaceChildren();
    if (snapshot.phase === 'loading') {
      this.status.textContent = STRINGS.connecting;
    } else if (snapshot.phase === 'waiting') {
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
    const last = snapshot.turns[snapshot.turns.length - 1];
    const shown = snapshot.phase === 'ready' && last?.answer ? last.answer.chips : [];
    const key = [last?.askId ?? '', ...shown].join('\u0000');
    if (key === this.chipsKey) {
      return;
    }
    this.chipsKey = key;
    this.chips.replaceChildren();
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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A drawn cross: a text "×" sits off center by each font's own metrics. */
function closeIcon(document: Document): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3.5 3.5l9 9M12.5 3.5l-9 9');
  svg.append(path);
  return svg;
}

/**
 * Whether the visitor asked for less motion. A host page that breaks `matchMedia` (missing, or
 * throwing) counts as asking: the chat then jumps, which is always safe.
 */
function prefersStill(log: HTMLElement): boolean {
  try {
    return (
      log.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ??
      true
    );
  } catch {
    return true;
  }
}

/**
 * Bring the newest message into view. A conversation that grows glides there; the first turns
 * (a chat opened on its history) jump, and so does every move for a visitor who asked for less
 * motion or a browser that cannot glide.
 */
export function scrollToNewest(log: HTMLElement, grew: boolean): void {
  if (grew && !prefersStill(log) && typeof log.scrollTo === 'function') {
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    return;
  }
  log.scrollTop = log.scrollHeight;
}

/** How long the panel takes to fade out on close (its CSS exit runs as long). */
const CLOSE_MS = 180;

/** Where "Powered by Askr" leads. */
const ASKR_SITE = 'https://askr.elisym.network';

/** Owner key moves (K21) the element follows per page at most: the gateway names the last one. */
const MAX_MOVES = 1;

/**
 * Define `<askr-chat store="npub...">` (6): a web component in shadow DOM.
 * The client starts on the first open (no gateway session for a visitor who
 * never opens the chat), and again on reload while the panel was left open.
 * With `checkStore`, nothing shows until it answers, and nothing at all for a store it hides;
 * a store the client finds not set up hides the same way.
 */
export function defineAskrElement(
  scope: Window & typeof globalThis,
  createClient: ClientFactory,
  checkStore?: StoreChecker,
): void {
  if (scope.customElements.get(ELEMENT_NAME)) {
    return;
  }
  class AskrChatElement extends scope.HTMLElement {
    private client: ChatClient | undefined;
    private closing: ReturnType<typeof setTimeout> | undefined;
    /** The owner key the store moved to (K21), followed at most MAX_MOVES times per page. */
    private movedTo: string | undefined;
    private moves = 0;
    private view: WidgetView | undefined;
    private unsubscribe: (() => void) | undefined;
    private hiddenNoticed = false;
    /** What had focus on the page when the panel opened: focus goes back there if the panel goes. */
    private focusBeforeOpen: Element | null = null;

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
      this.view = view;
      const owner = parseStoreKey(this.getAttribute('store'));
      if (owner === undefined || checkStore === undefined) {
        this.reveal(view, owner);
        return;
      }
      shadow.replaceChildren();
      checkStore(owner)
        .catch((): StoreVisibility => 'show')
        .then((visibility) => {
          if (this.view !== view) {
            return;
          }
          if (visibility === 'hide') {
            this.hideAll();
            return;
          }
          this.reveal(view, owner);
        })
        .catch(() => undefined);
    }

    /** Show the launcher, and the panel too when it was left open in this tab. */
    private reveal(view: WidgetView, owner: string | undefined): void {
      this.shadowRoot?.replaceChildren(view.launcher, view.panel);
      if (
        owner &&
        readItem(storageArea('sessionStorage'), `${PANEL_OPEN_PREFIX}${owner}`) === '1'
      ) {
        this.setOpen(true);
      }
    }

    /** Nothing on the page for a store that is not served: no launcher, no panel (B). */
    private hideAll(): void {
      const hadFocus = (this.shadowRoot?.activeElement ?? null) !== null;
      this.shadowRoot?.replaceChildren();
      if (hadFocus) {
        this.restoreFocus();
      }
      this.removeAttribute('open');
      const owner = parseStoreKey(this.getAttribute('store'));
      if (owner !== undefined) {
        removeItem(storageArea('sessionStorage'), `${PANEL_OPEN_PREFIX}${owner}`);
      }
      if (!this.hiddenNoticed) {
        this.hiddenNoticed = true;
        console.info(HIDDEN_NOTICE);
      }
    }

    disconnectedCallback(): void {
      if (this.closing !== undefined) {
        clearTimeout(this.closing);
        this.closing = undefined;
      }
      this.removeAttribute('closing');
      this.unsubscribe?.();
      this.client?.stop();
      this.client = undefined;
      this.unsubscribe = undefined;
      this.view = undefined;
    }

    private setOpen(open: boolean): void {
      const owner = parseStoreKey(this.getAttribute('store'));
      this.showPanel(open);
      const session = storageArea('sessionStorage');
      if (owner === undefined) {
        return;
      }
      if (open) {
        writeItem(session, `${PANEL_OPEN_PREFIX}${owner}`, '1');
      } else {
        removeItem(session, `${PANEL_OPEN_PREFIX}${owner}`);
      }
      if (open) {
        const active = this.ownerDocument.activeElement;
        this.focusBeforeOpen = active === this ? null : active;
      }
      if (open && !this.client && this.view) {
        this.startClient(this.movedTo ?? owner);
      }
    }

    /**
     * Open at once (the panel's entrance is CSS); close after a short exit, so the panel fades
     * out before the launcher returns. Reduced motion closes at once.
     */
    private showPanel(open: boolean): void {
      if (this.closing !== undefined) {
        clearTimeout(this.closing);
        this.closing = undefined;
      }
      this.removeAttribute('closing');
      const panel = this.view?.panel;
      panel?.removeAttribute('inert');
      const still =
        this.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ??
        true;
      if (open || still || !this.hasAttribute('open')) {
        const wasOpen = this.hasAttribute('open');
        this.toggleAttribute('open', open);
        if (open && !wasOpen) {
          // A closed panel has no layout, so the log lost its place: show the newest at once.
          this.view?.jumpToNewest();
        }
        if (!open && wasOpen) {
          this.returnFocus();
        }
        return;
      }
      // The panel takes no input while it fades: a tap there would land on a closing chat.
      panel?.setAttribute('inert', '');
      this.setAttribute('closing', '');
      this.closing = setTimeout(() => {
        this.closing = undefined;
        panel?.removeAttribute('inert');
        this.removeAttribute('closing');
        this.removeAttribute('open');
        this.returnFocus();
      }, CLOSE_MS);
    }

    /**
     * Focus left in a panel that is gone (the store is not served): back to what had it before the
     * panel opened, or off this element, so it is never stranded on nothing.
     */
    private restoreFocus(): void {
      const before = this.focusBeforeOpen;
      this.focusBeforeOpen = null;
      if (before instanceof scope.HTMLElement && before.isConnected) {
        before.focus();
        return;
      }
      this.blur();
    }

    /** Focus left in the closed panel goes back to the launcher, never to the top of the page. */
    private returnFocus(): void {
      const view = this.view;
      const active = this.shadowRoot?.activeElement;
      if (view && active && view.panel.contains(active)) {
        view.launcher.focus();
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
        if (snapshot.phase === 'failed') {
          // The store has no settings and the gateway does not serve it: not set up, shown nowhere.
          this.unsubscribe?.();
          client.stop();
          this.hideAll();
          return;
        }
        view.update(snapshot);
      });
      client.start();
    }
  }
  scope.customElements.define(ELEMENT_NAME, AskrChatElement);
}
