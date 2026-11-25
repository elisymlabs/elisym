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
.cart[data-state='done'] { cursor: default; }
.cart[data-state='busy']:disabled { opacity: 0.75; }
:focus-visible { outline: 2px solid var(--cc-text); outline-offset: 2px; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.mark-ink { fill: var(--cc-text); }
.mark-paper { fill: var(--cc-bg); }
/* A card: the mark, "Ask AI" and a line that says what it does. A narrow screen keeps the
   mark alone in a square of the same height. */
.launcher {
  display: flex; align-items: center; gap: 10px; height: 50px; padding: 0 18px 0 10px;
  border: 1px solid var(--cc-border); border-radius: 15px; background: var(--cc-bg);
  color: var(--cc-text); box-shadow: 0 14px 32px -12px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.06);
  text-align: left; white-space: nowrap; position: relative; overflow: hidden; isolation: isolate;
  max-width: calc(100vw - 32px);
  transition: border-color 0.25s ease;
  animation: askr-pop 0.32s cubic-bezier(0.2, 0.9, 0.25, 1) both;
}
/* While the pointer stays, the border takes a slightly firmer color, the same width and
   shadow: the button still reads as hovered once the highlight has passed. */
.launcher:hover { border-color: var(--cc-muted); }
.launcher:hover { border-color: color-mix(in srgb, var(--cc-muted) 55%, var(--cc-border)); }
.launcher:focus-visible { outline: 2px solid var(--cc-text); outline-offset: 3px; }
.launcher-mark { display: block; flex: none; width: 30px; height: 30px; margin-top: -2px; }
/* A store's own text with unusually wide glyphs ends in an ellipsis inside the screen. */
.launcher-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.launcher-label {
  font-size: 14px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2;
  overflow: hidden; text-overflow: ellipsis;
  /* Room for tall stacked marks (Thai, Vietnamese) the clip would cut, at the same size. */
  padding-block: 2px; margin-block: -2px;
}
.launcher-hint { font-size: 11.5px; color: var(--cc-muted); line-height: 1.2; }
/* On a narrow screen the words leave the screen but not the button's name. */
@media (max-width: 480px) {
  .launcher { width: 50px; padding: 0; justify-content: center; }
  .launcher-text {
    position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap;
  }
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
.who { flex: 1; min-width: 0; }
.name { font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai { font-size: 12px; color: var(--cc-muted); }
.close {
  flex: none; display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
  border: 0; border-radius: 8px; background: transparent; color: var(--cc-muted);
}
.close svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; }
.close:hover { background: var(--cc-surface); }
.log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
/* A thin scrollbar that stays out of sight until the pointer is over the conversation. */
.log { scrollbar-width: thin; scrollbar-color: transparent transparent; scrollbar-gutter: stable; }
.log:hover, .log:focus-within { scrollbar-color: var(--cc-border) transparent; }
.log:hover, .log:focus-within { scrollbar-color: color-mix(in srgb, var(--cc-muted) 45%, transparent) transparent; }
.log::-webkit-scrollbar { width: 10px; }
.log::-webkit-scrollbar-track { background: transparent; }
.log::-webkit-scrollbar-thumb { border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; background-color: transparent; }
.log:hover::-webkit-scrollbar-thumb { background-color: var(--cc-border); }
.log:hover::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--cc-muted) 45%, transparent); }
.log::-webkit-scrollbar-thumb:hover { background-color: var(--cc-muted); }
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
/* A Buy milestone (paid, refused...): the widget's own line, not the assistant's. */
.note { align-self: center; font-size: 12.5px; color: var(--cc-muted); text-align: center; }
.component { align-self: stretch; display: flex; flex-direction: column; gap: 10px; }
.component-title { font-weight: 600; }
.cards {
  display: flex; gap: 10px; overflow-x: auto;
  margin: 0 -16px; padding: 2px 16px 6px; scroll-padding-inline: 16px; scrollbar-width: none;
}
.cards::-webkit-scrollbar { display: none; }
/* No snapping: a swipe, a wheel or a drag scrolls the row freely and it stays where it stops.
   A mouse drags a row of several cards sideways (drag-scroll.ts): a hand over it, a closed hand
   while dragging, and no text selected. */
