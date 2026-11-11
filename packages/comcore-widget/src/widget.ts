import { createBrowserClient } from './browser-client';
import { ELEMENT_NAME } from './constants';
import { defineComCoreElement, parseStoreKey } from './ui/element';

/**
 * `widget.js`: `<script src=".../widget.js" data-store="npub1..." async>`.
 * Defines the element and mounts one for the script's store, unless the host
 * already placed one.
 */
function mount(script: HTMLOrSVGScriptElement | null): void {
  defineComCoreElement(window, createBrowserClient);
  const store = script?.getAttribute('data-store') ?? null;
  if (parseStoreKey(store) === undefined || document.querySelector(ELEMENT_NAME)) {
    return;
  }
  const widget = document.createElement(ELEMENT_NAME);
  widget.setAttribute('store', store ?? '');
  const theme = script?.getAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    widget.setAttribute('theme', theme);
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
