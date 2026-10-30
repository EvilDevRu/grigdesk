import { selectUiOption } from '../helpers/selectUiOption.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';
import { startSettingsBrowser } from '../fixtures/settings-modal/browser.mjs';

/**
 * Название и пояснение образуют один блок слева, одиночное поле стоит по центру этого блока.
 * Пояснение остаётся в колонке названия и не заходит под поле.
 */
function findFieldMisalignments(modal) {
  const fields = [...modal.querySelectorAll('[data-ui-settings-field] > .ui-field')].flatMap((field) => {
    const label = field.querySelector(':scope > .ui-field__label');
    const group = field.querySelector(':scope > .ui-field__control');
    const controls = [...group.children].filter((control) => control.getBoundingClientRect().width);

    if (!label || controls.length !== 1) {
      return [];
    }

    const title = label.getBoundingClientRect();
    const control = controls[0].getBoundingClientRect();
    const hint = field.querySelector(':scope > .ui-field__hint, :scope > .ui-field__error')
      ?.getBoundingClientRect();

    if (!title.width || title.right > control.left) {
      return [];
    }

    const bottom = hint ? hint.bottom : title.bottom;
    const axis = Math.abs((title.top + bottom) / 2 - (control.top + control.bottom) / 2);
    const hintBeside = !hint || hint.right <= control.left + 1 && hint.top >= title.bottom - 1;

    return axis > 1 || !hintBeside ? [{
      label: label.textContent.trim(),
      axis,
      hintBeside,
    }] : [];
  });
  const hotkeys = [...modal.querySelectorAll('.settings-hotkey-row')].flatMap((row) => {
    const label = row.querySelector('.settings-hotkey-label');
    const title = label.getBoundingClientRect();
    const combo = row.querySelector('kbd').getBoundingClientRect();
    const hint = row.querySelector('small');

    if (!title.width) {
      return [];
    }

    const axis = Math.abs(title.top + title.height / 2 - combo.top - combo.height / 2);
    const hintBelow = !hint || hint.getBoundingClientRect().top >= Math.max(title.bottom, combo.bottom);

    return axis > 1 || !hintBelow ? [{
      label: label.textContent.trim(),
      axis,
      hintBelow,
    }] : [];
  });

  return [...fields, ...hotkeys];
}

/**
 * Каждый снимок дополнен замером обеих областей: форма не расширяет окно,
 * а прокрутка страницы остаётся вертикальной даже с длинными подписями.
 */
async function captureSettingsPage(fixture, filename) {
  await fixture.page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const geometry = await fixture.page.locator('[data-role="settings-modal"]').evaluate((modal) => {
    const page = modal.querySelector('.settings-page-scroll');
    const navigation = modal.querySelector('.settings-navigation-scroll');
    const selected = navigation.querySelector('[aria-selected="true"]')?.getBoundingClientRect();
    const bounds = navigation.getBoundingClientRect();

    return {
      modalFits: modal.scrollWidth <= modal.clientWidth + 1,
      pageFits: page.scrollWidth <= page.clientWidth + 1,
      selectedVisible: !navigation.clientWidth
        || Boolean(selected && selected.top >= bounds.top - 1 && selected.bottom <= bounds.bottom + 1),
    };
  });

  assert.deepEqual(geometry, {
    modalFits: true,
    pageFits: true,
    selectedVisible: true,
  }, `Геометрия: ${filename}`);

  const misalignments = await fixture.page.locator('[data-role="settings-modal"]')
    .evaluate(findFieldMisalignments);

  assert.deepEqual(misalignments, [], `Выравнивание полей: ${filename}`);
  await fixture.page.screenshot({ path: path.join(fixture.artifacts, filename) });
}