@media (hover: hover) and (pointer: fine) {
  .cards:has(> .card + .card) { cursor: grab; }
}
.cards.dragging { cursor: grabbing; user-select: none; -webkit-user-select: none; }
.cards.dragging * { cursor: grabbing; }
/* A comparison of three or more products is wider than the panel: it drags like a row of cards. */
@media (hover: hover) and (pointer: fine) {
  .table-scroll:has(tr > :nth-child(4)) { cursor: grab; }
}
.table-scroll.dragging { cursor: grabbing; user-select: none; -webkit-user-select: none; }
.table-scroll.dragging * { cursor: grabbing; }
/* No ghost image follows the pointer: a photo or the title link never starts the browser's own drag. */
.card img, .card a { -webkit-user-drag: none; user-drag: none; }
.card-media { user-select: none; -webkit-user-select: none; }
/* The row bleeds into the log's padding: its focus ring goes inside, never clipped. */
.cards:focus-visible { outline-offset: -2px; border-radius: 12px; }
/* Several products scroll sideways, the next one peeking in; a single one takes the width. */
.card {
  flex: 0 0 232px; display: flex; flex-direction: column;
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
.choice-group { display: flex; flex-direction: column; gap: 5px; }
.choice-name { font-size: 11.5px; color: var(--cc-muted); }
.choices { display: flex; flex-wrap: wrap; gap: 6px; }
.choice {
  min-width: 34px; height: 30px; padding: 0 10px; border: 1px solid var(--cc-border);
  border-radius: 999px; background: transparent; font-size: 12.5px; font-weight: 500;
}
.choice:hover { border-color: var(--cc-muted); }
.choice[aria-pressed='true'] { border-color: var(--cc-text); background: var(--cc-text); color: var(--cc-bg); }
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
/* No button for this product (no cart hook, no connected shop): no empty row under the price. */
.card-actions:empty { display: none; }
/* Sold out stands where the button stood, the same height, so picking a sold-out size moves
   nothing. */
.card-actions .label.sold-out { align-self: stretch; height: 36px; display: flex; align-items: center; justify-content: center; font-size: 13px; border-radius: 999px; }
.cart, .view {
  height: 36px; padding: 0 14px; border: 0; border-radius: 999px; font-size: 12.5px;
  font-weight: 600; background: var(--cc-accent); color: var(--cc-accent-text);
  text-decoration: none; white-space: nowrap;
}
/* The three labels share one cell: the button keeps the widest one's width, so nothing moves. */
.cart { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; }
.cart-icon {
  flex: none; width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round;
}
.cart-labels { display: grid; }
.cart-label { grid-area: 1 / 1; text-align: center; visibility: hidden; }
.cart[data-state='ready'] .cart-ready,
.cart[data-state='busy'] .cart-busy,
.cart[data-state='done'] .cart-done { visibility: visible; }
.cart-done::after { content: ' \\2713'; }
.view { display: flex; align-items: center; justify-content: center; background: var(--cc-surface); color: var(--cc-text); }
/* A button that waits for the visitor's pick: dimmed, still focusable, and a hint over it names
   the options to choose, on hover, on focus and for a moment after a tap. */
.card-actions { position: relative; }
.cart.needs-pick { opacity: 0.4; cursor: not-allowed; }
.cart-hint {
  position: absolute; left: 50%; bottom: calc(100% + 8px); z-index: 1;
  width: max-content; max-width: 100%; padding: 6px 10px; border-radius: 8px;
  background: var(--cc-text); color: var(--cc-bg); font-size: 12px; font-weight: 500;
  line-height: 1.3; text-align: center; overflow-wrap: anywhere;
  opacity: 0; pointer-events: none; transform: translate(-50%, 4px);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.cart-hint::after {
  content: ''; position: absolute; top: 100%; left: 50%; margin-left: -5px;
  border: 5px solid transparent; border-top-color: var(--cc-text);
}
.waits-for-pick:hover .cart-hint,
.waits-for-pick:focus-within .cart-hint,
.waits-for-pick.hint-shown .cart-hint { opacity: 1; transform: translate(-50%, 0); }
/* A comparison scrolls sideways, never squeezes: readable columns, row names stay in view.
   Separate borders (end and bottom only) let the box's rounded border clip the cells. */
.table-scroll {
  min-width: 0; max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain;
  scrollbar-width: thin;
  border: 1px solid var(--cc-border); border-radius: min(12px, var(--cc-radius)); background: var(--cc-bg);
}
.table-scroll table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; }
.table-scroll th, .table-scroll td {
  min-width: 96px; padding: 7px 10px; text-align: start; vertical-align: top;
  white-space: normal; word-break: normal; overflow-wrap: break-word; hyphens: manual;
  border-inline-end: 1px solid var(--cc-border); border-bottom: 1px solid var(--cc-border);
}
.table-scroll tr > :last-child { border-inline-end: 0; }
.table-scroll tr:last-child > * { border-bottom: 0; }
.table-scroll tr:first-child > th { background: linear-gradient(var(--cc-surface), var(--cc-surface)), var(--cc-bg); font-weight: 600; }
.table-scroll tr > th:first-child {
  position: sticky; inset-inline-start: 0; z-index: 1; min-width: 84px;
  background: linear-gradient(var(--cc-surface), var(--cc-surface)), var(--cc-bg); color: var(--cc-muted); font-weight: 500;
}
.table-scroll th .label { display: inline-block; margin-top: 4px; white-space: nowrap; background: var(--cc-bg); }
.steps { margin: 0; padding-left: 20px; }
.detail { color: var(--cc-muted); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 8px; }
.chip {
  border: 1px solid var(--cc-border); background: transparent; border-radius: 999px;
  padding: 5px 11px; font-size: 12.5px;
}
.chip:hover { border-color: var(--cc-muted); }
.status { padding: 0 16px 8px; font-size: 12.5px; color: var(--cc-muted); min-height: 18px; display: flex; gap: 8px; align-items: center; }
.status-mark { flex: none; width: 24px; height: 24px; margin-top: -2px; }
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
.wordmark { display: block; height: 12px; width: auto; color: var(--cc-text); }
.powered:hover .wordmark { opacity: 0.75; }
/* The mark a little taller than the wordmark's A and set close to it: one lockup, all three
   centered on one line. */
.footer-mark { display: block; width: 19px; height: 19px; margin-right: -2px; }
/* ---------- Motion: short, eased, and none at all under reduced motion ---------- */
@keyframes askr-pop { from { opacity: 0; transform: translateY(8px) scale(0.96); } }
@keyframes askr-panel-in { from { opacity: 0; transform: translateY(14px) scale(0.97); } }
@keyframes askr-panel-out { to { opacity: 0; transform: translateY(10px) scale(0.98); } }
@keyframes askr-rise { from { opacity: 0; transform: translateY(8px); } }
@keyframes askr-fade { from { opacity: 0; } }
/* A highlight that sweeps across a button the pointer is over. */
.launcher::after, .cart::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(105deg, transparent 30%, var(--cc-sheen) 50%, transparent 70%);
  transform: translateX(-130%);
}
.launcher:hover::after, .cart:not(:disabled):not([aria-disabled='true']):hover::after {
  transform: translateX(130%); transition: transform 0.85s cubic-bezier(0.2, 0.7, 0.2, 1);
}
:host { --cc-sheen: rgba(18, 19, 22, 0.08); }
:host([theme='dark']) { --cc-sheen: rgba(255, 255, 255, 0.14); }
@media (prefers-color-scheme: dark) { :host(:not([theme='light'])) { --cc-sheen: rgba(255, 255, 255, 0.14); } }
.cart { position: relative; overflow: hidden; isolation: isolate; transition: filter 0.2s ease, transform 0.15s ease; }
.cart:not(:disabled):not([aria-disabled='true']):hover { filter: brightness(1.08); }
.cart:not(:disabled):not([aria-disabled='true']):active { transform: scale(0.98); }
.cart[data-state='done'] .cart-done { animation: askr-fade 0.25s ease both; }
/* The panel grows out of the corner it opens from, and fades back into it. */
.panel { transform-origin: bottom right; }
:host([open]) .panel { animation: askr-panel-in 0.32s cubic-bezier(0.2, 0.9, 0.25, 1) both; }
:host([closing]) .panel { animation: askr-panel-out 0.18s ease-in both; }
/* Messages, answers and their cards rise in; the cards one after another. */
.bubble, .component-title, .component > .table-scroll, .component > .steps, .chip {
  animation: askr-rise 0.36s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.cards > .card { animation: askr-rise 0.42s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.cards > .card:nth-child(2) { animation-delay: 0.06s; }
.cards > .card:nth-child(3) { animation-delay: 0.12s; }
.cards > .card:nth-child(n + 4) { animation-delay: 0.18s; }
.chip:nth-child(2) { animation-delay: 0.05s; }
.chip:nth-child(3) { animation-delay: 0.1s; }
.chip:nth-child(4) { animation-delay: 0.15s; }
.status > span { animation: askr-fade 0.3s ease both; }
.card { transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease; }
.card:hover { border-color: var(--cc-muted); }
.card:hover { border-color: color-mix(in srgb, var(--cc-muted) 50%, var(--cc-border)); }
.card-media img { transition: transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1); }
.card:hover .card-media img { transform: scale(1.04); }
.choice, .chip, .close, .selector select, .composer input, .composer button {
  transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease, transform 0.15s ease;
}
.choice:active, .chip:active, .composer button:not(:disabled):active { transform: scale(0.96); }
.composer input:focus { border-color: var(--cc-muted); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .card:hover .card-media img { transform: none; }
}
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
