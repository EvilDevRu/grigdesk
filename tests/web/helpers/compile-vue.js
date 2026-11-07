import { existsSync } from 'node:fs';
// Единый TS-aware compiler для component tests. Он бандлит локальный граф .vue/.ts,
// а Vue/Pinia оставляет внешними singleton-модулями из web/node_modules.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from '../../../web/node_modules/esbuild/lib/main.js';
import { compileScript, parse } from '../../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js';

import { ApiError, failureText } from '../../../web/src/shared/apiClient.ts';

const REPO_ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const WEB_ROOT = path.join(REPO_ROOT, 'web');
const SINGLETONS = new Map([
  ['vue', path.join(WEB_ROOT, 'node_modules/vue/index.mjs')],
  ['pinia', path.join(WEB_ROOT, 'node_modules/pinia/dist/pinia.mjs')],
  ['vue-router', path.join(WEB_ROOT, 'node_modules/vue-router/dist/vue-router.mjs')],
]);
// Тяжёлые библиотеки не включаются в каждую тестовую сборку чата.
// В component tests подсветка и схемы подменяются явными загрузчиками.
const LAZY_EXTERNALS = ['mermaid', 'shiki', 'shiki/*'];

const migrationPairs = Object.entries(JSON.parse(await readFile(
  new URL('../../fixtures/webMigrationScope.json', import.meta.url), 'utf8',
)).pairs);

/**
 * Точные подмены следуют переименованию только перечисленных продуктовых модулей.
 * Это переходный resolver тестов: отсутствие конечных файлов отдельно ловит MIG.
 */
export function renamedSpecifier(specifier) {
  for (const [previous, next] of migrationPairs) {
    const oldName = path.basename(previous);

    if (specifier.endsWith(`/${oldName}`)) {
      return specifier.slice(0, -oldName.length) + path.basename(next);
    }
  }

  return specifier;
}

let nonce = 0;