test('UI00: общий модал на изолированном браузерном стенде', async (t) => {
  const data = JSON.parse(await fs.readFile('tests/web/fixtures/settings-modal/data.json', 'utf8'));
  const nativeCatalog = JSON.parse(await fs.readFile(
    'tests/fixtures/executor-settings/synthetic-catalog.json', 'utf8',
  ));

  nativeCatalog.providerId = 'fixture';
  nativeCatalog.fields = Array.from({ length: 160 }, (_, index) => ({
    ...structuredClone(nativeCatalog.fields[0]),
    id: JSON.stringify([`field.${index}`]),
    path: [`field.${index}`],
    label: `Параметр ${index}`,
    writable: index % 3 !== 0,
    reason: index % 3 === 0 ? 'Недоступен в этой версии' : undefined,
  }));

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

  await fixture.page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  await fixture.page.locator('[data-role="settings-modal"]').waitFor({ timeout: 2000 });
  await fixture.page.locator('[data-settings-field]').first().waitFor();
  await captureSettingsPage(fixture, 'UI00-1280x800.png');

  for (const pageId of [
    'interface.behavior', 'interface.notifications', 'interface.shortcuts', 'agents.models',
    'automation.chats', 'automation.context', 'automation.launch', 'automation.monitoring',
    'automation.arbiter', 'system.diagnostics',
    'speech.dictation', 'speech.video', 'speech.language', 'speech.models', 'speech.advanced',
  ]) {
    await fixture.page.evaluate((id) => window.settingsFixture.settings.selectPage(id), pageId);

    if (pageId.startsWith('speech.')) {
      await fixture.page.locator(`[data-settings-speech-page="${pageId}"][data-ready="true"]`).waitFor();
    } else {
      await fixture.page.locator('[data-settings-field]').first().waitFor();
    }

    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await fixture.page.setViewportSize({ width, height });
      await captureSettingsPage(fixture, `${pageId}-${width}x${height}.png`);
    }
  }

  for (const tab of ['overview', 'access', 'parameters', 'models', 'mcp']) {
    await fixture.page.evaluate((tabId) => {
      window.settingsFixture.settings.selectPage('agents.providers', 'fixture', tabId);
    }, tab);
    await fixture.page.locator('[data-provider-page="fixture"][data-ready="true"]').waitFor();
    assert.equal(await fixture.page.locator('[data-select-provider="fixture"]')
      .getAttribute('aria-pressed'), 'true');

    if (tab === 'parameters') {
      await fixture.page.getByRole('button', { name: 'Дополнительные параметры', exact: true }).click();
      await fixture.page.locator('[data-field-id]').first().waitFor();
      assert.equal(await fixture.page.getByText('Недоступен в этой версии', { exact: true }).count(), 0);
    }

    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await fixture.page.setViewportSize({ width, height });

      const field = fixture.page.locator(tab === 'parameters'
        ? '[data-provider-page] [data-field-id]' : '[data-provider-page] [data-settings-field]').first();

      if (await field.count()) {
        await field.scrollIntoViewIfNeeded();
      }

      await captureSettingsPage(fixture, `agents.providers-${tab}-${width}.png`);
    }

    if (tab === 'overview') {
      const picker = fixture.page.getByRole('combobox', { name: 'Выберите исполнителя', exact: true });

      await selectUiOption(fixture.page, picker, 'three-d');
      await fixture.page.locator('[data-provider-page="three-d"][data-ready="true"]').waitFor();
      assert.equal(await fixture.page.locator('[data-select-provider="three-d"]')
        .getAttribute('aria-pressed'), 'true');
      await selectUiOption(fixture.page, picker, 'fixture');
      await fixture.page.locator('[data-provider-page="fixture"][data-ready="true"]').waitFor();
    }
  }

  await fixture.page.evaluate(() => {
    window.settingsFixture.settings.selectPage('plugins.installed', 'sample');
  });
  await fixture.page.locator('[data-plugin-page="sample"][data-ready="true"]').waitFor();

  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await fixture.page.setViewportSize({ width, height });
    await fixture.page.locator('[data-plugin-page] input[type="number"]').scrollIntoViewIfNeeded();
    await captureSettingsPage(fixture, `plugins.installed-${width}.png`);
  }

  for (const pageId of [
    'connections.b24', 'connections.devices',
    'system.startup', 'system.updates', 'system.processes',
  ]) {
    await fixture.page.evaluate((id) => window.settingsFixture.settings.selectPage(id), pageId);

    const root = pageId.startsWith('connections.') ? `[data-connections-page="${pageId}"]`
      : pageId === 'system.processes' ? '[data-processes-page]' : `[data-system-page="${pageId}"]`;

    if (pageId === 'connections.devices') {
      await fixture.page.locator('.server-access .devices-empty').waitFor();
    } else {
      await fixture.page.locator(`${root}[data-ready="true"]`).waitFor();
    }

    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await fixture.page.setViewportSize({ width, height });
      await captureSettingsPage(fixture, `${pageId}-${width}.png`);
    }
  }

  await fixture.page.evaluate(() => window.settingsFixture.settings.selectPage('connections.mobile'));
  assert.equal(await fixture.page.evaluate(() => window.settingsFixture.settings.pageId),
    'connections.devices');
  await fixture.page.locator('.server-access .devices-empty').waitFor();

  await fixture.page.evaluate(() => window.settingsFixture.settings.selectPage('plugins.installed'));
  await fixture.page.locator('[data-install-git]').click();
  await fixture.page.locator('[data-role="plugin-install-dialog"]').waitFor();

  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await fixture.page.setViewportSize({ width, height });
    await captureSettingsPage(fixture, `plugins.install-${width}.png`);
  }

  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});

