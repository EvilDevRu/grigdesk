import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { PluginInstallService } from '../../server/src/lib/packageInstall/service.ts';
import { SYSTEM } from '../../server/src/lib/pluginsRegistry.ts';
import pluginsModule from '../../server/src/modules/plugins/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import { createPluginRepo } from './helpers/pluginRepo.js';
import { requireFromServer } from './helpers/pluginInstallHttpFixture.js';

const cases = [
  {
    label: 'true-custom',
    enabled: true,
    settings: true,
    placements: true,
  },
  {
    label: 'false-custom',
    enabled: false,
    settings: true,
    placements: true,
  },
  {
    label: 'absent',
    settings: false,
    placements: false,
  },
  {
    label: 'settings-only',
    settings: true,
    placements: false,
  },
  {
    label: 'placements-only',
    settings: false,
    placements: true,
  },
  {
    label: 'empty-maps',
    settings: false,
    placements: false,
    empty: true,
  },
  {
    label: 'true-default',
    enabled: true,
    settings: false,
    placements: false,
  },
];

/**
 * Контрактная версия читает прежний UUID без продуктовых операций и paid provider.
 * Настоящие installer/loader/prefs отвечают за сохранение id и допуск импорта.
 */
function releaseFixture() {
  return {
    manifest: {
      defaultEnabled: false,
      entrypoints: {
        server: 'server.mjs',
        web: { dir: 'ui', entry: 'panel.js' },
      },
      contributes: {
        panels: [{ title: '3D', hotkey: 'Ctrl+Shift+Digit7' }],
        slots: [{
          slot: 'provider.popover.after-bars',
          kind: 'provider-usage',
          default: true,
        }],
        settings: [
          {
            key: 'autoImport',
            type: 'checkbox',
            default: true,
          },
          {
            key: 'lowDiskGb',
            type: 'number',
            default: 10,
          },
          {
            key: 'libraryDir',
            type: 'text',
            default: '',
          },
        ],
      },
      install: { npm: [] },
    },
    files: {
      'server.mjs': [
        "import { readFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        '/**',
        ' * Фикстура читает прежний marker через выбранную настройку.',
        ' * Никаких новых файлов библиотеки и запросов поставщику она не создаёт.',
        ' */',
        'export default async function plugin(app, options) {',
        '  app.extractionProbe.imports.push(options.plugin.id);',
        '  const settings = options.prefs.read().pluginSettings?.[options.plugin.id] ?? {};',
        '  const directory = settings.libraryDir || app.extractionProbe.defaultLibraryDir;',
        '  app.get("/identity", async () => JSON.parse(',
        '    await readFile(path.join(directory, ".library.json"), "utf8")));',
        '}',
      ].join('\n'),
      'ui/panel.js': 'export default { render() { return null; } };',
    },
  };
}

/**
 * Файл prefs и две отдельные библиотеки принадлежат только текущему тесту.
 * Применение использует реальный полный SYSTEM reservedIds, не тестовое исключение id.
 */
