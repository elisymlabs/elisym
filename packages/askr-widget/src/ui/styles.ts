/**
 * The widget's styles. They go into the shadow root as a constructable
 * stylesheet (`adoptedStyleSheets`), never an inline `<style>`, so a strict
 * `style-src` on the host page holds (6). Theming is through the
 * `--askr-*` custom properties, which inherit into the shadow root from the
 * host page; light and dark follow the system unless `theme` is set.
 */
export const WIDGET_CSS = `
:host {
  --cc-bg: var(--askr-bg, #fbfbfc);
  --cc-surface: var(--askr-surface, #f1f2f4);
  --cc-text: var(--askr-text, #121316);
  --cc-muted: var(--askr-muted, #6b6e76);
  --cc-border: var(--askr-border, #e6e7eb);
  --cc-danger: var(--askr-danger, #b42318);
  --cc-accent: var(--askr-accent, #121316);
  --cc-accent-text: var(--askr-accent-text, #fbfbfc);
  --cc-radius: var(--askr-radius, 18px);
  --cc-font: var(--askr-font, system-ui, -apple-system, Roboto, sans-serif);
  --cc-z: var(--askr-z-index, 2147483000);
  --cc-shadow: 0 24px 60px -18px rgba(18, 19, 22, 0.35), 0 2px 6px rgba(18, 19, 22, 0.08);
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: var(--cc-z);
  font-family: var(--cc-font);
  font-size: 14px;
  line-height: 1.45;
  color: var(--cc-text);
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme='light'])) {
    --cc-bg: var(--askr-bg, #121316);
    --cc-surface: var(--askr-surface, #1c1d21);
    --cc-text: var(--askr-text, #f2f2f4);
    --cc-muted: var(--askr-muted, #9a9ca4);
    --cc-border: var(--askr-border, #2a2c31);
    --cc-danger: var(--askr-danger, #f97066);
    --cc-accent: var(--askr-accent, #f2f2f4);
    --cc-accent-text: var(--askr-accent-text, #121316);
    --cc-shadow: 0 24px 60px -18px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4);
  }
}
:host([theme='dark']) {
  --cc-bg: var(--askr-bg, #121316);
  --cc-surface: var(--askr-surface, #1c1d21);
  --cc-text: var(--askr-text, #f2f2f4);
  --cc-muted: var(--askr-muted, #9a9ca4);
  --cc-border: var(--askr-border, #2a2c31);
  --cc-danger: var(--askr-danger, #f97066);
  --cc-accent: var(--askr-accent, #f2f2f4);
  --cc-accent-text: var(--askr-accent-text, #121316);
  --cc-shadow: 0 24px 60px -18px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4);
}
* { box-sizing: border-box; }
button, input, select { font: inherit; color: inherit; margin: 0; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: 0.4; }
:focus-visible { outline: 2px solid var(--cc-text); outline-offset: 2px; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.mark-ink { fill: var(--cc-text); }
.mark-paper { fill: var(--cc-bg); }
.mark-off { display: none; }
/* A pill: the mark and "Ask AI". A narrow screen, or launcher="icon", keeps the mark alone. */
.launcher {
  display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 20px 0 8px;
  border: 1px solid var(--cc-border); border-radius: 999px; background: var(--cc-bg);
  color: var(--cc-text); box-shadow: var(--cc-shadow); font-weight: 600; font-size: 15px;
  letter-spacing: -0.01em; white-space: nowrap;
}
.launcher:hover { border-color: var(--cc-muted); }
/* The launcher sits on the host's page: its own background inside the ink ring keeps the focus
   visible on a light site and on a dark one. */
.launcher:focus-visible { outline: 2px solid var(--cc-text); outline-offset: 3px; }
.launcher-mark { display: block; flex: none; width: 40px; height: 40px; }
:host([launcher='icon']) .launcher { width: 56px; padding: 0; justify-content: center; }
:host([launcher='icon']) .launcher-label { display: none; }
@media (max-width: 480px) {
  .launcher { width: 56px; padding: 0; justify-content: center; }
  .launcher-label { display: none; }
}
.panel {
  display: none; flex-direction: column;
  width: min(380px, calc(100vw - 32px)); height: min(600px, calc(100vh - 32px));
  background: var(--cc-bg); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius); box-shadow: var(--cc-shadow); overflow: hidden;
}
:host([open]) .panel { display: flex; }
:host([open]) .launcher { display: none; }
.header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--cc-border); }
.avatar { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; background: var(--cc-surface); }
.header-mark { flex: none; width: 28px; height: 28px; }
.who { flex: 1; min-width: 0; }
.name { font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai { font-size: 12px; color: var(--cc-muted); }
.close {
  flex: none; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px;
  background: transparent; font-size: 20px; line-height: 1; color: var(--cc-muted);
}
.close:hover { background: var(--cc-surface); }
.log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.bubble { max-width: 88%; overflow-wrap: anywhere; }
.bubble p { margin: 0 0 6px; }
.bubble p:last-child, .bubble ul:last-child, .bubble ol:last-child { margin-bottom: 0; }
.bubble ul, .bubble ol { margin: 0 0 6px; padding-left: 20px; }
.bubble code { font-family: ui-monospace, monospace; font-size: 0.92em; }
.mine {
  align-self: flex-end; padding: 9px 13px; border-radius: 16px 16px 4px 16px;
  background: var(--cc-accent); color: var(--cc-accent-text); white-space: pre-wrap;
}
.theirs { align-self: flex-start; }
.component { align-self: stretch; display: flex; flex-direction: column; gap: 10px; }
.component-title { font-weight: 600; }
.cards {
  display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x mandatory;
  margin: 0 -16px; padding: 2px 16px 6px; scroll-padding-inline: 16px; scrollbar-width: none;
}
.cards::-webkit-scrollbar { display: none; }
/* Several products scroll sideways, the next one peeking in; a single one takes the width. */
.card {
  flex: 0 0 232px; scroll-snap-align: start; display: flex; flex-direction: column;
  border: 1px solid var(--cc-border); border-radius: 18px; background: var(--cc-bg);
  overflow: hidden;
}
.cards > .card:only-child { flex-basis: 100%; }
/* One photo height for every card, whatever its width, so a row of cards lines up. */
.card-media { position: relative; flex: none; height: 150px; background: var(--cc-surface); }
.card-media img { display: block; width: 100%; height: 100%; object-fit: cover; }
.card-media .label { position: absolute; top: 10px; left: 10px; }
.card-body { flex: 1; display: flex; flex-direction: column; gap: 8px; padding: 12px 12px 12px; }
.card-title {
  font-weight: 600; line-height: 1.3; color: inherit; text-decoration: none; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
a.card-title:hover { text-decoration: underline; }
.reason {
  font-size: 12.5px; line-height: 1.4; color: var(--cc-muted);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
.label {
  align-self: flex-start; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: var(--cc-surface); color: var(--cc-muted);
}
.card-media .label { background: #121316; color: #ffffff; }
.label.sold-out, .label.cart-failed { color: var(--cc-danger); }
.label.recommended { color: var(--cc-text); }
.card-options { display: flex; flex-direction: column; gap: 6px; }
.card-options:empty { display: none; }
.choices { display: flex; flex-wrap: wrap; gap: 6px; }
.choice {
  min-width: 34px; height: 30px; padding: 0 10px; border: 1px solid var(--cc-border);
  border-radius: 999px; background: transparent; font-size: 12.5px; font-weight: 500;
}
.choice:hover { border-color: var(--cc-muted); }
.choice[aria-checked='true'] { border-color: var(--cc-text); background: var(--cc-text); color: var(--cc-bg); }
.selector { display: block; min-width: 0; }
/* The browser's own arrow sits differently in every engine and under every host's CSS, so it
   is turned off and a thin chevron is drawn from two gradient strokes, with room on the right. */
.selector select {
  -webkit-appearance: none; appearance: none; width: 100%; height: 32px;
  padding: 0 28px 0 12px; font-size: 12.5px; line-height: 1.2;
  border: 1px solid var(--cc-border); border-radius: 999px; background-color: transparent;
  background-image:
    linear-gradient(45deg, transparent calc(50% - 0.75px), var(--cc-muted) calc(50% - 0.75px), var(--cc-muted) calc(50% + 0.75px), transparent calc(50% + 0.75px)),
    linear-gradient(-45deg, transparent calc(50% - 0.75px), var(--cc-muted) calc(50% - 0.75px), var(--cc-muted) calc(50% + 0.75px), transparent calc(50% + 0.75px));
  background-position: calc(100% - 17px) 55%, calc(100% - 12px) 55%;
  background-size: 5px 5px; background-repeat: no-repeat; cursor: pointer; text-overflow: ellipsis;
}
.selector select:hover { border-color: var(--cc-muted); }
/* The price on its own line and the button full width under it, always: a long price
   ("from 149.00 USD / month"), a short one, or sold out lay the card out the same. */
.card-foot { margin-top: auto; display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding-top: 2px; }
.price { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
.card-actions { display: flex; flex-direction: column; align-items: stretch; gap: 6px; min-width: 0; min-height: 36px; }
/* Sold out stands where the button stood, the same height, so picking a sold-out size moves
   nothing. */
.card-actions .label.sold-out { align-self: stretch; height: 36px; display: flex; align-items: center; justify-content: center; font-size: 13px; border-radius: 999px; }
.cart, .view {
  height: 36px; padding: 0 14px; border: 0; border-radius: 999px; font-size: 12.5px;
  font-weight: 600; background: var(--cc-accent); color: var(--cc-accent-text);
  text-decoration: none; white-space: nowrap;
}
/* The three labels share one cell: the button keeps the widest one's width, so nothing moves. */
.cart { display: grid; align-items: center; width: 100%; }
.cart-label { grid-area: 1 / 1; text-align: center; visibility: hidden; }
.cart[data-state='ready'] .cart-ready,
.cart[data-state='busy'] .cart-busy,
.cart[data-state='done'] .cart-done { visibility: visible; }
.cart-done::after { content: ' \\2713'; }
.view { display: flex; align-items: center; justify-content: center; background: var(--cc-surface); color: var(--cc-text); }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border: 1px solid var(--cc-border); padding: 4px 6px; text-align: left; vertical-align: top; }
.steps { margin: 0; padding-left: 20px; }
.detail { color: var(--cc-muted); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 8px; }
.chip {
  border: 1px solid var(--cc-border); background: transparent; border-radius: 999px;
  padding: 5px 11px; font-size: 12.5px;
}
.chip:hover { border-color: var(--cc-muted); }
.status { padding: 0 16px 8px; font-size: 12.5px; color: var(--cc-muted); min-height: 18px; display: flex; gap: 8px; align-items: center; }
.status-mark { flex: none; width: 20px; height: 20px; }
.status button { border: 0; background: transparent; color: var(--cc-text); text-decoration: underline; padding: 0; }
.status a { color: var(--cc-text); }
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--cc-border); }
.composer input {
  flex: 1; min-width: 0; padding: 9px 12px; border: 1px solid var(--cc-border);
  border-radius: 12px; background: var(--cc-surface);
}
.composer button {
  border: 0; border-radius: 12px; padding: 8px 14px; font-weight: 600;
  background: var(--cc-accent); color: var(--cc-accent-text);
}
.footer { display: flex; justify-content: center; padding: 0 16px 10px; }
.powered {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--cc-muted);
  text-decoration: none;
}
.powered b { color: var(--cc-text); font-weight: 600; }
.powered:hover b { text-decoration: underline; }
.footer-mark { display: block; width: 14px; height: 14px; }
`;

/** The shared stylesheet, built once per page and adopted by every widget instance. */
let sheet: CSSStyleSheet | undefined;

export function widgetStyleSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(WIDGET_CSS);
  }
  return sheet;
}
