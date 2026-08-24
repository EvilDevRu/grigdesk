// Даёт тестам общие функции для компиляции SFC-компонентов компаньона и браузерную среду.
import { compileVue, webFile } from './compile-vue.js';

const componentPromises = new Map();

export async function compileCompanionSfc(name) {
  if (!componentPromises.has(name)) {
    componentPromises.set(
      name,
      compileVue(webFile(`src/features/companion/${name}.vue`)),
    );
  }

  return componentPromises.get(name);
}

export async function installCompanionBrowser(t, url = 'https://cockpit.test/#/pipeline') {
  const { Window } = await import('../../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (callback) => {
      queueMicrotask(() => callback(Date.now()));

      return 1;
    },
    cancelAnimationFrame: () => {},
  })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

export function bubbleProps(store) {
  return {
    draft: store.draft,
    interim: store.dictationState.interim,
    scopeLabel: 'Задача #42',
    interaction: store.interaction,
    attention: store.attention,
    attentionDestination: store.attentionDestination,
    statusLabel: store.statusLabel,
    lastReply: store.lastReply,
    speechBusy: store.speechBusy,
    transcribing: store.transcribing,
    thinking: store.thinking,
    stopping: store.stopping,
    canSend: store.canSend,
    muted: store.muted,
    outputAvailable: store.outputState.available,
    ttsConsentPrompt: store.ttsConsentPrompt,
    prompt: store.dictationState.prompt || '',
    speechError: store.speechError,
    chatError: store.chatError,
    outputError: store.outputError,
    'onUpdate:draft': store.setDraft,
    onSend: store.sendText,
    onMic: store.toggleVoice,
    onCancel: store.cancelVoice,
    onStop: store.stopTurn,
    onMute: store.toggleMute,
    onConfirmTts: store.confirmTtsConsent,
    onDismissTts: store.dismissTtsConsent,
    onOpenChat: store.openConversation,
    onOpenPipeline: () => {},
  };
}