/**
 * Каждая проверка получает только синтетические DTO и свой origin Vite.
 * Запись prefs возвращает фактически принятый patch, остальные неизвестные API запрещены.
 */
async function geometryFixture(t) {
  const data = JSON.parse(await fs.readFile('tests/web/fixtures/settings-modal/data.json', 'utf8'));
  const native = JSON.parse(await fs.readFile(
    'tests/fixtures/executor-settings/synthetic-catalog.json', 'utf8',
  ));

  data.providers.providers[0].name = 'Очень длинное имя будущего исполнителя '
    + 'с большим описанием возможностей';
  native.providerId = 'fixture';
  native.fields = Array.from({ length: 160 }, (_, index) => ({
    ...structuredClone(native.fields[0]),
    id: JSON.stringify([`entry.${index}`]),
    path: [`entry.${index}`],
    label: `Длинная подпись дополнительного параметра номер ${index}`,
  }));

  return startSettingsBrowser(t, {
    '/api/settings/prefs': async (request) => {
      if (request.method() === 'POST') {
        Object.assign(data.prefs, request.postDataJSON());
      }

      return data.prefs;
    },
    '/api/settings/speech': data.speech,
    '/api/providers': data.providers,
    '/api/providers/usage': { usage: {} },
    '/api/providers/fixture/settings/catalog': native,
    '/api/plugins': data.plugins,
    '/api/plugin-catalog': {
      state: 'unconfigured',
      applicationVersion: '1.0.0',
      fetchedAt: null,
      catalog: null,
    },
    '/api/plugin-installs/jobs/current': { job: null, recoveryError: null },
    '/api/mobile/status': data.mobile,
  });
}

