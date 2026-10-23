import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startSettingsBrowser } from '../fixtures/settings-modal/browser.mjs';
import { catalogFixture } from '../../helpers/pluginCatalog.js';
import { webInstallJob } from '../helpers/pluginInstallFixtures.js';

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
