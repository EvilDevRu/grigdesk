// Модуль providers — реестр LLM-исполнителей GrigDesk.
// Единая точка правды о том, какие исполнители есть, доступны ли и какие у них модели:
// топбар рисует иконки, чат строит выбор модели/эффорта, схемы выбирают исполнителя по id.
// ПОДКЛЮЧЕНИЕ НОВОГО ИИ — МОДУЛЬНОЕ: один файл в server/src/lib/executors/ (контракт там),
// этот модуль ничего не знает про конкретных вендоров.
import { resolveWorkdirCapability } from '../../lib/chat/workdir.ts';
import { AccessProfileService } from '../../lib/accessProfiles/service.ts';
import { accessProfileAdapter } from '../../lib/accessProfiles/adapter.ts';
import type { AccessConfig, AccessOptions } from '../../lib/accessProfiles/types.ts';
import { registerAccessProfiles } from './accessProfiles.ts';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getProviderAdapters, isChatExecutor, supportsScopedWorkspace } from '../../lib/executors/index.ts';
import { normalizeExecutorType } from '../../../../shared/chat/executorTypes.ts';
import type { ExecutorAdapter } from '../../lib/executors/index.ts';
import { getModelsRegistry, invalidateModelsRegistry } from '../../lib/modelsRegistry.ts';
import { parseInTurnCapability } from '../../../../shared/chat/chatInTurnContracts.ts';
import { isOutdated, parseVersion } from '../../lib/executors/_npmLatest.ts';
import { applyProviderSetting, resolveProviderSettings } from '../../lib/providerSettings.ts';
import { credentialViews, declaredCredentials, envFileNames } from '../../lib/executorCredentials.ts';
import {
  createUsageReadCache,
  executeProviderUsageAction,
  mergeProviderUsage,
  normalizeProviderUsage,
  unsupportedProviderUsage,
} from '../../lib/providerUsage.ts';
import { createProviderUsagePoller, type UsagePollContext } from '../../lib/providerUsagePoller.ts';
import { createProviderStatusProbe, VENDOR_FAULT_USAGE_STATES } from '../../lib/providerStatus.ts';
import { ProviderUsageSeenStore, isFreshGroup } from '../../lib/providerUsageSeen.ts';
import type { ProviderUsage, ProviderUsagePatch, UsageBar } from '../../lib/providerUsage.ts';
import { acceptPatch, projectUsage, settlePoll } from '../../lib/providerUsageLive.ts';
import type { LiveUsage } from '../../lib/providerUsageLive.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';
import { registerProviderNativeSettings } from './settings.ts';
import { registerProviderCredentials } from './credentials.ts';
import { registerProviderInstallations } from './installations.ts';
import { ProviderInstallService, type ProviderInstallOptions } from '../../lib/providerInstall/service.ts';
import { resolveProviderInstallation } from '../../lib/providerInstall/commands.ts';
import { discoverExternalCli } from '../../lib/providerInstall/inventory.ts';
import { runtimeInstallationRoot, runtimeRoot } from '../../lib/runtimePaths.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { artifactsPath } from '../../../../shared/runtime/dataHome.ts';
import { resolveUserCliEnvironment } from '../../lib/providerInstall/userCliEnvironment.ts';
import type { ExternalCliInventory } from '../../../../shared/chat/providerInstallationInventory.ts';

// Серверный config в объёме, который читает реестр. Полная его форма объявлена
// в config.ts; адаптеры получают его целиком и разбирают сами.
type ProvidersConfig = {
  modelsPath: string;
  providerUsageSeenPath: string;
  providerInstallStatePath?: string;
  // Корневой .env: туда окно «Ключи доступа» пишет объявленные исполнителем ключи.
  envPath?: string;
};

export interface ProvidersModuleOptions {
  accessProfiles?: AccessOptions;
  config: ProvidersConfig;
  claudeAuth?: unknown;
  prefs?: PrefsStore;
  // Точка подмены для офлайн-тестов: реестр не знает про конкретных вендоров.
  getProviderAdapters?: () => Promise<Map<string, ExecutorAdapter>>;
  getModelsRegistry?: typeof getModelsRegistry;
  // Период фонового чтения лимитов; офлайн-тесты укорачивают его до миллисекунд.
  usageTickMs?: number;
  providerInstall?: ProviderInstallOptions;
  // Окружение, которое видят исполнители. Тесты подменяют его, чтобы не трогать process.env.
  env?: NodeJS.ProcessEnv;
}

