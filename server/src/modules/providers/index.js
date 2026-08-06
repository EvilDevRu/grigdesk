// Модуль providers — реестр LLM-исполнителей кокпита.
// Единая точка правды о том, какие исполнители есть, доступны ли и какие у них модели:
// топбар рисует иконки, чат строит выбор модели/эффорта, схемы выбирают исполнителя по id.
// ПОДКЛЮЧЕНИЕ НОВОГО ИИ — МОДУЛЬНОЕ: один файл в server/src/lib/executors/ (контракт там),
// этот модуль ничего не знает про конкретных вендоров.
// Не путать с /api/agents — там база агентов-стадий конвейера (промпты).
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';
import { getProviderAdapters } from '../../lib/executors/index.js';
import { getModelsRegistry } from '../../lib/models-registry.js';
import { isOutdated } from '../../lib/executors/_npm-latest.js';
import { applyProviderSetting, resolveProviderSettings } from '../../lib/provider-settings.js';
import {
  createUsageReadCache,
  executeProviderUsageAction,
  mergeProviderUsage,
  normalizeProviderUsage,
  unsupportedProviderUsage,
} from '../../lib/provider-usage.js';

// Список меняется редко — кэшируем, чтобы не гонять probe-подпроцессы на каждый запрос.
const CACHE_MS = 60_000;

// Меню слэш-команд доверяет только валидным записям контракта (executors/index.js):
// cmd вида '/name', run ∈ prompt|none, desc до 120 символов.
function normalizeCommands(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c
      && typeof c.cmd === 'string' && /^\/\S+$/.test(c.cmd)
      && typeof c.desc === 'string' && c.desc.trim()
      && (c.run === 'prompt' || c.run === 'none'))
    .map((c) => ({
      cmd: c.cmd,
      desc: c.desc.trim().slice(0, 120),
      run: c.run,
      ...(c.hint ? { hint: String(c.hint).slice(0, 120) } : {}),
      ...(c.args ? { args: true } : {}),
    }));
}

