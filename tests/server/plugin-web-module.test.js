import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import pluginsModule from '../../server/src/modules/plugins/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const fixtureSource = new URL('../fixtures/plugins/ui-module/', import.meta.url);
const declaration = {
  dir: 'ui',
  entry: 'panel.js',
  css: ['panel.css'],
  locales: { ru: 'ru.json', en: 'en.json' },
};

/**
 * Каждый тест владеет каталогом плагинов, сессий и настроек.
 * Пакет копируется из репозитория; данные установленного окна не читаются.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-module-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'plugins'));

  return root;
}

/**
 * Manifest и модуль записаны до старта Fastify, как при обычном обнаружении.
 * Идентификатор изменяется согласованно с именем временной папки.
 */
async function packageAt(root, id = 'ui-module', extra = {}) {
  const directory = path.join(root, 'plugins', id);

  await cp(fixtureSource, directory, { recursive: true });
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({
    id,
    name: id,
    api: 2,
    version: '1.0.0',
    webModule: declaration,
    ...extra,
  }));

  return directory;
}

/**
 * Настоящий общий гард использует только созданную этим тестом сессию.
 * В модуль передаются прежние config/prefs без установщика или живого сервиса.
 */
async function startApp(t, root, enabled = ['ui-module']) {
  const app = Fastify({ logger: false });
  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'auth/account.json'),
    sessionsPath: path.join(root, 'auth/sessions.json'),
  });
  let data = { plugins: Object.fromEntries(enabled.map((id) => [id, true])) };
  const prefs = {
    read: () => data,
    write: (patch) => {
       data = { ...data, ...patch };
    },
  };

  t.after(() => app.close());
  await app.register(authPlugin, { authStore });
  await app.register(pluginsModule, {
    config: { userPluginsDir: path.join(root, 'plugins'), userPluginsDataDir: path.join(root, 'data') },
    prefs,
  });
  await app.ready();

  return { app, headers: { cookie: `grigdesk_sid=${authStore.createSession().id}` } };
}

test('PM-SCAN: api2 без index получает модуль и nav по умолчанию; api1 игнорирует поле', async (t) => {
  const root = await fixture(t);

  await packageAt(root);
  await packageAt(root, 'legacy', { api: 1 });

  const plugins = await scanUserPlugins(path.join(root, 'plugins'));
  const module = plugins.find((item) => item.id === 'ui-module');

  assert.ok(module.webModule, 'Scanner должен обнаружить JS-модуль api2 без index.html');
  assert.equal(module.webModule.dir, path.join(root, 'plugins/ui-module/ui'));
  assert.equal(module.web, null);
  assert.equal(module.nav.path, '/ext/ui-module');
  assert.equal(module.nav.group, 'dock');
  assert.equal(module.nav.icon, 'plugin');
  assert.equal(module.nav.label, module.name);
  assert.equal(plugins.find((item) => item.id === 'legacy').webModule ?? null, null);
});

for (const [label, webModule] of Object.entries({
  absolute: { ...declaration, dir: '/etc' },
  root: { ...declaration, dir: '.' },
  escape: { ...declaration, entry: '../plugin.json' },
  scheme: { ...declaration, entry: 'https://other.invalid/panel.js' },
  missing: { ...declaration, entry: 'missing.js' },
  wrongtype: { ...declaration, entry: 'ru.json' },
  query: { ...declaration, entry: 'panel.js?x=1' },
  backslash: { ...declaration, entry: '..\\panel.js' },
})) {
  test(`PM-SCAN: неверный ${label} отбрасывает только модуль с предупреждением`, async (t) => {
    const root = await fixture(t);

    await packageAt(root, 'bad', { webModule });
    await packageAt(root, 'healthy');

    const warnings = [];
    const list = await scanUserPlugins(path.join(root, 'plugins'), {
      warn: (meta) => warnings.push(meta.plugin),
    });

    assert.equal(list.length, 2);
    assert.equal(list.find((item) => item.id === 'bad').webModule ?? null, null);
    assert.ok(warnings.includes('bad'), 'Отказ объявления должен быть назван в журнале');
    assert.ok(list.find((item) => item.id === 'healthy').webModule);
  });
}

