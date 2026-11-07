import type { FastifyInstance, FastifyRequest } from '../../server/node_modules/fastify/fastify.js';
import type {
  InstallablePluginManifest, PluginManifest,
} from '../../packages/plugin-types/src/index.js';
import type {
  PluginCore, PluginServerAsync, PluginServerCallback, PluginServerOptions,
} from '../../packages/plugin-types/src/server.js';
import type { PluginServerModule } from '../../server/src/lib/runtimeImport.ts';
import { createPluginCore } from '../../server/src/modules/plugins/core.ts';

// PUBLIC-MANIFEST: вход автора отличается от нормализованных метаданных.
const manifest: PluginManifest = {
  id: 'typed-plugin',
  api: 1,
  description: 'Панель с сервером',
  icon: 'assets/icon.png',
  entrypoints: {
    server: 'runtime/main.ts',
    web: {
      dir: 'ui',
      entry: 'panel.js',
      css: ['panel.css'],
      locales: { ru: 'ru.json', en: 'en.json' },
    },
  },
  contributes: {
    panels: [{ title: 'Панель', group: 'tools' }],
    settings: [{
      key: 'limit',
      type: 'number',
      default: 1
    }],
    slots: [{
      slot: 'provider.popover.after-bars',
      kind: 'provider-usage',
      default: true
    }],
  },
  install: { npm: [] },
  engines: { grigdesk: '>=0.1.0' },
};
// @ts-expect-error PUBLIC-MANIFEST: старый HTML-канал запрещён.
const legacy: PluginManifest = { ...manifest, web: 'web' };
const installable: InstallablePluginManifest = { ...manifest, version: '1.0.0' };
// @ts-expect-error PUBLIC-MANIFEST: второе поколение не исполняется.
const invalidApi: PluginManifest = { ...manifest, api: 2 };
// @ts-expect-error PUBLIC-MANIFEST: version обязательна только для установки.
const missingVersion: InstallablePluginManifest = { id: 'bad' };
// @ts-expect-error PUBLIC-MANIFEST: старый nav не является входом автора.
const missingPath: PluginManifest = { ...manifest, nav: { label: 'Плагин' } };

// PUBLIC-SERVER-OPTIONS: загрузчик и автор используют один контракт options.
declare const runtimeOptions: Parameters<PluginServerModule['default']>[1];
const options: PluginServerOptions = runtimeOptions;
declare const request: FastifyRequest;
const authKind: 'session' | 'internal' | 'cli' | null | undefined = request.authKind;
/**
 * Автор использует lifecycle и Fastify без внутренних объектов приложения.
 * Аннотация проверяет оба направления связи options с загрузчиком.
 */
const asyncServer: PluginServerAsync = async (app, input) => {
  app.get('/status', async (incoming) => ({ authKind: incoming.authKind }));
  input.core.emit('ready', input.plugin.id);
  input.prefs.write({ enabled: true });
  input.prefs.write(null);
  input.lifecycle.onEnable = () => {};
  input.lifecycle.onDisable = async () => {};
  input.lifecycle.prepareChange = async (change, signal) => {
    signal.throwIfAborted();
    input.core.emit('settings', change.values);

    return {
      commit() {},
      rollback: async () => {},
      afterCommit: async () => {},
    };
  };
  input.lifecycle.prepareReplace = async (signal) => {
    signal.throwIfAborted();

    return { finish: async (outcome) => {
      void outcome;
    } };
  };
};
const callbackServer: PluginServerCallback = (app, input, done) => {
  input.core.emit('ready');
  app.get('/callback', async () => ({}));
  done();
};
const asyncModule: PluginServerModule = { default: asyncServer };
const callbackModule: PluginServerModule = { default: callbackServer };

// PUBLIC-CORE-PRIVACY: проверяется реальный результат фабрики, а не только новый интерфейс.
declare const actualCore: ReturnType<typeof createPluginCore>;
const core: PluginCore = actualCore;

actualCore.acquireKernelFileLock({
  lockPath: '/unused',
  mode: 'shared',
  timeoutMs: 1,
});
// @ts-expect-error PUBLIC-CORE-PRIVACY: выбор бинарника принадлежит ядру.
actualCore.acquireKernelFileLock({ lockPath: '/unused', binary: 'flock' });
// @ts-expect-error PUBLIC-CORE-PRIVACY: фабрика ошибок принадлежит ядру.
actualCore.acquireKernelFileLock({ lockPath: '/unused', errorFactory: () => new Error() });

declare const handle: Awaited<ReturnType<typeof actualCore.acquireKernelFileLock>>;
// @ts-expect-error PUBLIC-CORE-PRIVACY: файловый дескриптор не публичный API.
handle.inheritedFd();
// @ts-expect-error PUBLIC-CORE-PRIVACY: нет доступа ко всему config.
options.config.prefsPath;
// @ts-expect-error PUBLIC-CORE-PRIVACY: нет внутренних методов PrefsStore.
options.prefs.readStored();
// @ts-expect-error PUBLIC-CORE-PRIVACY: нельзя добавлять корни.
core.documents.addRootProvider(() => []);

const locked: Promise<number> = core.withPathLock('key', async () => 1);
const range: { start: number; end: number } | 'invalid' | null = core.parseByteRange('bytes=0-1', 2);
const providers = core.getProviders('3d');

void [legacy, installable, invalidApi, missingVersion, missingPath, authKind, asyncModule,
  callbackModule, locked, range, providers];
