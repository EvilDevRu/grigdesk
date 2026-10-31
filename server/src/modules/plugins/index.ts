import type {
  PluginServerOptions, PluginServerCallback, PluginServerAsync,
} from '../../../../packages/plugin-types/src/server.ts';
// Модуль plugins — реестр плагинов GrigDesk: список, вкл/выкл, настройки.
// Регистрируется РАНЬШЕ модулей-плагинов: декорирует fastify.pluginEnabled(id),
// которым системные модули (media/code) гейтят свои роуты на лету — тумблер
// действует без рестарта. Пользовательский сервер подключается только при старте;
// загруженный runtime выключается и включается через собственный admission gate.
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import {
  SYSTEM,
  scanUserPlugins,
  isEnabled,
  placementsState,
  settingsValues,
} from '../../lib/pluginsRegistry.ts';
import type { PluginManifest, PluginSetting } from '../../lib/pluginsRegistry.ts';
import { resolvePluginDocs } from '../../lib/pluginDocs.ts';
import type { PluginDocsEntry } from '../../lib/pluginDocs.ts';
import { normalizePluginCategory } from '../../../../shared/plugins/pluginsContracts.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';
import type { GrigDeskConfig } from '../../config.ts';
import type { PluginInstallPort } from '../../lib/packageInstall/service.ts';
import { createPluginLifecycle, PluginAdmission } from './lifecycle.ts';
import installRoutes from './installRoutes.ts';
import { preparePluginDataDir, preparePluginDataRoot } from './pluginData.ts';
import { importRuntimeModule } from '../../lib/runtimeImport.ts';
import type { PluginServerModule } from '../../lib/runtimeImport.ts';
import { assertRealPackageRoot } from '../../lib/packageInstall/packageTree.ts';
import type { PluginInstallInfo } from '../../../../shared/plugins/pluginInstallContracts.ts';
import { pluginModuleStaticOptions } from '../../lib/pluginWebModule.ts';
import type { DocumentReader } from '../../lib/documents/reader.ts';
import { createPluginCore } from './core.ts';
import { changeError, writeUserPluginChange } from './changes.ts';
import type { PluginTransition } from './changes.ts';

export type { PluginTransition } from './changes.ts';

export interface PluginsModuleOptions {
  config: Pick<GrigDeskConfig, 'userPluginsDir'> & { userPluginsDataDir?: string };
  prefs: PrefsStore;
  installs?: PluginInstallPort;
  documentReader?: DocumentReader;
  onToggle?: (id: string, enabled: boolean) => unknown;
  prepareChange?: (id: string, change: { enabled?: boolean; values?: unknown }) =>
    Promise<PluginTransition | undefined> | PluginTransition | undefined;
}

/**
 * Подготовка плагина завершена до prefs.write; commit не уступает управление.
 * Отказ записи откатывает только новые ресурсы, оставляя прежний runtime действующим.
 */
async function writePluginChange(prefs: PrefsStore, patch: Record<string, unknown>,
  transition: PluginTransition | undefined): Promise<void> {
  try {
    prefs.write(patch);
  } catch (error) {
    await transition?.rollback();

    throw error;
  }

  transition?.commit();
  await transition?.afterCommit();
}

/**
 * Hook выдаёт только собственные безопасные ошибки с явным HTTP кодом.
 * Остальные отказы сохраняют прежнюю обработку Fastify и не маскируются успехом.
 */
function pluginChangeError(error: unknown, reply: FastifyReply): unknown {
  const source = error as { statusCode?: number; code?: string; message?: string };

  if (source.statusCode && source.statusCode >= 400 && source.statusCode < 500
    && source.code && /^[a-z_]+$/.test(source.code)) {
    return reply.code(source.statusCode).send({ error: source.code, message: source.message });
  }

  throw error;
}

