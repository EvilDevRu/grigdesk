// Общие public-registrations для domain tests. По умолчанию тесты монтируют реальные
// primitives; stubs нужны только когда проверяется раскладка родителя, а не UI contract.
export const uiComponentStubs = {
  UiButton: { template: '<button type="button" @click="$emit(\'click\', $event)"><slot /></button>' },
  UiIconButton: { template: '<button type="button" :aria-label="$attrs.label" @click="$emit(\'click\', $event)"><slot /></button>' },
  UiInput: { template: '<input :value="$attrs.modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
  UiTextarea: { template: '<textarea :value="$attrs.modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
  UiSelect: { template: '<select :value="$attrs.modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>' },
};

export async function createUiBrowser(url = 'https://cockpit.test/ui-gallery.html') {
  const { Window } = await import('../../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Document: browser.Document,
    DocumentFragment: browser.DocumentFragment,
    ShadowRoot: browser.ShadowRoot,
    Text: browser.Text,
    Comment: browser.Comment,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLAnchorElement: browser.HTMLAnchorElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLOptionElement: browser.HTMLOptionElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
    FocusEvent: browser.FocusEvent,
    KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent,
    CompositionEvent: browser.CompositionEvent,
    CustomEvent: browser.CustomEvent,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  browser.document.body.innerHTML = '<div id="mount"></div>';

  return browser;
}

export async function installUiBrowser(t, url = 'https://cockpit.test/ui-gallery.html') {
  const browser = await createUiBrowser(url);

  t.after(() => browser.close());
  return browser;
}
