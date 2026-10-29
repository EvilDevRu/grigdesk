import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build as viteBuild } from '../../../web/node_modules/vite/dist/node/index.js';
import { build as esbuild } from '../../../web/node_modules/esbuild/lib/main.js';
import ts from '../../../web/node_modules/typescript/lib/typescript.js';
import { clientBrowser } from './client-browser.mjs';
import { descriptor, pluginCard } from './pluginModuleContract.js';

const execFileAsync = promisify(execFile);
const buildHeapMb = 3072;
const root = path.resolve(import.meta.dirname, '../../..');
const fixtureRoot = path.join(root, 'tests/fixtures/plugins/ui-module/ui');
const hostId = '\0plugin-test-host-probe';
const probeSource = `
  import * as Vue from 'vue';
  import * as UI from ${JSON.stringify(path.join(root, 'web/src/ui.ts'))};
  import { usePluginsStore } from ${JSON.stringify(path.join(root, 'web/src/stores/plugins.ts'))};
  import { useDockStore } from ${JSON.stringify(path.join(root, 'web/src/stores/dock.ts'))};
  import { useChatStore } from ${JSON.stringify(path.join(root, 'web/src/stores/chat.ts'))};
  import { useAuthStore } from ${JSON.stringify(path.join(root, 'web/src/stores/auth.ts'))};
  export function fixtureState() {
    return { plugins: usePluginsStore(), dock: useDockStore(), chat: useChatStore(), auth: useAuthStore() };
  }

  export { Vue, UI };
  export { currentDesktopMode } from ${JSON.stringify(path.join(root, 'web/src/shared/desktopSettings.ts'))};
  export const runtimeProbe = {
    ref: Vue.ref, reactive: Vue.reactive, UiButton: UI.UiButton,
    confirmDialog: UI.confirmDialog, useUiLayer: UI.useUiLayer,
  };
  export function mountCoreProbe() {
    const element = document.createElement('div');
    element.id = 'core-runtime-probe';
    document.body.append(element);
    Vue.render(Vue.h(UI.UiButton, {
      onClick: () => UI.confirmDialog('Проверка ядра'),
    }, () => 'Кнопка ядра'), element);
  }
`;

/**
 * Probe входит в тот же Rollup-граф, что настоящее окно и фасады.
 * Никаких отдельных library build или копий Vue для сравнения не создаётся.
 */
function hostProbePlugin(production = false) {
  return {


    name: 'plugin-test-host-probe',


    buildStart() {
      if (!production) {
        return;
      }

      this.emitFile({


         type: 'chunk',


        id: hostId,


        name: 'plugin-test-host',


        preserveSignature: 'strict'


      });
    },


    resolveId(id) {
      return id === hostId || id === '/__plugin_host_probe__.js' ? hostId : null;
    },


    load(id) {
      return id === hostId ? probeSource : null;
    },


  };
}

/**
 * Читается AST того же ui.ts, который собирается в фасад.
 * Type-only декларации не становятся ложным ожиданием runtime-экспорта.
 */
export async function expectedUiExports() {
  const source = await readFile(path.join(root, 'web/src/ui.ts'), 'utf8');
  const ast = ts.createSourceFile('ui.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  return ast.statements.filter(ts.isExportDeclaration)
    .filter((statement) => !statement.isTypeOnly && statement.exportClause
      && ts.isNamedExports(statement.exportClause))
    .flatMap((statement) => statement.exportClause.elements
      .filter((item) => !item.isTypeOnly).map((item) => item.name.text)).sort();
}

/**
 * Полная сборка окна идёт в отдельном процессе node со своим пределом кучи.
 * Сторож тестов даёт worker-у 1024 МБ, а настоящей сборке нужно около 1,8 ГБ RSS (замер
 * 24.10.2026); предел RSS сторожа по группе процессов при этом по-прежнему держит машину.
 * Процесс пишет байты выходов и их описание в temp: ни dist, ни .vite-temp в worktree.
 */
async function writeRuntimeBundle(directory) {
  const result = await viteBuild({
    root: path.join(root, 'web'),
    configFile: path.join(root, 'web/vite.config.js'),
    configLoader: 'native',
    envFile: false,
    cacheDir: path.join(directory, 'cache'),
    logLevel: 'silent',
    plugins: [hostProbePlugin(true)],
    build: { write: false, outDir: path.join(directory, 'dist') },
  });
  const bundle = Array.isArray(result) ? result[0] : result;

  assert.ok(bundle && 'output' in bundle, 'Vite должен вернуть окончательный bundle');

  const items = [];

  for (const item of bundle.output) {
    const file = path.join(directory, 'dist', item.fileName);

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, item.type === 'asset' ? item.source : item.code);
    items.push(item.type === 'asset'
      ? { type: item.type, fileName: item.fileName }
      : {
        type: item.type,
        fileName: item.fileName,
        exports: item.exports,
        modules: Object.keys(item.modules),
        facadeModuleId: item.facadeModuleId,
      });
  }

  await writeFile(path.join(directory, 'output.json'), JSON.stringify(items));
}

