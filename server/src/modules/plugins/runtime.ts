import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

import type { PluginManifest } from '../../lib/pluginsRegistry.ts';
import { importRuntimeModule } from '../../lib/runtimeImport.ts';
import type { PluginServerModule } from '../../lib/runtimeImport.ts';
import type {
  PluginServerOptions, PluginServerAsync, PluginServerCallback, ReplacementLease,
} from '../../../../packages/plugin-types/src/server.ts';
import { pluginModuleStaticOptions } from '../../lib/pluginWebModule.ts';
import { createPluginLifecycle, PluginAdmission } from './lifecycle.ts';
import { changeError } from './changes.ts';

export const PLUGIN_APIS = [1];

interface RuntimeEntry {
  app: FastifyInstance;
  gate: PluginAdmission;
  manifest: PluginManifest;
  directory: string | null;
  generation: string;
  closed: boolean;
  ready: boolean;
}

interface RuntimeOptions {
  parent: FastifyInstance;
  options(manifest: PluginManifest): Promise<Omit<PluginServerOptions, 'lifecycle'>>;
}

/**
 * Каждый пользовательский сервер владеет отдельным Fastify без слушающего порта.
 * Постоянный маршрут оболочки передаёт ему запрос только после общего auth и admission.
 */
export class UserPluginRuntime {
  readonly gates = new Map<string, PluginAdmission>();
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly retired = new Set<string>();
  private readonly requests = new WeakMap<IncomingMessage, FastifyRequest>();
  private readonly options: RuntimeOptions;
  private closing = false;

  constructor(options: RuntimeOptions) {
    this.options = options;
  }

  isLoaded(id: string): boolean {
    return this.entries.has(id);
  }

  isLoading(id: string): boolean {
    return this.loading.has(id);
  }

  renewModule(id: string): void {
    const entry = this.entries.get(id);

    if (entry) {
      entry.generation = randomUUID();
    }
  }

  /**
   * Опубликованный каталог завершает замену также у выключенных пакетов.
   * Их первое включение сможет загрузить новую версию без старого installed gate.
   */
  catalogPublished(): void {
    for (const id of this.retired) {
      if (!this.entries.has(id)) {
        this.retired.delete(id);
        this.gates.delete(id);
      }
    }
  }

  /**
   * Адрес поколения меняет также базу относительных import внутри оконного модуля.
   * Старый браузерный ESM и его ошибки не переиспользуются после обновления или on/off.
   */
  manifest(manifest: PluginManifest): PluginManifest {
    const entry = this.entries.get(manifest.id);

    if (!entry) {
      return manifest;
    }

    const prefix = `/api/ext/${manifest.id}/module/`;
    const web = manifest.entrypoints?.web;
    const url = (value: string) => `${prefix}${entry.generation}/` + value.slice(prefix.length);

    return {
      ...manifest,
      entrypoints: { web: web ? {
        ...web,
        entry: url(web.entry),
        css: web.css.map(url),
        locales: Object.fromEntries(Object.entries(web.locales)
          .map(([language, value]) => [language, url(value)])),
      } : null },
    };
  }

  /**
   * Первое включение разделяет одну подготовку между конкурентными запросами.
   * Публикация каталога отдельно снимает запрет после завершённой замены файлов.
   */
  async load(manifest: PluginManifest): Promise<void> {
    if (this.closing) {
      throw changeError('plugin_runtime_closed', 'Загрузчик плагинов закрывается.');
    }

    if (this.retired.has(manifest.id)) {
      return;
    }

    const pending = this.loading.get(manifest.id);

    if (pending) {
      return pending;
    }

    const existing = this.entries.get(manifest.id);

    if (existing?.gate.options.stopRequired) {
      throw changeError('plugin_load_failed', 'Не удалось загрузить сервер плагина. Проверьте его файлы.');
    }

    if (existing) {
      return;
    }

    const task = this.start(manifest);

    this.loading.set(manifest.id, task);

    try {
      await task;
    } finally {
      this.loading.delete(manifest.id);
    }
  }

