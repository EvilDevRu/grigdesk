import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const STORES_KEY = '__cockpitVersionTileStores';
const TILE = 'src/features/cockpit-update/CockpitVersionTile.vue';

function snapshot(overrides = {}) {
  return {
    running: { version: 'v0.1.0', sha: 'abcdef0123456789' },
    checkout: { version: 'v0.1.0', sha: 'abcdef0123456789', branch: 'main', dirty: false },
    latest: null,
    checkoutChanged: false,
    updateAvailable: false,
    installBlockReasons: [],
    checkedAt: null,
    checkError: null,
    job: null,
    ...overrides,
  };
}

/**
 * Один браузер и один скомпилированный компонент на весь файл: Vue запоминает `document`
 * при первом импорте, и Teleport второго монтирования уехал бы в закрытое окно. Сторы
 * же у каждого сценария свои — заглушки читают их при вызове, а не при импорте модуля.
 */
async function prepareTile(t) {
  const browser = await installUiBrowser(t, 'https://cockpit.test/#/chats');
  const [{ nextTick, reactive }, { mount }, shared] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/src/shared/cockpit-update.js'),
  ]);
  const CockpitVersionTile = await compileVue(webFile(TILE), {
    stubs: {
      '../../stores/pwa.js': `export const usePwaStore = () => globalThis[${JSON.stringify(STORES_KEY)}].pwa;`,
      '../../stores/cockpit-update.js': [
        "export * from './src/shared/cockpit-update.js';",
        `export const useCockpitUpdateStore = () => globalThis[${JSON.stringify(STORES_KEY)}].cockpitUpdate;`,
      ].join('\n'),
      'vue-router': `export const useRouter = () => globalThis[${JSON.stringify(STORES_KEY)}].router;`,
    },
  });

  t.after(() => {
    delete globalThis[STORES_KEY];
  });

  /**
   * Монтирует плитку с управляемыми сторами: без настоящего service worker, API и роутера.
   * Геттеры tone/active повторяют логику стора поверх того же shared-модуля, чтобы тест
   * проверял плитку, а не переписывал её правила.
   */
  function mountTile(scenario, { standalone = false } = {}) {
    const calls = { updates: 0, swChecks: 0, pushes: [] };
    const pwa = reactive({
      needRefresh: false,
      updating: false,
      doUpdate() {
        calls.updates += 1;
      },
      checkForUpdate() {
        calls.swChecks += 1;
      },
    });
    const cockpitUpdate = reactive({
      status: null,
      get tone() {
        return shared.cockpitUpdateTone(this.status);
      },
      get active() {
        return shared.ACTIVE_UPDATE_STATES.has(this.status?.job?.status);
      },
    });
    const router = {
      push(path) {
        calls.pushes.push(path);
      },
    };

    globalThis[STORES_KEY] = { pwa, cockpitUpdate, router };

    const wrapper = mount(CockpitVersionTile, {
      attachTo: browser.document.querySelector('#mount'),
      props: { standalone },
    });

    scenario.after(() => wrapper.unmount());

    return { calls, cockpitUpdate, pwa, wrapper };
  }

  return { browser, mountTile, nextTick };
}

const tile = (wrapper) => wrapper.get('[data-context="cockpit-version"]');

