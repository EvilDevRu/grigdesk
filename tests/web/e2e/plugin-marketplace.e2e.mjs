import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startSettingsBrowser } from '../fixtures/settings-modal/browser.mjs';
import { catalogFixture } from '../../helpers/pluginCatalog.js';
import { webInstallJob } from '../helpers/pluginInstallFixtures.js';
import { moduleCatalogFixture, catalogResponse } from '../../helpers/pluginCatalogModules.js';
import { moduleWarning } from '../../server/helpers/pluginModuleFixture.js';

test('CAT-B1: catalog preset ready, source warning, resume и три размера окна', async (t) => {
  const data = JSON.parse(await fs.readFile('tests/web/fixtures/settings-modal/data.json', 'utf8'));
  const catalog = catalogFixture();
  const external = 'https://github.com/other/demo.git';
  const catalogSeed = webInstallJob();
  const externalSeed = webInstallJob('ready', 'install', {
    id: '00000000-0000-4000-8000-000000000099',
  });
  const starts = [];
  let current = null;
  let applies = 0;
  const measurements = [];
  const fixture = await startSettingsBrowser(t, {
    '/api/settings/prefs': data.prefs,
    '/api/providers': data.providers,
    '/api/plugins': data.plugins,
    '/api/plugin-catalog': {
      state: 'fresh',
      applicationVersion: '1.0.0',
      fetchedAt: catalog.index.generatedAt,
      catalog: catalog.index,
    },
    '/api/plugin-catalog/demo': catalog.detail,
    '/api/plugin-installs/jobs/current': () => ({ job: current, recoveryError: null }),
    '/api/plugin-installs/versions': async (request) => {
      const body = request.postDataJSON();

      return { source: { kind: 'git', url: body.url }, versions: [catalog.version] };
    },
    '/api/plugin-installs/jobs': async (request) => {
      const body = request.postDataJSON();
      const source = { kind: 'git', url: body.url };

      starts.push(structuredClone(body));
      current = structuredClone(body.url === external ? externalSeed : catalogSeed);
      current.source = source;
      current.target = {
        version: catalog.version.version,
        tag: catalog.version.tag,
        sha: catalog.version.sha,
      };
      current.preview.source = source;
      current.preview.target = current.target;
      current.preview.version = catalog.version.version;

      return { job: current };
    },
    [`/api/plugin-installs/jobs/${catalogSeed.id}/cancel`]: () => {
      current = {
        ...current,
        status: 'cancelled',
        stage: null,
        finishedAt: '2026-10-22T11:00:00.000Z',
      };

      return { job: current };
    },
    [`/api/plugin-installs/jobs/${externalSeed.id}/apply`]: () => {
      applies += 1;
      current = {
        ...current,
        status: 'done',
        stage: null,
        finishedAt: '2026-10-22T11:00:00.000Z',
      };

      return { job: current };
    },
  });

  await fixture.page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  await fixture.page.locator('[data-role="settings-modal"]').waitFor();
  await fixture.page.evaluate(() => window.settingsFixture.settings.selectPage('plugins.installed'));
  await fixture.page.locator('[data-catalog-id="demo"]').waitFor();

  for (const [width, height] of [[1280, 800], [600, 800], [390, 844]]) {
    await fixture.page.setViewportSize({ width, height });

    if (await fixture.page.locator('[data-catalog-id="demo"]').isVisible()) {
      await fixture.page.locator('[data-catalog-id="demo"]').click();
    }

    await fixture.page.locator('[data-catalog-readme]').waitFor();
    assert.equal(await fixture.page.locator('[data-catalog-readme] script').count(), 0);
    assert.match(await fixture.page.locator('[data-catalog-readme]').textContent(), /<script>/u);


    const fits = await fixture.page.locator('.settings-page-scroll').evaluate((element) =>
      element.scrollWidth <= element.clientWidth + 1);

    assert.equal(fits, true);
    measurements.push({
      width,
      height,
      ...await fixture.page.locator('.settings-page-scroll').evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      })),
    });
    assert.equal(await fixture.page.locator('[data-install-git]').isVisible(), true);
    await fixture.page.screenshot({ path: path.join(fixture.artifacts, `catalog-${width}.png`) });

    const back = fixture.page.getByRole('button', { name: 'Назад к списку', exact: true });

    if (await back.isVisible()) {
      await back.click();
      assert.equal(await fixture.page.locator('[data-catalog-id="demo"]').isVisible(), true);
    }
  }

  await fs.writeFile(path.join(fixture.artifacts, 'catalog-geometry.json'),
    JSON.stringify(measurements, null, 2));
  await fixture.page.locator('[data-catalog-id="demo"]').click();
  await fixture.page.locator('[data-catalog-action]').click();
  await fixture.page.locator('[data-role="install-start"]:not([disabled])').waitFor();

  const presetUrl = await fixture.page.locator('[data-role="install-url"]').inputValue();

  assert.equal(presetUrl, catalog.entry.source.url);
  await fixture.page.locator('[data-role="install-start"]').click();
  await fixture.page.locator('[data-source-notice][data-membership="community"]').waitFor();
  await fixture.page.screenshot({ path: path.join(fixture.artifacts, 'catalog-ready-390.png') });
  assert.deepEqual(starts[0], {
    url: catalog.entry.source.url,
    version: catalog.version.version,
    expectedId: 'demo',
    expectedSha: catalog.version.sha,
  });
  assert.equal(applies, 0);
  await fixture.page.locator('[data-role="install-cancel"]').click();
  await fixture.page.locator('[data-role="install-result"]').waitFor();
  await fixture.page.getByRole('button', { name: 'Закрыть окно установки', exact: true }).click();

  // Первый job явно отменён. Обнуляется только тестовый transport перед независимым сценарием.
  // У нового job другой UUID, поэтому terminal receipts предыдущего не подменяют его результат.
  current = null;
  await fixture.page.locator('[data-install-git]').click();
  await fixture.page.locator('[data-role="install-url"]').fill(external);
  await fixture.page.locator('[data-role="install-find"]').click();
  await fixture.page.locator('[data-role="install-start"]:not([disabled])').click();
  await fixture.page.locator('[data-source-notice][data-membership="external"]').waitFor();
  assert.equal(applies, 0);
  assert.equal(starts[1].url, external);
  assert.equal(Object.hasOwn(starts[1], 'expectedId'), false);
  await fixture.page.getByRole('button', { name: 'Закрыть окно установки', exact: true }).click();
  await fixture.page.locator('[data-install-git]').click();
  await fixture.page.locator('[data-source-notice][data-membership="external"]').waitFor();
  assert.equal(applies, 0);
  assert.equal((await fixture.page.locator('[data-role="install-apply"]').textContent()).trim(),
    'Установить из этого источника');
  await fixture.page.screenshot({ path: path.join(fixture.artifacts, 'external-ready-390.png') });
  await fixture.page.locator('[data-role="install-apply"]:not([disabled])').click();
  await fixture.page.locator('[data-role="install-result"]').waitFor();
  assert.equal(applies, 1);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, []);
});


