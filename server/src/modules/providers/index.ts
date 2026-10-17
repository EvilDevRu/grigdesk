// Модуль providers — реестр LLM-исполнителей кокпита.
// Единая точка правды о том, какие исполнители есть, доступны ли и какие у них модели:
// топбар рисует иконки, чат строит выбор модели/эффорта, схемы выбирают исполнителя по id.
// ПОДКЛЮЧЕНИЕ НОВОГО ИИ — МОДУЛЬНОЕ: один файл в server/src/lib/executors/ (контракт там),
// этот модуль ничего не знает про конкретных вендоров.
// Не путать с /api/agents — там база агентов-стадий конвейера (промпты).
import { resolveWorkdirCapability } from '../../lib/chat/workdir.ts';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import { getProviderAdapters, isChatExecutor, supportsScopedWorkspace } from '../../lib/executors/index.ts';
import { normalizeExecutorType } from '../../../../shared/chat/executorTypes.ts';
import type { ExecutorAdapter } from '../../lib/executors/index.ts';
import { getModelsRegistry } from '../../lib/modelsRegistry.ts';
import { parseInTurnCapability } from '../../../../shared/chat/chatInTurnContracts.ts';
import { isOutdated } from '../../lib/executors/_npmLatest.ts';
import { applyProviderSetting, resolveProviderSettings } from '../../lib/providerSettings.ts';
import { credentialViews, declaredCredentials, envFileNames } from '../../lib/executorCredentials.ts';
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
import { registerProviderNativeSettings } from './settings.ts';
import { registerProviderCredentials } from './credentials.ts';

// Серверный config в объёме, который читает реестр. Полная его форма объявлена
// в config.ts; адаптеры получают его целиком и разбирают сами.
type ProvidersConfig = {
  modelsPath: string;
  providerUsageSeenPath: string;
  // Корневой .env: туда окно «Ключи доступа» пишет объявленные исполнителем ключи.
  envPath?: string;
};