// Data-URL навсегда оставляет в ESM cache и сам base64-код, и очень длинный
// идентификатор модуля. Короткий file: URL удерживает только загруженный модуль;
// исходник после import уже не нужен.
async function importCompiled(code) {
  const directory = await mkdtemp(path.join(tmpdir(), 'grigdesk-vue-test-'));
  const filename = path.join(directory, `module-${process.pid}-${nonce += 1}.mjs`);

  try {
    await writeFile(filename, code, 'utf8');

    return await import(pathToFileURL(filename).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function vuePlugin(expose = [], entryFilename = null) {
  return {
    name: 'grigdesk-vue-sfc',
    setup(builder) {
      builder.onResolve({ filter: /\.vue$/ }, (args) => ({
        path: path.isAbsolute(args.path) ? args.path : path.resolve(args.resolveDir, args.path),
        namespace: 'grigdesk-vue',
      }));
      builder.onLoad({ filter: /\.vue$/, namespace: 'grigdesk-vue' }, async (args) => {
        let source = await readFile(args.path, 'utf8');

        if (args.path === entryFilename && expose.length) {
          source = source.includes('defineExpose({')
            ? source.replace('defineExpose({', `defineExpose({ ${expose.join(', ')}, `)
            : source.replace('</script>', `\ndefineExpose({ ${expose.join(', ')} });\n</script>`);
        }

        const parsed = parse(source, { filename: args.path });

        if (parsed.errors.length) {
          throw new Error(parsed.errors.map((error) => error instanceof Error ? error.message : String(error)).join('\n'));
        }

        const descriptor = parsed.descriptor;
        const compiled = compileScript(descriptor, {
          id: `data-v-test-${nonce += 1}`,
          inlineTemplate: true,
        });

        // Vue распаковывает default динамического импорта по признаку ES-модуля.
        // Синтетический namespace esbuild сам этого признака не получает.
        return {
          contents: compiled.content + '\nexport const __esModule = true;\n',
          loader: descriptor.scriptSetup?.lang === 'ts' || descriptor.script?.lang === 'ts' ? 'ts' : 'js',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

function dependencyPlugin(stubs) {
  return {
    name: 'grigdesk-test-dependencies',
    setup(builder) {
      for (const [specifier, singletonPath] of SINGLETONS) {
        if (Object.hasOwn(stubs, specifier)) {
          continue;
        }

        builder.onResolve({ filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => ({
          path: pathToFileURL(singletonPath).href,
          external: true,
        }));
      }

      const compatibleStubs = { ...stubs };

      for (const [specifier, contents] of Object.entries(stubs)) {
        const renamed = renamedSpecifier(specifier);

        compatibleStubs[renamed] = contents;

        for (const [previous, next] of migrationPairs) {
          if (specifier.endsWith(`/${path.basename(next)}`)) {
            compatibleStubs[specifier.slice(0, -path.basename(next).length)
              + path.basename(previous)] = contents;
          }
        }
      }

      for (const [specifier, contents] of Object.entries(compatibleStubs)) {
        const filter = new RegExp(
          `^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        );

        builder.onResolve({ filter }, () => ({
          path: specifier,
          namespace: 'grigdesk-stub',
        }));
        // resolveDir нужен стабам, которые реэкспортируют кусок настоящего модуля:
        // без него esbuild некуда разрешать пути из подменённого кода.
        builder.onLoad(
          {
            filter,
            namespace: 'grigdesk-stub',
          },
          () => ({
            contents,
            loader: 'js',
            resolveDir: WEB_ROOT
          }),
        );
      }

      builder.onResolve({ filter: /\.ts$/ }, (args) => {
        const target = path.resolve(args.resolveDir, args.path);

        if (target === webFile('src/shared/apiClient.ts')) {
         return { path: pathToFileURL(target).href, external: true };
        }

        for (const [previous, next] of migrationPairs) {
          const oldFile = path.join(REPO_ROOT, previous);
          const newFile = path.join(REPO_ROOT, next);

          if (target === newFile && !existsSync(newFile)) {
           return { path: oldFile };
          }
        }

       return null;
      });
    },
  };
}

/**
 * @param {string} filename абсолютный путь к SFC
 * @param {{stubs?: Record<string, string>, expose?: string[]}} options
 */
export async function compileVue(filename, { stubs = {}, expose = [] } = {}) {
  const result = await build({
    entryPoints: [filename],
    absWorkingDir: WEB_ROOT,
    bundle: true,
    external: LAZY_EXTERNALS,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    plugins: [dependencyPlugin(stubs), vuePlugin(expose, filename)],
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text;

  if (!code) {
    throw new Error(`esbuild не вернул модуль для ${filename}`);
  }

  return (await importCompiled(code)).default;
}

/**
 * Бандлит обычный JS/TS entry тем же resolver-ом, что и компонентные проверки.
 * Тяжёлые lazy imports остаются внешними; тест задаёт их результат явным loader-ом.
 */
export async function compileModule(filename, { stubs = {} } = {}) {
  const result = await build({
    entryPoints: [filename],
    absWorkingDir: WEB_ROOT,
    bundle: true,
    external: LAZY_EXTERNALS,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    plugins: [dependencyPlugin(stubs), vuePlugin()],
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text;

  if (!code) {
    throw new Error(`esbuild не вернул модуль для ${filename}`);
  }

  return importCompiled(code);
}

export function webFile(relativePath) {
  return path.join(WEB_ROOT, relativePath);
}

/**
 * Возвращает тот же runtime singleton, который использует компилятор.
 * Неизвестная зависимость означает ошибку фикстуры, а не новый экземпляр Vue.
 */
export function singletonUrl(name) {
  const file = SINGLETONS.get(name);

  if (!file) {
    throw new Error(`Неизвестный singleton: ${name}`);
  }

  return pathToFileURL(file).href;
}

// Переходная обвязка выполняет один и тот же контракт на исходном JS и будущем TS.
// Структурные тесты отдельно запрещают fallback и требуют конечные пути.

export const migrationHarness = {
  api: {},
  ApiError,
  failureText,
  alerts: [],
  dismissed: [],
  sse: null,
  providers: null,
  context: null,
  visibility: null,
  routerOptions: null,
};

globalThis.__migrationHarness = migrationHarness;

const prelude = 'const harness = globalThis.__migrationHarness;';

/**
 * Выбирает вход без изменения проверяемого исходника и не касается данных владельца.
 * Существующий TS всегда приоритетен: после BUILD исполняется именно новый модуль.
 */
export function migrationFile(oldPath, newPath = oldPath.replace(/\.js$/, '.ts')) {
  return webFile(existsSync(webFile(newPath)) ? newPath : oldPath);
}

/**
 * Подменяет только внешние порты: локальные контракты и декодеры остаются настоящими.
 * Оба точных имени поддерживают rename, не скрывая новых зависимостей широкой regexp.
 */
export function migrationStubs() {
  const apiStub = `${prelude}
    export const api = harness.api;
    export const ApiError = harness.ApiError;
    export const failureText = harness.failureText;`;
  const stubs = {
    '../shared/apiClient.ts': apiStub,
    '../../shared/apiClient.ts': apiStub,
    './apiClient.ts': apiStub,
    '../shared/alerts.ts': `${prelude}
      export const alertUser = (notice) => harness.alerts.push(notice);
      export const dismissAlert = (id) => harness.dismissed.push(id);
      export const dismissAlertScope = (id) => harness.dismissed.push(id);`,
    '../composables/useSse.ts': `${prelude}
      export const sseSubscribe = (fn) => { harness.sse = fn; return () => {}; };`,
    './uiContext.ts': `${prelude} export const useUiContextStore = () => harness.context;`,
    '../shared/md.ts': 'export const mdToText = (value) => value;',
    '../shared/chatVisibility.ts': `${prelude} export const chatVisibility = harness.visibility;`,
  };
  const router = `${prelude} export const router = {
    currentRoute: { value: { path: '/chats', meta: {} } },
  };`;
  const providers = `${prelude} export const useProvidersStore = () => harness.providers;`;

  for (const extension of ['js', 'ts']) {
    stubs[`../router.${extension}`] = router;
    stubs[`./providers.${extension}`] = providers;
  }

  stubs['./speechPcmWorklet.ts?worker&url'] = 'export default "file:///test-worklet.js";';

  return stubs;
}

/**
 * Каждая сборка создаёт отдельный модуль и сохраняет настоящий singleton Pinia.
 * Дополнительные точные doubles задаются сценарием поверх стандартных портов.
 */
export function loadMigrationModule(oldPath, newPath, stubs = {}) {
  return compileModule(migrationFile(oldPath, newPath), {
    stubs: { ...migrationStubs(), ...stubs },
  });
}

// Component-проверки открывают только нужные setup-поля через тестовый compiler.
// Шаблон, watchers и действия остаются исходными; сеть и внешние виджеты управляемы.

export const viewHarness = {
  ApiError,
  failureText,
  api: /** @type {{
   * get?: (url: string, options?: object) => Promise<unknown>;
   * post?: (url: string, body?: object) => Promise<unknown>;
   * upload?: (url: string, body?: object) => Promise<unknown>;
   * wsUrl?: (url: string) => string;
   * }} */ ({}),
  stores: {},
  route: { query: {} },
  router: {
    replace(value) {},
    push() {},
    back() {}
  },
  errors: /** @type {unknown[]} */ ([]),
  sockets: /** @type {{onmessage(event: {data: unknown}): void}[]} */ ([]),
  terminals: /** @type {{writes: unknown[]}[]} */ ([]),
};

globalThis.__viewBoundaryHarness = viewHarness;

const viewPrelude = 'const h = globalThis.__viewBoundaryHarness;';

/**
 * Собирает корневой экран с настоящим setup и лёгкими дочерними оболочками.
 * Изолируется только импортируемый SFC: зависимости неизвестного типа не стираются regex-заменой.
 */
export async function compileBoundary(relative, expose, additional = {}) {
  const filename = webFile(relative);
  const source = await readFile(filename, 'utf8');
  const uiSource = await readFile(webFile('src/ui.ts'), 'utf8');
  const uiNames = [...uiSource.matchAll(/default as (Ui\w+)/g)].map((match) => match[1]);
  const ui = [
    'import { h } from "vue";',
    `export { t } from ${JSON.stringify(webFile('src/services/locale.ts'))};`,
    'const component = { setup: (_, { slots }) => () => h("div", {}, slots.default?.({close() {}})) };',
    ...uiNames.map((name) => name === 'UiDialog' || name === 'UiPopover'
      ? `export const ${name} = { props: ['open'], setup: () => () => null };`
      : `export const ${name} = component;`),
    'export const vTooltip = {};',
    'export const confirmDialog = async () => true;',
    'export const alertDialog = async () => {};',
    'export const showToast = () => {};',
  ].join('\n');
  const apiStub = `${viewPrelude}
    export const api = h.api;
    export const ApiError = h.ApiError;
    export const failureText = h.failureText;`;
  const stubs = {
    '../ui': ui,
    '../../ui': ui,
    '../shared/apiClient.ts': apiStub,
    '../../shared/apiClient.ts': apiStub,
    'vue-router': `${viewPrelude}
      export const useRoute = () => h.route;
      export const useRouter = () => h.router;`,
    '../composables/useSse.ts': `
      export const useSse = () => ({connected: {value: true}});
      export const sseSubscribe = () => () => {};
    `,
    '../composables/useUiContextSource.ts': `export const useUiContextSource = () => ({
      focus() {}, update() {}, blur() {},
    });`,
    '../shared/md.ts': 'export const mdToHtml = (text) => String(text || "");',
    '../../shared/md.ts': 'export const mdToHtml = (text) => String(text || "");',
  };

  for (const match of source.matchAll(/from\s+['"]([^'"]+\.vue)['"]/g)) {
    stubs[match[1]] = 'export default {template: "<div><slot /></div>"};';
  }

  for (const [file, exported] of Object.entries({
    ui: 'useUiStore',
    tasks: 'useTasksStore',
    board: 'useBoardStore',
    plugins: 'usePluginsStore',
    taskFavorites: 'useTaskFavoritesStore',
    taskSeen: 'useTaskSeenStore',
    taskShelf: 'useTaskShelfStore',
    trackers: 'useTrackersStore',
  })) {
    for (const extension of ['js', 'ts']) {
      stubs[`../stores/${file}.${extension}`] = `${viewPrelude}
        export const ${exported} = () => h.stores[${JSON.stringify(exported)}];`;
    }
  }

  return compileVue(filename, { stubs: { ...stubs, ...additional }, expose });
}

/**
 * Терминал сохраняет реальный lifecycle и wire handlers без настоящего PTY.
 * Записи и отправленные команды видны тесту, а ресурсы закрываются при unmount.
 */
export function terminalDoubles() {
  viewHarness.sockets = [];
  viewHarness.terminals = [];

  class Terminal {
    constructor() {
      this.cols = 80;
      this.rows = 24;
      this.writes = [];
      viewHarness.terminals.push(this);
    }

    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write(value) {
      this.writes.push(value);
    }
    focus() {}
    dispose() {}
  }

  class Socket {
    static OPEN = 1;

    constructor() {
      this.readyState = 1;
      this.sent = [];
      viewHarness.sockets.push(this);
    }

    send(value) {
      this.sent.push(value);
    }
    close() {
      this.readyState = 3;
    }
  }

  Object.defineProperty(globalThis, 'WebSocket', { value: Socket, configurable: true });
  viewHarness.Terminal = Terminal;

  return {
    '@xterm/xterm': `${viewPrelude} export const Terminal = h.Terminal;`,
    '@xterm/addon-fit': 'export class FitAddon { fit() {} }',
  };
}

// Медиа-порты не открывают микрофон и сокет; controller/transport остаются настоящими.
// Запись и ответы можно менять независимо, чтобы отличать неверный DTO от cleanup.

export function transportHarness({
  flushPcm = null,
  flushAck = true,
  deferredModule = null,
  deferredClose = null,
  deferredSocketClose = null,
} = {}) {
  const state = {
    sockets: /** @type {FakeSocket[]} */ ([]),
    contexts: /** @type {FakeAudioContext[]} */ ([]),
    workletNodes: [],
    sources: [],
    gains: [],
    trackStops: 0,
  };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      this.closeCalls = [];
      state.sockets.push(this);
    }
    send(value) {
      this.sent.push(value);
    }
    /**
     * Закрытие сокета может быть отложено тестом для проверки bounded cleanup.
     * В обычном режиме ресурс сразу переходит в закрытое состояние.
     */
    close(code) {
      this.closeCalls.push(code);

      if (!deferredSocketClose) {
       this.readyState = 3;

        return;
      }

      this.readyState = 2;
      deferredSocketClose.promise.then(() => {
       this.readyState = 3;
       this.onclose?.();
      });
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    message(value) {
      this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
    }
    serverClose() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  class FakeAudioNode {
    constructor(bucket) {
      this.connections = [];
      this.disconnectCalls = 0;
      bucket.push(this);
    }
    connect(target) {
      this.connections.push(target);

      return target;
    }
    disconnect() {
      this.disconnectCalls += 1;
    }
  }

  class FakeSource extends FakeAudioNode {
    constructor() {
      super(state.sources);
    }
  }

  class FakeGain extends FakeAudioNode {
    constructor() {
      super(state.gains);
      this.gain = { value: 1 };
    }
  }

  class FakePort {
    constructor() {
      this.onmessage = null;
      this.started = false;
      this.closed = false;
      this.toWorklet = [];
    }
    start() {
      this.started = true;
    }
    close() {
      this.closed = true;
    }
    postMessage(message) {
      this.toWorklet.push(message);

      if (message?.type !== 'flush') {
        return;
      }

      queueMicrotask(() => {
        if (flushPcm) {
         this.emitPcm(flushPcm);
        }
        if (flushAck) {
         this.onmessage?.({ data: { type: 'flushed' } });
        }
      });
    }
    emitPcm(pcm) {
      const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm);

      this.onmessage?.({ data: { type: 'pcm', pcm: samples.buffer } });
    }
  }

  class FakeWorkletNode extends FakeAudioNode {
    constructor(context, name, options) {
      super(state.workletNodes);
      this.context = context;
      this.name = name;
      this.options = options;
      this.port = new FakePort();
    }
  }

  class FakeAudioContext {
    constructor() {
      this.destination = {};
      this.closeCalls = 0;
      this.resumeCalls = 0;
      this.loadedModules = [];
      this.audioWorklet = {
        addModule: async (url) => {
         this.loadedModules.push(url);

          if (deferredModule) {
            await deferredModule.promise;
          }
        },
      };
      state.contexts.push(this);
    }
    createMediaStreamSource() {
      return new FakeSource();
    }
    createGain() {
      return new FakeGain();
    }
    async resume() {
      this.resumeCalls += 1;
    }
    async close() {
      this.closeCalls += 1;

      if (deferredClose) {
        await deferredClose.promise;
      }
    }
  }

  const mediaStream = {
    getTracks: () => [{ stop: () => {
                                state.trackStops += 1;
                              } }],
  };
  const config = {
    mediaStream,
    sessionId: 'speech-session-1',
    revision: 'opaque-revision-1',
    apiClient: { wsUrl: (path) => `wss://grigdesk.test${path}` },
    WebSocketCtor: FakeSocket,
    AudioContextCtor: FakeAudioContext,
    AudioWorkletNodeCtor: FakeWorkletNode,
  };

  return { state, config };
}

/**
 * Контроллер получает полный browser/media контракт с управляемыми ответами.
 * Recorder завершает запись асинхронно, как браузер, без живого сервиса речи.
 */
export async function speechControllerHarness(prefs, replies = {}) {
  const module = await loadProductModule('src/features/speech/controller.ts');
  const state = {
    prefs,
    commits: [],
    errors: [],
    calls: /** @type {Array<[string, string, unknown?]>} */ ([]),
    recognitions: [],
    stopped: 0
  };

  class Recognition {
    static async available() {
      return 'available';
    }
    constructor() {
       state.recognitions.push(this);
    }
    start() {}
    abort() {}
    stop() {}
  }

  Object.defineProperty(Recognition.prototype, 'processLocally', { value: true, writable: true });

  class Recorder {
    constructor() {
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
       this.ondataavailable?.({ data: new Blob(['audio'], {type: 'audio/webm'}) });
       this.onstop?.();
      });
    }
  }

  const controller = module.createDictationController({
    settings: {
      read: () => state.prefs,
      apply: (payload) => {
               state.prefs = payload.settings || payload;

              return state.prefs;
             },
    },
    browser: {
      isSecureContext: () => true,
      recognitionCtor: () => Recognition,
      phraseCtor: () => null,
      uiLanguage: () => 'ru-RU',
    },
    media: {
      hasGetUserMedia: () => true,
      getUserMedia: async () => ({getTracks: () => [{stop: () => {
                                                             state.stopped += 1;
                                                           }}]}),
      recorderCtor: () => Recorder,
    },
    localStream: { supported: () => false },
    apiClient: {
      async get(url) {
        state.calls.push(['GET', url]);

       return replies.settings || {};
      },
      async post(url, body) {
        state.calls.push(['POST', url, body]);

       return url.endsWith('/warmup') ? (replies.warmup || {}) : (replies.settings || {});
      },
      async upload(url, body) {
        state.calls.push(['UPLOAD', url, body]);

       return replies.upload || {};
      },
      async del(url) {
        state.calls.push(['DELETE', url]);

       return {};
      },
    },
  });
  const lease = controller.acquire(Symbol('speech-boundary'), {
    onCommit: (text) => state.commits.push(text),
    onError: (error) => state.errors.push(error),
  });

  return {
    controller,
    lease,
    state
  };
}

/**
 * Unit-потребители разделяют настоящий API singleton с самим тестом.
 * Стирается только TypeScript и Vite URL import; доменные функции не подменяются.
 */
export function loadProductModule(relative, stubs = {}) {
  const pair = migrationPairs.find(([, next]) => next === `web/${relative}`);
  const previous = pair ? pair[0].slice(4) : relative;

  return compileModule(migrationFile(previous, relative), {
    stubs: {
      './speechPcmWorklet.ts?worker&url': 'export default "file:///test-worklet.js";',
      ...stubs,
    },
  });
}

/**
 * Чтение исходника и загрузка модуля используют одинаковый переходный выбор.
 * URL нужен старым unit-потребителям, сохраняющим fileURLToPath/new URL контракт.
 */
export function migrationUrl(relative) {
  const pair = migrationPairs.find(([, next]) => next === `web/${relative}`);
  const previous = pair ? pair[0].slice(4) : relative;

  return pathToFileURL(migrationFile(previous, relative));
}