// Запрос с id плагина в адресе и телом настройки.
type PluginRequest = FastifyRequest<{
  Params: { id: string };
  Body: {
    enabled?: unknown;
    values?: Record<string, unknown>;
    placements?: Record<string, unknown>;
  } | null;
}>;

/**
 * Recovery предшествует scan и import, а зарегистрированные runtime держат свои gates.
 * Installer обновляет каталог без загрузки новой версии кода в текущий процесс.
 */
async function pluginsModule(fastify: FastifyInstance, opts: PluginsModuleOptions): Promise<void> {
  const { config, prefs, onToggle, prepareChange } = opts;

  const recovery = await opts.installs?.recover();
  const dataRoot = config.userPluginsDataDir
    ? await preparePluginDataRoot(config.userPluginsDir, config.userPluginsDataDir) : null;

  if (opts.installs && !dataRoot) {
    throw new TypeError('Для installer нужен отдельный userPluginsDataDir.');
  }

  const scanned = await scanUserPlugins(config.userPluginsDir, fastify.log);
  const userPlugins = scanned.filter((manifest) => recovery?.blockedIds !== '*'
    && !recovery?.blockedIds.includes(manifest.id));
  const loaded = new Set<string>();
  const gates = new Map<string, PluginAdmission>();
  // Признак `system` объявляет сам манифест (в SYSTEM и в скане) — здесь его не
  // дописываем: умолчание вкл/выкл считается по манифесту целиком, и вторая
  // копия правды разошлась бы с первой.
  let all: PluginManifest[] = [...SYSTEM, ...userPlugins];
  let byId = new Map(all.map((m) => [m.id, m]));

  /**
   * Новый scan публикуется целиком без import и регистрации runtime routes.
   * Существующий каталог и byId сохраняются при отказе любого подготовительного шага.
   */
  async function refreshUserPlugins(): Promise<void> {
    await assertRealPackageRoot(config.userPluginsDir);

    const nextUser = await scanUserPlugins(config.userPluginsDir, fastify.log);
    const next = [...SYSTEM, ...nextUser.filter((manifest) => recovery?.blockedIds !== '*'
      && !recovery?.blockedIds.includes(manifest.id))];
    const nextById = new Map(next.map((manifest) => [manifest.id, manifest]));

    all = next;
    byId = nextById;
  }

  /**
   * Installer health не превращает ошибку одного дерева в отказ каталога ядра.
   * Безопасная общая причина остаётся доступной в API исходов установки.
   */
  async function describeInstall(id: string): Promise<PluginInstallInfo | null> {
    try {
      return await opts.installs?.describe(id) ?? null;
    } catch {
      return null;
    }
  }

  opts.installs?.bindRuntime({
    isLoaded: (id) => loaded.has(id),
    prepareReplace: async (id, signal) => {
      const gate = gates.get(id);

      return gate ? gate.prepare(signal) : { async finish() {} };
    },
    refresh: refreshUserPlugins,
  });

  // Живой гейт для системных модулей: читает prefs при каждом вызове.
  fastify.decorate('pluginEnabled', (id: string) => {
    const m = byId.get(id);
    if (!m) return false;
    return isEnabled(prefs.read(), m);
  });

  // Значения настроек плагина для серверного кода (например, общая модель Inbox).
  fastify.decorate('pluginSettings', (id: string) => {
    const m = byId.get(id);
    return m ? settingsValues(prefs.read(), m) : {};
  });

  // Пользовательские server.js: только включённые. Ошибка одного плагина не валит сервер.
  // ВАЖНО: регистрация с prefix — роуты плагина ЖЁСТКО заперты в /api/ext/<id>/ (это не
  // конвенция, а механика Fastify: перекрыть системный путь плагин не может). Контракт
  // манифеста версионирован полем api — несовместимый плагин не поднимаем, а честно жалуемся.
  const PLUGIN_APIS = [1, 2];

  for (const m of userPlugins) {
    if (!isEnabled(prefs.read(), m) || m.serverError) {
      continue;
    }

    if (!PLUGIN_APIS.includes(m.api || 1)) {
      fastify.log.warn({ plugin: m.id, api: m.api }, `плагин рассчитан на api=${m.api}, GrigDesk даёт api=${PLUGIN_APIS.join(', ')} — пропущен`);
      continue;
    }

    const dataDir = m.hasServer && dataRoot ? await preparePluginDataDir(dataRoot, m.id) : undefined;
    const lifecycle = createPluginLifecycle();
    const gate = new PluginAdmission({ lifecycle, hasServer: !!m.hasServer });

    gates.set(m.id, gate);
    await fastify.register(async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        gate.admit(request, reply);
      });

      if (m.web) {
        await scope.register(fastifyStatic, {
          root: m.web.dir,
          prefix: m.web.url,
          decorateReply: false,
          index: ['index.html'],
          cacheControl: true,
          maxAge: 0,
        });
        loaded.add(m.id);
      }

      if (m.webModule) {
        await scope.register(fastifyStatic, pluginModuleStaticOptions(m.webModule, m.id));
        loaded.add(m.id);
      }

      if (!m.hasServer) {
        return;
      }

      // Import может успеть создать timer или child даже перед исключением.
      // Такой runtime остаётся загруженным и требует остановки после неудачи.
      loaded.add(m.id);

      try {
        const mod = await importRuntimeModule<PluginServerModule>(
          path.join(String(m.dir), m.serverEntry ?? 'server.js'));

        await scope.register(async (serverScope) => {
          try {
            const options: PluginServerOptions = {
              config,
              prefs,
              plugin: m,
              prefix: `/api/ext/${m.id}`,
              dataDir,
              lifecycle,
              core: createPluginCore(fastify, m.id, opts.documentReader),
            };

            if (mod.default.length >= 3) {
              await new Promise<void>((resolve, reject) => {
                (mod.default as PluginServerCallback)(serverScope, options,
                  (error?: Error) => error ? reject(error) : resolve());
              });
            } else {
              await (mod.default as PluginServerAsync)(serverScope, options);
            }
          } catch (error) {
            gate.options.stopRequired = true;
            fastify.log.warn({ plugin: m.id }, 'пользовательский сервер не зарегистрирован; нужен рестарт');
          }
        }, { prefix: `/api/ext/${m.id}` });
      } catch (error) {
        gate.options.stopRequired = true;
        fastify.log.warn({ plugin: m.id }, 'пользовательский сервер не импортирован; нужен рестарт');
      }
    });
  }

  /**
   * Документация доступных плагинов для хода агента: включённых пользовательских, чей
   * контракт GrigDesk поднимает. Оглавление ищется в постоянном месте при каждом вызове —
   * установка, удаление и правка папки видны следующему ходу без рестарта.
   */
  fastify.decorate('pluginDocs', async () => {
    const p = prefs.read();
    const available = all.filter((m) => !m.system && m.dir && isEnabled(p, m)
      && PLUGIN_APIS.includes(m.api || 1));
    const found = await Promise.all(available.map(async (m): Promise<PluginDocsEntry | null> => {
      const docs = await resolvePluginDocs(String(m.dir));

      if (!docs) {
        return null;
      }

      return {
        id: m.id,
        name: m.name,
        description: m.description,
        ...docs,
      };
    }));

    return found
      .filter((entry): entry is PluginDocsEntry => entry !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  });

  /**
   * Перезапуск нужен только для кода, который этот процесс ещё не подключил или заменил.
   * Ошибка пакета и несовместимый API требуют исправления причины, а не рестарта.
   */
  function needsRestart(manifest: PluginManifest): boolean {
    if (manifest.system || manifest.serverError || !PLUGIN_APIS.includes(manifest.api || 1)) {
      return false;
    }

    const gate = gates.get(manifest.id);

    return !!gate?.needsRestart || (!loaded.has(manifest.id) && isEnabled(prefs.read(), manifest)
      && (!!manifest.hasServer || !!manifest.web || !!manifest.webModule));
  }

  /**
   * Уведомления следуют за принятой сменой допуска и не задерживают HTTP.
   * Ошибку автора журналируем без его произвольного текста и внутренних данных.
   */
  function notifyEnabled(id: string, enabled: boolean): void {
    const lifecycle = gates.get(id)?.options.lifecycle;
    const hook = enabled ? lifecycle?.onEnable : lifecycle?.onDisable;

    if (hook) {
      void Promise.resolve().then(() => hook.call(lifecycle)).catch(() => {
        fastify.log.warn({ plugin: id, phase: enabled ? 'enable' : 'disable' },
          'Уведомление плагина не завершено.');
      });
    }
  }

  fastify.get('/api/plugins', async () => {
    if (opts.installs?.health()) {
      // Commit остаётся достоверным при отказе scanner: следующее чтение повторяет refresh.
      // Ошибка recovery сохраняет прежний каталог и не лишает ядро его системных API.
      await opts.installs.refreshCatalog().catch(() => {});
    }

    const p = prefs.read();

    return {
      plugins: await Promise.all(all.map(async (m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        system: m.system,
        // Категория режет экран настроек по роду работы; SYSTEM объявляет её сам,
        // у чужого манифеста значение уже нормализовано сканом.
        category: normalizePluginCategory(m.category),
        nav: m.nav || null,
        enabled: isEnabled(p, m),
        settings: m.settings || [],
        values: settingsValues(p, m),
        placements: placementsState(p, m),
        setup: m.setup || null,
        web: m.web?.url ?? null,
        webModule: m.webModule ? {
          entry: m.webModule.entry,
          css: m.webModule.css,
          locales: m.webModule.locales,
          ...(m.webModule.startOnLogin === undefined ? {} : { startOnLogin: m.webModule.startOnLogin }),
        } : null,
        serverError: m.serverError ?? null,
        needsRestart: needsRestart(m),
        install: m.system ? null : await describeInstall(m.id),
      }))),
    };
  });

  fastify.post('/api/plugins/:id/toggle', async (request: PluginRequest, reply) => {
    const m = byId.get(String(request.params.id));
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const enabled = !!(request.body || {}).enabled;

    if (!m.system) {
      const gate = gates.get(m.id);
      let changed = false;

      try {
        if (enabled && m.serverError) {
          throw changeError('plugin_server_conflict', m.serverError);
        }

        await writeUserPluginChange(gate, { enabled }, () => {
          const current = prefs.read();

          changed = isEnabled(current, m) !== enabled;
          prefs.write({
            plugins: { ...(current.plugins as Record<string, unknown> || {}), [m.id]: enabled },
          });
        }, () => {
          gate?.setEnabled(enabled);

          if (changed) {
            notifyEnabled(m.id, enabled);
          }
        }, () => fastify.log.warn({ plugin: m.id }, 'Очистка изменения плагина не завершена.'));
      } catch (error) {
        return pluginChangeError(error, reply);
      }

      if (changed) {
        fastify.sse?.broadcast?.('state-change', { plugins: true });
      }

      return {
        ok: true,
        enabled,
        needsRestart: needsRestart(m),
      };
    }

    let transition: PluginTransition | undefined;

    try {
      transition = await prepareChange?.(m.id, { enabled });
    } catch (error) {
      return pluginChangeError(error, reply);
    }

    const p = prefs.read();
    const next = { ...(p.plugins as Record<string, unknown> || {}), [m.id]: enabled };

    await writePluginChange(prefs, { plugins: next }, transition);
    try {
      await onToggle?.(m.id, enabled);
    } catch (error) {
      if (!transition) {
        prefs.write({ plugins: (p.plugins as Record<string, unknown>) || {} });
      }
      throw error;
    }

    if (isEnabled(p, m) !== enabled) {
      fastify.sse?.broadcast?.('state-change', { plugins: true });
    }

    return {
      ok: true,
      enabled: next[m.id],
      needsRestart: needsRestart(m),
    };
  });

  fastify.put('/api/plugins/:id/settings', async (request: PluginRequest, reply) => {
    const m = byId.get(String(request.params.id));
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const hasValues = Object.hasOwn(request.body || {}, 'values');

    // Принимаем только ключи из схемы — мусор в prefs не попадает.
    const settings = new Map<string, PluginSetting>(
      (m.settings || []).map((setting) => [setting.key, setting]),
    );
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((request.body || {}).values || {})) {
      const setting = settings.get(k);
      if (!setting) continue;
      // Область по исполнителям — только массив строк-идентификаторов без повторов:
      // всё остальное превратилось бы в «все» или в вечный отказ на стороне плагина.
      if (setting.type === 'providers') {
        values[k] = Array.isArray(v)
          ? [...new Set(v.filter((id) => typeof id === 'string' && id).map(String))]
          : [];
        continue;
      }
      if (setting.type !== 'number') {
        values[k] = v;
        continue;
      }
      const numeric = Number(v);
      if (!Number.isFinite(numeric)) continue;
      const minimum = Number.isFinite(setting.min) ? Number(setting.min) : numeric;
      const maximum = Number.isFinite(setting.max) ? Number(setting.max) : numeric;
      const clamped = Math.min(maximum, Math.max(minimum, numeric));
      const step = Number(setting.step) > 0 ? Number(setting.step) : 1;
      values[k] = Math.min(maximum, minimum + Math.round((clamped - minimum) / step) * step);
    }
    let transition: PluginTransition | undefined;

    if (hasValues && m.system) {
      const preparedPrefs = { ...prefs.read(), pluginSettings: { [m.id]: values } };

      try {
        transition = await prepareChange?.(m.id, { values: settingsValues(preparedPrefs, m) });
      } catch (error) {
        return pluginChangeError(error, reply);
      }
    }

    // Тумблеры размещений принимаются только по слотам из манифеста.
    const declared = new Set((m.placements || []).map((decl) => decl.slot));
    const placements: Record<string, boolean> = {};

    for (const [slot, on] of Object.entries((request.body || {}).placements || {})) {
      if (declared.has(slot)) {
        placements[slot] = !!on;
      }
    }

    // После асинхронной подготовки собираем patch из свежих prefs.
    // Другие плагины и placements-only запросы могли записать свои поля во время ожидания.
    const settingsPatch = () => {
      const current = prefs.read();
      const stored = (current.pluginPlacements as Record<string, unknown> || {});
      const own = (stored[m.id] as Record<string, unknown> || {});

      return {
        ...(hasValues && {
          pluginSettings: { ...(current.pluginSettings as Record<string, unknown> || {}), [m.id]: values },
        }),
        ...(Object.keys(placements).length && {
          pluginPlacements: { ...stored, [m.id]: { ...own, ...placements } },
        }),
      };
    };

    if (!m.system && hasValues) {
      const preparedPrefs = { ...prefs.read(), pluginSettings: { [m.id]: values } };

      try {
        await writeUserPluginChange(gates.get(m.id), { values: settingsValues(preparedPrefs, m) },
          () => prefs.write(settingsPatch()), () => {},
          () => fastify.log.warn({ plugin: m.id }, 'Очистка изменения плагина не завершена.'));
      } catch (error) {
        return pluginChangeError(error, reply);
      }
    } else {
      await writePluginChange(prefs, settingsPatch(), transition);
    }

    // Размещения в ответе — только у плагина, который их объявил: остальным поле ни к чему.
    return {
      ok: true,
      values: hasValues ? values : settingsValues(prefs.read(), m),
      ...(m.placements?.length && { placements: placementsState(prefs.read(), m) }),
    };
  });

  if (opts.installs) {
    await fastify.register(installRoutes, { installs: opts.installs });
  }
}

export default fp(pluginsModule, { name: 'module-plugins' });