test('PM-SCAN: entry-ссылка наружу отвергнута, явная навигация сохраняется', async (t) => {
  const root = await fixture(t);
  const dir = await packageAt(root, 'linked');

  await writeFile(path.join(root, 'outside.js'), 'export default {};');
  await rm(path.join(dir, 'ui/panel.js'));
  await symlink(path.join(root, 'outside.js'), path.join(dir, 'ui/panel.js'));
  await packageAt(root, 'nav', {
    nav: {
       path: '/custom',
      label: 'Своё имя',
      group: 'tools',
      order: 7
    },
  });

  const warnings = [];
  const list = await scanUserPlugins(path.join(root, 'plugins'), {
    warn: (meta) => warnings.push(meta.plugin),
  });

  assert.equal(list.find((item) => item.id === 'linked').webModule ?? null, null);
  assert.ok(warnings.includes('linked'));
  assert.equal(list.find((item) => item.id === 'nav').nav.group, 'tools');
  assert.equal(list.find((item) => item.id === 'nav').nav.order, 7);
});

test('PM-HTTP: каталог, MIME, helper и прежний prefix server.js; off/api99 закрыты', async (t) => {
  const root = await fixture(t);
  const dir = await packageAt(root);

  await writeFile(path.join(dir, 'server.js'), `
    export default async function register(app, options) {
      app.get('/probe', async () => ({
        pluginId: options.plugin.id,
        hasConfig: !!options.config,
        hasPrefs: !!options.prefs,
      }));
    }
  `);
  await packageAt(root, 'off');
  await packageAt(root, 'future', { api: 99 });

  const { app, headers } = await startApp(t, root, ['ui-module', 'future']);
  const catalog = (await app.inject({ url: '/api/plugins', headers })).json().plugins;
  const card = catalog.find((item) => item.id === 'ui-module');

  const prefix = card.webModule.entry.replace(/panel\.js$/, '');

  assert.match(prefix, /^\/api\/ext\/ui-module\/module\/[a-f0-9-]+\/$/);
  assert.deepEqual(card.webModule, {
    entry: `${prefix}panel.js`,
    css: [`${prefix}panel.css`],
    locales: {
      ru: `${prefix}ru.json`,
      en: `${prefix}en.json`,
    },
  });
  assert.ok(catalog.every((item) => item.web === null || typeof item.web === 'string'));

  for (const [file, mime] of [
    ['panel.js', /javascript/], ['helper.js', /javascript/],
    ['panel.css', /text\/css/], ['ru.json', /json/], ['en.json', /json/],
  ]) {
    const response = await app.inject({ url: `${prefix}${file}`, headers });

    assert.equal(response.statusCode, 200, file);
    assert.match(response.headers['content-type'], mime);
  }

  const probe = await app.inject({ url: '/api/ext/ui-module/probe', headers });

  assert.equal(probe.statusCode, 200);
  assert.deepEqual(probe.json(), {
     pluginId: 'ui-module',
    hasConfig: true,
    hasPrefs: true
  });

  for (const id of ['off', 'future']) {
    assert.equal((await app.inject({ url: `/api/ext/${id}/module/panel.js`, headers })).statusCode, 404);
  }
});

