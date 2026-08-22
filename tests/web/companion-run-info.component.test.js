// Проверяет отображение в пузыре компаньона выбранных модели, усилия и заполненности контекста.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  bubbleProps,
  compileCompanionSfc,
  installCompanionBrowser,
} from './helpers/companion-component.js';

const root = new URL('../../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

test('COMP-RUN-01: пузырь показывает модель, усилие и заполненность контекста', async (t) => {
  const browser = await installCompanionBrowser(t);
  const [{ h, reactive }, { mount }, Bubble] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileCompanionSfc('CompanionBubble'),
  ]);
  const store = reactive({
    draft: '', dictationState: { interim: '', prompt: '' }, interaction: 'open',
    attention: { kind: 'none', count: 0 }, attentionDestination: '', statusLabel: 'Готов',
    lastReply: '', speechBusy: false, transcribing: false, thinking: false, stopping: false,
    canSend: false, muted: true, outputState: { available: false }, ttsConsentPrompt: false,
    speechError: '', chatError: '', outputError: '',
    setDraft() {}, sendText() {}, toggleVoice() {}, cancelVoice() {}, stopTurn() {},
    toggleMute() {}, confirmTtsConsent() {}, dismissTtsConsent() {}, openConversation() {},
  });
  const wrapper = mount({
    setup: () => () => h(Bubble, {
      ...bubbleProps(store),
      runLabel: 'Opus 5 · max',
      runTitle: 'Ход уйдёт: Opus 5 · max · режим «план».',
      contextView: { percent: 84, tone: 'mid', title: 'Контекст: 168 000 из 200 000 до сжатия (84%).' },
    }),
  }, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => wrapper.unmount());

  const run = wrapper.get('[data-testid="companion-run"]');
  assert.equal(run.text(), 'Opus 5 · max');
  assert.match(run.attributes('title'), /режим «план»/);
  const ctx = wrapper.get('[data-testid="companion-context"]');
  assert.equal(ctx.text(), '84%');
  assert.ok(ctx.classes('mid'), 'подход к порогу помечен тоном, а не только текстом');
  assert.match(ctx.attributes('title'), /до сжатия/);
});

test('COMP-RUN-02: без данных о ходе чипы не выдумываются', async (t) => {
  const browser = await installCompanionBrowser(t);
  const [{ h, reactive }, { mount }, Bubble] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileCompanionSfc('CompanionBubble'),
  ]);
  const store = reactive({
    draft: '', dictationState: { interim: '', prompt: '' }, interaction: 'open',
    attention: { kind: 'none', count: 0 }, attentionDestination: '', statusLabel: 'Готов',
    lastReply: '', speechBusy: false, transcribing: false, thinking: false, stopping: false,
    canSend: false, muted: true, outputState: { available: false }, ttsConsentPrompt: false,
    speechError: '', chatError: '', outputError: '',
    setDraft() {}, sendText() {}, toggleVoice() {}, cancelVoice() {}, stopTurn() {},
    toggleMute() {}, confirmTtsConsent() {}, dismissTtsConsent() {}, openConversation() {},
  });
  const wrapper = mount({ setup: () => () => h(Bubble, bubbleProps(store)) },
    { attachTo: browser.document.querySelector('#mount') });
  t.after(() => wrapper.unmount());

  assert.equal(wrapper.find('[data-testid="companion-run"]').exists(), false);
  assert.equal(wrapper.find('[data-testid="companion-context"]').exists(), false);
});

test('COMP-RUN-03: шкала контекста у пузыря и полного чата — одна и та же', async () => {
  const [{ contextFill }, chatSession, host] = await Promise.all([
    import('../../web/src/shared/chat-context.js'),
    source('web/src/views/chat/ChatSession.vue'),
    source('web/src/features/companion/CompanionHost.vue'),
  ]);

  // Обе поверхности обязаны считать одним модулем: копия арифметики разошлась бы,
  // и предупреждение в одном месте противоречило бы проценту в другом.
  assert.match(chatSession, /from '\.\.\/\.\.\/shared\/chat-context\.js'/);
  assert.match(host, /from '\.\.\/\.\.\/shared\/chat-context\.js'/);
  assert.doesNotMatch(chatSession, /const CTX_CEIL_RATIO/, 'константы порога живут в общем модуле');

  // Выключенное автосжатие не схлопывает шкалу в ноль, а отдаёт её потолку окна.
  assert.equal(contextFill({ tokens: 165_172, window: 1_000_000, compactWindow: 0 }).pct, 21);
  assert.equal(contextFill({ tokens: 165_172, window: 1_000_000, compactWindow: 200_000 }).pct, 83);
  assert.equal(contextFill({ tokens: 165_172, window: 1_000_000, compactWindow: 200_000 }).limitWhat, 'до сжатия');
  assert.equal(contextFill({ tokens: 10, window: 200_000, compactWindow: 0 }).limitWhat, 'до потолка окна');
  assert.equal(contextFill({ tokens: 170_000, window: 200_000, compactWindow: 0 }).tone, 'hi');
  assert.equal(contextFill({ tokens: 140_000, window: 200_000, compactWindow: 0 }).tone, 'mid');
});
