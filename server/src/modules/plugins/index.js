// Модуль plugins — реестр плагинов кокпита: список, вкл/выкл, настройки.
// Регистрируется РАНЬШЕ модулей-плагинов: декорирует fastify.pluginEnabled(id),
// которым системные модули (media/code) гейтят свои роуты на лету — тумблер
// действует без рестарта. Пользовательские server.js подключаются здесь же
// (только включённые; их вкл/выкл требует рестарта — честно отражено в API).
import fp from 'fastify-plugin';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SYSTEM, scanUserPlugins, isEnabled, settingsValues } from '../../lib/plugins-registry.js';

async function pluginsModule(fastify, opts) {
  const { config, prefs } = opts;

  const userPlugins = await scanUserPlugins(config.userPluginsDir, fastify.log);
  const all = [...SYSTEM.map((m) => ({ ...m, system: true })), ...userPlugins.map((m) => ({ ...m, system: false }))];
  const byId = new Map(all.map((m) => [m.id, m]));

  // Живой гейт для системных модулей: читает prefs при каждом вызове.
  fastify.decorate('pluginEnabled', (id) => {
    const m = byId.get(id);
    if (!m) return false;
    return isEnabled(prefs.read(), id, m.system);
  });

  // Значения настроек плагина для серверного кода (модуль медиа читает whisperModel).
  fastify.decorate('pluginSettings', (id) => {
    const m = byId.get(id);
    return m ? settingsValues(prefs.read(), m) : {};
  });

  // Пользовательские server.js: только включённые. Ошибка одного плагина не валит сервер.
  // ВАЖНО: регистрация с prefix — роуты плагина ЖЁСТКО заперты в /api/ext/<id>/ (это не
  // конвенция, а механика Fastify: перекрыть системный путь плагин не может). Контракт
  // манифеста версионирован полем api — несовместимый плагин не поднимаем, а честно жалуемся.
  const PLUGIN_API = 1;
  for (const m of userPlugins) {
    if (!m.hasServer || !isEnabled(prefs.read(), m.id, false)) continue;
    if ((m.api || 1) !== PLUGIN_API) {
      fastify.log.warn({ plugin: m.id, api: m.api }, `плагин рассчитан на api=${m.api}, кокпит даёт api=${PLUGIN_API} — пропущен`);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(path.join(m.dir, 'server.js')).href);
      await fastify.register(mod.default, { config, prefs, plugin: m, prefix: `/api/ext/${m.id}` });
      fastify.log.info({ plugin: m.id }, `пользовательский плагин зарегистрирован (/api/ext/${m.id})`);
    } catch (err) {
      fastify.log.warn({ plugin: m.id, err: err.message }, 'пользовательский плагин не поднялся — пропущен');
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
        nav: m.nav || null,
        enabled: isEnabled(p, m.id, m.system),
        settings: m.settings || [],
        values: settingsValues(p, m),
        // Пользовательский серверный код подключается на старте — тумблер подействует после рестарта.
        needsRestart: !m.system && m.hasServer,
      })),
    };
  });

  fastify.post('/api/plugins/:id/toggle', async (request, reply) => {
    const m = byId.get(String(request.params.id));
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const p = prefs.read();
    const next = { ...(p.plugins || {}), [m.id]: !!(request.body || {}).enabled };
    prefs.write({ plugins: next });
    return { ok: true, enabled: next[m.id] };
  });

  fastify.put('/api/plugins/:id/settings', async (request, reply) => {
    const m = byId.get(String(request.params.id));
    if (!m) return reply.code(404).send({ error: 'not_found' });
    // Принимаем только ключи из схемы — мусор в prefs не попадает.
    const allowed = new Set((m.settings || []).map((s) => s.key));
    const values = {};
    for (const [k, v] of Object.entries((request.body || {}).values || {})) {
      if (allowed.has(k)) values[k] = v;
    }
    const p = prefs.read();
    prefs.write({ pluginSettings: { ...(p.pluginSettings || {}), [m.id]: values } });
    return { ok: true, values };
  });
}

export default fp(pluginsModule, { name: 'module-plugins' });