/**
 * Выходы дочерней сборки возвращаются в той форме Rollup output, которую читают проверки:
 * exports, ключи modules, facadeModuleId и байты code/source.
 */
async function readRuntimeBundle(directory) {
  const items = JSON.parse(await readFile(path.join(directory, 'output.json'), 'utf8'));

  return Promise.all(items.map(async (item) => {
    const bytes = await readFile(path.join(directory, 'dist', item.fileName));

    if (item.type === 'asset') {
      return { ...item, source: bytes };
    }

    return {
      ...item,
      code: bytes.toString('utf8'),
      modules: Object.fromEntries(item.modules.map((id) => [id, {}])),
    };
  }));
}

/**
 * Одна настоящая сборка index.html переиспользуется всеми production-проверками.
 * Кэш и выходы временные; Vite не пишет ни dist, ни .vite-temp в worktree.
 */
export async function buildRuntime() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-build-'));

  try {
    await execFileAsync(process.execPath, [`--max-old-space-size=${buildHeapMb}`, import.meta.filename,
      '--build', directory], { cwd: root, maxBuffer: 16 * 1024 * 1024 });

    const output = await readRuntimeBundle(directory);
    const html = output.find((item) => item.fileName === 'index.html');
    const recipe = await esbuild({


      entryPoints: [path.join(fixtureRoot, 'panel.js')],


      bundle: true,


      format: 'esm',


      external: ['vue', '@grigdesk/ui'],


      write: false,


      metafile: true,


    });

    assert.ok(html && html.type === 'asset');
    assert.ok(Object.keys(recipe.metafile.inputs).every((name) => !name.includes('node_modules')));
    assert.match(recipe.outputFiles[0].text, /from ["']vue["']/);
    assert.match(recipe.outputFiles[0].text, /from ["']@grigdesk\/ui["']/);

    return {


      directory,


      output,


      html: String(html.source),


      recipe: recipe.outputFiles[0].text,


      probeUrl: './' + output.find((item) =>
        item.type === 'chunk' && item.facadeModuleId === hostId).fileName,


    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });

    throw error;
  }
}

/**
 * Карта проверяется до запуска браузера, поэтому базовый RED указывает на отсутствующее поведение.
 * Все цели должны принадлежать именно текущему output и идти перед любым module preload/script.
 */
export function runtimeMap(built) {
  const match = built.html.match(/<script\b[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/);

  assert.ok(match, 'PM-BUILD: настоящий index.html должен содержать import map плагинов');

  const map = JSON.parse(match[1]);

  assert.deepEqual(Object.keys(map.imports).sort(), ['@grigdesk/ui', 'vue']);

  const firstModule = built.html.search(
    /<(?:script[^>]*type=["']module|link[^>]*rel=["']modulepreload)/,
  );

  assert.ok(match.index < firstModule);

  for (const url of Object.values(map.imports)) {
    assert.match(url, /^\.\/assets\/.+-[\w-]{8,}\.js$/);
    assert.ok(built.output.some((item) => './' + item.fileName === url), 'Цель карты есть в текущем bundle');
  }

  return map;
}

/**
 * Тестовый middleware отдаёт байты собранного HTML до преобразований Vite.
 * Пакет, API и сессия вымышленные; запросы не уходят на живой GrigDesk.
 */
function assetsPlugin(built, variant = 'valid') {
  return {
    name: 'plugin-test-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://fixture');
        const name = url.pathname.split('/').at(-1);
        let body;
        let type = 'application/javascript';

        if (url.pathname === '/api/fixture/echo') {
          body = JSON.stringify({ session: req.headers.cookie?.includes('fixture-session') ?? false });
          type = 'application/json';
        } else if (url.pathname.startsWith('/api/ext/ui-module/module/')) {
          if (name === 'missing.js') {
            res.statusCode = 404;
            res.end('Модуля нет');

            return;
          }
          if (name === 'broken.js') {
            body = 'export default {render(){throw new Error("Ошибка render")}};';
          } else if (name === 'panel.js' && built) {
            body = built.recipe;
          } else if (['panel.js', 'helper.js', 'panel.css', 'ru.json', 'en.json'].includes(name)) {
            body = await readFile(path.join(fixtureRoot, name));
            type = name.endsWith('.json') ? 'application/json' : name.endsWith('.css') ? 'text/css' : type;
          }
        } else if (built && url.pathname === '/') {
          body = built.html;
          type = 'text/html';

          if (variant === 'missing-map') {
            body = body.replace(/<script\b[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/, '');
          } else if (variant === 'invalid-json') {
            body = body.replace(/(<script\b[^>]*type=["']importmap["'][^>]*>)[\s\S]*?(<\/script>)/, '$1{$2');
          } else if (variant !== 'valid') {
            body = body.replace(/(<script\b[^>]*type=["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/,
              (_, start, json, end) => {
                const map = JSON.parse(json);

                map.imports.vue = variant === 'missing-target' ? '/missing-vue.js' : '/wrong-vue.js';

                return start + JSON.stringify(map) + end;
              });
          }
        } else if (url.pathname === '/wrong-vue.js') {
          body = 'export const ref=()=>{}; export const reactive=()=>{};';
        } else if (url.pathname === '/missing-vue.js') {
          res.statusCode = 404;
          res.end();

          return;
        } else if (built) {
          const item = built.output.find((entry) => '/' + entry.fileName === url.pathname);

          if (item) {
            body = item.type === 'asset' ? item.source : item.code;
            type = item.fileName.endsWith('.css') ? 'text/css' : type;
          }
        }

        if (body !== undefined) {
          res.setHeader('Content-Type', type);
          res.end(body);

          return;
        }

        next();
      });
    },
  };
}

/**
 * Окно использует настоящий App/ToolHost и изолированные API общего browser-helper.
 * Изменён только каталог и статика пакета; дополнительные hosts и SSE не создаются.
 * @param {import('node:test').TestContext} t
 * @param {{built?: Awaited<ReturnType<typeof buildRuntime>> | null, variant?: string,
 * entry?: string, width?: number, hmr?: boolean, b1?: boolean, mode?: 'main' | 'page'}} [options]
 */
export async function runtimeBrowser(t, { built = null, variant = 'valid', entry = descriptor.entry,
  width = 1280, hmr = false, b1 = false, mode = 'page' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-browser-'));
  const streams = new Set();
  const requests = [];
  const eventPlugin = {
    name: 'plugin-b1-events',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://fixture');

        if (url.pathname.startsWith('/api/')) {
          requests.push({ method: req.method, path: url.pathname });
        }
        if (url.pathname === '/api/events') {
          res.setHeader('Content-Type', 'text/event-stream');
          res.write('event: hello\ndata: {"boot":"fixture"}\n\n');
          streams.add(res);
          res.on('close', () => streams.delete(res));

          return;
        }

        next();
      });
    },
  };
  const plugins = [assetsPlugin(built, variant), ...(b1 ? [eventPlugin] : []), hostProbePlugin()];

  t.after(() => {
    for (const stream of streams) {
      stream.destroy();
    }
  });

  t.after(() => rm(directory, { recursive: true, force: true }));

  if (!built) {
    const pluginPath = path.join(root, 'web/scripts/pluginRuntimePlugin.mjs');
    const present = await access(pluginPath).then(() => true, () => false);

    if (present) {
      const module = await import(pathToFileURL(pluginPath).href);
      const factory = module.default ?? module.pluginRuntimePlugin;

      plugins.push(factory());
    }
  }

  const fixture = await clientBrowser(t, {


    artifacts: directory,


    hmr,


    vitePlugins: plugins,


    responses: {
      '/api/plugins': { plugins: [pluginCard({
        webModule: {
          ...descriptor,
          entry,
          ...(b1 ? { startOnLogin: true } : {})
        },
      })] },
      ...(b1 ? {
        '/api/chat/store': {
          sessions: [{
            id: 'existing-chat',
            messages: [],
            createdAt: 1
          }],
          activeId: 'existing-chat',
          defModelRef: { provider: 'fixture-provider', model: 'fixture-model' },
        },
        '/api/chat/workdir/preview': {
          capability: { switch: 'resume', roots: 'multi' },
          target: { cwd: directory, workdir: { kind: 'grigdesk' } },
        },
      } : {}),
    },


  });
  const page = await fixture.browser.newPage({ viewport: { width, height: 900 } });

  if (mode === 'main') {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'GrigDeskSettings/1 GrigDeskWindow/main',
        configurable: true,
      });
    });
  }

  await page.context().addCookies([{


     name: 'grigdesk_sid',


    value: 'fixture-session',


    url: fixture.origin


  }]);
  await page.addInitScript(() => {
    const Original = window.EventSource;

    window.__eventSourceCount = 0;
    window.EventSource = class extends Original {
      constructor(...args) {
        super(...args);
        window.__eventSourceCount += 1;
      }
    };
  });
  await page.goto(fixture.origin + '#/chats');
  await page.locator('#app').waitFor();

  if (!built) {
    // SSE запускается до завершения первого lazy-маршрута.
    // Ждём маршрутизатор, чтобы следующий переход не затёрся начальным /chats.
    await page.evaluate(async () => {
      const { router } = await import('/src/router.ts');

      await router.isReady();
    });
  }

  const probeUrl = built ? new URL(built.probeUrl, fixture.origin).href
    : new URL('/__plugin_host_probe__.js', fixture.origin).href;

  await page.evaluate(async (url) => {
    window.__pluginHost = await import(url);
    window.__pluginHost.mountCoreProbe();
  }, probeUrl);
  await page.getByRole('button', { name: 'Кнопка ядра', exact: true }).waitFor();
  await page.waitForFunction(() => window.__eventSourceCount >= 1);

  return {


     ...fixture,


    page,


    probeUrl,
    requests,
    emitPlugin: (pluginId, event, data) => {
      const body = JSON.stringify({
        pluginId,
        event,
        data
      });

      for (const stream of streams) {
        stream.write(`event: plugin-event\ndata: ${body}\n\n`);
      }
    },

  };
}

/**
 * Проверка === выполняется в настоящем браузере на нативных bare imports.
 * Версии пакетов или отдельная сборка библиотеки такой проверки не заменяют.
 */
export async function sharedIdentity(page, { production = true } = {}) {
  const identity = await page.evaluate(async (production) => {
    const host = window.__pluginHost.runtimeProbe;
    const plugin = await import('/api/ext/ui-module/module/panel.js');
    const vue = await import('vue');
    const ui = await import('@grigdesk/ui');

    return Object.fromEntries(Object.keys(host).map((key) => [key,
      host[key] === plugin.runtimeProbe[key] && host[key] === (key in vue ? vue[key] : ui[key]),
    ]));
  }, production);

  assert.deepEqual(identity, {


    ref: true,

    reactive: true,

    UiButton: true,

    confirmDialog: true,

    useUiLayer: true,


  });
}

/**
 * Штатный confirm открывается через уже существующий DialogHost настоящего App.
 * Его работоспособность проверяется и до открытия неисправного плагина, и после.
 */
export async function healthyCore(page) {
  await page.getByRole('button', { name: 'Кнопка ядра', exact: true }).click();
  await page.getByText('Проверка ядра', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('Проверка ядра', { exact: true }).waitFor({ state: 'hidden' });
}

/**
 * Открытие всегда идёт штатным hash-маршрутом, доступным и на телефоне.
 * Ожидание ограничено, чтобы отсутствие новой панели давало адресный assertion RED.
 */
export async function openModule(page, origin) {
  await page.goto(origin + '#/ext/ui-module');

  const present = await page.locator('.plugin-runtime-fixture').waitFor({ timeout: 6000 })
    .then(() => true, () => false);

  assert.equal(present, true, 'PM-PANEL: модульная Vue-панель отсутствует на /ext/ui-module');
}

/**
 * Сообщение читается из того же общего словаря, что и панель продукта.
 * Язык переключается через общий runtime ref, без перезагрузки документа.
 */
export async function expectPanelMessage(page, key, locale = 'ru') {
  const text = await page.evaluate(({ key, locale }) => {
    window.__pluginHost.UI.setUiLocale(locale);

    return window.__pluginHost.UI.t(key, { name: 'Модуль проверки' });
  }, { key, locale });

  assert.ok(text && text !== key && text.includes('Модуль проверки'),
    `Отсутствует перевод панели с именем плагина: ${key} (${locale})`);

  const shown = await page.getByText(text, { exact: false }).first().waitFor({ timeout: 6000 })
    .then(() => true, () => false);

  assert.equal(shown, true, `PM-FAILURES: нет локального сообщения ${key} (${locale})`);
}

/**
 * Общие UI элементы исполняются через default ESM-компонент плагина.
 * Проверяются Teleport, два Escape, CSS и сохранность ввода без дополнительных hosts.
 */
export async function sharedControls(f) {
  const { page } = f;

  await openModule(page, f.origin);
  await page.goto(f.origin + '#/chats');
  await page.locator('.tool-rail-item[aria-label^="Модуль проверки"]').click();
  await page.locator('.tool-surface.is-dock .plugin-runtime-fixture').waitFor();
  assert.equal(await page.locator('[data-context="tool-dock-detach"]').count(), 0);
  await sharedIdentity(page);
  await page.getByLabel('Ввод плагина').fill('Черновик');
  await page.getByRole('button', { name: 'Подсказка плагина', exact: true }).hover();
  await page.getByText('Общая подсказка', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Диалог плагина', exact: true }).click();
  await page.getByText('Диалог модуля', { exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-runtime-fixture .ui-dialog').count(), 0);

  const geometry = await page.locator('.ui-dialog-overlay').last().evaluate((element) => {
    const rect = element.getBoundingClientRect();

    return {


       x: rect.x,


      y: rect.y,


      width: rect.width,


      height: rect.height


    };
  });
  const viewport = page.viewportSize();

  assert.ok(geometry.width >= viewport.width - 1 && geometry.height >= viewport.height - 1);
  await page.getByRole('button', { name: 'Подтверждение плагина', exact: true }).click();
  await page.getByText('Подтвердить из плагина?', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('Подтвердить из плагина?', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('Диалог модуля', { exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  await page.getByText('Диалог модуля', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('Ввод плагина').inputValue(), 'Черновик');

  const styles = await page.locator('.plugin-runtime-fixture').evaluate((element) => ({
    fixture: getComputedStyle(element).getPropertyValue('--plugin-fixture-loaded').trim(),
    button: getComputedStyle(element.querySelector('.ui-button')).fontFamily,
  }));

  assert.equal(styles.fixture, 'yes');
  assert.ok(styles.button && styles.button !== 'Times New Roman');
  await page.getByText('Помощник модуля', { exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-runtime-fixture').getAttribute('data-compact'), 'true');
  await page.locator('[data-context="tool-dock-expand"]').click();
  assert.equal(await page.locator('.tool-surface.is-expanded .plugin-runtime-fixture').count(), 1);
  assert.equal(await page.getByLabel('Ввод плагина').inputValue(), 'Черновик');
}

/**
 * Context использует вымышленную cookie, общий язык и единственный SSE настоящего окна.
 * После смены языка сохранён тот же input, а модуль не исполняется повторно.
 */
export async function browserContext(f) {
  const { page } = f;
  const before = await page.evaluate(() => window.__eventSourceCount);

  await openModule(page, f.origin);
  await page.getByLabel('Ввод плагина').fill('Ввод');
  await page.getByText('Привет, Мир', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Запрос плагина', exact: true }).click();
  await page.locator('[data-plugin-response]').filter({ hasText: 'true' }).waitFor();

  const input = await page.getByLabel('Ввод плагина').elementHandle();
  const executions = await page.evaluate(() => window.__pluginFixtureExecutions);

  await page.evaluate(() => window.__pluginHost.UI.setUiLocale('en'));
  await page.getByText('Hello, Мир', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Ввод плагина').inputValue(), 'Ввод');
  assert.equal(await page.getByLabel('Ввод плагина').evaluate((element, previous) => element === previous,
    input), true);
  assert.equal(await page.evaluate(() => window.__pluginFixtureExecutions), executions);
  assert.equal(await page.evaluate(() => window.__eventSourceCount), before);
}

export const sourceRoot = root;

if (process.argv[1] === import.meta.filename && process.argv[2] === '--build') {
  await writeRuntimeBundle(process.argv[3]);
}