for (const locale of ['ru', 'en']) {
  for (const [width, height] of [[1280, 800], [600, 800], [390, 844]]) {
    test(`CAT-B2-MODULE-INSTALL: ${locale}, ${width}×${height}, warning/code/reopen/reload`, async (t) => {
      const data = JSON.parse(await fs.readFile('tests/web/fixtures/settings-modal/data.json', 'utf8'));
      const { modern } = moduleCatalogFixture();
      const seed = webInstallJob();
      const starts = [];
      let current = null;
      let applies = 0;

      seed.source = modern.entry.source;
      seed.target = {
        version: modern.version.version,
        tag: modern.version.tag,
        sha: modern.version.sha,
      };
      seed.preview.source = seed.source;
      seed.preview.target = seed.target;
      seed.preview.version = seed.target.version;
      seed.preview.hasServer = false;
      seed.preview.hasWeb = true;
      seed.preview.warnings = [moduleWarning];
      seed.preview.changes = {
        commits: [],
        files: ['panel.js', 'panel.css', 'ru.json', 'en.json']
          .map((file) => ({ status: 'M', path: `ui/${file}` })),
        sensitive: ['ui/panel.js', 'ui/panel.css', 'ui/ru.json', 'ui/en.json'],
        truncated: false,
      };

      const fixture = await startSettingsBrowser(t, {
        '/api/settings/prefs': data.prefs,
        '/api/providers': data.providers,
        '/api/plugins': data.plugins,
        '/api/plugin-catalog': catalogResponse(modern),
        '/api/plugin-catalog/demo': modern.detail,
        '/api/plugin-installs/jobs/current': () => ({ job: current, recoveryError: null }),
        '/api/plugin-installs/versions': () => ({ source: seed.source, versions: [seed.target] }),
        '/api/plugin-installs/jobs': (request) => {
          starts.push(request.postDataJSON());
          current = structuredClone(seed);

          return { job: current };
        },
        [`/api/plugin-installs/jobs/${seed.id}/apply`]: () => {
          applies += 1;
          current.status = 'done';
          current.kind = 'update';
          current.preview.replaces = {
            kind: 'managed',
            version: '1.1.0',
            sourceChanged: false,
          };
          current.finishedAt = '2026-10-22T11:00:00.000Z';

          return { job: current };
        },
      });
      const page = fixture.page;

      await page.setViewportSize({ width, height });
      await page.evaluate(async (url) => {
        const ui = await import(url);

        ui.setUiLocale('ru');
      }, `/@fs${path.resolve('web/src/ui.ts')}`);
      await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
      await page.locator('[data-role="settings-modal"]').waitFor();
      await page.evaluate(async ({ url, locale }) => {
        const ui = await import(url);

        ui.setUiLocale(locale);
        window.settingsFixture.settings.selectPage('plugins.installed');
      }, { url: `/@fs${path.resolve('web/src/ui.ts')}`, locale });
      await page.locator('.catalog-panel').waitFor();
      await page.evaluate(async (url) => {
        const { usePluginCatalogStore } = await import(url);

        await usePluginCatalogStore().loadIndex();
      }, `/@fs${path.resolve('web/src/stores/pluginCatalog.ts')}`);
      assert.equal(await page.locator('[data-catalog-id="demo"]').count(), 1,
        'Новый клиент должен показывать api2 карточку');
      await page.locator('[data-catalog-id="demo"]').click();
      await page.locator('[data-catalog-action]:not([disabled])').click();
      await page.locator('[data-role="install-start"]:not([disabled])').click();
      await page.locator('[data-role="install-warning"]').waitFor();
      assert.equal(await page.locator('[data-role="install-warning"]').textContent(), moduleWarning);
      assert.deepEqual(starts, [{
        url: modern.entry.source.url,
        version: modern.version.version,
        expectedId: 'demo',
        expectedSha: modern.version.sha,
      }]);
      assert.equal(applies, 0);

      const dialog = page.locator('[data-role="plugin-install-dialog"]');
      const close = dialog.locator('.install-head-row button');

      assert.equal(await close.isVisible(), true);
      await close.click();
      await page.locator('[data-install-git]').click();
      await page.locator('[data-role="install-warning"]').waitFor();
      assert.equal(await page.locator('[data-role="install-warning"]').textContent(), moduleWarning);
      await page.locator('[data-role="install-changes-toggle"]').click();
      assert.equal(await page.locator('[data-role="install-file"][data-sensitive="true"]').count(), 4);

      const codeText = locale === 'ru' ? 'код, исполняемый GrigDesk, или его зависимости'
        : 'code executed by GrigDesk or its dependencies';
      const previewText = await page.locator('[data-role="install-preview"]').textContent();

      assert.equal(previewText.includes(codeText), true);
      assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
      assert.equal(await page.locator('[data-role="install-scroll"]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
      assert.equal(await page.locator('[data-role="install-apply"]').isEnabled(), true);
      await page.screenshot({ path: path.join(fixture.artifacts, `module-ready-${locale}-${width}.png`) });
      await page.locator('[data-role="install-apply"]').click();
      await page.locator('[data-role="install-result"]').waitFor();

      const reload = locale === 'ru' ? /Перезапустите GrigDesk и перезагрузите окно/u
        : /Restart GrigDesk and reload the window/u;

      assert.match(await page.locator('[data-role="install-result"]').textContent(), reload);
      assert.equal(applies, 1);
      await close.click();
      current.kind = 'rollback';
      current.id = '00000000-0000-4000-8000-000000000088';
      current.target = {
        version: '1.1.0',
        tag: 'v1.1.0',
        sha: modern.detail.plugin.versions[1].sha,
      };
      current.preview.target = current.target;
      current.preview.version = current.target.version;
      await page.locator('[data-install-git]').click();
      await page.locator('[data-role="install-result"]').waitFor();
      assert.match(await page.locator('[data-role="install-result"]').textContent(), reload);
      assert.equal(await page.locator('[data-role="install-close"]').isVisible(), true);
      assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
      await page.screenshot({ path: path.join(fixture.artifacts, `module-rollback-${locale}-${width}.png`) });
      assert.deepEqual(fixture.errors, []);
      assert.deepEqual(fixture.unexpected, []);
    });
  }
}
