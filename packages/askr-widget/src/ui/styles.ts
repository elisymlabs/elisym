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
.launcher {
  display: block; width: 72px; height: 72px; padding: 0; border: 0; border-radius: 12px;
  background: transparent;
}
/* A thin edge in the background color keeps the rim readable on a site of the opposite tone. */
.launcher-mark {
  display: block; width: 72px; height: 72px;
  filter: drop-shadow(0 0 1.5px var(--cc-bg)) drop-shadow(0 8px 14px rgba(0, 0, 0, 0.28));
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
.cards { display: flex; flex-direction: column; gap: 10px; }
.card {
  display: grid; grid-template-columns: 64px minmax(0, 1fr); column-gap: 12px; row-gap: 4px;
  align-content: start; padding: 10px; border: 1px solid var(--cc-border); border-radius: 14px;
  background: var(--cc-bg);
}
.card > * { grid-column: 2; min-width: 0; }
.card > img {
  grid-column: 1; grid-row: 1 / span 6; width: 64px; height: 64px; object-fit: cover;
  border-radius: 10px; background: var(--cc-surface);
}
.card-title { font-weight: 600; color: inherit; text-decoration: none; }
a.card-title:hover { text-decoration: underline; }
.price { font-variant-numeric: tabular-nums; font-weight: 600; }
.reason { font-size: 12.5px; color: var(--cc-muted); }
.label {
  justify-self: start; font-size: 11px; padding: 1px 7px; border-radius: 6px;
  background: var(--cc-surface); color: var(--cc-muted);
}
.label.sold-out, .label.cart-failed { color: var(--cc-danger); }
.label.recommended { color: var(--cc-text); font-weight: 600; }
.card > div:empty { display: none; }
.card > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.selector { display: block; }
/* The browser's own arrow sits differently in every engine and under every host's CSS, so it
   is turned off and a chevron of two gradients is drawn, with its own room on the right. */
.selector select {
  -webkit-appearance: none; appearance: none; height: 30px; padding: 0 28px 0 10px;
  font-size: 12.5px; line-height: 1.2; border: 1px solid var(--cc-border); border-radius: 8px;
  background-color: var(--cc-surface);
  background-image:
    linear-gradient(45deg, transparent 50%, var(--cc-muted) 50%),
    linear-gradient(135deg, var(--cc-muted) 50%, transparent 50%);
  background-position: calc(100% - 15px) 50%, calc(100% - 10px) 50%;
  background-size: 5px 5px; background-repeat: no-repeat; cursor: pointer;
}
.selector select:hover { border-color: var(--cc-muted); }
.cart, .view {
  height: 30px; padding: 0 14px; border: 0; border-radius: 999px; font-size: 12.5px;
  font-weight: 600; background: var(--cc-accent); color: var(--cc-accent-text);
  text-decoration: none;
}
/* The three labels share one cell: the button keeps the widest one's width, so nothing moves. */
.cart { display: inline-grid; align-items: center; }
.cart-label { grid-area: 1 / 1; text-align: center; visibility: hidden; }
.cart[data-state='ready'] .cart-ready,
.cart[data-state='busy'] .cart-busy,
.cart[data-state='done'] .cart-done { visibility: visible; }
.cart-done::after { content: ' \\2713'; }
.view { display: inline-flex; align-items: center; background: var(--cc-surface); color: var(--cc-text); }
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
.footer { padding: 0 16px 8px; font-size: 11px; color: var(--cc-muted); text-align: right; }
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