test('UI01–UI10: геометрия, настоящая hash history и сохранение основного экрана', async (t) => {
  const f = await geometryFixture(t);
  const page = f.page;
  const modal = page.locator('[data-role=settings-modal]');

  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  await modal.waitFor();
  await page.evaluate(() =>
    window.settingsFixture.settings.selectPage('agents.providers', 'fixture', 'parameters'));
  await page.getByRole('button', { name: 'Дополнительные параметры', exact: true }).click();
  await page.locator('[data-field-id]').first().waitFor();

  await t.test('UI01/02/07: шесть размеров, footer и независимая прокрутка', async () => {
    const violations = [];

    for (const [width, height] of [
      [1440, 900], [1280, 800], [1024, 768], [800, 600], [600, 800], [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.locator('.settings-page-scroll').evaluate((element) => {
        element.scrollTop = 10000;
      });

      const metrics = await modal.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const footer = element.querySelector('.settings-actions').getBoundingClientRect();
        const header = element.querySelector('h2').getBoundingClientRect();
        const close = element.querySelector('[aria-label="Закрыть настройки"]').getBoundingClientRect();
        const scroll = element.querySelector('.settings-page-scroll');

        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          overflow: element.scrollWidth > element.clientWidth + 1,
          footer: footer.bottom <= innerHeight && footer.top >= 0,
          header: header.top >= 0 && header.bottom <= innerHeight
            && Math.abs((close.top + close.bottom - header.top - header.bottom) / 2) < 2,
          scroll: scroll.scrollHeight > scroll.clientHeight && scroll.scrollTop > 0,
        };
      });

      if (metrics.overflow || !metrics.footer || !metrics.header || !metrics.scroll) {
        violations.push({
          width,
          height,
          metrics,
        });
      }
      if (width <= 600 && (Math.abs(metrics.x) > 1 || Math.abs(metrics.width - width) > 1)) {
        violations.push({ width, fullscreen: metrics });
      }
      if (width > 600 && (metrics.x < 19 || metrics.y < 19 || metrics.height > height - 39)) {
        violations.push({ width, margin: metrics });
      }

      await page.screenshot({ path: path.join(f.artifacts, `UI01-${width}x${height}.png`) });
    }

    assert.deepEqual(violations, []);
  });

  await t.test('UI03/05: поиск, раскрытие поля, draft и keyboard focus на 390', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Разделы', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Поиск настроек', exact: true }).fill('стилевая');
    await page.getByRole('button', { name: /^Стилевая подсказка видео/ }).click();
    await page.getByRole('textbox', { name: 'Стилевая подсказка видео', exact: true })
      .fill('Сохранённый черновик');
    await page.getByRole('button', { name: 'Разделы', exact: true }).click();
    assert.equal(await page.getByRole('searchbox', { name: 'Поиск настроек', exact: true })
      .inputValue(), 'стилевая');
    await page.getByRole('button', { name: /^Стилевая подсказка видео/ }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Стилевая подсказка видео', exact: true })
      .inputValue(),
      'Сохранённый черновик');
    await page.keyboard.press('Tab');
    assert.equal(await modal.evaluate((element) => element.contains(document.activeElement)), true);
    await page.screenshot({ path: path.join(f.artifacts, 'UI03-search-draft-390.png') });
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
  });

  await t.test('UI09/10: anchor/hash сохраняют текст, scroll, route и DOM', async () => {
    await page.evaluate(() => window.settingsFixture.settings.cancel());
    await modal.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('textbox', { name: 'Текст основной страницы', exact: true })
      .fill('Текст до настроек');
    await page.locator('[data-fixture-scroll]').evaluate((element) => {
      element.scrollTop = 450;
      window.__fixtureNode = element;
    });
    await page.locator('[data-fixture-settings-link]').click();
    await modal.waitFor();
    await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    await modal.waitFor();
    await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });

    const state = await page.evaluate(() => ({
      route: window.settingsFixture.router.currentRoute.value.path,
      mounted: window.settingsFixture.counters.mounted,
      unmounted: window.settingsFixture.counters.unmounted,
      identity: window.__fixtureNode === document.querySelector('[data-fixture-scroll]'),
      scroll: document.querySelector('[data-fixture-scroll]').scrollTop,
    }));

    assert.deepEqual(state, {
      route: '/fixture',
      mounted: 1,
      unmounted: 0,
      identity: true,
      scroll: 450,
    });
    assert.equal(await page.getByRole('textbox', { name: 'Текст основной страницы' })
      .inputValue(), 'Текст до настроек');
  });

  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.unexpected, []);
});