// Маршруты исполнителя адресуются его id; действие и список добавляют свои части.
interface ProviderRoute {
  Params: { id: string };
  Querystring: { refresh?: string };
}

interface ProviderUsageRefreshRoute {
  Body: { providerId?: unknown } | null;
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
  Querystring: {
    refresh?: string;
    wait?: string;
  };
}

// Список меняется редко — кэшируем, чтобы не гонять probe-подпроцессы на каждый запрос.
const CACHE_MS = 60_000;
const REGISTRY_READ_BUDGET_MS = 1_200;

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
  'command-broker',
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
    kind?: unknown;
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
      ...(c.kind === 'skill' ? { kind: 'skill' as const } : {}),
      ...(c.hint ? { hint: String(c.hint).slice(0, 120) } : {}),
      ...(c.args ? { args: true } : {}),
    }));
}

/**
 * Общий реестр и опрос лимитов принадлежат жизненному циклу этого экземпляра сервера.
 * Остановка запрещает новые проверки и дожидается уборки уже запущенных адаптеров.
 */
async function providersModule(
  fastify: FastifyInstance,
  opts: ProvidersModuleOptions,
): Promise<void> {
  const { config, claudeAuth, prefs } = opts;
  const usageAbort = new AbortController();
  const usageRequests = new Set<Promise<unknown>>();
  const deps = { claudeAuth, signal: usageAbort.signal };
  const serviceEnv = opts.env || process.env;
  const rawAdaptersOf = opts.getProviderAdapters || getProviderAdapters;
  const accessProfiles = new AccessProfileService(config as AccessConfig, serviceEnv,
    rawAdaptersOf, opts.accessProfiles);
  const adaptersOf = async () => new Map([...(await rawAdaptersOf()).entries()].map(([id, adapter]) =>
    [id, accessProfileAdapter(adapter, { service: accessProfiles })]));

  registerAccessProfiles(fastify, accessProfiles);
  fastify.addHook('onClose', () => accessProfiles.close());

  const modelsOf = opts.getModelsRegistry || getModelsRegistry;
  const installationChecks = new Map<string, {
    at: number;
    installed: boolean;
  }>();

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
  async function buildRegistry(_previous: unknown, context: { isCurrent: () => boolean }) {
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

      if (context.isCurrent()) {
        installationChecks.set(ex.id, {
          at: Date.now(),
          installed: ok,
        });
      }

      const distribution = ex.distribution?.(config, probe) || null;
      const managed = distribution?.managed === true;
      let installation = managed ? null : await resolveProviderInstallation(ex, config,
        serviceEnv, opts.providerInstall?.runtimePaths);
      const home = serviceEnv.HOME || os.homedir();
      const external = managed ? null : ex.externalCli?.(config, home);
      let inventory: ExternalCliInventory | undefined;

      if (external) {
        let env: NodeJS.ProcessEnv = { ...serviceEnv, PATH: '' };
        let environment: ExternalCliInventory['environment'];

        try {
          const shell = await resolveUserCliEnvironment({
            env: serviceEnv,
            cliName: external.binName,
            scratch: path.join(opts.providerInstall?.artifactsDir
              ?? artifactsPath({ env: serviceEnv, home }), 'provider-install-probes'),
          });

          env = shell.env;
          environment = { state: 'ready' };
        } catch {
          environment = { state: 'unavailable', reason: 'shell_probe_failed' };
        }

        const legacyRoots = [
          path.join(opts.providerInstall?.roots?.dataHome
            ?? path.join(home, '.grigdesk'), 'state', 'npm-global'),
          opts.providerInstall?.roots?.installationRoot ?? runtimeInstallationRoot(),
          opts.providerInstall?.roots?.runtimeRoot ?? runtimeRoot(),
        ];

        inventory = {
          ...await discoverExternalCli({
            providerId: ex.id,
            definition: external,
            configuredBin: String(ex.bin(config)),
            env,
            home,
            legacyRoots,
          }),
          environment,
        };
      }

      const selectedCopy = inventory?.installations.find((entry) =>
        entry.installationId === inventory.selectedId);

      if (selectedCopy?.source === 'native') {
        const declared = ex.installation?.(config);

        installation = declared ? { ...declared, update: declared.update ? declared.install : null }
          : installation;
        selectedCopy.version = parseVersion(version)?.join('.') ?? null;
      }

      const canServiceCopy = !external || selectedCopy?.source === 'npm'
        || selectedCopy?.source === 'native';
      const canUpdate = !!ok && !!installation?.update && canServiceCopy;

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
        ...(ex.accessProfiles ? {
          accessProfiles: await accessProfiles.list(ex.id).then((list) => ({
            supported: true,
            methods: list.methods,
            activeProfile: list.profiles.find((item) => item.id === list.activeProfileId) ?? null,
          })),
        } : {}),
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
        ...(chatEnabled && ex.chatSpeed ? { chatSpeed: { modes: [...ex.chatSpeed.modes] } } : {}),
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
        install: managed ? null : ex.install || null,
        distribution: distribution ? { ...distribution, ready: ok } : null,
        // Куда смотреть при сбое вендора. Какой домен «свой» — знает только адаптер,
        // поэтому Vue домены не перечисляет и по вендорам не ветвится.
        statusPage: ex.statusPage || null,
        ...(ex.usagePresentation ? { usagePresentation: ex.usagePresentation } : {}),
        // Установка и login могут быть разными сценариями. Старые адаптеры пока
        // объявляют одной строкой install, поэтому для них сохраняем прежнее поведение.
        setupCommand: managed ? null : ok ? (ex.login || ex.install || null) : (ex.install || null),
        canUpdate: !managed && (external ? canUpdate : installation ? !!installation.update : !!ex.updateCmd),
        ...(installation ? {
          installation: {
            ...(inventory ? { inventory } : {}),
            ...(external ? {
              lifecycleProtocol: 2,
              canReinstall: inventory?.installations.some((entry) =>
                entry.installationId === inventory.selectedId
                  && ['npm', 'native'].includes(entry.source) && !!entry.version),
              canUninstall: inventory?.installations.some((entry) =>
                entry.installationId === inventory.selectedId && ['npm', 'native'].includes(entry.source)),
            } : {}),
            installCommand: installation.install.command,
            updateCommand: installation.update?.command || null,
            fallbackInstallCommand: installation.install.fallbackCommand,
            fallbackUpdateCommand: installation.update?.fallbackCommand || null,
            loginCommand: installation.loginCommand,
            canInstall: !ok && (!selectedCopy || selectedCopy.state === 'missing'),
            canUpdate,
          },
        } : {}),
        // Сообщает ли исполнитель о своих MCP-серверах. Сам список сюда НЕ кладём:
        // адаптер может делать health-check или читать конфиг, UI ходит отдельным маршрутом.
        mcp: typeof ex.mcpStatus === 'function',
        settingsCatalog: typeof ex.nativeSettings?.discover === 'function',
        // Индикатор «вышла новая версия» — из фоновой проверки (updates), не из этого запроса:
        // ходить в сеть на каждый рендер топбара незачем.
        latest: managed ? null : updates.get(ex.id)?.latest || null,
        updateAvailable: !managed && !!updates.get(ex.id)?.outdated,
        checkedAt: updates.get(ex.id)?.at || null,
        models: chatEnabled ? models[ex.id] || [] : [],
        modes: modes || [],
        defaultPermissionMode: ex.defaultPermissionMode,
        permissionModeSelectionPolicy: ex.permissionModeSelectionPolicy,
        permissionModesRequiringExplicitSelection: ex.permissionModesRequiringExplicitSelection,
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
    background = false,
  ): Promise<Result> {
    for (;;) {
      const version = registryCache.version();
      const providers = await (background
        ? registryCache.readStale(REGISTRY_READ_BUDGET_MS, [], () => {
          fastify.sse?.broadcast?.('providers-update', {});
        })
        : registryCache.read());

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

  // Метка «новое» — бухгалтерия GrigDesk, а не факт адаптера: адаптер называет ведро
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
  const usageGenerations = new Map<string, number>();
  const liveUsage = new Map<string, LiveUsage>();
  const usageBootId = randomUUID();
  const removedRuntimes = new Set<string>();
  let usageProviderIds: string[] = [];

  /**
   * Использует свежий probe реестра или прошлого опроса, не собирая тяжёлую карточку.
   * Ошибка probe не доказывает удаление; поздний ответ старого поколения не кэшируется.
   */
  async function installedOf(ex: ExecutorAdapter, isCurrent: () => boolean): Promise<boolean | undefined> {
    const cached = installationChecks.get(ex.id);

    if (cached && Date.now() - cached.at < CACHE_MS) {
      return cached.installed;
    }

    try {
      const { ok } = await ex.probe(config);

      if (isCurrent()) {
        installationChecks.set(ex.id, {
          at: Date.now(),
          installed: ok,
        });
      }

      return ok;
    } catch {
      return undefined;
    }
  }

  /**
   * Замораживает один runtime одинаково при lifecycle-операции и исчезновении CLI.
   * Время замера и Retry-After сохраняются, прежние живые события теряют поколение.
   */
  function retainRuntimeUsage(ex: ExecutorAdapter, removed: boolean): ProviderUsage {
    const previous = usagePrevious.get(ex.id);
    const generation = (usageGenerations.get(ex.id) ?? 0) + 1;

    usageGenerations.set(ex.id, generation);
    liveUsage.delete(ex.id);

    if (removed) {
      removedRuntimes.add(ex.id);
    } else {
      removedRuntimes.delete(ex.id);
    }

    const retained: ProviderUsage = {
      ...(previous ?? normalizeProviderUsage({ state: 'unavailable' })),
      ...(removed ? {
        state: 'unavailable',
        message: 'Программа исполнителя удалена. Установи CLI для проверки лимитов.',
        bars: [],
        resources: [],
      } : {}),
      stale: true,
      ...(ex.usagePresentation?.freshness ? {
        lastSuccessfulAt: previous?.lastSuccessfulAt ?? null,
        runtimeGeneration: `${usageBootId}:${generation}`,
        pollIntervalMs: usageTickMs,
      } : {}),
    };

    usagePrevious.set(ex.id, retained);

    return retained;
  }

  /**
   * Все выходы накладывают живые значения одним способом, сохраняя сырой кэш опроса.
   * Полная карта не удаляет соседнего исполнителя в сторе, который заменяет снимок целиком.
   */
  function projectUsageMap(usage: Record<string, ProviderUsage>): Record<string, ProviderUsage> {
    return Object.fromEntries(Object.entries(usage).map(([id, entry]) => [
      id,
      projectUsage(entry, liveUsage.get(id)),
    ]));
  }

  fastify.decorate('providerUsageSink', (providerId: string) => {
    const generation = usageGenerations.get(providerId) ?? 0;

    return (patch: ProviderUsagePatch): boolean => {
      try {
        if (!usagePoller.isEnabled() || usageAbort.signal.aborted) {
          return false;
        }

        if ((usageGenerations.get(providerId) ?? 0) !== generation) {
          return false;
        }

        const previous = usagePrevious.get(providerId);
        const current = liveUsage.get(providerId) ?? {
          generation,
          seq: 0,
          bars: new Map()
        };
        const accepted = acceptPatch(current, previous?.bars ?? [], patch, { now: Date.now() });

        if (!accepted.changed) {
          return false;
        }

        liveUsage.set(providerId, accepted.state);

        if (previous && usageProviderIds.every((id) => usagePrevious.has(id))) {
          publishUsage();
        }

        return true;
      } catch {
        return false;
      }
    };
  });


  /**
   * Отказ по частоте — единственная беда, на которую GrigDesk отвечает молчанием. Сеть,
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

  /**
   * Измеряет один аккаунт и фиксирует результат только в его действующем поколении.
   * Все ожидания заканчиваются до записи backoff, истории вёдер и видимого снимка.
   */
  async function pollProviderUsage(id: string, context: UsagePollContext): Promise<void> {
    const ex = (await adaptersOf()).get(id);

    if (!ex || usageAbort.signal.aborted || !context.isCurrent()) {
      return;
    }

    const checkedAt = Date.now();
    const generation = usageGenerations.get(id) ?? 0;
    const previous = usagePrevious.get(id);
    const held = usageBackoff.get(id);
    const isCurrent = () => !usageAbort.signal.aborted && context.isCurrent()
      && (usageGenerations.get(id) ?? 0) === generation;
    const installed = ex.kind === 'api' || ex.usageRequiresRuntime === false
      ? true : await installedOf(ex, isCurrent);

    if (!isCurrent()) {
      return;
    }
    if (installed === false) {
      if (!removedRuntimes.has(id) || !previous) {
        retainRuntimeUsage(ex, true);
      }

      return;
    }
    if (installed === true) {
      removedRuntimes.delete(id);
    }
    if ((held && held.until > checkedAt || removedRuntimes.has(id)) && previous) {
      return;
    }

    let current: ProviderUsage;
    const startSeq = liveUsage.get(id)?.seq ?? 0;

    if (typeof ex.usage !== 'function') {
      current = unsupportedProviderUsage(String(ex.name), checkedAt);
    } else {
      try {
        const pending = Promise.resolve(ex.usage(config as never, deps as never));

        usageRequests.add(pending);

        let response: unknown;

        try {
          response = await pending;
        } finally {
          usageRequests.delete(pending);
        }

        current = normalizeProviderUsage(response, { providerName: String(ex.name), checkedAt });

        if (ex.usagePresentation?.freshness && isRecord(response)
          && typeof response.usageSchema === 'string' && response.usageSchema.length <= 128) {
          current.usageSchema = response.usageSchema;
        }
      } catch {
        if (isCurrent()) {
          fastify.log.warn({ provider: id }, 'usage исполнителя не получен');
        }

        current = normalizeProviderUsage({
          state: 'unavailable',
          message: `Не удалось получить лимиты ${ex.name}. Повторите проверку.`,
        }, { providerName: String(ex.name), checkedAt });
      }
    }

    if (!isCurrent()) {
      return;
    }

    const provisional = mergeProviderUsage(previous, current) as ProviderUsage;
    const vendorStatus = VENDOR_FAULT_USAGE_STATES.has(provisional.state) && ex.statusPage
      ? await statusProbe.read(ex.statusPage) : null;

    if (!isCurrent()) {
      return;
    }

    const latestPrevious = usagePrevious.get(id);

    rememberUsageBackoff(id, current, checkedAt);

    const merged = withPauseUntil(id, mergeProviderUsage(latestPrevious,
      markFreshBuckets(id, current)) as ProviderUsage);

    if (ex.usagePresentation?.freshness) {
      const succeeded = current.state === 'ok' && !current.stale
        && (current.bars.length > 0 || current.resources.length > 0);

      merged.lastSuccessfulAt = succeeded
        ? current.dataCheckedAt : latestPrevious?.lastSuccessfulAt ?? null;
      merged.runtimeGeneration = `${usageBootId}:${generation}`;
      merged.pollIntervalMs = usageTickMs;
      merged.usageSchema = current.usageSchema ?? latestPrevious?.usageSchema ?? '1';
    }

    const result = vendorStatus ? { ...merged, vendorStatus } : merged;

    usagePrevious.set(id, result);

    const live = liveUsage.get(id);

    if (current.state === 'ok' && live) {
      liveUsage.set(id, settlePoll(live, startSeq));
    }
  }

  const initialUsagePrefs = prefs?.read();
  let usagePolicyRevision = Number(initialUsagePrefs?.providerUsagePolicyRevision ?? 0);
  const usagePoller = createProviderUsagePoller(
    pollProviderUsage,
    initialUsagePrefs?.providerUsageAutoRefresh === true,
  );

  /**
   * Полная карта содержит все уже известные снимки, не подделывая неизмеренные квоты.
   * Одинаковая проекция используется HTTP, ручным ответом и существующим SSE-потоком.
   */
  function usageSnapshot() {
    return {
      usage: projectUsageMap(Object.fromEntries(usagePrevious)),
      autoRefresh: usagePoller.isEnabled(),
      autoRefreshRevision: usagePolicyRevision,
    };
  }

  /**
   * Политика и снимки доставляются одним событием всем подключённым окнам.
   * После остановки никакое завершение старого чтения больше не публикуется.
   */
  function publishUsage(): void {
    if (!usageAbort.signal.aborted) {
      fastify.sse?.broadcast?.('providers-usage', usageSnapshot());
    }
  }

  /**
   * Выключение сохраняет видимые проценты без продвижения даты измерения.
   * Включение планирует сбор отдельно: сохранённая настройка не зависит от сети.
   */
  function syncProvidersUsagePolicy(enabled: boolean, revision: number): void {
    usagePolicyRevision = revision;

    if (enabled === usagePoller.isEnabled()) {
      return;
    }
    if (!enabled) {
      const frozen = usageSnapshot().usage;

      for (const [id, entry] of Object.entries(frozen)) {
        usagePrevious.set(id, entry);
      }

      liveUsage.clear();
    }

    usagePoller.setEnabled(enabled);
    publishUsage();

    if (enabled) {
      void refreshUsageIfStale().catch((err: unknown) => {
        fastify.log.warn({ err }, 'не удалось возобновить автоматическое чтение квот');
      });
    }
  }

  fastify.decorate('syncProvidersUsagePolicy', syncProvidersUsagePolicy);

  /**
   * Обычное чтение при выключении обслуживается только сохранённым снимком.
   * Разрешённый автоопрос делит работу по аккаунтам, сохраняя полный HTTP-контракт.
   */
  async function readUsage(minAgeMs: number): Promise<void> {
    if (!usagePoller.isEnabled() || usageAbort.signal.aborted) {
      return;
    }

    usageProviderIds = [...(await adaptersOf()).keys()];
    await Promise.all(usageProviderIds.map((id) => usagePoller.poll(id, 'automatic', minAgeMs)));
  }

  /**
   * Смена файлов CLI не меняет аккаунтный Retry-After и не запускает внеочередной poll.
   * Сохранённые цифры становятся stale; старое поколение HTTP/live больше не публикуется.
   */
  async function invalidateProviderRuntime(id: string, options: { removed?: boolean } = {}) {
    const adapter = (await adaptersOf()).get(id);

    registryCache.clear();
    installationChecks.delete(id);

    if (!adapter?.usagePresentation?.freshness) {
      return false;
    }

    retainRuntimeUsage(adapter, options.removed === true);

    usagePoller.invalidate(id, true);
    publishUsage();

    return true;
  }

  fastify.decorate('invalidateProviderRuntime', invalidateProviderRuntime);

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
   * Обновление остаётся ручным; новые метаданные не убирают прежние карточки на время сбора.
   */
  async function checkUpdates() {
    const executors = await adaptersOf();
    let changed = false;

    for (const ex of executors.values()) {
      if (ex.distribution?.(config)?.managed === true) {
        changed = updates.delete(ex.id) || changed;

        continue;
      }

      if (typeof ex.latestVersion !== 'function') continue;
      let latest = '';
      try { latest = String(await ex.latestVersion(config) || ''); } catch { latest = ''; }
      // Сеть молчит — свежая версия CLI сравнивается с последней известной: иначе после
      // установки индикатор «устарел» висел бы до следующего удачного ответа реестра.
      latest ||= updates.get(ex.id)?.latest || '';
      if (!latest) continue;
      const current = (await ex.probe(config))?.version || '';
      const outdated = isOutdated(current, latest);
      const prev = updates.get(ex.id);
      if (prev?.latest !== latest || prev?.outdated !== outdated) changed = true;
      updates.set(ex.id, { latest, outdated, current, at: Date.now() });
      if (outdated) fastify.log.info({ provider: ex.id, current, latest }, 'доступно обновление CLI (обновление — вручную из настроек)');
    }

    if (changed) {
      registryCache.expire();
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

  fastify.get<{ Querystring: { cached?: string } }>('/api/providers/usage', async (request) => {
    if (request.query.cached !== '1') {
      await readUsage(usageTickMs);
    }

    return usageSnapshot();
  });

  fastify.post<ProviderUsageRefreshRoute>('/api/providers/usage/refresh', async (request, reply) => {
    const id = request.body?.providerId;

    if (typeof id !== 'string' || !id || id.length > 128 || id.trim() !== id) {
      return reply.code(400).send({
        error: 'provider_required',
        message: 'Выберите исполнителя для проверки квоты. Обновите окно приложения.',
      });
    }

    const adapters = await adaptersOf();

    if (!adapters.has(id)) {
      return reply.code(404).send({ error: 'unknown_provider' });
    }

    usageProviderIds = [...adapters.keys()];
    await usagePoller.poll(id, 'manual', USAGE_FORCE_MIN_AGE_MS);
    publishUsage();

    return usageSnapshot();
  });

  /**
   * Общий фоновый вход сохраняет период и запрет автоматического режима.
   * Прогноз использует этот же вход и не получает отдельного разрешения на измерение.
   */
  async function refreshUsageIfStale(): Promise<void> {
    if (!usagePoller.isEnabled() || usageAbort.signal.aborted) {
      return;
    }

    await readUsage(usageTickMs / 2);
    publishUsage();
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

  /**
   * Останавливает не только будущие тики, но и уже запущенные проверки с их cleanup.
   * preClose отменяет HTTP-опрос до ожидания соединений; drain делает это до выхода сервера.
   */
  async function stopUsage(): Promise<void> {
    clearInterval(usageTimer);
    usagePoller.stop();
    usageAbort.abort();
    await Promise.allSettled([...usageRequests]);
  }

  fastify.shutdown?.register('лимиты исполнителей', stopUsage);
  fastify.addHook('preClose', stopUsage);

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
    const ex = (await adaptersOf()).get(String(request.params.id));
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
    if (r?.ok) {
      liveUsage.delete(ex.id);
      usagePoller.invalidate(ex.id);
    } else {
      fastify.log.warn({
        provider: ex.id,
        action: request.params.actionId,
        err: r?.error,
      }, 'действие usage не выполнено');
    }

    return r;
  });

  fastify.get<ProvidersListRoute>('/api/providers', async (request, reply) => {
    const force = request.query?.refresh === '1';
    // Отправка ждёт общий готовый каталог без повторного discovery и сброса кэша.
    const wait = request.query?.wait === '1';
    // Старые версии моделей приходят всегда (с `legacy: true`), а показывать ли их —
    // решает настройка: тумблер в UI не должен ходить за новым списком на сервер.
    const showAllModels = !!prefs?.read().showAllModels;

    if (force) {
      await modelsOf(config, { refresh: true }); // пересобрать каталог моделей
      registryCache.clear();
    }

    return readRegistry((providers) => reply.send({ providers, showAllModels }), !force && !wait);
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
      usageGenerations.set(id, (usageGenerations.get(id) ?? 0) + 1);
      liveUsage.delete(id);
      usagePoller.invalidate(id);
      usageBackoff.delete(id);
      usagePrevious.delete(id);
    },
    refreshModels: () => modelsOf(config, { refresh: true }),
  });

  accessProfiles.activityChanged = (id) => {
    fastify.sse?.broadcast?.('access-profiles', { provider: id });
  };

  accessProfiles.changed = (id, options) => {
    if (options?.metadataOnly) {
      // Имя и удаление неактивного профиля не меняют действующий доступ.
      // Сохраняем карточки на время проб и не отзываем модели или статистику аккаунта.
      registryCache.expire();
      fastify.sse?.broadcast?.('providers-update', { metadata: id });
      fastify.sse?.broadcast?.('access-profiles', { provider: id });

      return;
    }

    invalidateModelsRegistry(config.modelsPath);
    registryCache.clear();
    usageGenerations.set(id, (usageGenerations.get(id) ?? 0) + 1);
    liveUsage.delete(id);
    usagePoller.invalidate(id);
    usageBackoff.delete(id);
    usagePrevious.delete(id);
    fastify.sse?.broadcast?.('providers-update', { credentials: id });
    fastify.sse?.broadcast?.('access-profiles', { provider: id });
  };

  const installationService = new ProviderInstallService({
    ...opts.providerInstall,
    statePath: config.providerInstallStatePath,
    config,
    env: serviceEnv,
    adaptersOf,
    latestOf: (id) => updates.get(id)?.latest,
    refreshModels: () => modelsOf(config, { refresh: true }),
    invalidate: async () => {
      registryCache.clear();
      await checkUpdates().catch(() => null);
    },
    broadcast: (snapshot) => fastify.sse?.broadcast?.('provider-install', snapshot),
    broadcastLifecycle: (snapshot) => fastify.sse?.broadcast?.('provider-install-v2', snapshot),
    invalidateRuntime: async (id, options) => {
      await invalidateProviderRuntime(id, options);
    },
  });

  registerProviderInstallations(fastify, installationService);
}

export default fp(providersModule, { name: 'module-providers' });