test('Плитка версии кокпита', async (t) => {
  const { browser, mountTile, nextTick } = await prepareTile(t);

  await t.test('VERSION-TILE-01: тихая плитка называет запущенную версию и не прыгает по состояниям', async (scenario) => {
    const { cockpitUpdate, wrapper } = mountTile(scenario);

    // До снимка плитка уже стоит, но без подписи: рейке нечего перестраивать.
    assert.equal(tile(wrapper).element.tagName, 'BUTTON');
    assert.equal(wrapper.get('.version-label').text(), '');
    assert.equal(wrapper.find('.version-dot').exists(), false);
    assert.equal(wrapper.get('.version-tile').attributes('role'), 'status');

    cockpitUpdate.status = snapshot();
    await nextTick();

    assert.equal(wrapper.get('.version-label').text(), 'v0.1.0');
    assert.ok(wrapper.get('.version-label').classes('mono'));
    assert.ok(wrapper.get('.version-tile').classes('is-idle'));
    assert.equal(tile(wrapper).attributes('data-ui-tooltip'), 'Версия Cockpit актуальна');
    assert.equal(wrapper.find('.version-dot').exists(), false);

    // Есть релиз: та же подпись, точка на знаке и жёлтый тон.
    cockpitUpdate.status = snapshot({ latest: { tag: 'v0.2.0' }, updateAvailable: true });
    await nextTick();

    assert.equal(wrapper.get('.version-label').text(), 'v0.1.0');
    assert.ok(wrapper.get('.version-tile').classes('is-release'));
    assert.ok(tile(wrapper).classes('release'));
    assert.ok(wrapper.find('.version-dot').exists());
    assert.equal(tile(wrapper).attributes('data-ui-tooltip'), 'Доступен новый стабильный релиз Cockpit');
  });

  await t.test('VERSION-TILE-02: идущая установка показывает стадию со спиннером вместо знака', async (scenario) => {
    const { cockpitUpdate, wrapper } = mountTile(scenario);

    cockpitUpdate.status = snapshot({ job: { id: 'j1', status: 'building', stage: 'building' } });
    await nextTick();

    assert.ok(wrapper.get('.version-tile').classes('is-busy'));
    assert.equal(wrapper.get('.version-label').text(), 'Собираю web');
    assert.equal(wrapper.get('.version-label').classes('mono'), false);
    assert.ok(wrapper.find('.ui-spinner').exists());
    assert.equal(wrapper.find('.version-icon').exists(), false);
    assert.equal(tile(wrapper).attributes('data-ui-tooltip'), 'Обновление: Собираю web');
  });

  await t.test('VERSION-TILE-03: готовая сборка — громкая плитка, один клик обновляет', async (scenario) => {
    const { calls, cockpitUpdate, pwa, wrapper } = mountTile(scenario);

    cockpitUpdate.status = snapshot({ latest: { tag: 'v0.2.0' }, updateAvailable: true });
    pwa.needRefresh = true;
    await nextTick();

    assert.ok(wrapper.get('.version-tile').classes('is-refresh'));
    assert.ok(tile(wrapper).classes('refresh'));
    assert.equal(wrapper.get('.version-label-full').text(), 'Обновить кокпит');
    // Плитке телефона хватает одного слова — вторую подпись показывает медиа-запрос.
    assert.equal(wrapper.get('.version-label-short').text(), 'Обновить');
    // Громкое состояние перебивает точку релиза: действие важнее сигнала.
    assert.equal(wrapper.find('.version-dot').exists(), false);

    await tile(wrapper).trigger('click');

    assert.equal(calls.updates, 1);

    pwa.updating = true;
    await nextTick();

    assert.equal(tile(wrapper).attributes('aria-busy'), 'true');
    assert.equal(wrapper.get('.version-label-full').text(), 'Обновляю…');
  });

  await t.test('VERSION-TILE-04: всплывашка версии открывается с плитки и ведёт в настройки сервера', async (scenario) => {
    const { calls, cockpitUpdate, wrapper } = mountTile(scenario);

    cockpitUpdate.status = snapshot({
      checkoutChanged: true,
      checkout: { version: 'v0.1.1', sha: '1234567abcdef', branch: 'dev', dirty: true },
      latest: { tag: 'v0.2.0' },
      installBlockReasons: ['working_tree_dirty'],
    });
    await nextTick();

    assert.equal(tile(wrapper).attributes('aria-expanded'), 'false');

    await tile(wrapper).trigger('click');
    await nextTick();

    const popover = browser.document.querySelector('.version-popover');
    assert.ok(popover);
    assert.match(popover.textContent, /Checkout Cockpit изменился после запуска сервера/u);
    assert.match(popover.textContent, /Запущено: v0\.1\.0 ·\s*abcdef0/u);
    assert.match(popover.textContent, /Checkout: v0\.1\.1 ·\s*1234567 ·\s*dev · dirty/u);
    assert.match(popover.textContent, /Доступно: v0\.2\.0/u);
    assert.match(popover.textContent, /Проверено: ещё не проверялось/u);
    assert.match(popover.textContent, /незакоммиченные или untracked-файлы/u);

    const footer = popover.querySelector('[data-context="topbar-popover-footer"]');
    assert.ok(footer);

    footer.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    await nextTick();

    assert.deepEqual(calls.pushes, ['/settings']);
    assert.equal(browser.localStorage.getItem('cockpit-settings-tab'), 'server');
    assert.equal(Boolean(browser.document.querySelector('.version-popover')), false);
  });

  await t.test('VERSION-TILE-05: завершённое задание просит service worker проверить сборку сразу', async (scenario) => {
    const { calls, cockpitUpdate } = mountTile(scenario);

    // Свежая вкладка с уже завершённым заданием — не повод дёргать регистрацию.
    cockpitUpdate.status = snapshot({ job: { id: 'j1', status: 'done', stage: 'done' } });
    await nextTick();

    assert.equal(calls.swChecks, 0);

    cockpitUpdate.status = snapshot({ job: { id: 'j2', status: 'restarting', stage: 'restarting' } });
    await nextTick();
    cockpitUpdate.status = snapshot({ job: { id: 'j2', status: 'done', stage: 'done' } });
    await nextTick();

    assert.equal(calls.swChecks, 1);

    cockpitUpdate.status = snapshot({ job: { id: 'j2', status: 'done', stage: 'done' } });
    await nextTick();

    assert.equal(calls.swChecks, 1);
  });

  await t.test('VERSION-TILE-06: экран входа получает только полосу «сборка готова» снизу', async (scenario) => {
    const { pwa, wrapper } = mountTile(scenario, { standalone: true });

    assert.equal(wrapper.find('.version-strip').exists(), false);
    assert.equal(wrapper.find('.version-tile').exists(), false);

    pwa.needRefresh = true;
    await nextTick();

    const strip = wrapper.get('.version-strip');
    assert.equal(strip.attributes('role'), 'status');
    assert.equal(wrapper.get('[data-context="cockpit-version-strip"]').text(), 'Обновить кокпит');

    const source = await readFile(webFile(TILE), 'utf8');
    assert.match(source, /\.version-strip \{[^}]*inset: auto 0 0;/u);
  });
});