async function extractionFixture(t, variant) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio3d-extraction-prefs-'));
  const pluginsDir = path.join(root, 'plugins');
  const prefsPath = path.join(root, 'prefs.json');
  const defaultLibraryDir = path.join(root, 'libraries/default');
  const customLibraryDir = path.join(root, 'libraries/custom');
  const seed = {};

  if (typeof variant.enabled === 'boolean') {
    seed.plugins = { studio3d: variant.enabled };
  }

  if (variant.settings) {
    seed.pluginSettings = { studio3d: {
      libraryDir: customLibraryDir,
      autoImport: false,
      lowDiskGb: 37,
    } };
  }

  if (variant.placements) {
    seed.pluginPlacements = { studio3d: { 'provider.popover.after-bars': false } };
  }

  if (variant.empty) {
    seed.plugins = {};
    seed.pluginSettings = {};
    seed.pluginPlacements = {};
  }

  await mkdir(pluginsDir, { recursive: true });
  await mkdir(defaultLibraryDir, { recursive: true });
  await mkdir(customLibraryDir, { recursive: true });

  const selectedLibrary = variant.settings ? customLibraryDir : defaultLibraryDir;
  const libraryId = randomUUID();
  const marker = `${JSON.stringify({ schema: 1, libraryId })}\n`;
  const history = `${JSON.stringify({
    schema: 1,
    intentId: randomUUID(),
    paymentState: 'unknown',
    amount: 12.5,
  })}\n`;
  const prefsBytes = `${JSON.stringify(seed, null, 2)}\n`;

  await writeFile(prefsPath, prefsBytes);
  await writeFile(path.join(selectedLibrary, '.library.json'), marker);
  await mkdir(path.join(selectedLibrary, '.jobs'));
  await writeFile(path.join(selectedLibrary, '.jobs/financial-history.json'), history);

  const prefs = new PrefsStore({ prefsPath });
  const write = prefs.write.bind(prefs);
  let writes = 0;

  t.mock.method(prefs, 'write', (patch) => {
    writes += 1;

    return write(patch);
  });

  const service = new PluginInstallService({
    pluginsDir,
    statePath: path.join(root, 'state/install.json'),
    grigDeskVersion: '1.0.0',
    reservedIds: SYSTEM.map((manifest) => manifest.id),
  });
  const apps = [];

  t.after(async () => {
    for (const app of apps) {
      await app.close();
    }

    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Каждый boot создаёт новый настоящий auth/router над теми же prefs и установленным деревом.
   * Готовность не меняет настройки; импорт включённого сервера виден в собственном probe.
   */
  async function boot() {
    const app = requireFromServer('fastify')({ logger: false });
    const authStore = new AuthStore({
      legacyAccountPath: path.join(root, 'auth/account.json'),
      sessionsPath: path.join(root, 'auth/sessions.json'),
    });
    const probe = { imports: [], defaultLibraryDir };

    apps.push(app);
    app.decorate('extractionProbe', probe);
    app.decorate('sse', { broadcast() {} });
    await app.register(authPlugin, { authStore });
    await app.register(pluginsModule, {
      config: {
        userPluginsDir: pluginsDir,
        userPluginsDataDir: path.join(root, 'data'),
      },
      prefs,
      installs: service,
      grigDeskVersion: '1.0.0',
    });
    await app.ready();

    const headers = { cookie: `grigdesk_sid=${authStore.createSession().id}` };

    return {
      app,
      probe,
      request: (url) => app.inject({ url, headers }),
    };
  }

  /**
   * Сравниваются исходные байты, чтобы no-op запись с тем же JSON не считалась миграцией.
   * Неизвестный денежный исход остаётся данными и не превращается тестом в новый заказ.
   */
  async function assertPreserved() {
    assert.equal(writes, 0);
    assert.equal(await readFile(prefsPath, 'utf8'), prefsBytes);
    assert.equal(await readFile(path.join(selectedLibrary, '.library.json'), 'utf8'), marker);
    assert.equal(await readFile(path.join(selectedLibrary, '.jobs/financial-history.json'), 'utf8'), history);
    assert.deepEqual(prefs.readStored(), seed);
  }

  return {
    root,
    service,
    boot,
    assertPreserved,
    seed,
    libraryId,
  };
}

for (const variant of cases) {
  test(`EXTRACT-BOOT: ${variant.label}, отсутствие пакета не пишет prefs/UUID/history`, async (t) => {
    const f = await extractionFixture(t, variant);
    const first = await f.boot();

    assert.equal((await first.request('/api/plugins')).statusCode, 200);
    assert.deepEqual(first.probe.imports, []);
    await f.assertPreserved();
    await first.app.close();

    const second = await f.boot();

    assert.equal((await second.request('/api/plugins')).statusCode, 200);
    assert.deepEqual(second.probe.imports, []);
    await f.assertPreserved();
  });
}

test('EXTRACT-FAILED: отказ настоящего candidate сохраняет все прежние данные', async (t) => {
  const repo = await createPluginRepo(t, { id: 'studio3d' });

  await repo.release('1.0.0', { manifest: { description: '' } });

  const f = await extractionFixture(t, cases[0]);

  await f.boot();
  await f.service.startInstall({ url: repo.url });
  await f.service.whenIdle();

  const failed = await f.service.currentJob();

  assert.equal(failed.status, 'failed');
  assert.equal(typeof failed.error.code, 'string');
  await f.assertPreserved();
});

test('EXTRACT-RESERVED-INSTALL: полный SYSTEM допускает прямой перенос с тем же id', async (t) => {
  const repo = await createPluginRepo(t, { id: 'studio3d' });

  await repo.release('1.0.0', releaseFixture());

  for (const variant of cases) {
    await t.test(variant.label, async (t) => {
      const f = await extractionFixture(t, variant);
      const first = await f.boot();

      await f.assertPreserved();
      await f.service.startInstall({ url: repo.url });
      await f.service.whenIdle();

      const ready = await f.service.currentJob();

      assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
      assert.equal((await f.service.apply(ready.id, ready.reviewToken)).status, 'done');
      await f.assertPreserved();

      const cards = (await first.request('/api/plugins')).json().plugins
        .filter((plugin) => plugin.id === 'studio3d');

      assert.equal(cards.length, 1);
      assert.equal(cards[0].system, false);
      assert.equal(cards[0].enabled, variant.enabled === true);
      assert.equal(cards[0].values.libraryDir, f.seed.pluginSettings?.studio3d?.libraryDir ?? '');
      assert.equal(cards[0].values.autoImport, variant.settings ? false : true);
      assert.equal(cards[0].placements[0].enabled, !variant.placements);
      assert.equal(first.probe.imports.length, variant.enabled === true ? 1 : 0);

      const identity = await first.request('/api/ext/studio3d/identity');

      assert.equal(identity.statusCode, variant.enabled === true ? 200 : 404);

      if (variant.enabled === true) {
        assert.equal(identity.json().libraryId, f.libraryId);
      }

      await first.app.close();

      const second = await f.boot();

      assert.equal(second.probe.imports.length, variant.enabled === true ? 1 : 0);
      await f.assertPreserved();
    });
  }
});
