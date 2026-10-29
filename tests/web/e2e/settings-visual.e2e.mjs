import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { startSettingsBrowser } from '../fixtures/settings-modal/browser.mjs';

/**
 * Открывает настоящий модал настроек на изолированном стенде с синтетическими DTO.
 * Каждый тест получает свой Vite и браузер; неизвестные API проверяются в конце теста.
 */
async function openSettings(t) {
  const data = JSON.parse(await fs.readFile('tests/web/fixtures/settings-modal/data.json', 'utf8'));
  const nativeCatalog = JSON.parse(await fs.readFile(
    'tests/fixtures/executor-settings/synthetic-catalog.json', 'utf8',
  ));

  nativeCatalog.providerId = 'fixture';

  const fixture = await startSettingsBrowser(t, {
    '/api/settings/prefs': data.prefs,
    '/api/settings/b24': data.b24,
    '/api/system/launcher': data.launcher,
    '/api/system/server': data.server,
    '/api/system/version': data.release,
    '/api/system/web-rebuild': { rebuild: { status: 'idle' } },
    '/api/chat/sessions': data.sessions,
    '/api/mobile/status': data.mobile,
    '/api/devices': {
      listener: { state: 'online', addresses: ['desk.example:8145'] },
      devices: [],
    },
    '/api/settings/speech': data.speech,
    '/api/plugins': data.plugins,
    '/api/plugin-catalog': {
      state: 'unconfigured',
      applicationVersion: '1.0.0',
      fetchedAt: null,
      catalog: null,
    },
    '/api/plugin-installs/jobs/current': { job: null, recoveryError: null },
    '/api/providers': data.providers,
    '/api/providers/usage': { usage: {} },
    '/api/providers/fixture/mcp': { state: 'ready', servers: [] },
    '/api/providers/fixture/settings/catalog': nativeCatalog,
    '/api/settings/factory-debug': data.factoryDebug,
  });

  await fixture.page.setViewportSize({ width: 1280, height: 800 });
  await fixture.page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  await fixture.page.locator('[data-role="settings-modal"]').waitFor({ timeout: 2000 });
  await fixture.page.locator('[data-settings-field]').first().waitFor();

  return fixture;
}

/**
 * Переход на страницу ждёт её поле или признак готовности, чтобы замер не попал на загрузку.
 * Два кадра анимации дают завершить раскладку container queries.
 */
