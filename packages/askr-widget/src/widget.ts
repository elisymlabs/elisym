import { checkBrowserStore, createBrowserClient } from './browser-client';
import { ELEMENT_NAME } from './constants';
import { snippetAttributes } from './snippet';
import { defineAskrElement, parseStoreKey } from './ui/element';

/**
 * `widget.js`: `<script src=".../widget.js" data-store="npub1..." async>`.
 * Defines the element and mounts one for the script's store, unless the host
 * already placed one. A store that is not active yet shows nothing (B).
 */
function mount(script: HTMLOrSVGScriptElement | null): void {
  defineAskrElement(window, createBrowserClient, checkBrowserStore);
  const store = script?.getAttribute('data-store') ?? null;
  if (parseStoreKey(store) === undefined || document.querySelector(ELEMENT_NAME)) {
    return;
  }
  const widget = document.createElement(ELEMENT_NAME);
  widget.setAttribute('store', store ?? '');
  for (const [name, value] of snippetAttributes(script)) {
    widget.setAttribute(name, value);
  }
  const attach = (): void => {
    document.body.append(widget);
  };
  if (document.body) {
    attach();
  } else {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  }
}

mount(document.currentScript);
