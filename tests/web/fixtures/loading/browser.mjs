import { extraStubs } from './extraCases.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createServer } from '../../../../web/node_modules/vite/dist/node/index.js';
import { propCases, portCases } from './cases.mjs';
import vue from '../../../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { chromium } from '../../../../desktop/node_modules/playwright-core/index.mjs';
/**
 * Один Vite и Chromium на файл; все страницы и ресурсы закрываются даже при отказе старта.
 * Реальные SFC и production CSS используют только синтетические порты без proxy к серверу.
 */
export async function startLoadingBrowser(t, { additionalMocks = {}, entry = '', replies = {} } = {}) {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const artifacts = path.join(process.env.GRIGDESK_ARTIFACTS_DIR, 'loading-browser');
    const fixture = path.join(root, 'tests/web/fixtures/loading');
    const ports = JSON.stringify(path.join(fixture, 'ports.mjs'));
    const mocks = new Map(Object.entries({
        'stores/docker.ts': 'export const useDockerStore = () => globalThis.__loadingSurface.store;',
        'stores/studio3d.ts': 'export const useStudio3dStore = () => globalThis.__loadingSurface.store;',
        'stores/plugins.ts': `export const usePluginsStore = () => ({ byId: () => ({ values: {} }),
          enabled: () => true, loaded: true,
          loadSetup: () => fetch('/api/fixture/setup').then((response) => response.json()),
        });`,
        'shared/projectsApi.ts': 'export const projectsApi = { list: async () => [] };',
        'stores/chat.ts': `export { useChatStore } from ${ports}; export const CONTEXT_WINDOW = 200000;`,
        'stores/providers.ts': `import { providers } from ${ports};
      export const useProvidersStore = () => providers;`,
        'stores/tasks.ts': 'export const useTasksStore = () => ({ load: async () => null });',
        'stores/documentPreview.ts': 'export const useDocumentPreviewStore = () => ({});',
        'features/speech/provider.ts': `import { speech } from ${ports};
      export const useDictationController = () => speech;`,
        'shared/tools/launcher.ts': 'export const useToolLauncher = () => ({ openTool() {} });',
        'features/code/links.ts': `export const loadCodeRoots = () => Promise.resolve([]);
      export const codeLinkFromClick = () => null;
      export const chatFileLinkHref = () => '';`,
        'composables/useUiContextSource.ts': `export const useUiContextSource = () => ({
      focus() {}, update() {}, blur() {},
    });`,
        'composables/useSse.ts': `import { connected } from ${ports};
      export const useSse = () => ({ connected });
      export const sseSubscribe = () => () => {};`,
    }).map(([relative, source]) => [path.join(root, 'web/src', relative), source]));

    for (const [relative, source] of Object.entries(extraStubs())) {
        const filename = path.resolve(root, 'web/src/views/synthetic', relative);

        mocks.set(filename, source);
        mocks.set(`${filename}.ts`, source);
        mocks.set(`${filename}.js`, source);
    }

    // Путь actions из экранов короче, чем из вложенных панелей.
    // Явная привязка не меняет разрешение остальных продуктовых импортов.
    mocks.set(path.join(root, 'web/src/actions/sandboxes'), extraStubs()['../actions/sandboxes']);
    mocks.set(path.join(root, 'web/src/shared/monaco.ts'), extraStubs()['../../shared/monaco.ts']);
    mocks.set(path.join(root, 'web/src/shared/routesApi.ts'), `export const routesApi = {
      effectivePolicy: () => fetch('/api/fixture/effective-policy').then((response) => response.json()),
    };`);
    mocks.set(path.join(root, 'web/src/stores/taskShelf.ts'),
      extraStubs()['../../stores/taskShelf.ts']);
    mocks.set(path.join(root, 'web/src/stores/ui.ts'), extraStubs()['../../stores/ui.ts']);

    for (const [relative, source] of Object.entries(additionalMocks)) {
        mocks.set(path.join(root, 'web/src', relative), source);
    }

    let server;
    let browser;

    t.after(async () => {
        await browser?.close();
        await server?.close();
    });
    await fs.mkdir(artifacts, { recursive: true });
    server = await createServer({
        configFile: false,
        envFile: false,
        root: fixture,
        cacheDir: path.join(artifacts, `vite-cache-${process.pid}`),
        plugins: [
            {
                name: 'loading-synthetic-ports',
                enforce: 'pre',
                /**
             * Подменяет только перечисленные внешние порты по полному пути.
             * Все остальные зависимости разрешает настоящий Vite.
             */
            resolveId(source, importer) {
                    if (!importer || !source.startsWith('.')) {
                        return;
                    }

                    const base = path.resolve(path.dirname(importer), source);
                    const target = [base, `${base}.ts`, `${base}.js`].find((item) => mocks.has(item));

                    if (mocks.has(target)) {
                        return `\0loading-port:${target}`;
                    }
                },
                load(id) {
                    return id.startsWith('\0loading-port:')
                    ? mocks.get(id.slice('\0loading-port:'.length))
                    : undefined;
                },
            },
            vue()
        ],
        resolve: {
            dedupe: ['vue', 'pinia', 'vue-router'],
            alias: {
                vue: path.join(root, 'web/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
                pinia: path.join(root, 'web/node_modules/pinia/dist/pinia.mjs'),
                'vue-router': path.join(root, 'web/node_modules/vue-router/dist/vue-router.mjs'),
            },
        },
        optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'vue-router'] },
        server: {
            host: '127.0.0.1',
            port: 0,
            watch: null,
            fs: { allow: [root, artifacts] }
        },
    });
    await server.listen();
    browser = await chromium.launch({
        headless: true,
        channel: 'chromium',
        chromiumSandbox: true,
        args: ['--disable-features=LocalNetworkAccessChecks'],
    });

    const address = server.httpServer.address();
    /**
     * Каждая проверка получает отдельный context и storage, а не живые настройки владельца.
     * Неизвестный запрос и любая мутация остаются причиной провала тестовой среды.
     */
    async function open(test, {
        mode = 'chat',
        viewport = { width: 1280, height: 800 },
        storage = {},
        blockedStorage = false,
    } = {}) {
        const context = await browser.newContext({ viewport });
        const unexpected = [];
        const errors = [];
        const requests = [];
        const held = Promise.withResolvers();
        const spec = [...propCases, ...portCases].find((item) => item.id === mode);

        test.after(() => context.close());
        await context.addInitScript(({ values, blocked }) => {
            for (const [key, value] of Object.entries(values)) {
                localStorage.setItem(key, String(value));
            }

            if (blocked) {
                Object.defineProperty(window, 'localStorage', {
                    get() {
                        throw new DOMException('Хранилище отключено фикстурой', 'SecurityError');
                    },
                });
            }
        }, { values: storage, blocked: blockedStorage });
        await context.route('**/api/**', (route) => {
            const request = route.request();
            const url = new URL(request.url());

            requests.push(`${request.method()} ${url.pathname}${url.search}`);

            if (request.method() === 'GET' && (spec?.endpoint?.test(url.pathname + url.search)
                || (spec?.port === 'routes-policy' && url.pathname === '/api/fixture/effective-policy')
                || (spec?.port === 'setup' && url.pathname === '/api/fixture/setup'))) {
                return held.promise.then(() => route.fulfill({ json: spec.response }));
            }

            if (request.method() === 'GET' && Object.hasOwn(replies, url.pathname)) {
                return held.promise.then(() => route.fulfill({ json: replies[url.pathname] }));
            }

            if (request.method() === 'GET' && url.pathname === '/api/tasks') {
                return route.fulfill({ json: { tasks: [] } });
            }
            if (request.method() === 'GET' && url.pathname === '/api/chat/sessions') {
                return route.fulfill({ json: { sessions: [] } });
            }

            unexpected.push(`${request.method()} ${url.pathname}${url.search}`);

            return route.fulfill({ status: 500, json: { error: 'Неизвестный API стенда' } });
        });

        const page = await context.newPage();

        page.setDefaultTimeout(7000);

        page.on('pageerror', (error) => errors.push(error.stack || error.message));
        await page.goto(`http://127.0.0.1:${address.port}/${entry}?mode=${mode}`);
        await page.waitForFunction(() => Boolean(window.loadingFixture), null, { timeout: 10000 })
            .catch((error) => {
                throw new Error(`${error.message}; pageerror=${JSON.stringify(errors)}`);
            });
        await frames(page);

        if (mode === 'docker-usage') {
            await page.getByRole('tab', { name: 'Уборка', exact: true }).click();
            await frames(page);
        }

        if (spec?.openDetails) {
            await page.locator(`${spec.openDetails} summary`).click();
            await frames(page);
        }

        return {
            release: () => held.resolve(),
            page,
            context,
            unexpected,
            errors,
            requests,
            artifacts
        };
    }

    return { open, artifacts };
}
/**
 * Измерение ждёт готовности шрифтов и двух кадров, без случайного sleep.
 * Это даёт браузеру применить реактивное состояние и пересчитать layout.
 */
export async function frames(page) {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}