  /**
   * Новый router готовится до публикации и не меняет таблицу маршрутов ядра.
   * Копия дерева даёт новый ESM graph, включая относительные зависимости server.js.
   */
  private async start(manifest: PluginManifest): Promise<void> {
    if (manifest.compatibility?.status === 'incompatible' || manifest.serverError
      || !PLUGIN_APIS.includes(manifest.api || 1)) {
      return;
    }

    const { parent } = this.options;
    const app = Fastify({
      loggerInstance: parent.log,
      bodyLimit: parent.initialConfig.bodyLimit,
      pluginTimeout: parent.initialConfig.pluginTimeout,
      onProtoPoisoning: parent.initialConfig.onProtoPoisoning,
      onConstructorPoisoning: parent.initialConfig.onConstructorPoisoning,
      routerOptions: parent.initialConfig.routerOptions,
    });
    const lifecycle = createPluginLifecycle();
    const gate = new PluginAdmission({
      lifecycle,
      hasServer: !!manifest.hasServer,
      prepareReplace: (signal) => this.closeForReplacement(manifest.id, signal),
    });
    const entry: RuntimeEntry = {
      app,
      gate,
      manifest,
      directory: null,
      generation: randomUUID(),
      closed: false,
      ready: false,
    };

    gate.setEnabled(false);

    app.decorateRequest('authKind', null);
    app.decorateRequest('authPrincipal', null);
    app.addHook('onRequest', async (request) => {
      const source = this.requests.get(request.raw);

      request.authKind = source?.authKind ?? null;
      request.authPrincipal = source?.authPrincipal ?? null;
    });
    await app.register(websocket, { options: { maxPayload: 1 * 1024 ** 2 } });
    await app.register(multipart, { limits: { fileSize: 3 * 1024 ** 3 } });

    // Декораторы остаются живыми ссылками владельца, а router и hooks принадлежат плагину.
    // Встроенные поля Fastify сохраняются у нового приложения без копирования internals.
    for (const key of Object.keys(parent)) {
      if (!(key in app)) {
        Object.defineProperty(app, key, {
          configurable: true,
          enumerable: true,
          get: () => (parent as unknown as Record<string, unknown>)[key],
        });
      }
    }

    this.entries.set(manifest.id, entry);
    this.gates.set(manifest.id, gate);

    try {
      const web = manifest.entrypoints?.web;

      if (web) {
        await app.register(fastifyStatic, pluginModuleStaticOptions(web, manifest.id));
      }

      if (manifest.hasServer) {
        const options = { ...await this.options.options(manifest), lifecycle };

        entry.directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-runtime-'));
        await cp(String(manifest.dir), entry.directory, {
          recursive: true,
          filter: (file) => path.basename(file) !== '.git',
        });

        const mod = await importRuntimeModule<PluginServerModule>(
          path.join(entry.directory, String(manifest.serverEntry)));

        await app.register(async (scope) => {
          if (mod.default.length >= 3) {
            await new Promise<void>((resolve, reject) => {
              (mod.default as PluginServerCallback)(scope, options,
                (error?: Error) => error ? reject(error) : resolve());
            });
          } else {
            await (mod.default as PluginServerAsync)(scope, options);
          }
        }, { prefix: `/api/ext/${manifest.id}` });
      }

      await app.ready();
      entry.ready = true;
    } catch {
      gate.options.stopRequired = true;
      parent.log.warn({ plugin: manifest.id }, 'Пользовательский сервер не загружен; нужен рестарт.');

      throw changeError('plugin_load_failed', 'Не удалось загрузить сервер плагина. Проверьте его файлы.');
    }
  }

