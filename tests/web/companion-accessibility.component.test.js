// Проверяет доступность аватара и пузыря компаньона: клавиатуру, фокус, motion и safe-area.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  compileCompanionSfc,
  installCompanionBrowser,
} from './helpers/companion-component.js';

const root = new URL('../../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

test('COMP-A11Y-01..09: avatar/bubble имеют keyboard, focus, motion и safe-area contracts', async () => {
  const [host, avatar, robot, topbar, bubble, app] = await Promise.all([
    source('web/src/features/companion/CompanionHost.vue'),
    source('web/src/features/companion/CompanionAvatar.vue'),
    source('web/src/features/companion/CompanionRobot.vue'),
    source('web/src/features/companion/CompanionTopbarButton.vue'),
    source('web/src/features/companion/CompanionBubble.vue'),
    source('web/src/App.vue'),
  ]);

  assert.match(avatar, /<UiPressable/);
  assert.match(avatar, /aria-expanded/);
  assert.match(avatar, /aria-controls/);
  // Рисунок один на обе поверхности и монохромен: цвет задаёт место, не фигурка.
  assert.match(robot, /currentColor/);
  assert.match(robot, /aria-hidden/);
  assert.match(avatar, /CompanionRobot/);
  assert.match(topbar, /CompanionRobot/);
  assert.match(topbar, /<UiPressable/);
  assert.match(host, /<UiFloatingDialog/);
  assert.doesNotMatch(bubble, /role="dialog"/);
  assert.match(bubble, /aria-live="polite"/);
  assert.match(bubble, /:pressed="outputAvailable \? muted : true"/);
  assert.match(bubble, /<UiTextarea/);
  assert.match(bubble, /<UiIconButton/);
  assert.doesNotMatch(bubble, /<(?:button|textarea)\b/);
  assert.match(host, /layer="companion"/);
  assert.match(host + avatar + robot + bubble, /prefers-reduced-motion:\s*reduce/);
  assert.match(host, /safe-area-inset-bottom/);
  assert.match(host, /bubbleVisible\.value\s*&&\s*!document\.hidden/,
    'скрытие документа снимает exact surface/audio eligibility');
  assert.match(host, /route\.path\s*===\s*['"]\/chats['"]/);
  assert.match(app, /<LoginView v-if="!auth\.authenticated" \/>[\s\S]*<SpeechProvider v-else>[\s\S]*<CompanionHost \/>[\s\S]*<\/SpeechProvider>/,
    'login branch не монтирует avatar/controller');
});

test('COMP-A11Y-10: unavailable speech output disables mute control и не показывает active audio', async (t) => {
  const browser = await installCompanionBrowser(t);
  const [{ h }, { mount }, Bubble] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileCompanionSfc('CompanionBubble'),
  ]);
  let muteEvents = 0;
  const wrapper = mount({
    setup: () => () => h(Bubble, {
      outputAvailable: false,
      muted: false,
      onMute: () => { muteEvents += 1; },
    }),
  }, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => wrapper.unmount());

  const mute = wrapper.get('[data-testid="companion-mute"]');
  assert.equal(mute.attributes('disabled'), '');
  assert.equal(mute.attributes('aria-pressed'), 'true');
  assert.match(mute.attributes('aria-label'), /недоступна/i);
  assert.equal(mute.text(), '🔇', 'unavailable output не выглядит включённым даже при stale prop');
  await mute.trigger('click');
  assert.equal(muteEvents, 0, 'disabled control не эмитит действие');
});