export interface ProvidersModuleOptions {
  config: ProvidersConfig;
  claudeAuth?: unknown;
  prefs?: PrefsStore;
  // Точка подмены для офлайн-тестов: реестр не знает про конкретных вендоров.
  getProviderAdapters?: () => Promise<Map<string, ExecutorAdapter>>;
  getModelsRegistry?: typeof getModelsRegistry;
  // Период фонового чтения лимитов; офлайн-тесты укорачивают его до миллисекунд.
  usageTickMs?: number;
  // Окружение, которое видят исполнители. Тесты подменяют его, чтобы не трогать process.env.
  env?: NodeJS.ProcessEnv;
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

// Период чтения лимитов у вендора — СВОЙ, и он намеренно длиннее реестра. Реестр — это
// probe локальных бинарей, они ничего не стоят; лимиты — запрос к API аккаунта, и минутный
// шаг круглосуточно упирался в отказ по частоте («Anthropic временно ограничил запрос
// проверки лимитов») у живого аккаунта. Окна лимитов измеряются часами и неделями, поэтому
// пятиминутный шаг не теряет ничего: сессия в 5ч сдвигается за это время на 1,7%.
const USAGE_CACHE_MS = 5 * 60_000;

// Пауза после отказа по частоте — в СВОИХ тиках, а не в минутах: она означает «пропусти
// столько своих походов», и при смене периода не надо пересчитывать её отдельно. С каждым
// отказом подряд удваивается и упирается в потолок: вендор, который просит реже, не должен
// получать один и тот же шаг вечно. При пятиминутном шаге это 15 → 30 → 60 минут.
const USAGE_BACKOFF_TICKS = 3;
const USAGE_BACKOFF_MAX_TICKS = 12;

// Принудительная проверка по кнопке не перечитывает снимок моложе этого: дробь кликов
// подряд не должна превращаться в очередь походов к вендору, а за 15 секунд лимиты
// не меняются заметно.
const USAGE_FORCE_MIN_AGE_MS = 15_000;
const DIRECT_SSH_ENFORCEMENTS = new Set([
  'command-hook',
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
  const serviceEnv = opts.env || process.env;
  const adaptersOf = opts.getProviderAdapters || getProviderAdapters;
  const modelsOf = opts.getModelsRegistry || getModelsRegistry;

  registerProviderNativeSettings(fastify, {
    config,
    prefs,
    adaptersOf,
  });

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
   * Способ запрета объявляет сам runtime-адаптер. Ошибка декларации не раскрывает
   * возможность молча: реестр честно показывает unsupported без списка вендоров.
   */
  async function directSshPolicyOf(ex: ExecutorAdapter) {
    if (!isChatExecutor(ex)) {
      return { enforcement: 'unsupported' };
    }

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

  /**
   * Собирает карточки из общих источников адаптеров и моделей без чтения MCP.
   * Возможности объявляет исполнитель; подменённые источники изолируют офлайн-стенд.
   */
  async function buildRegistry() {
    const executors = await adaptersOf();
    const models = await modelsOf(config);
    const fileNames = await envFileNames(config.envPath);
    const providers = [];

    for (const ex of executors.values()) {
      const type = normalizeExecutorType(ex.type);
      const universal = type === 'universal';
      const chatEnabled = isChatExecutor(ex);
      const [probe, auth] = await Promise.all([ex.probe(config), ex.auth(config, deps)]);
      const { ok, version } = probe;
      const distribution = ex.distribution?.(config, probe) || null;
      const embedded = distribution?.kind === 'embedded';
      // Режимы прав спрашиваем у самого CLI (как и эффорты) — список не хардкодим.
      let modes = null;

      if (universal && ok && typeof ex.modes === 'function') {
        try { modes = await ex.modes(config); } catch { modes = null; }
      }
      // Слэш-команды исполнителя для меню чата. Источники cwd-независимы, поэтому
      // легально едут в том же глобальном кэше; падение сканера одного ИИ не валит реестр.
      const commands = universal && typeof ex.commands === 'function'
        ? normalizeCommands(await Promise.resolve(ex.commands(config)).catch(() => []))
        : [];

      providers.push({
        id: ex.id,
        name: ex.name,
        vendor: ex.vendor,
        type,
        kind: ex.kind === 'api' ? 'api' : 'cli',
        bin: ex.bin(config),
        color: ex.color,
        version,
        auth: auth.mode,
        authLabel: auth.label,
        available: ok && auth.available,
        // Setup-only карточка видна здесь, но отсутствует в runtime-реестре чатов.
        chatEnabled,
        capabilities: {
          chatAutoCompact: universal && (ex.chatAutoCompact === true || !!ex.autoCompactEnv),
          scopedWorkspace: chatEnabled && await supportsScopedWorkspace(ex, config),
          untrustedText: chatEnabled
            && typeof ex.runUntrusted === 'function'
            && ex.untrustedInput?.text === true,
        },
        // Канал ввода в активный ход: адаптер объявляет его сам, наружу идёт разобранная форма.
        inTurn: parseInTurnCapability(universal ? ex.inTurnInput : null),
        // Resume id принадлежит server-owned sidecar, а не JSON чата/браузеру.
        sessionBinding: chatEnabled && Boolean(ex.sessionBinding),
        // Как переносить память и применять рабочие корни, UI узнаёт
        // из контракта адаптера — без хардкода id/названий.
        workdir: universal ? await resolveWorkdirCapability(ex, config) : null,
        directSshPolicy: await directSshPolicyOf(ex),
        installed: ok,
        install: embedded ? null : ex.install || null,
        distribution: distribution ? { ...distribution, ready: ok } : null,
        // Куда смотреть при сбое вендора. Какой домен «свой» — знает только адаптер,
        // поэтому Vue домены не перечисляет и по вендорам не ветвится.
        statusPage: ex.statusPage || null,
        // Установка и login могут быть разными сценариями. Старые адаптеры пока
        // объявляют одной строкой install, поэтому для них сохраняем прежнее поведение.
        setupCommand: embedded ? null : ok ? (ex.login || ex.install || null) : (ex.install || null),
        canUpdate: !embedded && !!ex.updateCmd,
        // Сообщает ли исполнитель о своих MCP-серверах. Сам список сюда НЕ кладём:
        // адаптер может делать health-check или читать конфиг, UI ходит отдельным маршрутом.
        mcp: typeof ex.mcpStatus === 'function',
        settingsCatalog: typeof ex.nativeSettings?.discover === 'function',
        // Индикатор «вышла новая версия» — из фоновой проверки (updates), не из этого запроса:
        // ходить в сеть на каждый рендер топбара незачем.
        latest: embedded ? null : updates.get(ex.id)?.latest || null,
        updateAvailable: !embedded && !!updates.get(ex.id)?.outdated,
        checkedAt: updates.get(ex.id)?.at || null,
        models: chatEnabled ? models[ex.id] || [] : [],
        modes: modes || [],
        commands,
        // Свои ручки исполнителя для его плашки в настройках (см. контракт в executors/index.js).
        settings: await settingsOf(ex),
        // Ключи доступа: что задано и откуда. Значения секретов сюда не попадают.
        credentials: credentialViews(await declaredCredentials(ex, config), serviceEnv, fileNames),
      });
    }
    return providers;
  }

  // Снимок ответа /api/providers: probe — подпроцессы, и гонять их на каждый запрос незачем.
  const registryCache = createUsageReadCache(buildRegistry, { maxAgeMs: CACHE_MS });

  /**
   * Защищает выход HTTP и декоратора после ожидания общей загрузки реестра.
   * Поколение, сменившееся между завершением loader и продолжением читателя, перечитывается.
   */
  async function readRegistry<Result>(
    consume: (providers: Awaited<ReturnType<typeof buildRegistry>>) => Result,
  ): Promise<Result> {
    for (;;) {
      const version = registryCache.version();
      const providers = await registryCache.read();

      if (version === registryCache.version()) {
        return consume(providers);
      }
    }
  }

  fastify.decorate('providerRegistry', () => readRegistry((providers) => Object.fromEntries(
      providers.filter((provider) => provider.available && provider.chatEnabled)
        .map((provider) => [provider.id, provider.models]),
  )));
  fastify.decorate('executorFor', async (id: unknown) => {
    const executor = (await adaptersOf()).get(String(id));

    return executor && isChatExecutor(executor) ? executor : null;
  });

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

  // Период фонового тика И TTL кэша — одна величина: пока она общая, между тиками ни одно
  // чтение окна к вендору не ходит, и частота походов равна ровно частоте тика.
  const usageTickMs = opts.usageTickMs ?? USAGE_CACHE_MS;

  // До какого момента исполнителя не трогаем. Пауза персональная: отказ по частоте у
  // одного аккаунта ничего не говорит про соседний, и глушить весь ряд было бы неверно.
  const usageBackoff = new Map<string, { until: number; ticks: number }>();
  // Адресный сброс общего кэша сохраняет прошлые снимки и паузы соседних аккаунтов.
  const usagePrevious = new Map<string, ProviderUsage>();

  /**
   * Отказ по частоте — единственная беда, на которую кокпит отвечает молчанием. Сеть,
   * протухший вход и отсутствие API лечатся повтором или человеком, а вот на «стучитесь
   * реже» повтор в прежнем темпе держит аккаунт в отказе сам.
   *
   * Срок называет вендор (`retryAt` из заголовка Retry-After), но своя шкала всё равно
   * нужна: заголовка может не быть вовсе, а просьба «через 30 секунд» короче нашего
   * собственного шага и вернула бы прежний темп. Берём более долгий из двух сроков.
   * Удачное чтение снимает паузу целиком; прочие беды её не трогают.
   */
  function rememberUsageBackoff(id: string, current: ProviderUsage, checkedAt: number): void {
    if (current.state === 'ok') {
      usageBackoff.delete(id);

      return;
    }

    if (current.state !== 'rate_limited') {
      return;
    }

    // Храним саму паузу, а не число отказов: следующая — вдвое длиннее прошлой, и на
    // потолке она просто перестаёт расти, без отдельного счётчика и его переполнения.
    const heldTicks = usageBackoff.get(id)?.ticks ?? 0;
    const ticks = Math.min(
      heldTicks ? heldTicks * 2 : USAGE_BACKOFF_TICKS,
      USAGE_BACKOFF_MAX_TICKS,
    );
    const ownPause = checkedAt + ticks * usageTickMs;
    const askedPause = typeof current.retryAt === 'number' ? current.retryAt : 0;

    usageBackoff.set(id, { until: Math.max(ownPause, askedPause), ticks });
  }

  // Срок паузы едет в снимок полем retryAt: по нему всплывашка гасит кнопку принудительной
  // проверки и называет время, а не оставляет человека гадать, почему клик ничего не дал.
  function withPauseUntil(id: string, usage: ProviderUsage): ProviderUsage {
    const until = usageBackoff.get(id)?.until;

    return until ? { ...usage, retryAt: until } : usage;
  }

  const usageCache = createUsageReadCache<Record<string, ProviderUsage>>(async (previousUsage, context) => {
    // Тот же источник адаптеров, что и у реестра (`adaptersOf`): иначе стенд подменял
    // исполнителей, а лимиты всё равно собирались у настоящих.
    const executors = await adaptersOf();

    if (!context.isCurrent()) {
      return {};
    }

    const checkedAt = Date.now();
    // Аккаунты независимы: медленная проверка одного исполнителя не должна
    // задерживать запуск остальных. Promise.all сохраняет порядок реестра.
    const entries = await Promise.all([...executors.values()].map(async (ex) => {
      const held = usageBackoff.get(ex.id);
      const previous = previousUsage?.[ex.id] ?? usagePrevious.get(ex.id);

      // Идёт пауза после «стучитесь реже»: отдаём прошлый снимок как есть. Он уже несёт
      // и слова вендора, и последние полосы — новых мы честно не знаем, а сходить за
      // ними значит повторить ровно то, о чём нас попросили не делать.
      if (held && held.until > checkedAt && previous) {
        return [ex.id, previous] as const;
      }

      let current: ProviderUsage;
      if (typeof ex.usage !== 'function') {
        current = unsupportedProviderUsage(String(ex.name), checkedAt);
      } else {
        try {
          current = normalizeProviderUsage(await ex.usage(config as never, deps as never), {
            providerName: String(ex.name),
            checkedAt,
          });
        } catch {
          if (context.isCurrent()) {
            fastify.log.warn({ provider: ex.id }, 'usage исполнителя не получен');
          }

          current = normalizeProviderUsage({
            state: 'unavailable',
            message: `Не удалось получить лимиты ${ex.name}. Повторим проверку автоматически.`,
          }, { providerName: String(ex.name), checkedAt });
        }
      }
      if (!context.isCurrent()) {
        return [ex.id, current] as const;
      }

      rememberUsageBackoff(ex.id, current, checkedAt);
      // `current` здесь есть всегда, поэтому слияние возвращает запись, а не прошлый снимок.
      const merged = withPauseUntil(ex.id, mergeProviderUsage(
        previous,
        markFreshBuckets(ex.id, current),
      ) as ProviderUsage);

      if (!VENDOR_FAULT_USAGE_STATES.has(merged.state) || !ex.statusPage) {
        usagePrevious.set(ex.id, merged);

        return [ex.id, merged] as const;
      }

      const vendorStatus = await statusProbe.read(ex.statusPage);
      const result = vendorStatus ? { ...merged, vendorStatus } : merged;

      if (context.isCurrent()) {
        usagePrevious.set(ex.id, result);
      }

      return [ex.id, result] as const;
    }));
    return Object.fromEntries(entries);
  }, { maxAgeMs: usageTickMs });

  /**
   * Проверяет актуальность непосредственно перед выходом HTTP/SSE.
   * Старый refresh разделяет чтение нового поколения, а не публикует прежний счёт.
   */
  async function readUsage<Result>(
    refresh: boolean,
    consume: (usage: Record<string, ProviderUsage>) => Result,
  ): Promise<Result> {
    for (;;) {
      const version = usageCache.version();
      const usage = await (refresh ? usageCache.refresh() : usageCache.read());

      if (version === usageCache.version()) {
        return consume(usage);
      }

      refresh = false;
    }
  }

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

  /**
   * Проверяет версии только у адаптеров текущего источника, включая фоновый таймер.
   * Обновление остаётся ручным; изменившийся снимок сбрасывает кэш карточек.
   */
  async function checkUpdates() {
    const executors = await adaptersOf();
    let changed = false;

    for (const ex of executors.values()) {
      if (ex.distribution?.(config)?.kind === 'embedded') {
        changed = updates.delete(ex.id) || changed;

        continue;
      }

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
      registryCache.clear(); // в следующем ответе /api/providers поедут новые поля
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
  fastify.get('/api/providers/usage', (_, reply) => readUsage(false, (usage) => reply.send({ usage })));

  // Принудительная проверка по кнопке во всплывашке. Обходит TTL кэша, но не паузу после
  // отказа вендора: её соблюдает само чтение и вернёт прошлый снимок. Свежий снимок
  // отдаётся как есть — он уже в кэше, и read() к вендору не пойдёт. Итог рассылается
  // всем окнам: проверку попросило одно, а полосы общие.
  fastify.post('/api/providers/usage/refresh', (_, reply) => readUsage(
    usageCache.ageMs() >= USAGE_FORCE_MIN_AGE_MS,
    (usage) => {
      fastify.sse?.broadcast?.('providers-usage', { usage });

      return reply.send({ usage });
    },
  ));

  // ── Фоновая свежесть лимитов ──
  // Раньше лимиты читались только по запросу окна: первое наведение после минуты тишины
  // запускало живой поход к вендору, и всплывашка секунды показывала прошлый снимок.
  // Тик держит серверный кэш тёплым и рассылает снимок по SSE, поэтому окно читает
  // готовое, а полосы идут за временем и без наведения.
  //
  // Цена фона — походы к вендору идут, пока открыт кокпит, а не пока водят мышью, поэтому
  // шаг здесь свой (USAGE_CACHE_MS) и заметно длиннее реестра: минутный круглосуточно
  // ловил отказ по частоте у живого аккаунта.

  /**
   * Перечитать лимиты, если снимок устарел, и разослать его. Снимок моложе половины
   * периода не перечитывается — его только что принёс запрос окна, второй поход подряд
   * лишний. Наружу отдаётся декоратором `refreshProvidersUsage`: фоновый потребитель
   * (прогноз лимитов) зовёт его своим редким таймером, когда окон нет, — снимок уходит
   * тем же событием, и второго пути к вендору не появляется.
   */
  async function refreshUsageIfStale(): Promise<void> {
    if (usageCache.ageMs() < usageTickMs / 2) return;

    await readUsage(true, (usage) => {
      fastify.sse?.broadcast?.('providers-usage', { usage });
    });
  }

  fastify.decorate('refreshProvidersUsage', refreshUsageIfStale);

  /**
   * Один тик. Пустой зал вендора не тревожит: без окон на потоке снимок никому не нужен,
   * а первое открывшееся окно перечитает его само.
   */
  async function tickUsage(): Promise<void> {
    if (!(fastify.sse?.clientCount?.() ?? 0)) return;

    await refreshUsageIfStale();
  }

  const usageTimer = setInterval(() => {
    tickUsage().catch((err: unknown) => {
      fastify.log.warn({ err }, 'фоновое чтение лимитов исполнителей не удалось');
    });
  }, usageTickMs);

  usageTimer.unref?.();
  fastify.addHook('onClose', async () => {
    clearInterval(usageTimer);
  });

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
    const ex = (await adaptersOf()).get(id);
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

  fastify.get<ProvidersListRoute>('/api/providers', async (request, reply) => {
    const force = request.query?.refresh === '1';
    // Старые версии моделей приходят всегда (с `legacy: true`), а показывать ли их —
    // решает настройка: тумблер в UI не должен ходить за новым списком на сервер.
    const showAllModels = !!prefs?.read().showAllModels;

    if (force) {
      await modelsOf(config, { refresh: true }); // пересобрать каталог моделей
      registryCache.clear();
    }

    return readRegistry((providers) => reply.send({ providers, showAllModels }));
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

    const settingId = String(request.body?.settingId || '');
    const approved = applied.providerSettings[ex.id] as Record<string, unknown>;

    prefs?.updateProviderSettings((current) => ({
      ...current,
      [ex.id]: { ...current[ex.id] as object, [settingId]: approved[settingId] },
    }));

    registryCache.clear(); // следующий /api/providers отдаст новое значение
    return { ok: true, settings: applied.settings };
  });

  // Окно «Ключи доступа»: маршрут в credentials.ts, кэши реестра и лимитов — здесь.
  registerProviderCredentials(fastify, {
    config,
    adaptersOf,
    env: serviceEnv,
    resetRegistry: () => {
      registryCache.clear();
    },
    resetUsage: (id) => {
      usageCache.clear();
      usageBackoff.delete(id);
      usagePrevious.delete(id);
    },
    refreshModels: () => modelsOf(config, { refresh: true }),
  });

  /**
   * Обновление CLI исполнителя (кнопка в настройках). Команда — свойство исполнителя
   * (`updateCmd`), ядро про вендоров не знает. После обновления сбрасываем кэши:
   * список моделей пересобирается из НОВОГО бинаря — так «вышел Opus 5» доезжает
   * до кокпита без правок кода.
   */
  fastify.post<ProviderRoute>('/api/providers/:id/update', async (request, reply) => {
    const ex = (await adaptersOf()).get(String(request.params.id));
    if (!ex) return reply.code(404).send({ error: 'unknown_provider' });
    if (ex.distribution?.(config)?.kind === 'embedded') {
      return reply.code(400).send({ error: 'no_update', message: 'Обновление доступно вместе с Cockpit' });
    }
    if (!ex.updateCmd) {
      return reply.code(400).send({
        error: 'no_update', message: `у исполнителя ${ex.name} нет команды обновления`,
      });
    }
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

    registryCache.clear();
    const after = (await ex.probe(config))?.version || '';
    // Версия сменилась → каталог моделей нового CLI (скан бинаря) подхватится сразу.
    await modelsOf(config, { refresh: true }).catch(() => null);
    // И индикатор «доступно обновление» должен погаснуть сразу, а не через 6 часов.
    await checkUpdates().catch(() => null);
    return { ok: out.ok, before, after, changed: before !== after, output: out.text };
  });
}

export default fp(providersModule, { name: 'module-providers' });
