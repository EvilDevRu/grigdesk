// Модуль plugins — реестр плагинов кокпита: список, вкл/выкл, настройки.
// Регистрируется РАНЬШЕ модулей-плагинов: декорирует fastify.pluginEnabled(id),
// которым системные модули (media/code) гейтят свои роуты на лету — тумблер
// действует без рестарта. Пользовательские server.js подключаются здесь же
// (только включённые; их вкл/выкл требует рестарта — честно отражено в API).
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SYSTEM,
  scanUserPlugins,
  isEnabled,
  placementsState,
  settingsValues,
} from '../../lib/pluginsRegistry.ts';
import type { PluginManifest, PluginSetting } from '../../lib/pluginsRegistry.ts';
import { normalizePluginCategory } from '../../../../shared/pluginsContracts.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';
import type { CockpitConfig } from '../../config.ts';

export interface PluginsModuleOptions {
  config: Pick<CockpitConfig, 'userPluginsDir'>;
  prefs: PrefsStore;
  onToggle?: (id: string, enabled: boolean) => unknown;
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

async function pluginsModule(fastify: FastifyInstance, opts: PluginsModuleOptions): Promise<void> {
  const { config, prefs, onToggle } = opts;

  const userPlugins = await scanUserPlugins(config.userPluginsDir, fastify.log);
  // Признак `system` объявляет сам манифест (в SYSTEM и в скане) — здесь его не
  // дописываем: умолчание вкл/выкл считается по манифесту целиком, и вторая
  // копия правды разошлась бы с первой.
  const all: PluginManifest[] = [...SYSTEM, ...userPlugins];
  const byId = new Map(all.map((m) => [m.id, m]));

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
  const PLUGIN_API = 1;
  for (const m of userPlugins) {
    if (!isEnabled(prefs.read(), m)) continue;
    if ((m.api || 1) !== PLUGIN_API) {
      fastify.log.warn({ plugin: m.id, api: m.api }, `плагин рассчитан на api=${m.api}, кокпит даёт api=${PLUGIN_API} — пропущен`);
      continue;
    }
    // Своя страница плагина раздаётся под тем же префиксом /api/ext/<id>/, что и его
    // роуты: общий auth guard закрывает её вместе со всем /api, а ядро не исполняет
    // ни строчки её кода — только отдаёт файлы папки. Кеша нет: правку страницы
    // человек видит по обновлению вкладки, без рестарта.
    if (m.web) {
      await fastify.register(fastifyStatic, {
        root: m.web.dir,
        prefix: m.web.url,
        decorateReply: false,
        index: ['index.html'],
        cacheControl: true,
        maxAge: 0,
      });
      fastify.log.info({ plugin: m.id }, `страница плагина раздаётся (${m.web.url})`);
    }
    if (!m.hasServer) continue;
    try {
      const mod = await import(pathToFileURL(path.join(String(m.dir), 'server.js')).href);
      await fastify.register(mod.default, { config, prefs, plugin: m, prefix: `/api/ext/${m.id}` });
      fastify.log.info({ plugin: m.id }, `пользовательский плагин зарегистрирован (/api/ext/${m.id})`);
    } catch (err) {
      fastify.log.warn(
        { plugin: m.id, err: (err as Error).message },
        'пользовательский плагин не поднялся — пропущен',
      );
    }
  }

  fastify.get('/api/plugins', async () => {
    const p = prefs.read();
    return {
      plugins: all.map((m) => ({
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
        // Пользовательский серверный код и страница подключаются на старте — тумблер
        // подействует после рестарта.
        needsRestart: !m.system && (m.hasServer || !!m.web),
      })),
    };
  });

  fastify.post('/api/plugins/:id/toggle', async (request: PluginRequest, reply) => {
    const m = byId.get(String(request.params.id));
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const p = prefs.read();
    const enabled = !!(request.body || {}).enabled;
    const next = { ...(p.plugins as Record<string, unknown> || {}), [m.id]: enabled };
    prefs.write({ plugins: next });
    try {
      await onToggle?.(m.id, enabled);
    } catch (error) {
      prefs.write({ plugins: (p.plugins as Record<string, unknown>) || {} });
      throw error;
    }
    return { ok: true, enabled: next[m.id] };
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
    const p = prefs.read();
    // Тумблеры размещений — только по слотам из манифеста: чужой слот не пишется.
    const declared = new Set((m.placements || []).map((decl) => decl.slot));
    const placements: Record<string, boolean> = {};
    for (const [slot, on] of Object.entries((request.body || {}).placements || {})) {
      if (declared.has(slot)) placements[slot] = !!on;
    }
    const storedPlacements = (p.pluginPlacements as Record<string, unknown> || {});
    const ownPlacements = (storedPlacements[m.id] as Record<string, unknown> || {});
    prefs.write({
      // Отсутствие values сохраняет параметры; явный values: {} возвращает их умолчания.
      ...(hasValues && {
        pluginSettings: { ...(p.pluginSettings as Record<string, unknown> || {}), [m.id]: values },
      }),
      ...(Object.keys(placements).length && {
        pluginPlacements: { ...storedPlacements, [m.id]: { ...ownPlacements, ...placements } },
      }),
    });
    // Размещения в ответе — только у плагина, который их объявил: остальным поле ни к чему.
    return {
      ok: true,
      values: hasValues ? values : settingsValues(p, m),
      ...(m.placements?.length && { placements: placementsState(prefs.read(), m) }),
    };
  });
}

export default fp(pluginsModule, { name: 'module-plugins' });
