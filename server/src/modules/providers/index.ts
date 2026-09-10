// Модуль providers — реестр LLM-исполнителей кокпита.
// Единая точка правды о том, какие исполнители есть, доступны ли и какие у них модели:
// топбар рисует иконки, чат строит выбор модели/эффорта, схемы выбирают исполнителя по id.
// ПОДКЛЮЧЕНИЕ НОВОГО ИИ — МОДУЛЬНОЕ: один файл в server/src/lib/executors/ (контракт там),
// этот модуль ничего не знает про конкретных вендоров.
// Не путать с /api/agents — там база агентов-стадий конвейера (промпты).
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import { getProviderAdapters, supportsScopedWorkspace } from '../../lib/executors/index.ts';
import type { ExecutorAdapter } from '../../lib/executors/index.ts';
import { getModelsRegistry } from '../../lib/modelsRegistry.ts';
import { isOutdated } from '../../lib/executors/_npmLatest.ts';
import { applyProviderSetting, resolveProviderSettings } from '../../lib/providerSettings.ts';
import {
  createUsageReadCache,
  executeProviderUsageAction,
  mergeProviderUsage,
  normalizeProviderUsage,
  unsupportedProviderUsage,
} from '../../lib/providerUsage.ts';
import { createProviderStatusProbe, VENDOR_FAULT_USAGE_STATES } from '../../lib/providerStatus.ts';
import { ProviderUsageSeenStore, isFreshGroup } from '../../lib/providerUsageSeen.ts';
import type { ProviderUsage } from '../../lib/providerUsage.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';

// Серверный config в объёме, который читает реестр. Полная его форма объявлена
// в config.ts; адаптеры получают его целиком и разбирают сами.
type ProvidersConfig = {
  modelsPath: string;
  providerUsageSeenPath: string;
};

export interface ProvidersModuleOptions {
  config: ProvidersConfig;
  claudeAuth?: unknown;
  prefs?: PrefsStore;
  // Точка подмены для офлайн-тестов: реестр не знает про конкретных вендоров.
  getProviderAdapters?: () => Promise<Map<string, ExecutorAdapter>>;
}

// Маршруты исполнителя адресуются его id; действие и список добавляют свои части.
interface ProviderRoute {
  Params: { id: string };
  Querystring: { refresh?: string };
}

interface ProviderActionRoute {
  Params: { id: string; actionId: string };
  Body: { payload?: unknown; requestId?: unknown };
}

interface ProviderSettingRoute {
  Params: { id: string };
  Body: { settingId?: unknown; value?: unknown; confirmed?: unknown };
}

interface ProvidersListRoute {
  Querystring: { refresh?: string };
}

// Полоса лимита в ответе адаптера. Ведро называет сам исполнитель, поэтому поле
// остаётся необязательным, а всё прочее содержимое полосы ядру безразлично.
interface UsageBar {
  group?: string;
  [field: string]: unknown;
}

// Список меняется редко — кэшируем, чтобы не гонять probe-подпроцессы на каждый запрос.
const CACHE_MS = 60_000;
const DIRECT_SSH_ENFORCEMENTS = new Set([
  'command-hook',
  'tool-filter',
  'network-sandbox',
  'fail-closed',
  'unsupported',
]);

// Меню слэш-команд доверяет только валидным записям контракта (executors/index.js):
// cmd вида '/name' (CLI-команда) либо '$name' (нативный skill Codex),
// run ∈ prompt|none, desc до 120 символов.
function normalizeCommands(list: unknown) {
  if (!Array.isArray(list)) return [];
  return (list as Array<{
    cmd?: unknown;
    desc?: unknown;
    run?: unknown;
    hint?: unknown;
    args?: unknown;
  }>)
    .filter((c) => c
      && typeof c.cmd === 'string' && /^[/$]\S+$/.test(c.cmd)
      && typeof c.desc === 'string' && c.desc.trim()
      && (c.run === 'prompt' || c.run === 'none'))
    .map((c) => ({
      cmd: c.cmd as string,
      desc: (c.desc as string).trim().slice(0, 120),
      run: c.run,
      ...(c.hint ? { hint: String(c.hint).slice(0, 120) } : {}),
      ...(c.args ? { args: true } : {}),
    }));
}