async function providersModule(fastify, opts) {
  const { config, claudeAuth, prefs } = opts;
  const deps = { claudeAuth };
  // Точка подмены для офлайн-тестов: реестр не знает про конкретных вендоров.
  const adaptersOf = opts.getProviderAdapters || getProviderAdapters;

  /**
   * Реестр: для каждого исполнителя — probe бинаря, авторизация, модели
   * (из models-registry: редактируемый файл + динамическое обнаружение эффортов).
   */
  /**
   * Схему своих настроек объявляет исполнитель (`executor.settings`), выбор человека
   * лежит в prefs. Собираем их вместе: UI получает готовую декларацию со значением.
   */
  function settingsOf(ex) {
    return resolveProviderSettings(ex, prefs?.read().providerSettings?.[ex.id]);
  }

  async function buildRegistry() {
    const executors = await adaptersOf();
    const models = await getModelsRegistry(config);
    const providers = [];
    for (const ex of executors.values()) {
      const [{ ok, version }, auth] = await Promise.all([ex.probe(config), ex.auth(config, deps)]);
      // Режимы прав спрашиваем у самого CLI (как и эффорты) — список не хардкодим.
      let modes = null;
      if (ok && typeof ex.modes === 'function') {
        try { modes = await ex.modes(config); } catch { modes = null; }
      }
      // Слэш-команды исполнителя для меню чата. Источники cwd-независимы, поэтому
      // легально едут в том же глобальном кэше; падение сканера одного ИИ не валит реестр.
      const commands = typeof ex.commands === 'function'
        ? normalizeCommands(await Promise.resolve(ex.commands(config)).catch(() => []))
        : [];
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
        // Setup-only карточка видна здесь, но отсутствует в runtime-реестре чатов.
        chatEnabled: typeof ex.run === 'function',
        installed: ok,
        install: ex.install || null,
        // Установка и login могут быть разными сценариями. Старые адаптеры пока
        // объявляют одной строкой install, поэтому для них сохраняем прежнее поведение.
        setupCommand: ok ? (ex.login || ex.install || null) : (ex.install || null),
        canUpdate: !!ex.updateCmd,
        // Индикатор «вышла новая версия» — из фоновой проверки (updates), не из этого запроса:
        // ходить в сеть на каждый рендер топбара незачем.
        latest: updates.get(ex.id)?.latest || null,
        updateAvailable: !!updates.get(ex.id)?.outdated,
        checkedAt: updates.get(ex.id)?.at || null,
        models: models[ex.id] || [],
        modes: modes || [],
        commands,
        // Свои ручки исполнителя для его плашки в настройках (см. контракт в executors/index.js).
        settings: settingsOf(ex),
      });
    }
    return providers;
  }

  let cache = null; // { at, providers }
  const usageCache = createUsageReadCache(async (previousUsage) => {
    const executors = await getProviderAdapters();
    const checkedAt = Date.now();
    // Аккаунты независимы: медленная проверка одного исполнителя не должна
    // задерживать запуск остальных. Promise.all сохраняет порядок реестра.
    const entries = await Promise.all([...executors.values()].map(async (ex) => {
      let current;
      if (typeof ex.usage !== 'function') {
        current = unsupportedProviderUsage(ex.name, checkedAt);
      } else {
        try {
          current = normalizeProviderUsage(await ex.usage(config, deps), {
            providerName: ex.name,
            checkedAt,
          });
        } catch (e) {
          fastify.log.warn({ provider: ex.id, err: e.message }, 'usage исполнителя не получен');
          current = normalizeProviderUsage({
            state: 'unavailable',
            message: `Не удалось получить лимиты ${ex.name}. Повторим проверку автоматически.`,
          }, { providerName: ex.name, checkedAt });
        }
      }
      return [ex.id, mergeProviderUsage(previousUsage?.[ex.id], current)];
    }));
    return Object.fromEntries(entries);
  }, { maxAgeMs: CACHE_MS });

  // ── Проверка новых версий CLI: периодически и по кнопке, НИКОГДА не обновляет сама ──
  const updates = new Map(); // providerId → { latest, outdated, at }
  const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // раз в 6 часов: релизы выходят не чаще
  const FIRST_CHECK_MS = 30_000;             // после старта — не мешая подъёму сервера

  async function checkUpdates() {
    const executors = await getProviderAdapters();
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
  fastify.get('/api/providers/usage', async () => ({ usage: await usageCache.read() }));

  /**
   * Generic provider-account action. The route knows neither billing semantics
   * nor vendor APIs: each executor exposes an explicit usageActions allow-list.
   * requestId crosses the boundary for idempotent irreversible actions.
   */
  fastify.post('/api/providers/:id/usage-actions/:actionId', async (request, reply) => {
    const ex = (await getProviderAdapters()).get(String(request.params.id));
    if (!ex) return reply.code(404).send({ error: 'unknown_provider' });
    const body = request.body || {};
    const r = await executeProviderUsageAction(ex, {
      actionId: request.params.actionId,
      payload: body.payload,
      requestId: body.requestId,
      config,
      deps,
    });
    if (r?.error === 'unknown_usage_action') {
      return reply.code(400).send({
        error: r.error,
        message: `исполнитель ${ex.name} не поддерживает это действие`,
      });
    }
    if (r?.ok) usageCache.clear();
    else fastify.log.warn({ provider: ex.id, action: request.params.actionId, err: r?.error }, 'действие usage не выполнено');
    return r;
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
   * Сохранение своей настройки исполнителя (тумблер в его плашке). Ядро не знает, что
   * значит настройка: принимаем только объявленные самим executor-ом id и приводим
   * значение к типу его `kind` — чужой ключ в prefs не попадёт.
   */
  fastify.post('/api/providers/:id/settings', async (request, reply) => {
    const ex = (await getProviderAdapters()).get(String(request.params.id));
    if (!ex) return reply.code(404).send({ error: 'unknown_provider' });
    const applied = applyProviderSetting(ex, prefs.read().providerSettings, request.body || {});
    if (!applied.ok) return reply.code(400).send({ error: applied.error, message: applied.message });
    prefs.write({ providerSettings: applied.providerSettings });
    cache = null; // следующий /api/providers отдаст новое значение
    return { ok: true, settings: applied.settings };
  });

  /**
   * Обновление CLI исполнителя (кнопка в настройках). Команда — свойство исполнителя
   * (`updateCmd`), ядро про вендоров не знает. После обновления сбрасываем кэши:
   * список моделей пересобирается из НОВОГО бинаря — так «вышел Opus 5» доезжает
   * до кокпита без правок кода.
   */
  fastify.post('/api/providers/:id/update', async (request, reply) => {
    const ex = (await getProviderAdapters()).get(String(request.params.id));
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