  /**
   * Тело ещё не прочитано оболочкой, поэтому сохраняются streaming, multipart и WS.
   * AuthKind передаётся из доверенного request, без служебного заголовка от клиента.
   */
  dispatch(id: string, request: FastifyRequest, reply: FastifyReply): void {
    const entry = this.entries.get(id);

    if (!entry) {
      this.gates.get(id)?.admit(request, reply);

      if (reply.sent) {
        return;
      }

      reply.code(404).send({ error: 'not_found' });

      return;
    }

    entry.gate.admit(request, reply);

    if (reply.sent) {
      return;
    }

    if (!entry.ready) {
      reply.code(503).send({
        error: entry.gate.options.stopRequired ? 'plugin_load_failed' : 'plugin_loading',
      });

      return;
    }

    this.requests.set(request.raw, request);

    const url = request.raw.url ?? '/';
    const canonical = url.replace(/^\/[^/]+\/[^/]+\/[^/?]+/u, `/api/ext/${id}`);

    request.raw.url = canonical;

    for (const resource of ['module']) {
      const prefix = `/api/ext/${id}/${resource}/`;
      const versioned = `${prefix}${entry.generation}/`;

      if (canonical.startsWith(versioned)) {
        request.raw.url = prefix + canonical.slice(versioned.length);

        break;
      }
    }

    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) {
        reply.raw.setHeader(name, value);
      }
    }

    reply.hijack();
    entry.app.routing(request.raw, reply.raw);
  }

  /**
   * Lease закрывает только собственный сервер после drain и проверки занятости.
   * При отказе до перестановки новый router восстанавливает прежнюю версию с диска.
   */
  private async closeForReplacement(id: string, signal: AbortSignal): Promise<ReplacementLease> {
    signal.throwIfAborted();

    const entry = this.entries.get(id)!;

    await this.closeEntry(entry);

    return {
      finish: async (outcome) => {
        if (outcome === 'reverted') {
          this.entries.delete(id);
          this.gates.delete(id);
          await this.load(entry.manifest);
          this.gates.get(id)?.setEnabled(entry.gate.isEnabled);
          this.options.parent.sse?.broadcast?.('state-change', { plugins: true });
        }
      },
    };
  }

  /**
   * Даже новый id резервируется до filesystem эффекта, исключая параллельное включение.
   * Installed освобождает router, а следующий refresh подключает уже новый manifest.
   */
  async prepareReplace(id: string, signal: AbortSignal): Promise<ReplacementLease> {
    if (this.loading.has(id) || this.retired.has(id)) {
      throw changeError('plugin_busy', 'Плагин ещё загружается или обновляется.');
    }

    this.retired.add(id);

    const entry = this.entries.get(id);
    let lease: ReplacementLease | undefined;

    try {
      lease = await entry?.gate.prepare(signal);
    } catch (error) {
      this.retired.delete(id);

      throw error;
    }

    let finishing: Promise<void> | undefined;

    return {
      finish: (outcome) => {
        finishing ??= (async () => {
          if (outcome === 'reverted') {
            this.retired.delete(id);
          }

          await lease?.finish(outcome);

          if (outcome === 'installed') {
            if (entry) {
              await this.closeEntry(entry);
            }

            this.entries.delete(id);
          }
        })();

        return finishing;
      },
    };
  }

  /**
   * onClose плагина завершается раньше удаления его ESM-копии.
   * Ошибка cleanup сохраняет закрытый gate и не выдаёт разрешение на замену файлов.
   */
  private async closeEntry(entry: RuntimeEntry): Promise<void> {
    if (!entry.closed) {
      entry.ready = false;

      try {
        await entry.app.close();
        entry.closed = true;
      } catch (error) {
        entry.gate.options.stopRequired = true;

        throw error;
      }
    }

    if (entry.directory) {
      await rm(entry.directory, { recursive: true, force: true });
      entry.directory = null;
    }
  }

  /**
   * Закрытие ядра ждёт собственные подготовки и все пользовательские onClose.
   * Ни один runtime не получает отдельного слушающего порта или фонового владельца.
   */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.loading.values());
    await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
  }
}