test('PM-AUTH-PATH: сессия обязательна, dotfiles/выход/ссылки не раскрывают файлы', async (t) => {
  const root = await fixture(t);
  const dir = await packageAt(root);

  await writeFile(path.join(root, 'outside.js'), 'СЕКРЕТ_ФИКСТУРЫ');
  await writeFile(path.join(dir, 'ui/.hidden'), 'СЕКРЕТ_ФИКСТУРЫ');
  await symlink(path.join(root, 'outside.js'), path.join(dir, 'ui/link.js'));

  const { app, headers } = await startApp(t, root);
  const url = '/api/ext/ui-module/module/panel.js';

  assert.equal((await app.inject({ url, headers })).statusCode, 200);
  assert.equal((await app.inject({ url })).statusCode, 401);

  for (const file of ['.hidden', 'link.js', '../plugin.json', '%2e%2e/plugin.json']) {
    const response = await app.inject({ url: `/api/ext/ui-module/module/${file}`, headers });

    assert.notEqual(response.statusCode, 200, file);
    assert.doesNotMatch(response.body, /СЕКРЕТ_ФИКСТУРЫ/);
  }
});

test('PM-DOCS-V2: документация api2 доступна, api99 исключена', async (t) => {
  const root = await fixture(t);

  for (const [id, api] of [['ui-module', 2], ['future', 99]]) {
    const dir = await packageAt(root, id, { api });

    await mkdir(path.join(dir, 'docs'));
    await writeFile(path.join(dir, 'docs/README.md'), '# Описание');
  }

  const { app } = await startApp(t, root, ['ui-module', 'future']);

  assert.deepEqual((await app.pluginDocs()).map((item) => item.id), ['ui-module']);
});

for (const startOnLogin of [true, false]) {
  test(`PM-START-DTO: scanner и HTTP сохраняют startOnLogin=${startOnLogin}`, async (t) => {
    const root = await fixture(t);

    await packageAt(root, 'ui-module', { webModule: { ...declaration, startOnLogin } });

    const list = await scanUserPlugins(path.join(root, 'plugins'));

    assert.equal(list[0].webModule.startOnLogin, startOnLogin);

    const { app, headers } = await startApp(t, root);
    const response = await app.inject({ url: '/api/plugins', headers });

    assert.equal(response.statusCode, 200);

    const card = response.json().plugins.find((item) => item.id === 'ui-module');

    assert.ok(card, 'HTTP-каталог содержит тестовый плагин');
    assert.equal(card.webModule.startOnLogin, startOnLogin);
  });
}

for (const startOnLogin of ['true', 1, null]) {
  test(`PM-START-DTO: ${JSON.stringify(startOnLogin)} отбрасывает только модуль`, async (t) => {
    const root = await fixture(t);

    await packageAt(root, 'bad', { webModule: { ...declaration, startOnLogin } });
    await packageAt(root, 'healthy');
    await packageAt(root, 'legacy', { api: 1, webModule: { ...declaration, startOnLogin } });

    const warnings = [];
    const list = await scanUserPlugins(path.join(root, 'plugins'), {
      warn: (meta) => warnings.push(meta.plugin),
    });

    assert.equal(list.length, 3);
    assert.equal(list.find((item) => item.id === 'bad').webModule ?? null, null);
    assert.ok(warnings.includes('bad'));
    assert.ok(list.find((item) => item.id === 'healthy').webModule);
    assert.equal(list.find((item) => item.id === 'legacy').webModule ?? null, null);
  });
}


test('PM-ICON: контур из пакета сохраняется scanner и HTTP даже у выключенного плагина', async (t) => {
  const root = await fixture(t);
  const icon = 'svg:M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3z';

  for (const id of ['ui-module', 'off']) {
    await packageAt(root, id, {
      nav: { path: `/ext/${id}`, label: id, icon, group: 'dock' },
    });
  }

  const list = await scanUserPlugins(path.join(root, 'plugins'));

  assert.equal(list.find((item) => item.id === 'ui-module').nav.icon, icon);

  const { app, headers } = await startApp(t, root);
  const response = await app.inject({ url: '/api/plugins', headers });

  assert.equal(response.statusCode, 200);

  const cards = response.json().plugins;

  for (const id of ['ui-module', 'off']) {
    const card = cards.find((item) => item.id === id);

    assert.equal(card.nav.icon, icon);
    assert.equal(card.enabled, id === 'ui-module');
  }
});
