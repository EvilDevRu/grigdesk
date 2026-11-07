import { Window } from '../../../mobile/node_modules/happy-dom/lib/index.js';

/**
 * Один документ создаётся до импорта Vue и используется всеми подслучаями файла.
 * Это сохраняет singleton document, который Vue запоминает на уровне модуля.
 */
export function installBrowser() {
  const browser = new Window({ url: 'http://localhost/#/chats' });

  for (const name of [
    'window',
    'document',
    'navigator',
    'location',
    'history',
    'HTMLElement',
    'ShadowRoot',
    'Document',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'SVGElement',
    'Element',
    'Node',
    'Text',
    'Event',
    'CustomEvent',
    'MouseEvent',
  ]) {
    Object.defineProperty(globalThis, name, {
      value: name === 'window' ? browser : browser[name],
      writable: true,
      configurable: true,
    });
  }

  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {}
  };

  return browser;
}