test('VERSION-TILE-07: плитка стоит в конце рейки, а не в топбаре; вход монтирует standalone', async () => {
  const [app, shell, actions] = await Promise.all([
    readFile(webFile('src/App.vue'), 'utf8'),
    readFile(webFile('src/shared/layout/AppShell.vue'), 'utf8'),
    readFile(webFile('src/styles/components/actions.css'), 'utf8'),
  ]);
  const sidebar = shell.slice(shell.indexOf('<aside class="sidebar">'), shell.indexOf('</aside>'));
  const topbar = shell.slice(shell.indexOf('<header class="topbar">'), shell.indexOf('</header>'));

  assert.ok(
    sidebar.indexOf('class="collapse-btn"') < sidebar.indexOf('<CockpitVersionTile class="rail-version" />'),
    'плитка версии — последняя в рейке, после «Свернуть»',
  );
  assert.doesNotMatch(topbar, /UpdateBanner|cockpit-version/u);
  assert.doesNotMatch(shell, /UpdateBanner/u);
  assert.match(app, /<CockpitVersionTile v-if="!auth\.authenticated" standalone \/>/u);
  // Ширину рейки плитка узнаёт у самой рейки: свёрнутая и планшетная сжимают её одинаково.
  assert.match(shell, /\.sidebar \{[^}]*container: rail \/ inline-size;/u);
  assert.match(actions, /@container rail \(max-width: 100px\)/u);
  // На телефоне плитка липнет к правому краю нижнего ряда.
  assert.match(
    shell,
    /@media \(max-width: 759px\) \{[\s\S]*\.rail-version \{\s*position: sticky; right: 0;/u,
  );
  assert.match(actions, /@media \(max-width: 759px\) \{\s*\.ui-pressable\[data-context='cockpit-version'\] \{[^}]*flex-direction: column;/u);
});