test('UI04/05/06/08: состояния, keyboard-only и viewport при масштабе', async (t) => {
  const f = await geometryFixture(t);
  const page = f.page;
  const modal = page.locator('[data-role=settings-modal]');

  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).focus();
  await page.keyboard.press('Enter');
  await modal.waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });

  const search = page.getByRole('searchbox', { name: 'Поиск настроек', exact: true });

  await search.focus();
  await page.keyboard.type('model');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  const tree = page.getByRole('tree');

  await tree.locator('[tabindex="0"]').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await tree.locator('[tabindex="0"]').count(), 1);
  assert.equal(await modal.evaluate((element) => element.contains(document.activeElement)), true);
  await page.screenshot({ path: path.join(f.artifacts, 'UI05-keyboard-tree.png') });

  // CSS viewport соответствует доступным пикселям при desktop zoom; настоящий zoom
  // отдельно проверяет Electron через setZoomFactor, без замены настроек браузера человека.
  for (const zoom of [1.25, 2]) {
    await page.setViewportSize({ width: Math.round(1280 / zoom), height: Math.round(800 / zoom) });

    const state = await modal.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const footer = element.querySelector('.settings-actions').getBoundingClientRect();

      return { right: box.right <= innerWidth + 1, bottom: footer.bottom <= innerHeight + 1 };
    });

    assert.deepEqual(state, { right: true, bottom: true });
    await page.screenshot({ path: path.join(f.artifacts, `UI06-viewport-${zoom}.png`) });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.settingsFixture.settings.selectPage('connections.mobile'));
  assert.equal(await page.evaluate(() => window.settingsFixture.settings.pageId), 'connections.devices');
  await page.locator('.server-access .devices-empty').waitFor();
  await page.locator('.server-access .ui-disclosure-button').click();
  await page.locator('.mobile-empty').first().waitFor();

  const add = page.locator('[data-testid=mobile-open-add]');

  assert.equal(await add.evaluate((element) => element.getBoundingClientRect().height >= 44), true);
  await add.click();
  await page.getByRole('dialog', { name: 'Добавить посредника', exact: true }).waitFor();
  await page.screenshot({ path: path.join(f.artifacts, 'UI06-nested-touch-390.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Добавить посредника', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 1);

  await page.evaluate(() => window.settingsFixture.settings.selectPage('automation.chats'));
  await page.getByRole('switch').first().waitFor();
  await page.getByRole('switch').first().press('Space');
  await page.route('**/api/settings/prefs', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { error: 'Синтетическая ошибка записи' } }) : route.continue());
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.getByText('Синтетическая ошибка записи', { exact: false }).first().waitFor();
  await page.screenshot({ path: path.join(f.artifacts, 'UI04-error-390.png') });
  await page.unroute('**/api/settings/prefs');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  await page.evaluate(() => window.settingsFixture.settings.selectPage('plugins.installed', 'sample'));
  await page.locator('[data-plugin-page="sample"][data-ready="true"]').waitFor();
  await page.locator('[data-plugin-filter]').fill('ничего-не-найдено');
  await page.getByText('Плагины не найдены.', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(f.artifacts, 'UI04-empty-390.png') });
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });

  const waiting = Promise.withResolvers();

  await page.route('**/api/settings/prefs', async (route) => {
    await waiting.promise;
    await route.fulfill({ json: { showAllModels: false } });
  });
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  await page.evaluate(() => window.settingsFixture.settings.selectPage('agents.models'));
  await page.getByText('Загрузка параметров…', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(f.artifacts, 'UI04-loading-390.png') });
  waiting.resolve();
  await page.getByRole('switch').waitFor();
  await page.unroute('**/api/settings/prefs');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.unexpected, []);
});
