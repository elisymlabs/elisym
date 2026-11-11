/**
 * The widget's styles. They go into the shadow root as a constructable
 * stylesheet (`adoptedStyleSheets`), never an inline `<style>`, so a strict
 * `style-src` on the host page holds (6). Theming is through the
 * `--comcore-*` custom properties, which inherit into the shadow root from the
 * host page; light and dark follow the system unless `theme` is set.
 */
export const WIDGET_CSS = `
:host {
  --cc-accent: var(--comcore-accent, #2563eb);
  --cc-accent-text: var(--comcore-accent-text, #ffffff);
  --cc-bg: var(--comcore-bg, #ffffff);
  --cc-surface: var(--comcore-surface, #f4f5f7);
  --cc-text: var(--comcore-text, #15171a);
  --cc-muted: var(--comcore-muted, #5f6670);
  --cc-border: var(--comcore-border, #dfe2e6);
  --cc-danger: var(--comcore-danger, #b42318);
  --cc-radius: var(--comcore-radius, 14px);
  --cc-font: var(--comcore-font, system-ui, -apple-system, sans-serif);
  --cc-z: var(--comcore-z-index, 2147483000);
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
    --cc-bg: var(--comcore-bg, #16181c);
    --cc-surface: var(--comcore-surface, #23262c);
    --cc-text: var(--comcore-text, #eceef1);
    --cc-muted: var(--comcore-muted, #a3a9b2);
    --cc-border: var(--comcore-border, #353a42);
    --cc-danger: var(--comcore-danger, #f97066);
  }
}
:host([theme='dark']) {
  --cc-bg: var(--comcore-bg, #16181c);
  --cc-surface: var(--comcore-surface, #23262c);
  --cc-text: var(--comcore-text, #eceef1);
  --cc-muted: var(--comcore-muted, #a3a9b2);
  --cc-border: var(--comcore-border, #353a42);
  --cc-danger: var(--comcore-danger, #f97066);
}
* { box-sizing: border-box; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: 0.55; }
.launcher {
  width: 56px; height: 56px; border-radius: 50%; border: 0;
  background: var(--cc-accent); color: var(--cc-accent-text);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); font-size: 24px;
}
.panel {
  display: none; flex-direction: column;
  width: min(380px, calc(100vw - 32px)); height: min(600px, calc(100vh - 32px));
  background: var(--cc-bg); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25); overflow: hidden;
}
:host([open]) .panel { display: flex; }
:host([open]) .launcher { display: none; }
.header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--cc-border); }
.avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: var(--cc-surface); }
.who { flex: 1; min-width: 0; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai { font-size: 12px; color: var(--cc-muted); }
.close { border: 0; background: transparent; font-size: 20px; color: var(--cc-muted); }
.log { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.bubble { max-width: 88%; padding: 8px 12px; border-radius: 12px; overflow-wrap: anywhere; }
.bubble p { margin: 0 0 6px; }
.bubble p:last-child, .bubble ul:last-child, .bubble ol:last-child { margin-bottom: 0; }
.bubble ul, .bubble ol { margin: 0 0 6px; padding-left: 20px; }
.bubble code { font-family: ui-monospace, monospace; font-size: 0.92em; }
.mine { align-self: flex-end; background: var(--cc-accent); color: var(--cc-accent-text); white-space: pre-wrap; }
.theirs { align-self: flex-start; background: var(--cc-surface); }
.component { align-self: stretch; display: flex; flex-direction: column; gap: 8px; }
.component-title { font-weight: 600; }
.cards { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
.card {
  flex: 0 0 200px; display: flex; flex-direction: column; gap: 6px; padding: 8px;
  border: 1px solid var(--cc-border); border-radius: 10px; background: var(--cc-bg);
}
.card img { width: 100%; height: 120px; object-fit: cover; border-radius: 6px; background: var(--cc-surface); }
.card-title { font-weight: 600; color: inherit; text-decoration: none; }
a.card-title:hover { text-decoration: underline; }
.price { font-variant-numeric: tabular-nums; }
.reason { font-size: 12px; color: var(--cc-muted); }
.label { align-self: flex-start; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--cc-surface); color: var(--cc-muted); }
.label.sold-out { color: var(--cc-danger); }
.label.recommended { color: var(--cc-accent); }
.selector { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.selector select { padding: 4px; border: 1px solid var(--cc-border); border-radius: 6px; background: var(--cc-bg); }
.cart, .view { padding: 6px 8px; border-radius: 8px; border: 0; background: var(--cc-accent); color: var(--cc-accent-text); text-align: center; text-decoration: none; }
.view { background: var(--cc-surface); color: var(--cc-text); }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border: 1px solid var(--cc-border); padding: 4px 6px; text-align: left; vertical-align: top; }
.steps { margin: 0; padding-left: 20px; }
.detail { color: var(--cc-muted); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 8px; }
.chip { border: 1px solid var(--cc-border); background: var(--cc-bg); border-radius: 999px; padding: 4px 10px; font-size: 12px; }
.status { padding: 0 14px 6px; font-size: 12px; color: var(--cc-muted); min-height: 18px; display: flex; gap: 8px; align-items: center; }
.status button { border: 0; background: transparent; color: var(--cc-accent); text-decoration: underline; padding: 0; }
.status a { color: var(--cc-accent); }
.composer { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--cc-border); }
.composer input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--cc-border); border-radius: 10px; background: var(--cc-bg); }
.composer button { border: 0; border-radius: 10px; padding: 8px 12px; background: var(--cc-accent); color: var(--cc-accent-text); }
.footer { padding: 0 14px 8px; font-size: 11px; color: var(--cc-muted); text-align: right; }
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