async function providersModule(
  fastify: FastifyInstance,
  opts: ProvidersModuleOptions,
): Promise<void> {
  const { config, claudeAuth, prefs } = opts;
  const deps = { claudeAuth };
  const adaptersOf = opts.getProviderAdapters || getProviderAdapters;

  /**
   * Реестр: для каждого исполнителя — probe бинаря, авторизация, модели
   * (из models-registry: редактируемый файл + динамическое обнаружение эффортов).
   */
  /**
   * Схему своих настроек объявляет исполнитель (`executor.settings` — массив или
   * async-функция от config), выбор человека лежит в prefs. Собираем их вместе:
   * UI получает готовую декларацию со значением.
   */
  async function settingsOf(ex: ExecutorAdapter) {
    const saved = prefs?.read().providerSettings as Record<string, Record<string, unknown>> | undefined;
    return resolveProviderSettings(ex, saved?.[ex.id], config);
  }

  /**
   * Поддержка доверенных каталогов — свойство адаптера, а не список известных
   * вендоров в реестре/UI. Setup-only карточка физически не может получить ход,
   * поэтому даже ошибочно объявленный ею признак наружу не выпускаем.
   */
  async function trustedDirectoriesOf(ex: ExecutorAdapter) {
    if (typeof ex.run !== 'function') return false;
    try {
      const declared = typeof ex.trustedDirectories === 'function'
        ? await ex.trustedDirectories(config)
        : ex.trustedDirectories;
      return declared === true;
    } catch (err) {
      fastify.log.warn(
        { provider: ex.id, err: (err as Error)?.message },
        'признак доверенных каталогов исполнителя не получен',
      );
      return false;
    }
  }

  /**
   * Способ запрета объявляет сам runtime-адаптер. Ошибка декларации не раскрывает
   * возможность молча: реестр честно показывает unsupported без списка вендоров.
   */
  async function directSshPolicyOf(ex: ExecutorAdapter) {
    if (typeof ex.run !== 'function') return { enforcement: 'unsupported' };
    try {
      const declared = (typeof ex.directSshPolicy === 'function'
        ? await ex.directSshPolicy(config)
        : ex.directSshPolicy) as { enforcement?: string } | null | undefined;
      if (!DIRECT_SSH_ENFORCEMENTS.has(String(declared?.enforcement))) {
        return { enforcement: 'unsupported' };
      }
      return { ...declared, enforcement: declared?.enforcement };
    } catch (err) {
      fastify.log.warn(
        { provider: ex.id, err: (err as Error)?.message },
        'способ запрета SSH исполнителя не получен',
      );
      return { enforcement: 'unsupported' };
    }
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
        capabilities: {
          scopedWorkspace: await supportsScopedWorkspace(ex, config),
          untrustedText: typeof ex.run === 'function'
            && typeof ex.runUntrusted === 'function'
            && ex.untrustedInput?.text === true,
        },
        // Какие исполнители реально применяют prefs.trustedDirectories, UI узнаёт
        // из контракта адаптера — без хардкода id/названий.
        trustedDirectories: await trustedDirectoriesOf(ex),
        directSshPolicy: await directSshPolicyOf(ex),
        installed: ok,
        install: ex.install || null,
        // Куда смотреть при сбое вендора. Какой домен «свой» — знает только адаптер,
        // поэтому Vue домены не перечисляет и по вендорам не ветвится.
        statusPage: ex.statusPage || null,
        // Установка и login могут быть разными сценариями. Старые адаптеры пока
        // объявляют одной строкой install, поэтому для них сохраняем прежнее поведение.
        setupCommand: ok ? (ex.login || ex.install || null) : (ex.install || null),
        canUpdate: !!ex.updateCmd,
        // Сообщает ли исполнитель о своих MCP-серверах. Сам список сюда НЕ кладём:
        // адаптер может делать health-check или читать конфиг, UI ходит отдельным маршрутом.
        mcp: typeof ex.mcpStatus === 'function',
        // Индикатор «вышла новая версия» — из фоновой проверки (updates), не из этого запроса:
        // ходить в сеть на каждый рендер топбара незачем.
        latest: updates.get(ex.id)?.latest || null,
        updateAvailable: !!updates.get(ex.id)?.outdated,
        checkedAt: updates.get(ex.id)?.at || null,
        models: models[ex.id] || [],
        modes: modes || [],
        commands,
        // Свои ручки исполнителя для его плашки в настройках (см. контракт в executors/index.js).
        settings: await settingsOf(ex),
      });
    }
    return providers;
  }

  // Снимок ответа /api/providers: probe — подпроцессы, и гонять их на каждый запрос незачем.
  let cache: { at: number; providers: Awaited<ReturnType<typeof buildRegistry>> } | null = null;

  fastify.decorate('providerRegistry', async () => {
    const providers = await buildRegistry();
    return Object.fromEntries(
      providers.filter((provider) => provider.available && provider.chatEnabled)
        .map((provider) => [provider.id, provider.models]),
    );
  });
  fastify.decorate('executorFor', async (id: unknown) => (await adaptersOf()).get(String(id)) || null);

  // Метка «новое» — бухгалтерия кокпита, а не факт адаптера: адаптер называет ведро
  // полем `group`, а помнит ли человек это ведро — знает только сервер.
  const usageSeen = new ProviderUsageSeenStore({ filePath: config.providerUsageSeenPath });

  /**
   * Ставит `fresh` полосам вёдер, которых раньше не видели. Считаем только по удачному
   * чтению: у отказа полосы приходят из прошлого ответа (`mergeProviderUsage`), и
   * базовая линия по ним записала бы вёдра, которых сервис прямо сейчас не подтверждал.
   */
  function markFreshBuckets(providerId: string, usage: ProviderUsage): ProviderUsage {
    if (usage?.state !== 'ok' || !usage.bars?.length) {
      return usage;
    }

    const bars = usage.bars as UsageBar[];
    const firstSeen = usageSeen.observe(providerId, bars.map((bar) => bar.group));
    const now = Date.now();

    return {
      ...usage,
      bars: bars.map((bar) => (
        bar.group && isFreshGroup(firstSeen[bar.group], now)
          ? { ...bar, fresh: true }
          : bar
      )),
    };
  }

  // Страницу состояния вендора читаем ТОЛЬКО когда лимиты уже не пришли: в норме это
  // лишний внешний запрос на каждое наведение мыши, а в беде — единственный ответ на
  // вопрос «это у меня или у них».
  const statusProbe = createProviderStatusProbe();

  const usageCache = createUsageReadCache<Record<string, ProviderUsage>>(async (previousUsage) => {
    // Тот же источник адаптеров, что и у реестра (`adaptersOf`): иначе стенд подменял
    // исполнителей, а лимиты всё равно собирались у настоящих.
    const executors = await adaptersOf();
    const checkedAt = Date.now();
    // Аккаунты независимы: медленная проверка одного исполнителя не должна
    // задерживать запуск остальных. Promise.all сохраняет порядок реестра.
    const entries = await Promise.all([...executors.values()].map(async (ex) => {
      let current: ProviderUsage;
      if (typeof ex.usage !== 'function') {
        current = unsupportedProviderUsage(String(ex.name), checkedAt);
      } else {
        try {
          current = normalizeProviderUsage(await ex.usage(config as never, deps as never), {
            providerName: String(ex.name),
            checkedAt,
          });
        } catch (e) {
          fastify.log.warn({ provider: ex.id, err: (e as Error)?.message }, 'usage исполнителя не получен');
          current = normalizeProviderUsage({
            state: 'unavailable',
            message: `Не удалось получить лимиты ${ex.name}. Повторим проверку автоматически.`,
          }, { providerName: String(ex.name), checkedAt });
        }
      }
      // `current` здесь есть всегда, поэтому слияние возвращает запись, а не прошлый снимок.
      const merged = mergeProviderUsage(
        previousUsage?.[ex.id],
        markFreshBuckets(ex.id, current),
      ) as ProviderUsage;

      if (!VENDOR_FAULT_USAGE_STATES.has(merged.state) || !ex.statusPage) {
        return [ex.id, merged] as const;
      }

      const vendorStatus = await statusProbe.read(ex.statusPage);

      return [ex.id, vendorStatus ? { ...merged, vendorStatus } : merged] as const;
    }));
    return Object.fromEntries(entries);
  }, { maxAgeMs: CACHE_MS });

  // ── Проверка новых версий CLI: периодически и по кнопке, НИКОГДА не обновляет сама ──
  // providerId → что показала последняя фоновая проверка новой версии CLI.
  const updates = new Map<string, {
    latest: string;
    outdated: boolean;
    current: string;
    at: number;
  }>();
  const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // раз в 6 часов: релизы выходят не чаще
  const FIRST_CHECK_MS = 30_000;             // после старта — не мешая подъёму сервера

  async function checkUpdates() {
    const executors = await getProviderAdapters();
    let changed = false;
    for (const ex of executors.values()) {
      if (typeof ex.latestVersion !== 'function') continue;
      let latest = '';
      try { latest = String(await ex.latestVersion(config) || ''); } catch { latest = ''; }
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
      fastify.sse?.broadcast?.('providers-update', {
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
   * Состояние MCP-серверов исполнителя — блок в его плашке «Настройки → Исполнители».
   * Отдельный ленивый маршрут, а НЕ поле общего `/api/providers`: Claude/Codex могут
   * делать живой health-check, Kimi читает несколько конфигов, и общий реестр не должен
   * ждать ни один из этих источников. Кэш короткий, ручное обновление обходит его.
   */
  // id исполнителя → короткий кэш его ответа про MCP-серверы.
  const mcpCache = new Map<string, { at: number; data: Record<string, unknown> }>();
  const MCP_CACHE_MS = 60_000;

  fastify.get<ProviderRoute>('/api/providers/:id/mcp', async (request, reply) => {
    const id = String(request.params.id);
    const ex = (await getProviderAdapters()).get(id);
    if (!ex) return reply.code(404).send({ error: 'unknown_provider' });
    if (typeof ex.mcpStatus !== 'function') {
      return reply.code(400).send({ error: 'no_mcp', message: `исполнитель ${ex.name} не сообщает о MCP-серверах` });
    }

    const hit = mcpCache.get(id);
    if (request.query?.refresh !== '1' && hit && Date.now() - hit.at < MCP_CACHE_MS) {
      return { ...hit.data, cached: true };
    }

    let data: Record<string, unknown>;
    try {
      data = await ex.mcpStatus(config) as Record<string, unknown>;
    } catch (err) {
      // Сбой опроса — это состояние панели, а не 500: остальные настройки живые.
      const message = (err as Error | null)?.message;
      fastify.log.warn({ provider: id, err: message }, 'опрос MCP-серверов не удался');
      data = { state: 'error', error: String(message || err).slice(0, 300), servers: [] };
    }
    data = { ...data, checkedAt: Date.now() };
    mcpCache.set(id, { at: Date.now(), data });
    return data;
  });

  /**
   * Generic provider-account action. The route knows neither billing semantics
   * nor vendor APIs: each executor exposes an explicit usageActions allow-list.
   * requestId crosses the boundary for idempotent irreversible actions.
   */
  fastify.post<ProviderActionRoute>('/api/providers/:id/usage-actions/:actionId', async (request, reply) => {
    const ex = (await getProviderAdapters()).get(String(request.params.id));
    if (!ex) return reply.code(404).send({ error: 'unknown_provider' });
    const body = request.body || {};
    const r = await executeProviderUsageAction(ex, {
      actionId: request.params.actionId,
      payload: body.payload,
      requestId: body.requestId,
      config,
      deps,
    }) as { ok?: unknown; error?: unknown } | null;
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

  fastify.get<ProvidersListRoute>('/api/providers', async (request) => {
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
  fastify.post<ProviderSettingRoute>('/api/providers/:id/settings', async (request, reply) => {
    const ex = (await adaptersOf()).get(String(request.params.id));
    if (!ex) return reply.code(404).send({ error: 'unknown_provider' });
    const saved = prefs?.read().providerSettings as Record<string, unknown> | undefined;
    const applied = await applyProviderSetting(ex, saved, request.body || {}, config);
    if (!applied.ok) return reply.code(400).send({ error: applied.error, message: applied.message });
    prefs?.write({ providerSettings: applied.providerSettings });
    cache = null; // следующий /api/providers отдаст новое значение
    return { ok: true, settings: applied.settings };
  });

  /**
   * Обновление CLI исполнителя (кнопка в настройках). Команда — свойство исполнителя
   * (`updateCmd`), ядро про вендоров не знает. После обновления сбрасываем кэши:
   * список моделей пересобирается из НОВОГО бинаря — так «вышел Opus 5» доезжает
   * до кокпита без правок кода.
   */
  fastify.post<ProviderRoute>('/api/providers/:id/update', async (request, reply) => {
    const ex = (await getProviderAdapters()).get(String(request.params.id));
    if (!ex) return reply.code(404).send({ error: 'unknown_provider' });
    if (!ex.updateCmd) return reply.code(400).send({ error: 'no_update', message: `у исполнителя ${ex.name} нет команды обновления` });
    const before = (await ex.probe(config))?.version || '';
    const updateCmd = ex.updateCmd;
    const out = await new Promise<{ ok: boolean; text: string }>((resolve) => {
      execFile(String(ex.bin(config)), updateCmd, {
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        resolve({ ok: !err, text: ((stdout || '') + (stderr || '')).trim().slice(-2000) });
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