async function showPage(fixture, pageId, ready = '[data-settings-field]') {
  await fixture.page.evaluate((id) => window.settingsFixture.settings.selectPage(id), pageId);
  await fixture.page.locator(ready).first().waitFor();
  await fixture.page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/**
 * Контраст по WCAG между двумя цветами `rgb(...)`; прозрачность не учитывается,
 * поэтому передаются только непрозрачные цвета. Функция исполняется в браузере.
 */
function contrastSource() {
  return `
    const channels = (value) => value.match(/[\\d.]+/g).slice(0, 3).map(Number);
    const luminance = (value) => channels(value).map((channel) => {
      const part = channel / 255;

      return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
    window.__contrast = (first, second) => {
      const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);

      return (light + 0.05) / (dark + 0.05);
    };
  `;
}

test('V01: текстовая область — во всю ширину под названием', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'speech.language',
    '[data-settings-speech-page="speech.language"][data-ready="true"]');

  const field = await fixture.page.locator('[data-ui-settings-field]:has(.ui-textarea)').first()
    .evaluate((element) => {
      const label = element.querySelector('.ui-field__label').getBoundingClientRect();
      const area = element.querySelector('.ui-textarea').getBoundingClientRect();

      return {
        left: Math.abs(area.left - label.left) <= 1,
        below: area.top >= label.bottom - 1,
      };
    });

  assert.deepEqual(field, { left: true, below: true });
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V02: ширина формы и шкала заголовков', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'speech.advanced',
    '[data-settings-speech-page="speech.advanced"][data-ready="true"]');

  const narrow = await fixture.page.locator('[data-role="settings-modal"]').evaluate((modal) => {
    const inner = modal.querySelector('.settings-page-inner').getBoundingClientRect();
    const title = getComputedStyle(modal.querySelector('#settings-page-title'));
    const section = modal.querySelector('.settings-section-heading');
    const label = modal.querySelector('[data-ui-settings-field] .ui-field__label');

    return {
      width: inner.width <= 760,
      title: title.fontSize,
      section: getComputedStyle(section.querySelector('h4')).fontSize,
      sectionLine: getComputedStyle(section).borderBottomWidth,
      label: getComputedStyle(label).fontWeight,
    };
  });

  assert.deepEqual(narrow, {
    width: true,
    title: '18px',
    section: '14px',
    sectionLine: '0px',
    label: '400',
  });

  await showPage(fixture, 'agents.providers', '[data-provider-page="fixture"][data-ready="true"]');

  const wide = await fixture.page.locator('.settings-page-inner').evaluate((element) =>
    element.getBoundingClientRect().width);

  assert.equal(wide > 760, true, 'Страница с каталогом исполнителей занимает всю ширину');
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V03: область действия — метка, а не строка текста', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'automation.arbiter');

  const scope = await fixture.page.locator('.settings-scope-label').first().evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      border: style.borderTopWidth,
      round: parseFloat(style.borderTopLeftRadius) >= 9,
    };
  });

  assert.deepEqual(scope, { border: '1px', round: true });
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V04: путь раздела виден только в узком окне', async (t) => {
  const fixture = await openSettings(t);
  const path = fixture.page.getByLabel('Путь раздела', { exact: true });

  assert.equal(await path.isVisible(), false);
  await fixture.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await path.isVisible(), true);
  assert.equal(await fixture.page.getByRole('button', { name: 'Разделы', exact: true }).isVisible(), true);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V05: переключатель читается в обоих состояниях', async (t) => {
  const fixture = await openSettings(t);

  await fixture.page.addScriptTag({ content: contrastSource() });
  await showPage(fixture, 'agents.models');

  const off = await fixture.page.locator('[data-role="settings-modal"] .ui-switch__track').first()
    .evaluate((track) => window.__contrast(getComputedStyle(track).borderTopColor,
      getComputedStyle(document.querySelector('.settings-page-area')).backgroundColor));

  assert.equal(off >= 3, true, `Рамка выключенного переключателя: ${off.toFixed(2)}:1`);
  await showPage(fixture, 'automation.chats');

  const on = await fixture.page.locator('[data-role="settings-modal"] .ui-switch__track').first()
    .evaluate((track) => getComputedStyle(track).backgroundColor);

  assert.equal(on, 'rgb(90, 162, 255)', `Дорожка включённого переключателя: ${on}`);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V06: дерево — одна раскрытая группа и подписи в одну строку', async (t) => {
  const fixture = await openSettings(t);
  const groups = new Set();
  const pages = new Set();
  let expanded = [];

  for (const pageId of ['agents.models', 'speech.advanced', 'connections.devices', 'plugins.installed']) {
    await showPage(fixture, pageId, `[data-settings-node="${pageId}"][aria-selected="true"]`);

    const tree = await fixture.page.locator('[role="tree"]').evaluate((element) => {
      const nodes = [...element.querySelectorAll('[role="treeitem"]')];
      const heights = (level) => nodes.filter((node) => node.getAttribute('aria-level') === level)
        .map((node) => Math.round(node.getBoundingClientRect().height));

      return {
        expanded: nodes.filter((node) => node.getAttribute('aria-expanded') === 'true')
          .map((node) => node.dataset.settingsNode),
        groups: heights('1'),
        pages: heights('2'),
      };
    });

    tree.groups.forEach((height) => groups.add(height));
    tree.pages.forEach((height) => pages.add(height));
    expanded = tree.expanded;
  }

  assert.deepEqual({
    expanded,
    groupHeights: groups.size,
    pageHeights: pages.size,
  }, {
    expanded: ['plugins'],
    groupHeights: 1,
    pageHeights: 1,
  });
  await showPage(fixture, 'speech.advanced', '[data-settings-node="speech.advanced"][aria-selected="true"]');
  assert.equal(await fixture.page.locator('[data-settings-node="speech.advanced"]').textContent(),
    'Дополнительно');
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V07: пустые состояния одного вида и без второго заголовка', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'connections.devices', '[data-settings-devices] .devices-empty');

  const devices = await fixture.page.locator('[data-settings-devices] .devices-empty')
    .evaluate((element) => ({
      shared: element.classList.contains('settings-empty'),
      border: getComputedStyle(element).borderTopStyle,
    }));

  await showPage(fixture, 'connections.mobile', '.mobile-empty');

  const mobile = await fixture.page.locator('[data-role="settings-modal"]').evaluate((modal) => ({
    shared: [...modal.querySelectorAll('.mobile-empty')]
      .every((element) => element.classList.contains('settings-empty')),
    count: modal.querySelectorAll('.mobile-empty').length,
    heading: modal.querySelector('#mobile-access-title').getBoundingClientRect().width <= 1,
  }));

  assert.deepEqual({ devices, mobile }, {
    devices: {
      shared: true,
      border: 'none',
    },
    mobile: {
      shared: true,
      count: 2,
      heading: true,
    },
  });
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V08: «Обновления» и «Запуск системы» — сведения парами', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'system.updates', '[data-system-page="system.updates"][data-ready="true"]');

  const updates = await fixture.page.locator('[data-system-page="system.updates"]')
    .evaluate((element) => ({
      pairs: element.querySelectorAll('dl.settings-facts dt').length,
      text: element.textContent,
    }));

  assert.equal(updates.pairs, 5);
  assert.doesNotMatch(updates.text, /Нет выполняемой пересборки|web-бандл|checkout|untracked/i);
  await showPage(fixture, 'system.startup', '[data-system-page="system.startup"][data-ready="true"]');
  assert.equal(await fixture.page.locator('[data-system-page="system.startup"] dl.settings-facts dt')
    .count(), 3);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V09: «Процессы» — сводка парами', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'system.processes', '[data-processes-page][data-ready="true"]');

  const terms = await fixture.page.locator('[data-processes-page] dl.settings-facts dt').allTextContents();

  assert.deepEqual(terms.map((term) => term.trim()), ['В пуле', 'Ведут ход', 'Свободны', 'Лимит пула']);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V10: речь — сведения парами, модели строками списка', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'speech.dictation',
    '[data-settings-speech-page="speech.dictation"][data-ready="true"]');
  assert.equal(await fixture.page.locator('[data-settings-speech-page] dl.settings-facts dt').count(), 4);
  await showPage(fixture, 'speech.models', '[data-settings-speech-page="speech.models"][data-ready="true"]');

  const models = await fixture.page.locator('[data-settings-speech-page="speech.models"]')
    .evaluate((element) => ({
      rows: element.querySelectorAll('li.settings-speech-model').length,
      sections: element.querySelectorAll('.settings-speech-model .settings-section-heading').length,
      cachedDownload: Boolean(element.querySelector('[data-download="small"]')),
      status: element.querySelector('[data-model="small"] .settings-speech-model-status')
        ?.textContent.trim(),
    }));

  assert.deepEqual(models, {
    rows: 2,
    sections: 0,
    cachedDownload: false,
    status: 'В кэше',
  });
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V11: горячие клавиши — сочетание и есть кнопка изменения', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'interface.shortcuts', '[data-hotkey-tool]');

  const rows = await fixture.page.locator('[data-role="settings-modal"]').evaluate((modal) => ({
    buttons: [...new Set([...modal.querySelectorAll('[data-hotkey-tool]')]
      .map((row) => row.querySelectorAll('button').length))],
    combo: [...modal.querySelectorAll('[data-hotkey-tool] [data-record]')].every((button) =>
      button.getAttribute('aria-label').startsWith(button.querySelector('kbd').textContent.trim())),
    rowNotes: [...modal.querySelectorAll('[data-hotkey-tool] small')]
      .filter((note) => /ещё не получено/.test(note.textContent)).length,
    pageNotes: [...modal.querySelectorAll('.ui-field__control > p')]
      .filter((note) => /ещё не получено/.test(note.textContent)).length,
  }));

  assert.deepEqual(rows, {
    buttons: [2],
    combo: true,
    rowNotes: 0,
    pageNotes: 1,
  });
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V12: у плагина один переключатель включения', async (t) => {
  const fixture = await openSettings(t);

  await fixture.page.evaluate(() => {
    window.settingsFixture.settings.selectPage('plugins.installed', 'sample');
  });
  await fixture.page.locator('[data-plugin-page="sample"][data-ready="true"]').waitFor();
  assert.equal(await fixture.page.locator('.settings-plugin-catalog [role="switch"]').count(), 0);
  assert.equal(await fixture.page.locator('[data-plugin-page="sample"] [role="switch"]').count() >= 1, true);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V13: действия каталога похожи на кнопки, раскрывашка на общей оси', async (t) => {
  const fixture = await openSettings(t);

  await fixture.page.evaluate(() => {
    window.settingsFixture.settings.selectPage('agents.providers', 'fixture', 'parameters');
  });
  await fixture.page.locator('[data-provider-page="fixture"][data-ready="true"]').waitFor();

  const geometry = await fixture.page.locator('[data-role="settings-modal"]').evaluate((modal) => {
    const action = getComputedStyle(modal.querySelector('[data-ui-settings-sidebar-action]'));
    const disclosure = modal.querySelector('.settings-provider-editor .ui-disclosure-button');
    const label = modal.querySelector('.settings-provider-editor [data-ui-settings-field] .ui-field__label');
    const text = document.createRange();

    text.selectNodeContents(disclosure);

    return {
      outlined: action.borderTopColor !== 'rgba(0, 0, 0, 0)',
      axis: Math.abs(text.getBoundingClientRect().left - label.getBoundingClientRect().left) <= 1,
    };
  });

  assert.deepEqual(geometry, { outlined: true, axis: true });
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V14: тексты без внутренних значений и обрезанных подсказок', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'interface.behavior');
  assert.match(await fixture.page.locator('.settings-page-intro p').textContent(), /язык/i);
  await showPage(fixture, 'connections.b24', '[data-connections-page="connections.b24"][data-ready="true"]');
  assert.equal(await fixture.page.locator('[data-connections-page] input[type="password"]')
    .getAttribute('placeholder'), 'Новый пароль');
  await showPage(fixture, 'system.diagnostics');
  assert.match(await fixture.page.locator('.settings-diagnostics').textContent(),
    /Только ошибки · источник: переменная окружения/);
  assert.doesNotMatch(await fixture.page.locator('.settings-diagnostics').textContent(), /errors|env/);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

test('V15: вкладки исполнителя помещаются без внутренней прокрутки', async (t) => {
  const fixture = await openSettings(t);

  await showPage(fixture, 'agents.providers', '[data-provider-page="fixture"][data-ready="true"]');

  for (const width of [1280, 768, 390]) {
    await fixture.page.setViewportSize({ width, height: 844 });

    const geometry = await fixture.page.locator('[data-ui-settings-tabs]').evaluate((element) => {
      const tabs = [...element.querySelectorAll('[role="tab"]')];

      return {
        horizontalOverflow: element.scrollWidth - element.clientWidth,
        verticalOverflow: element.scrollHeight - element.clientHeight,
        labelsFit: tabs.every((tab) => tab.scrollHeight <= tab.clientHeight),
      };
    });

    assert.deepEqual(geometry, {
      horizontalOverflow: 0,
      verticalOverflow: 0,
      labelsFit: true,
    }, `Вкладки без переполнения при ширине ${width} px`);

    await fixture.page.screenshot({
      path: `${fixture.artifacts}/settings-tabs-${width}.png`,
    });
  }

  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});
