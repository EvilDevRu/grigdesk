// Модуль providers — реестр LLM-исполнителей кокпита.
// Единая точка правды о том, какие исполнители есть, доступны ли и какие у них модели:
// топбар рисует иконки, чат строит выбор модели/эффорта, схемы выбирают исполнителя по id.
// ПОДКЛЮЧЕНИЕ НОВОГО ИИ — МОДУЛЬНОЕ: один файл в server/src/lib/executors/ (контракт там),
// этот модуль ничего не знает про конкретных вендоров.
// Не путать с /api/agents — там база агентов-стадий конвейера (промпты).
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';
import { getExecutors } from '../../lib/executors/index.js';
import { getModelsRegistry } from '../../lib/models-registry.js';
import { isOutdated } from '../../lib/executors/_npm-latest.js';

// Список меняется редко — кэшируем, чтобы не гонять probe-подпроцессы на каждый запрос.
const CACHE_MS = 60_000;

async function providersModule(fastify, opts) {
  const { config, claudeAuth, prefs } = opts;
  const deps = { claudeAuth };

  /**
   * Реестр: для каждого исполнителя — probe бинаря, авторизация, модели
   * (из models-registry: редактируемый файл + динамическое обнаружение эффортов).
   */
  async function buildRegistry() {
    const executors = await getExecutors();
    const models = await getModelsRegistry(config);
    const providers = [];
    for (const ex of executors.values()) {
      const [{ ok, version }, auth] = await Promise.all([ex.probe(config), ex.auth(config, deps)]);
      // Режимы прав спрашиваем у самого CLI (как и эффорты) — список не хардкодим.
      let modes = null;
      if (ok && typeof ex.modes === 'function') {
        try { modes = await ex.modes(config); } catch { modes = null; }
      }
      providers.push({
        id: ex.id,
        name: ex.name,
        vendor: ex.vendor,
        kind: 'cli',
        bin: ex.bin(config),
        color: ex.color,
        version,
        auth: auth.mode,
        authLabel: auth.label,
        available: ok && auth.available,
        installed: ok,
        install: ex.install || null,
        canUpdate: !!ex.updateCmd,
        // Индикатор «вышла новая версия» — из фоновой проверки (updates), не из этого запроса:
        // ходить в сеть на каждый рендер топбара незачем.
        latest: updates.get(ex.id)?.latest || null,
        updateAvailable: !!updates.get(ex.id)?.outdated,
        checkedAt: updates.get(ex.id)?.at || null,
        models: models[ex.id] || [],
        modes: modes || [],
      });
    }
    return providers;
  }

  let cache = null; // { at, providers }
  let usageCache = null; // { at, usage }

  // ── Проверка новых версий CLI: периодически и по кнопке, НИКОГДА не обновляет сама ──
  const updates = new Map(); // providerId → { latest, outdated, at }
  const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // раз в 6 часов: релизы выходят не чаще
  const FIRST_CHECK_MS = 30_000;             // после старта — не мешая подъёму сервера

  async function checkUpdates() {
    const executors = await getExecutors();
    let changed = false;
    for (const ex of executors.values()) {
      if (typeof ex.latestVersion !== 'function') continue;
      let latest = null;
      try { latest = await ex.latestVersion(config); } catch { latest = null; }
      if (!latest) continue; // сеть молчит — оставляем прошлый результат
      const current = (await ex.probe(config))?.version || '';
      const outdated = isOutdated(current, latest);
      const prev = updates.get(ex.id);
      if (prev?.latest !== latest || prev?.outdated !== outdated) changed = true;
      updates.set(ex.id, { latest, outdated, current, at: Date.now() });
      if (outdated) fastify.log.info({ provider: ex.id, current, latest }, 'доступно обновление CLI (обновление — вручную из настроек)');
    }
    if (changed) {
      cache = null; // в следующем ответе /api/providers поедут новые поля
      fastify.sse.broadcast('providers-update', {
        updates: [...updates.entries()].map(([id, u]) => ({ id, latest: u.latest, updateAvailable: u.outdated })),
      });
    }
    return [...updates.entries()].map(([id, u]) => ({ id, ...u }));
  }

  const firstTimer = setTimeout(() => { checkUpdates().catch(() => {}); }, FIRST_CHECK_MS);
  const everyTimer = setInterval(() => { checkUpdates().catch(() => {}); }, CHECK_EVERY_MS);
  // unref: таймеры проверки не должны держать процесс живым при остановке.
  firstTimer.unref?.();
  everyTimer.unref?.();
  fastify.addHook('onClose', async () => { clearTimeout(firstTimer); clearInterval(everyTimer); });

  // Ручная проверка «прямо сейчас» (кнопка в настройках).
  fastify.post('/api/providers/check-updates', async () => ({ updates: await checkUpdates() }));

  // Потребление лимитов исполнителей (прогрессбары в тултипе топбара).
  fastify.get('/api/providers/usage', async () => {
    if (usageCache && Date.now() - usageCache.at < CACHE_MS) return { usage: usageCache.usage };
    const executors = await getExecutors();
    const usage = {};
    for (const ex of executors.values()) {
      if (typeof ex.usage !== 'function') continue;
      try {
        const u = await ex.usage(config, deps);
        if (u) usage[ex.id] = u;
      } catch (e) {
        fastify.log.warn({ provider: ex.id, err: e.message }, 'usage исполнителя не получен');
      }
    }
    // Сетевой сбой не затирает прошлые данные: лучше слегка устаревшие бары, чем пустые.
    usageCache = { at: Date.now(), usage: Object.keys(usage).length ? usage : (usageCache?.usage || {}) };
    return { usage: usageCache.usage };
  });

  fastify.get('/api/providers', async (request) => {
    const force = request.query?.refresh === '1';
    // Старые версии моделей приходят всегда (с `legacy: true`), а показывать ли их —
    // решает настройка: тумблер в UI не должен ходить за новым списком на сервер.
    const showAllModels = !!prefs?.read().showAllModels;
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return { providers: cache.providers, showAllModels };
    if (force) await getModelsRegistry(config, { refresh: true }); // пересобрать каталог моделей
    const providers = await buildRegistry();
    cache = { at: Date.now(), providers };
    return { providers, showAllModels };
  });

  /**
   * Обновление CLI исполнителя (кнопка в настройках). Команда — свойство исполнителя
   * (`updateCmd`), ядро про вендоров не знает. После обновления сбрасываем кэши:
   * список моделей пересобирается из НОВОГО бинаря — так «вышел Opus 5» доезжает
   * до кокпита без правок кода.
   */
  fastify.post('/api/providers/:id/update', async (request, reply) => {
    const ex = (await getExecutors()).get(String(request.params.id));
    if (!ex) return reply.code(404).send({ error: 'unknown_provider' });
    if (!ex.updateCmd) return reply.code(400).send({ error: 'no_update', message: `у исполнителя ${ex.name} нет команды обновления` });
    const before = (await ex.probe(config))?.version || '';
    const out = await new Promise((resolve) => {
      execFile(ex.bin(config), ex.updateCmd, { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, text: ((stdout || '') + (stderr || '')).trim().slice(-2000), code: err?.code ?? 0 });
      });
    });
    cache = null;
    const after = (await ex.probe(config))?.version || '';
    // Версия сменилась → каталог моделей нового CLI (скан бинаря) подхватится сразу.
    await getModelsRegistry(config, { refresh: true }).catch(() => null);
    // И индикатор «доступно обновление» должен погаснуть сразу, а не через 6 часов.
    await checkUpdates().catch(() => null);
    return { ok: out.ok, before, after, changed: before !== after, output: out.text };
  });
}

export default fp(providersModule, { name: 'module-providers' });
