// Даёт тестам общие функции для компиляции SFC-компонентов компаньона и браузерную среду.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
let nonce = 0;
// У data:-модуля нет базового пути, поэтому относительный импорт соседнего SFC
// падает ERR_UNSUPPORTED_RESOLVE_REQUEST и роняет весь файл теста. Дочерний
// компонент компилируем тем же путём и подставляем через globalThis.
const CHILD_IMPORT = /import\s+(\w+)\s+from\s+['"]\.\/([\w-]+)\.vue['"];?/g;

export async function compileCompanionSfc(name) {
  const { parse, compileScript } = await import(
    '../../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const path = fileURLToPath(new URL(`../../../web/src/features/companion/${name}.vue`, import.meta.url));
  const source = await readFile(path, 'utf8');
  const { descriptor, errors } = parse(source, { filename: path });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: `data-v-companion-${name.toLowerCase()}-${nonce}`,
    inlineTemplate: true,
  }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`);
  for (const [line, local, child] of [...code.matchAll(CHILD_IMPORT)]) {
    const key = `__companionChild_${child}_${nonce += 1}`;
    globalThis[key] = await compileCompanionSfc(child);
    code = code.replace(line, `const ${local} = globalThis.${key};`);
  }
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce++}`)).default;
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
