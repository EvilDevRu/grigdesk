// Модуль factory (read-only, M0) — отдаёт состояние конвейера в чистом JSON,
// которого нет у Python-дашборда (там server-rendered HTML). Мутации (ворота/запуск)
// добавятся отдельным этапом через factory-cli.
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STAGES, StageKind } from '../../lib/stages.ts';
import { readInstruction, readActivity, readAgentLive } from '../../lib/factoryCli.ts';
import { taskDiff } from '../../lib/git.ts';
import { refreshRepos } from '../../lib/gitRefresh.ts';
import { loadTriageProfile } from '../../lib/analysis/profile.ts';
import { CAP_CLARIFICATIONS } from '../../lib/analysis/prompt.ts';
import { resolveRoute } from '../../lib/analysis/routePolicy.ts';
import { questionKey } from '../../../../shared/analysisContracts.ts';
import { DISCUSSION_SECTION_TITLE } from '../../lib/telegram/discussion.ts';
import {
  hasSlotReservation, reserveSlot, releaseSlot, slotsOverview, SlotsFullError,
} from '../../lib/sandboxSlots.ts';
import { PROFILE_RE } from '../../lib/profiles.ts';
import { archivedProjectIds } from '../../lib/projects/archive.ts';
import {
  buildTicket, validateTicket, writeTicketFile, TicketError,
} from '../../lib/factoryTicket.ts';
import {
  diagnosisSuggestion,
  FactoryLaunchContractError,
  instrumentationSuggestions,
  loadFactoryLaunchProfile,
  normalizeFactoryLaunchInputs,
  profileMatchingTriage,
  scopeSuggestion,
} from '../../lib/factoryLaunchContract.ts';
import {
  confirmRouteResume, logLength, readLogSince,
  runRouteEngine, spawnRouteEngine, routeUnitActive,
  routeFailure, startRegistryIdentity, stopRouteOrchestrator,
  routeCheckArgs, routeStartArgs, routeResumeArgs, routeAbandonArgs, routeGateArgs, routeGotoArgs,
  routeFindingsArgs,
  routeBootstrapAnswerArgs,
  stageAutoCompactEnv,
} from '../../lib/factoryRouteCli.ts';
import {
  FactoryRunnerControl,
  RunnerControlCommandError,
  RunnerControlInputError,
} from '../../lib/runnerControl.ts';
import { listInstalledRunners } from '../../lib/runnersCatalog.ts';
import { loadRunnerConfig, resolveProjectRunnerState } from '../../lib/runnerState.ts';
import { parseSandboxRepositories } from '../../lib/sandboxEnv.ts';
import { parsePipeline } from '../../lib/pipelineParse.ts';
import { archiveTaskFiles } from '../../lib/taskArtifacts.ts';
import {
  ARBITER_ACTOR,
  arbitrationGate,
  buildArbiterPrompt,
  formatArbiterReason,
  normalizeArbiterSettings,
  parseArbiterDecision,
  readArbitrationContext,
  resolveArbiterTarget,
} from '../../lib/factoryArbiter.ts';
import { resolveModelRef } from '../../lib/chat/modelRef.ts';
import { getExecutor } from '../../lib/executors/index.ts';
import { getModelsRegistry } from '../../lib/modelsRegistry.ts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FactoryStateAdapter } from '../../adapters/factoryState.ts';
import type { ArbiterCardsStore } from '../../lib/arbiterCards.ts';
import type { FactoryArbiterLive } from '../../lib/factoryArbiterLive.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';
import type { RouteConfig } from '../../lib/factoryRouteCli.ts';
import type {
  LaunchConfig,
  NormalizedLaunchInputs,
  TriageAnalysis,
} from '../../lib/factoryLaunchContract.ts';
import type { RouteTicket } from '../../lib/factoryTicket.ts';
import type { ArbiterExecutor, ArbiterRunOutput } from '../../lib/factoryArbiter.ts';
import type { SlotDecision } from '../../lib/sandboxSlots.ts';
import type { CockpitConfig } from '../../config.ts';
import type { RunnerState } from '../../lib/runnerState.ts';

// Проверенные входы запуска: ровно то, что уедет движку после preflight.
interface PreparedLaunch {
  profile: string;
  route: string;
  runnerPrimary: string;
  catalogHash: string;
  launchInputs: NormalizedLaunchInputs;
  ticket: RouteTicket;
}

// Ответ HTTP, собранный до отправки: статус и тело.
interface RouteReply {
  status: number | null;
  body: Record<string, unknown>;
}

// Подготовка сохраняет отказ отдельно от входов, которые уже прошли все проверки.
type StartPreparation = RouteReply | {
  status: null;
  prepared: {
    options: LaunchOptions;
    routePreflight: Extract<PreflightResult, { ok: true }>;
  };
};

// Поля формы проверяет общий preflight перед первым побочным действием.
interface LaunchOptions {
  profile?: string;
  route?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: unknown;
  sourceUrl?: string;
  reuseTicket?: boolean;
  runnerPrimary?: string;
  expectedCatalogHash?: string;
  deliveryTargets?: unknown[];
  instrumentationFiles?: unknown[];
  diagnosisKind?: string;
  diagnosisSignal?: string;
}

type HumanComment = { ok: true; value: string } | { ok: false; message: string };

// Вотчер пользуется тем же отказом, что HTTP, но ему не нужен полный FastifyReply.
interface RejectionReply {
  code(status: number): { send(body: Record<string, unknown>): unknown };
}

type SandboxDownResult =
  | { ok: true; output: string }
  | { ok: false; message: string };

// Итог preflight: либо готовый отказ для HTTP, либо проверенные входы запуска.
type PreflightResult =
  | { ok: false; result: RouteReply }
  | { ok: true; value: PreparedLaunch };

// Что инспектор знает о запуске задачи прямо сейчас.
interface LaunchInspection {
  kind: string;
  identity: Record<string, unknown> | null;
  origin: string | null;
}

// Маршруты фабрики адресуются номером задачи, именем профиля, узла или решения —
// все параметры приходят строками, тело и строка запроса недоверенные.
interface FactoryRoute {
  Params: Record<string, string>;
  Querystring: Record<string, string | undefined>;
  Body: Record<string, unknown>;
}

// Реестр задачи — плоская провайдерская проекция `tNNNN.pipeline`.
type Registry = Record<string, string>;

// Соседи, которых модуль получает сборкой приложения. Их полные контракты живут
// в своих файлах; здесь перечислено ровно то, что использует раздел.
interface B24Port {
  accountIdentity: () => Promise<{ baseUrl?: unknown; userId?: unknown } | null>;
  taskPageData: (id: string) => Promise<{ comments?: unknown }>;
}

interface AnalyzerPort {
  readClarifications: (id: string) => Promise<string | null>;
  readOpenQuestions: (id: string) => Promise<{ questions: string[]; unknowns: string[] } | null>;
  // Что по задаче уже решено: идентификаторы вопросов и ключи их текстов. Второй ключ
  // обязателен — заход триажа переписывает вопросы, и по одному id ответ теряется.
  answeredQuestions?: (id: string) => Promise<{ ids: Set<string>; keys: Set<string> }>;
  get?: (id: string) => Promise<{
    analysis: (TriageAnalysis & {
      route_catalog_hash?: string;
      route_guess?: string | null;
      route_depth?: string | null;
      route_reason?: string | null;
    }) | null;
  }>;
}

// Серверный config в объёме, который читает раздел: контракты движка запуска и
// маршрута плюс собственные каталоги. Полная его форма объявлена в config.ts.
type FactoryModuleConfig = RouteConfig & LaunchConfig & Pick<
  CockpitConfig, 'ticketsDir' | 'modelsPath' | 'factoryProfile' | 'sandboxDownCmd'
> & {
  factoryStandsDir?: string;
};

export interface FactoryModuleOptions {
  factoryState: FactoryStateAdapter;
  config: FactoryModuleConfig;
  prefs: PrefsStore;
  b24?: B24Port | null;
  analyzer: AnalyzerPort;
  internalToken?: string;
  arbiterCards?: ArbiterCardsStore | null;
  arbiterLive?: FactoryArbiterLive | null;
  // Подмена инспектора очереди в тестах: та же форма ответа, что у собственного.
  inspectLaunchState?: (id: string) => Promise<LaunchInspection>;
}

const RUNNER_PRIMARY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
// Лимит хода арбитра. `executor.run` своего таймаута не имеет by design — в чате его
// считает watchdog, который знает, что агент ждёт ответа человека. Арбитр человека не
// ждёт вовсе, поэтому лимит здесь простой и жёсткий.
//
// Десяти минут оказалось мало на реальной остановке (замер 28.08.2026, задача с
// перф-регрессией в чужой библиотеке): арбитр честно прочитал отчёт, диагностику и
// исходники — 34 команды, — и был оборван на десятой минуте, не дав ничего. Худший из
// возможных исходов: время живого агента потрачено, конвейер стоит, задача ушла в
// часовой cooldown. Двадцать минут против часов человеческого ожидания дёшевы, а
// главная защита от бесконечного чтения теперь не резак, а объявленный агенту бюджет
// (`budgetMin` в промпте): знающий свой лимит начинает формулировать заранее.
const ARBITER_TURN_LIMIT_MIN = 20;
const ARBITER_TURN_LIMIT_MS = ARBITER_TURN_LIMIT_MIN * 60 * 1000;

const registryIsMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === 'ENOENT';

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

function errorStepCount(error: unknown): number | null {
  const steps = (error as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps) ? steps.length : null;
}

/**
 * Адаптер сам собирает runner из resolveRunnerState. Здесь сужается только эта часть
 * открытого nodeMeta, остальные поля схемы принадлежат соседним читателям.
 */
function graphRunner(
  graph: Awaited<ReturnType<FactoryStateAdapter['getTaskGraph']>>,
  nodeId: string | undefined,
): RunnerState | null {
  const runner = nodeId ? graph.nodeMeta?.[nodeId]?.runner : null;
  return (runner as RunnerState | null | undefined) ?? null;
}

/**
 * Общий реестр динамически импортирует исполнителей. После проверки наличия run
 * арбитр использует узкий контракт одного читающего хода и сохраняет объект адаптера.
 */
async function arbiterExecutor(provider: string): Promise<ArbiterExecutor | null> {
  const executor = await getExecutor(provider);
  if (!executor || typeof executor.run !== 'function') {
    return null;
  }
  return executor as ArbiterExecutor;
}

// Потолок человеческого текста, уезжающего в журнал попытки и в промпт агента. Тот же
// предел стоит в движке (`_attempt_state_reason`): причина едет аргументом execFile и
// переменной окружения, обе упираются в MAX_ARG_STRLEN 128 КБ, а 20 000 символов
// кириллицы в UTF-8 — 40 КБ, то есть с троекратным запасом.
const HUMAN_COMMENT_LIMIT = 20000;

// Замечание человека — это ТЕКСТ ЗАДАНИЯ следующему агенту, а не подпись к клику.
// Прежние `.replace(/\n/g,' ').slice(0,500)` резали разбор на первом же абзаце, причём
// молча: человек видел «принято», а до узла доезжал обрубок. Теперь сохраняем разметку
// (переводы строки), убираем только то, что действительно ломает журнал: CR из CRLF
// браузерной textarea и прочие управляющие символы. Переполнение — отказ, а не тихая
// обрезка: пусть человек сам решит, что сокращать.
function humanComment(raw: unknown, { fallback = '' }: { fallback?: string } = {}): HumanComment {
  const text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
  if (!text) return { ok: true, value: fallback };
  if (text.length > HUMAN_COMMENT_LIMIT) {
    return {
      ok: false,
      message: `комментарий ${text.length} символов, предел ${HUMAN_COMMENT_LIMIT}: развёрнутый разбор кладётся в файл, в комментарий идёт ссылка на него`,
    };
  }
  return { ok: true, value: text };
}

// Проекция runner.actual хранит последнего исполнителя этапа и после stop, поэтому
// сама по себе не означает живой процесс. Для live-switch нужны одновременно живой
// оркестратор и активный именно этот этап; остановленному этапу разрешаем stage override,
// который подхватит следующий resume.
function runnerStageIsLive(
  graph: { daemonAlive?: unknown; statuses?: Record<string, string> } | null | undefined,
  registry: Registry | null | undefined,
  nodeId: string,
  stage: string,
) {
  if (!graph?.daemonAlive) return false;
  return graph.statuses?.[nodeId] === 'run' || Boolean(registry?.[`ACTIVE_RUN_${stage}`]);
}

async function factoryModule(
  fastify: FastifyInstance,
  opts: FactoryModuleOptions,
): Promise<void> {
  const {
    factoryState, config, prefs, b24, analyzer, internalToken = '', arbiterCards = null,
    arbiterLive = null,
  } = opts;
  const cfg = { factoryHome: config.factoryHome, stateDir: config.stateDir };
  const runnerControl = new FactoryRunnerControl({
    factoryBin: config.factoryBin,
    stateDir: config.stateDir,
    configRoot: config.factoryConfigRoot,
    profilesDir: config.profilesDir,
  });
  // Все start одной задачи проходят через один promise-tail.
  // Detached engine может не успеть опубликовать trusted identity до ответа HTTP, поэтому
  // одного хвоста недостаточно: для такого bootstrap сохраняем process-local fail-closed
  // marker. Следующий start разрешается только после появления проверяемого прогона.
  const taskLaunchTails = new Map<string, Promise<void>>();
  const taskLaunchPending = new Map<string, { startedAt: number }>();
  async function withTaskLaunchLock<Value>(task: unknown, operation: () => Promise<Value>) {
    const key = String(task);
    const previous: Promise<unknown> = taskLaunchTails.get(key) || Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    taskLaunchTails.set(key, tail);
    await previous.catch(() => {});
    try { return await operation(); }
    finally {
      release();
      if (taskLaunchTails.get(key) === tail) taskLaunchTails.delete(key);
    }
  }

  const hasRouteProjectionIdentity = (registry: Registry | null | undefined) => (
    typeof factoryState.hasRouteProjectionIdentity === 'function'
      ? factoryState.hasRouteProjectionIdentity(registry)
      : Boolean(registry?.CATALOG_PROTOCOL === 'route-v2'
        && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(registry.PROFILE || '')
        && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(registry.ROUTE || '')
        && /^a_[a-f0-9]{32}$/.test(registry.ATTEMPT_ID || '')
        && /^[a-f0-9]{64}$/.test(registry.ROUTE_HASH || ''))
  );

  // Заголовок нужен списку конвейеров независимо от трекера. Каждый route-запуск
  // уже имеет валидный тикет в server-owned хранилище, поэтому ручные задачи без
  // Bitrix не должны навсегда оставаться с «загрузка названия…». Полный description
  // в список не кладём: один тикет может занимать до 256 КиБ.
  const storedTicketTitle = async (task: unknown) => {
    const id = String(task ?? '');
    if (!/^[1-9][0-9]{0,18}$/.test(id) || !config.ticketsDir) return null;
    try {
      const file = path.join(config.ticketsDir, `t${id}.ticket.json`);
      const ticket = validateTicket(JSON.parse(await fs.readFile(file, 'utf8')), id);
      return ticket.title;
    } catch {
      // У исторического реестра тикета может не быть. Это не делает сам реестр
      // нечитаемым: UI по-прежнему попробует получить название из Bitrix.
      return null;
    }
  };

  // Historical registry files remain readable, but never reach an executable, a
  // lifecycle script or a writer. Every mutation calls this guard first.
  const managedRegistry = async (id: string, reply: RejectionReply) => {
    let registry: Registry;
    try { ({ registry } = await factoryState.readRegistry(id)); }
    catch (err) {
      if (registryIsMissing(err)) {
        reply.code(404).send({ error: 'not_found', message: 'Прогон задачи не найден.' });
      } else {
        reply.code(409).send({
          error: 'attempt_integrity_failed',
          message: 'Реестр прогона недоступен; lifecycle mutation запрещена.',
        });
      }
      return null;
    }
    if (!hasRouteProjectionIdentity(registry)) {
      reply.code(409).send({
        error: 'legacy_task_read_only',
        message: 'Старый реестр доступен только для просмотра и не может быть запущен или продолжен.',
      });
      return null;
    }
    if (typeof factoryState.readTrustedAttempt !== 'function') {
      reply.code(409).send({
        error: 'attempt_integrity_failed',
        message: 'Trusted control ledger недоступен; lifecycle mutation запрещена.',
      });
      return null;
    }
    try {
      const trusted = await factoryState.readTrustedAttempt(id, registry);
      // Поле подтверждено ledger-reader, но его исторический тип ещё допускает отсутствие.
      if (typeof trusted.profile !== 'string') {
        throw new Error('trusted attempt не содержит профиль');
      }
      return { registry, trusted: { ...trusted, profile: trusted.profile } };
    } catch (err) {
      reply.code(409).send({
        error: 'attempt_integrity_failed',
        message: `Проекция прогона не совпадает с trusted control ledger: ${errorMessage(err)}`,
      });
      return null;
    }
  };

  // Destructive stand/checkout lifecycle additionally requires an exact env projection.
  // WORKSPACE_MODE, STAND_OWNERSHIP and repo paths never come from provider-writable env.
  const managedLifecycle = async (id: string, reply: FastifyReply) => {
    const managed = await managedRegistry(id, reply);
    if (!managed) return null;
    const env = await factoryState.readEnv(id);

    // Подъём, упавший до записи t<номер>.env, оставляет проекцию ПУСТОЙ — сверять с
    // контрактом нечего. Отказ здесь запирал ровно тот случай, ради которого сделаны
    // «перезапустить стенд» и «закрыть задачу»: половинчатую песочницу не убирал ни один
    // путь интерфейса. Пути сноса и решение о нём берутся из trusted-контракта, а не из
    // env, поэтому пустую проекцию пропускаем; непустая проверяется как раньше.
    const envProjected = Object.keys(env || {}).length > 0;

    try {
      if (typeof factoryState.verifyTrustedEnvironment !== 'function') {
        throw new Error('trusted environment verifier недоступен');
      }
      if (envProjected) {
        factoryState.verifyTrustedEnvironment(managed.trusted, env);
      }
    } catch (err) {
      reply.code(409).send({
        error: 'attempt_integrity_failed',
        message: `Env прогона не совпадает с immutable profile contract: ${errorMessage(err)}`,
      });
      return null;
    }
    const sandbox = {
      kind: 'generic',
      workspaceMode: managed.trusted.workspaceMode,
      repos: managed.trusted.repositories.map((repo) => ({
        name: repo.name,
        path: repo.workspace,
        branch: repo.branch,
      })),
    };
    return { ...managed, env, sandbox };
  };

  // Список всех задач с картой статусов этапов.
  fastify.get<FactoryRoute>('/api/tasks', async () => {
    const tasks = await factoryState.listTasks();
    const titledTasks = await Promise.all(tasks.map(async (task) => ({
      ...task,
      title: await storedTicketTitle(task.task),
      // Пока идёт разбор, задача снаружи выглядит вставшей: тот же затык, та же кнопка.
      // Без этого признака человек берётся за неё руками параллельно с арбитром.
      arbitrating: arbiterLive?.read(task.task) || null,
    })));
    // Порог молчания едет вместе со списком: «этот ход завис» обязаны считать одинаково
    // чип в навигации, оповещение и карточка задачи, а хранится он в настройках.
    return { tasks: titledTasks, silenceWindow: Math.max(0, Number(prefs.read().runSilenceWindow) || 0) };
  });

  // Деталь одной задачи: реестр + карта этапов + таймлайн.
  fastify.get<FactoryRoute>('/api/tasks/:id', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      return await factoryState.getTaskDetail(id);
    } catch (err) {
      return reply.code(404).send({ error: 'not_found', message: errorMessage(err) });
    }
  });

  // Документ этапа — человеку у ворот: план (утверждение), разведнота, диагноз,
  // шип-инструкция, отчёт браузерной проверки. Без него решение по воротам слепое.
  // `audit` — досье к приёмке, `review` — отчёт независимого ревью: второй
  // писался с первого дня, но в этом списке его не было, то есть открыть его
  // было нечем ни на одном узле.
  const STAGE_DOCS: Record<string, string> = {
    plan: 'plan.md',
    recon: 'recon.md',
    diag: 'diag.md',
    ship: 'ship.md',
    report: 'report.md',
    audit: 'audit.md',
    review: 'review.md',
  };
  /**
   * Файл отчёта исполнителя. У обычного маршрута — прежний `t<id>.report.md`. В режиме
   * «цикл» отчёт свой на каждый визит исполнителя, и движок называет в реестре последний
   * сданный (`LOOP_REPORT`): его и читают ворота приёмки. Общий `report.md` в цикле —
   * чужой, от прошлой попытки или маршрута, поэтому показать его вместо отчёта цикла
   * нельзя: нет сданного отчёта — пустой текст. Реестр без `LOOP_REPORT` писал движок
   * до пофайловых визитов — тогда отчёт круга `LOOP_ROUND`.
   */
  async function reportDocFile(dir: string, id: string): Promise<string | null> {
    let registry: Record<string, string> = {};
    try {
      registry = parsePipeline(await fs.readFile(path.join(dir, `t${id}.pipeline`), 'utf8'));
    } catch {
      return `t${id}.report.md`;
    }
    if (registry.LOOP_MODE !== '1') return `t${id}.report.md`;
    if (Object.hasOwn(registry, 'LOOP_REPORT')) {
      const named = registry.LOOP_REPORT || '';
      const valid = new RegExp(`^t${id}\\.report\\.r\\d{1,3}(?:\\.v\\d{1,4})?\\.md$`);
      return valid.test(named) ? named : null;
    }
    const round = registry.LOOP_ROUND || '';
    return /^\d{1,3}$/.test(round) ? `t${id}.report.r${round}.md` : null;
  }

  fastify.get<FactoryRoute>('/api/tasks/:id/doc/:name', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const name = String(request.params.name);
    const file = STAGE_DOCS[name];
    if (!id || !file) return reply.code(400).send({ error: 'bad_doc' });
    try {
      const dir = await factoryState.taskStateDir(id);
      const target = name === 'report' ? await reportDocFile(dir, id) : `t${id}.${file}`;
      if (!target) return { text: '' };
      return { text: await fs.readFile(path.join(dir, target), 'utf8') };
    } catch { return { text: '' }; }
  });

  // Список на приёмке читает exact immutable источники, а не устаревающий tN.deferred.md.
  // Ошибка чтения видима клиенту и не становится законным пустым списком.
  fastify.get<FactoryRoute>('/api/tasks/:id/findings', async (request, reply) => {
    const id = request.params.id || '';

    if (!/^[1-9][0-9]{0,18}$/.test(id)) {
      return reply.code(400).send({ error: 'bad_task' });
    }

    const managed = await managedRegistry(id, reply);

    if (!managed) {
      return reply;
    }

    const { trusted } = managed;

    if (request.query.profile !== trusted.profile || request.query.attempt !== trusted.attempt) {
      return reply.code(409).send({
        error: 'attempt_changed',
        message: 'Попытка изменилась — обнови карточку.',
      });
    }

    const exported = await runRouteEngine(config, routeFindingsArgs(config, {
      task: id,
      profile: trusted.profile,
      attempt: trusted.attempt,
    }));

    if (!exported.ok) {
      return reply.code(409).send({ error: 'findings_unavailable', message: exported.message });
    }

    try {
      const value = JSON.parse(exported.stdout);

      if (value.taskId !== id || value.profile !== trusted.profile || value.attemptId !== trusted.attempt
          || !Array.isArray(value.findings?.deferred)) {
        throw new Error('Движок вернул список другой попытки или неверную форму.');
      }

      return value;
    } catch (error) {
      return reply.code(409).send({ error: 'findings_unavailable', message: errorMessage(error) });
    }
  });

  // Воркдиры задачи — для кнопки «Открыть в VS Code». Исторический BE/FE env здесь
  // можно только прочитать; actionable пути (чат/lifecycle) требуют generic REPO_*.
  fastify.get<FactoryRoute>('/api/tasks/:id/workspace', async (request) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const env = id ? await factoryState.readEnv(id) : {};
    const parsed = parseSandboxRepositories(env, { allowLegacy: true });
    return { repos: parsed.repos, workspaceMode: parsed.workspaceMode, readOnly: parsed.kind === 'legacy' };
  });

  // Диф задачи (несохранённые изменения всех worktree) — для приёмки.
  fastify.get<FactoryRoute>('/api/tasks/:id/diff', async (request) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const env = id ? await factoryState.readEnv(id) : {};
    const repos: Array<Record<string, unknown>> = [];
    for (const repo of parseSandboxRepositories(env, { allowLegacy: true }).repos) {
      try { repos.push({ ...repo, ...(await taskDiff(repo.path)) }); }
      catch (e) { repos.push({ ...repo, error: errorMessage(e), stat: '', files: [] }); }
    }
    return { repos };
  });

  // Глобальный каталог стадий (enum) — для будущего редактора профилей.
  fastify.get<FactoryRoute>('/api/factory/stages', async () => ({ kinds: StageKind, stages: STAGES }));

  // Установленные исполнители (адаптеры движка) — для формы запуска и модалки этапа.
  fastify.get<FactoryRoute>('/api/factory/runners', async () => ({
    runners: await listInstalledRunners(config),
  }));

  // Правило кокпита: isolated-конвейер стартует со свежего кода (worktree задачи
  // форкается от локального master). Безопасно: ff-only и только чистый master;
  // сбой обновления запуск не блокирует — фиксируется в ответе.
  async function maybeRefreshRepos(id: string, profile: string) {
    if (!prefs?.read().gitRefreshBeforeRun) return null;
    try {
      const triageProfile = await loadTriageProfile(config, profile);
      const gitRefresh = await refreshRepos(triageProfile.repos);
      fastify.log.info({ task: id, gitRefresh }, 'репозитории обновлены перед конвейером');
      return gitRefresh;
    } catch (e) {
      fastify.log.warn(
        { task: id, err: errorMessage(e) },
        'обновление репозиториев перед конвейером не удалось',
      );
      return null;
    }
  }

  // Ссылка на задачу в трекере — обязательное поле immutable ticket (движок требует http(s) URL).
  // Берём из настроек портала: своего адреса задачи кокпит не выдумывает.
  async function taskSourceUrl(id: string) {
    if (!b24) return '';
    try {
      const identity = await b24.accountIdentity();
      const base = String(identity?.baseUrl || '').replace(/\/+$/, '');
      if (!base || !identity?.userId) return '';
      return `${base}/company/personal/user/${identity.userId}/tasks/task/view/${id}/`;
    } catch (e) {
      fastify.log.warn({ task: id, err: errorMessage(e) }, 'ссылка на задачу для тикета не получена');
      return '';
    }
  }

  // Контекст, которого нет в описании задачи: локальные уточнения человека и арбитра
  // (в трекер их НЕ публикуем — заказчик видит комментарии) и несистемные комментарии
  // из B24. Без них конвейер стартует слепее триажа и переспрашивает отвеченное.
  // Уточнения режутся тем же пределом, что и в промпте триажа: описание тикета
  // вмещает на порядок больше, а разный объём у двух читателей — разная постановка.
  async function ticketSections(id: string, { profile = null, title = '', description = '' }: {
    profile?: string | null;
    title?: string;
    description?: string;
  } = {}) {
    const sections: Array<{ title: string; text: string }> = [];
    const clarify = await analyzer.readClarifications(id);
    if (clarify) {
      sections.push({
        title: '[Внутренние уточнения триажа — учитывай автора каждой записи; пометки «[приложено фото: /путь]» открывай инструментом Read]',
        text: clarify.slice(0, CAP_CLARIFICATIONS),
      });
    }
    const open = await analyzer.readOpenQuestions(id);
    if (open) {
      const lines: string[] = [];
      if (open.questions.length) {
        lines.push('Открытые вопросы триажа:');
        open.questions.forEach((q: string, i: number) => lines.push(`${i + 1}. ${q}`));
      }
      if (open.unknowns.length) {
        if (lines.length) lines.push('');
        lines.push('Технические неизвестные (проверить по коду при планировании):');
        open.unknowns.forEach((u: string, i: number) => lines.push(`${i + 1}. ${u}`));
      }
      sections.push({
        title: '[Открытые вопросы триажа — начинай с них: отвечай первой секцией плана «## Открытые решения»; закрытые уточнения выше снимают вопрос]',
        text: lines.join('\n').slice(0, 4000),
      });
    }
    if (b24) {
      try {
        const page = await b24.taskPageData(id);
        const comments = (page.comments || []) as Array<{
          isSystem?: unknown;
          text?: unknown;
          author?: unknown;
          time?: unknown;
        }>;
        const comm = comments
          .filter((c) => !c.isSystem && c.text)
          .map((c) => `— ${c.author}${c.time ? ` (${c.time})` : ''}: ${c.text}`)
          .join('\n');
        if (comm) sections.push({ title: '[Комментарии к задаче из трекера]', text: comm });
      } catch (e) {
        fastify.log.warn(
          { task: id, err: errorMessage(e) },
          'комментарии для тикета не получены — конвейер стартует без них',
        );
      }
    }

    // Переписка по телеграм-ссылкам из постановки. Ищем её во ВСЁМ, что уже
    // собрано (заголовок, описание, уточнения, комментарии): ссылку на обсуждение
    // чаще вписывают комментарием в трекере, чем в описание. Дубли схлопывает
    // разбор текста, поэтому одна ссылка в двух местах даст один блок.
    //
    // Проект = профиль прогона: чат, привязанный к соседнему проекту, агенту не
    // показывается — иначе ссылка в описании вытягивала бы чужую переписку.
    // Ссылка на декоратор ленивая: модуль telegram регистрируется позже нас,
    // а выключенный плагин и любой сбой отдают пустоту (см. modules/telegram).
    if (typeof fastify.telegramDiscussion === 'function') {
      const source = [title, description, ...sections.map((s) => s.text)].filter(Boolean).join('\n');
      // Объём ограничен ЗДЕСЬ, а не подрезкой при сборке тикета: секции идут
      // в хвост описания, а `fitDescription` режет с конца — обсуждение
      // обрезалось бы первым и молча.
      const view = await fastify.telegramDiscussion(source, {
        project: profile,
      }) as { text?: string } | null;
      if (view?.text) {
        sections.push({ title: DISCUSSION_SECTION_TITLE, text: view.text });
      }
    }
    return sections;
  }

  /**
   * Рекомендация маршрута с учётом ответов человека.
   *
   * Глубину политика считает в момент триажа, когда вопросы ещё открыты, и записывает
   * в файл оценки. Человек отвечает уже после — и форма запуска продолжала показывать
   * маршрут «с открытыми вопросами», хотя открытых не осталось. Пересчёт идёт ЗДЕСЬ и
   * только для показа и старта: файл оценки — снимок своего захода, и переписывать его
   * ответами нельзя. Отвечать нечем (ответов нет, профиль или каталог недоступны) —
   * возвращаем null, и форма берёт то, что записал триаж.
   */
  async function liveRouteDecision(id: string, profile: string, analysis: any, catalog: any) {
    if (!analysis || typeof analyzer?.answeredQuestions !== 'function') {
      return null;
    }

    let answered;
    try {
      answered = await analyzer.answeredQuestions(id);
    } catch {
      return null;
    }
    const questions = (Array.isArray(analysis.questions) ? analysis.questions : [])
      .filter((question: { id?: string; text?: string }) => (
        question?.id
        && !answered.ids.has(question.id)
        && !answered.keys.has(questionKey(question.text))
      ));
    if (questions.length === (analysis.questions?.length || 0)) {
      return null;
    }

    const triageProfile = await loadTriageProfile(config, profile).catch(() => null);
    const decision = resolveRoute({
      ...analysis,
      questions,
      // Признак «нужно уточнение» держится ровно до последнего открытого вопроса.
      needs_clarification: analysis.needs_clarification === true && questions.length > 0,
    }, { routeMap: triageProfile?.routeMap || '', routes: catalog?.routes || [] });

    return decision.route ? decision : null;
  }

  /**
   * Продолжить route-прогон после ворот, возврата или падения.
   *
   * Само решение (gate/goto) уже записано в журнал попытки, поэтому провал ЗАПУСКА
   * продолжения — не отказ операции, а состояние «записано, но не поехало»: его
   * возвращаем полем, чтобы человек нажал «Продолжить», а не гадал.
   *
   * Регистрации юнита мало: движок держит весь fail-closed преflight (pins, контракт
   * профиля, тикет) в первых секундах и выходит кодом 75/78, а `systemd-run` к тому
   * моменту давно вернул 0. Поэтому запуск ПОДТВЕРЖДАЕМ и причину берём из журнала
   * этапов — только то, что дописано после нашего запуска, без чужих строк.
   */
  async function resumeRouteAttempt(id: string, { profile, attempt, why }: {
    profile: string;
    attempt: string;
    why: string;
  }) {
    const stagesLog = path.join(config.stateDir, 'logs', `t${id}.stages.log`);
    const from = await logLength(stagesLog);
    const launch = await spawnRouteEngine(config, {
      task: id,
      args: routeResumeArgs(config, { task: id, profile, attempt }),
      extraEnv: stageAutoCompactEnv(prefs?.read()),
    });
    if (!launch.ok) {
      fastify.log.warn({ task: id, err: launch.message }, `route resume ${why} не запустился — продолжить вручную`);
      return launch;
    }
    const confirmed = await confirmRouteResume({
      attempt,
      identity: async () => {
        try {
          const { registry } = await factoryState.readRegistry(id);
          return {
            attempt: registry.ATTEMPT_ID || '',
            alive: factoryState.isDaemonAlive(registry.ORCH_PID, id),
          };
        } catch { return null; }
      },
      // Без systemd быстрый выход уже поймал сам spawn (он ждёт код 3 секунды),
      // поэтому здесь остаётся только финальная проверка identity.
      unitAlive: launch.unit ? () => routeUnitActive(id) : async () => true,
      reason: () => readLogSince(stagesLog, from),
    });
    if (!confirmed.ok) {
      const failure = routeFailure(confirmed.message);
      fastify.log.warn(
        { task: id, outcome: confirmed.outcome, err: confirmed.message },
        `route resume ${why} не поднялся — прогон стоит`,
      );
      return {
        ...launch,
        ok: false,
        message: failure?.message || confirmed.message,
        failure,
      };
    }
    return { ...launch, ok: true };
  }

  /**
   * Общий side-effect-free preflight ручного запуска и enqueue. Он ничего не пишет,
   * не обновляет git, не резервирует слот и не создаёт attempt. Queue-вариант собирает
   * только базовый тикет: уточнения/комментарии/Telegram намеренно перечитываются при dispatch.
   */
  async function preflightRoutePipeline(id: string, {
    profile, route, title, description, acceptanceCriteria, sourceUrl, reuseTicket = false,
    runnerPrimary = '', expectedCatalogHash = '',
    deliveryTargets = [], instrumentationFiles = [], diagnosisKind = '', diagnosisSignal = '',
  }: LaunchOptions = {}, { dynamicSections = true }: {
    dynamicSections?: boolean;
  } = {}): Promise<PreflightResult> {
    const wanted = String(route || 'feature');
    const expected = String(expectedCatalogHash || '');
    if (expected && !/^[a-f0-9]{64}$/.test(expected)) {
      return {
        ok: false,
        result: { status: 400, body: { error: 'bad_launch_payload', message: 'expectedCatalogHash должен быть sha256' } },
      };
    }
    const catalog = await factoryState.catalog(profile);
    if (!catalog || profile === undefined) {
      return {
        ok: false,
        result: {
          status: 409,
          body: { error: 'no_catalog', message: 'каталог маршрутов профиля не опубликован или повреждён' },
        },
      };
    }
    if (!catalog.routes.includes(wanted)) {
      return {
        ok: false,
        result: {
          status: 409,
          body: { error: 'route_not_published', message: `маршрут ${wanted} отсутствует в опубликованном каталоге` },
        },
      };
    }
    if (expected && catalog.catalogHash !== expected) {
      return {
        ok: false,
        result: {
          status: 409,
          body: { error: 'catalog_changed', message: 'опубликованный каталог изменился после открытия формы' },
        },
      };
    }
    const pinnedCatalogHash = expected || catalog.catalogHash;
    const check = await runRouteEngine(config, routeCheckArgs(config, {
      profile,
      route: wanted,
      expectedCatalogHash: pinnedCatalogHash,
    }));
    if (!check.ok) {
      const failure = check.failure;
      return {
        ok: false,
        result: {
          status: 409,
          body: failure?.error === 'catalog_changed'
            ? { error: failure.error, message: failure.message }
            : { error: 'route_check_failed', message: check.message || 'профиль или маршрут не приняты движком' },
        },
      };
    }
    const deliveryMode = /\bdelivery=(publish|disabled)\b/.exec(check.stdout)?.[1] || null;
    const instrumentationMode = /\binstrumentation=(explicit|derived|disabled)\b/
      .exec(check.stdout)?.[1] || null;
    if (!deliveryMode || !instrumentationMode) {
      return {
        ok: false,
        result: {
          status: 409,
          body: { error: 'route_check_failed', message: 'движок не подтвердил launch contract маршрута' },
        },
      };
    }
    const catalogDelivery = catalog.routeOptions?.[wanted]?.deliveryMode;
    const catalogInstrumentation = catalog.routeOptions?.[wanted]?.instrumentationMode;
    if (!catalogDelivery || !catalogInstrumentation
        || catalogDelivery !== deliveryMode || catalogInstrumentation !== instrumentationMode) {
      return {
        ok: false,
        result: {
          status: 409,
          body: { error: 'route_check_failed', message: 'опубликованный маршрут и engine check расходятся по launch contract' },
        },
      };
    }

    let launchProfile;
    try {
      launchProfile = await loadFactoryLaunchProfile(config, profile, id);
    } catch (e) {
      return {
        ok: false,
        result: {
          status: 409,
          body: {
            error: 'launch_contract_unavailable',
            message: e instanceof FactoryLaunchContractError
              ? errorMessage(e)
              : 'profile launch contract недоступен',
          },
        },
      };
    }
    let launchInputs;
    try {
      launchInputs = normalizeFactoryLaunchInputs({
        deliveryMode,
        instrumentationMode,
        repositories: launchProfile.repositories,
        deliveryTargets,
        instrumentationFiles,
        diagnosisKind,
        diagnosisSignal,
        profileDeliveryActions: launchProfile.deliveryActions,
      });
    } catch (e) {
      if (e instanceof FactoryLaunchContractError) {
        return {
          ok: false,
          result: { status: 400, body: { error: 'bad_launch_contract', message: errorMessage(e) } },
        };
      }
      throw e;
    }

    const stored = path.join(config.ticketsDir, `t${id}.ticket.json`);
    let built;
    if (reuseTicket) {
      // Перезапуск стенда идёт с ТОЙ ЖЕ постановкой. Пересобирать её нельзя: уточнения
      // и комментарии уже вклеены в описание, и второй проход приклеил бы их повторно.
      try {
        built = validateTicket(JSON.parse(await fs.readFile(stored, 'utf8')), id);
      } catch (e) {
        return {
          ok: false,
          result: {
            status: 409,
            body: {
              error: 'no_ticket',
              message: 'сохранённой постановки нет или она не проходит проверку'
                + ` (${errorMessage(e)}) — запусти задачу кнопкой «на конвейер»`,
            },
          },
        };
      }
    } else {
      try {
        built = buildTicket({
          task: id,
          title,
          description,
          acceptanceCriteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [],
          sourceUrl: sourceUrl || (await taskSourceUrl(id)),
          sections: dynamicSections
            ? await ticketSections(id, { profile, title, description })
            : [],
        });
      } catch (e) {
        if (e instanceof TicketError) {
          return {
            ok: false,
            result: { status: 400, body: { error: 'bad_ticket', message: errorMessage(e) } },
          };
        }
        throw e;
      }
    }

    return {
      ok: true,
      value: {
        profile: String(profile),
        route: wanted,
        runnerPrimary,
        catalogHash: pinnedCatalogHash,
        launchInputs,
        ticket: built,
      },
    };
  }

  /**
   * Старт после общего preflight: только здесь начинаются git/slot/ticket/engine side effects.
   */
  async function startRoutePipeline(
    id: string,
    options: Parameters<typeof preflightRoutePipeline>[1] = {},
    preparedResult: PreflightResult | null = null,
  ): Promise<RouteReply> {
    const prepared = preparedResult
      || await preflightRoutePipeline(id, options, { dynamicSections: true });
    if (!prepared.ok) return prepared.result;
    const {
      profile, route: wanted, runnerPrimary, catalogHash, launchInputs, ticket: built,
    } = prepared.value;
    const gitRefresh = await maybeRefreshRepos(id, profile);

    // Слот стенда резервируем до запуска, чтобы два provisioning не взяли один порт.
    let slot: SlotDecision = { k: null, source: 'none' };
    try {
      slot = await reserveSlot({
        factoryBin: config.factoryBin,
        stateDir: config.stateDir,
        profilesDir: config.profilesDir,
        profile,
        task: id,
      });
    } catch (e) {
      if (e instanceof SlotsFullError) {
        return { status: 409, body: { outcome: 'no_slot', message: errorMessage(e), slots: e.details } };
      }
      throw e;
    }
    const slotInfo = slot.k === null ? null : { k: slot.k, source: slot.source };

    let launch;
    try {
      const ticketFile = await writeTicketFile({ dir: config.ticketsDir, task: id, ticket: built });
      // Именно spawn — первая граница, после которой вызывающий уже не может доказать,
      // появился ли detached engine. До неё ошибки git/slot/ticket безопасно повторяемы.
      taskLaunchPending.set(String(id), { startedAt: Date.now() });
      launch = await spawnRouteEngine(config, {
        task: id,
        args: routeStartArgs(config, {
          task: id,
          profile,
          route: wanted,
          ticketFile,
          runnerPrimary,
          expectedCatalogHash: catalogHash,
          ...launchInputs,
        }),
        extraEnv: {
          ...stageAutoCompactEnv(prefs?.read()),
          ...((slot.k !== null && slot.source !== 'registry') ? { FACTORY_SB_K: String(slot.k) } : {}),
        },
      });
    } catch (err) {
      if (slot.source === 'new') releaseSlot({ stateDir: config.stateDir, task: id });
      throw err;
    }
    if (!launch.ok) {
      if (slot.source === 'new') releaseSlot({ stateDir: config.stateDir, task: id });
      if (launch.failure?.error === 'catalog_changed') {
        return {
          status: 409,
          body: { error: 'catalog_changed', message: launch.failure.message },
        };
      }
      return {
        status: 500,
        body: {
          outcome: 'invalid',
          ...(launch.failure ? {
            error: launch.failure.error,
            runners: launch.failure.runners,
          } : {}),
          message: launch.message || 'прогон не запустился',
        },
      };
    }

    // Одного ORCH_PID недостаточно: движок пишет его в начальную проекцию ДО pin-а
    // attempt/route. Быстрый rc=75/78 раньше успевал выглядеть как «Запущено» — UI
    // видел живой bootstrap PID, хотя через долю секунды юнит уже умер. Подтверждаем
    // полную identity четыре последовательных опроса; это добавляет <1с штатному
    // старту и оставляет быстрый отказ видимым как отказ.
    let launchIdentity = '';
    let launchConfirmations = 0;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => { setTimeout(r, 250); });
      let registry: Registry | null = null;
      try { registry = (await factoryState.readRegistry(id)).registry; } catch { /* реестр ещё пишется */ }
      const identity = startRegistryIdentity(registry, {
        profile,
        route: wanted,
        expectedCatalogHash: catalogHash,
        runnerPrimaryOverride: runnerPrimary,
      });
      if (identity && registry && factoryState.isDaemonAlive(registry.ORCH_PID, id)) {
        if (identity === launchIdentity) launchConfirmations += 1;
        else { launchIdentity = identity; launchConfirmations = 1; }
      } else {
        launchIdentity = '';
        launchConfirmations = 0;
      }
      if (launchConfirmations >= 4 && registry) {
        return {
          status: null,
          body: {
            outcome: 'launched',
            profile,
            route: wanted,
            attempt: registry.ATTEMPT_ID || null,
            identity: {
              dispatchId: registry.QUEUE_DISPATCH_ID || null,
              profile,
              route: wanted,
              catalogHash,
              attempt: registry.ATTEMPT_ID || null,
              runnerPrimaryOverride: registry.RUNNER_OVERRIDE_PRIMARY || '',
            },
            gitRefresh,
            slot: slotInfo,
          },
        };
      }
      if (launch.unit && !(await routeUnitActive(id))) {
        if (slot.source === 'new') releaseSlot({ stateDir: config.stateDir, task: id });
        const tail = await readLogSince(launch.logFile, launch.logOffset, { lines: 10, limit: 2000 });
        const failure = routeFailure(tail);
        if (failure?.error === 'catalog_changed') {
          return {
            status: 409,
            body: { error: 'catalog_changed', message: failure.message },
          };
        }
        return {
          status: 500,
          body: {
            outcome: 'invalid',
            ...(failure ? { error: failure.error, runners: failure.runners } : {}),
            message: failure?.message || `прогон не стартовал — ${tail || `смотри ${launch.logFile}`}`,
          },
        };
      }
    }
    return {
      status: null,
      body: {
        outcome: 'started',
        profile,
        route: wanted,
        gitRefresh,
        slot: slotInfo,
        note: 'демон не подтвердил PID за 10с — проверь конвейер',
      },
    };
  }

  function compactLaunchIdentity(trusted: {
    queueDispatchId?: unknown;
    profile?: unknown;
    route?: unknown;
    catalogHash?: unknown;
    attempt?: unknown;
    runnerPrimaryOverride?: unknown;
  } | null | undefined) {
    if (!trusted) return null;
    return {
      dispatchId: trusted.queueDispatchId || null,
      profile: trusted.profile,
      route: trusted.route,
      catalogHash: trusted.catalogHash,
      attempt: trusted.attempt,
      // v1 attempts не хранили override: null честно означает «trusted ledger не знает».
      runnerPrimaryOverride: trusted.runnerPrimaryOverride ?? null,
    };
  }

  function failClosedPendingInspection(id: string, inspection: LaunchInspection): LaunchInspection {
    if (inspection?.kind === 'absent' && taskLaunchPending.has(String(id))) {
      return { kind: 'bootstrap', identity: null, origin: null };
    }
    return inspection;
  }

  /**
   * Exact inspector очереди. Registry без подтверждённого ledger и промежуток между
   * slot reservation/unit registration и полным pin — bootstrap, а не доказательство
   * отсутствия запуска.
   */
  async function inspectLaunchState(id: string): Promise<LaunchInspection> {
    if (typeof opts.inspectLaunchState === 'function') {
      return failClosedPendingInspection(id, await opts.inspectLaunchState(id));
    }
    let registry: Registry | null = null;
    try { registry = (await factoryState.readRegistry(id)).registry; }
    catch (err) {
      if (!registryIsMissing(err)) {
        throw new Error('Реестр запуска временно недоступен; отсутствие прогона не доказано.');
      }
    }
    if (!registry) {
      const reserved = hasSlotReservation({ stateDir: config.stateDir, task: id });
      const unit = reserved ? false : await routeUnitActive(id);
      return failClosedPendingInspection(id, reserved || unit
        ? { kind: 'bootstrap', identity: null, origin: null }
        : { kind: 'absent', identity: null, origin: null });
    }
    if (!hasRouteProjectionIdentity(registry)
        || typeof factoryState.readTrustedAttempt !== 'function') {
      return { kind: 'bootstrap', identity: null, origin: null };
    }
    let trusted;
    try { trusted = await factoryState.readTrustedAttempt(id, registry); }
    catch { return { kind: 'bootstrap', identity: null, origin: null }; }
    const identity = compactLaunchIdentity(trusted);
    if (trusted.terminal) {
      return { kind: 'terminal', identity, origin: trusted.origin || null };
    }
    if (factoryState.isDaemonAlive(registry.ORCH_PID, id)) {
      return { kind: 'active', identity, origin: trusted.origin || null };
    }
    return { kind: 'stopped', identity, origin: trusted.origin || null };
  }

  // Единственная стартовая поверхность. Любой существующий route-run продолжаетcя
  // только через resume; legacy registry не конвертируется в скрытый старый запуск.
  async function prepareStartPipeline(
    id: string,
    opts: Parameters<typeof preflightRoutePipeline>[1] = {},
    { dynamicSections = true }: { dynamicSections?: boolean } = {},
  ): Promise<StartPreparation> {
    const { profile: reqProfile } = opts;
    const profile = reqProfile || config.factoryProfile || (await factoryState.primaryProfile());
    if (!profile) return { status: 400, body: { error: 'no_profile', message: 'профиль конвейера не определён' } };
    const profiles = factoryState.discoverProfiles().filter((name) => PROFILE_RE.test(name));

    // Архивный проект — не «сломанный», а убранный: уже бегущие попытки идут дальше,
    // а новую запускать некуда. Отказ до любых побочных эффектов, как и bad_profile.
    if (archivedProjectIds(prefs).has(profile)) {
      return {
        status: 409,
        body: {
          error: 'archived',
          message: `Проект «${profile}» в архиве: верните его из архива, чтобы запускать конвейер.`,
        },
      };
    }
    if (!PROFILE_RE.test(profile) || !profiles.includes(profile)) {
      return {
        status: 400,
        body: {
          error: 'bad_profile',
          message: 'профиль конвейера не установлен',
          profiles,
        },
      };
    }

    // Явный выбор исполнителя — только из установленных адаптеров движка и только
    // до любых побочных эффектов: проверка дешёвая (каталог *.sh на диске), а отказ
    // обязан прийти до check, слота и transient-юнита. Пусто/отсутствует — по профилю.
    const runnerPrimary = String(opts.runnerPrimary || '');
    if (runnerPrimary) {
      const runners = await listInstalledRunners(config);
      if (!RUNNER_PRIMARY_RE.test(runnerPrimary) || !runners.includes(runnerPrimary)) {
        return {
          status: 400,
          body: {
            error: 'bad_runner',
            message: `исполнитель ${runnerPrimary} не установлен или имя некорректно`,
            runners,
          },
        };
      }
    }

    let reg = null;
    try { reg = (await factoryState.readRegistry(id)).registry; }
    catch (err) {
      if (!registryIsMissing(err)) {
        return {
          status: 409,
          body: {
            error: 'attempt_integrity_failed',
            message: 'Реестр прогона недоступен; новый запуск запрещён до проверки состояния.',
          },
        };
      }
    }
    if (reg) {
      if (!hasRouteProjectionIdentity(reg)) {
        return {
          status: 409,
          body: {
            error: 'legacy_task_read_only',
            message: 'Старый реестр нельзя запускать или resume через текущий движок.',
          },
        };
      }
      if (typeof factoryState.readTrustedAttempt !== 'function') {
        return {
          status: 409,
          body: { error: 'attempt_integrity_failed', message: 'Trusted control ledger недоступен; запуск запрещён.' },
        };
      }
      let trusted;
      try { trusted = await factoryState.readTrustedAttempt(id, reg); }
      catch (err) {
        return {
          status: 409,
          body: {
            error: 'attempt_integrity_failed',
            message: `Проекция прогона не совпадает с trusted control ledger: ${errorMessage(err)}`,
          },
        };
      }
      if (factoryState.isDaemonAlive(reg.ORCH_PID, id)) {
        return {
          status: null,
          body: {
            outcome: 'already_running',
            profile: trusted.profile,
            identity: compactLaunchIdentity(trusted),
          },
        };
      }
      return {
        status: 409,
        body: { error: 'run_exists', message: 'Прогон уже открыт — используй «Продолжить».' },
      };
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'ticket')) {
      return {
        status: 400,
        body: {
          error: 'bad_ticket_shape',
          message: 'Передай title, description, acceptanceCriteria и sourceUrl отдельными полями.',
        },
      };
    }
    const options = { ...opts, profile, runnerPrimary };
    const routePreflight = await preflightRoutePipeline(id, options, { dynamicSections });
    if (!routePreflight.ok) return routePreflight.result;
    return { status: null, prepared: { options, routePreflight } };
  }

  async function startPipeline(
    id: string,
    opts: LaunchOptions = {},
    auth: { dynamicSections?: boolean } = {},
  ): Promise<RouteReply> {
    if (taskLaunchPending.has(String(id))) {
      let inspection = null;
      try { inspection = await inspectLaunchState(id); } catch { /* marker остаётся fail-closed */ }
      if (inspection && ['active', 'stopped', 'terminal'].includes(inspection.kind)) {
        taskLaunchPending.delete(String(id));
      } else {
        return {
          status: 409,
          body: {
            error: 'run_exists',
            message: 'Предыдущий запуск уже передан движку, но его trusted identity ещё не подтверждена.',
          },
        };
      }
    }
    const ready = await prepareStartPipeline(id, opts, auth);
    if (!('prepared' in ready)) return ready;
    const key = String(id);
    let result;
    try {
      result = await startRoutePipeline(id, ready.prepared.options, ready.prepared.routePreflight);
    } catch (err) {
      // Неизвестно, успел ли detached launcher пересечь границу side effect.
      // Marker остаётся до точного proof или явного lifecycle-разрешения человеком.
      throw err;
    }
    const provenVisible = result.status === null && result.body?.outcome === 'launched';
    // `runner_preflight_unavailable` тоже доказан: движок печатает этот маркер в конце
    // ПОЛНОСТЬЮ отработавшего preflight, а создание попытки идёт строго после него —
    // ни attempt, ни реестра, ни занятых ресурсов не появляется (проверено: после такого
    // отказа на диске остаётся только `t<id>.launch.log` с причиной). Без этой ветки
    // маркер висел до перезапуска сервера, и задача запиралась ответом `run_exists`
    // из-за чужого CLI: `inspectLaunchState` видит `absent` и marker снять не может.
    // Соседний `runner_preflight_failed` сюда НЕ входит намеренно — он означает, что
    // сломалась сама проверка, и такого же доказательства за ним нет.
    const provenPreSideEffect = (result.status === 409 && result.body?.outcome === 'no_slot')
      || (result.status === 409 && result.body?.error === 'catalog_changed')
      || (result.status === 500 && result.body?.error === 'runner_preflight_unavailable');
    if (provenVisible || provenPreSideEffect) taskLaunchPending.delete(key);
    return result;
  }

  // Чем заполнять модалку запуска: профиль и маршруты только опубликованного каталога.
  // Отсутствие/повреждение каталога — fail closed, а не выбор другого двигателя.
  fastify.get<FactoryRoute>('/api/tasks/:id/launch-options', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const installedProfiles = factoryState.discoverProfiles().filter((name) => PROFILE_RE.test(name));
    const requested = request.query?.profile;
    if (requested !== undefined
        && (typeof requested !== 'string' || !PROFILE_RE.test(requested)
          || !installedProfiles.includes(requested))) {
      return reply.code(400).send({
        error: 'bad_profile',
        message: 'запрошенный профиль конвейера не установлен',
        profiles: installedProfiles,
      });
    }

    // Архив — решение человека о том, что проектом больше не начинают работу.
    // Форма о нём говорит тем же кодом, что и запуск: иначе выбор архивного
    // профиля выглядел бы рабочим до самого нажатия «Запустить».
    const archivedIds = archivedProjectIds(prefs);
    if (typeof requested === 'string' && archivedIds.has(requested)) {
      return reply.code(409).send({
        error: 'archived',
        message: `Проект «${requested}» в архиве: верните его из архива, чтобы запускать конвейер.`,
      });
    }
    // В обычной форме нет смысла предлагать выключенные профили без опубликованного
    // каталога. Если именно такой профиль выбран по умолчанию, оставляем его первым,
    // чтобы показать fail-closed причину и дать переключиться на реально доступный.
    const catalogEntries = await Promise.all(installedProfiles.map(async (name): Promise<[
      string, Awaited<ReturnType<FactoryStateAdapter['catalog']>>,
    ]> => {
      try { return [name, await factoryState.catalog(name)]; }
      catch { return [name, null]; }
    }));
    const catalogs = new Map(catalogEntries);
    const launchableProfiles = installedProfiles
      .filter((name) => catalogs.get(name) && !archivedIds.has(name));

    // Триаж читается ДО выбора профиля: одним снимком он подсказывает форме и профиль,
    // и маршрут, и файлы инструментации. Разъехавшись, они дают пустое поле scope у
    // explicit-маршрута — то есть форму, которую нечем отправить.
    let analysis = null;
    if (typeof analyzer?.get === 'function') {
      try { analysis = (await analyzer.get(id))?.analysis || null; }
      catch { /* триаж — только подсказка, запуск от него не зависит */ }
    }
    const suggested = requested
      || config.factoryProfile
      || (await profileMatchingTriage(config, id, analysis, launchableProfiles))
      || (await factoryState.primaryProfile());
    // Профиль по умолчанию приходит и от последнего прогона: он мог уйти в архив
    // уже после него. Форме нужен тот, которым можно работать, — иначе она
    // открывается на выборе, который сама же и отклонит.
    const profile = suggested && archivedIds.has(suggested)
      ? (launchableProfiles[0] || '')
      : suggested;
    if (!profile) return reply.code(400).send({ error: 'no_profile', message: 'профиль конвейера не определён' });
    if (!installedProfiles.includes(profile)) {
      return reply.code(400).send({
        error: 'bad_profile',
        message: 'профиль конвейера по умолчанию не установлен',
        profiles: installedProfiles,
      });
    }
    const profiles = catalogs.get(profile)
      ? launchableProfiles
      : [profile, ...launchableProfiles.filter((name) => name !== profile)];

    let registry = null;
    try { registry = (await factoryState.readRegistry(id)).registry; }
    catch (err) {
      if (!registryIsMissing(err)) {
        return reply.code(503).send({
          error: 'attempt_state_unavailable',
          message: 'Состояние прогона временно недоступно; запуск запрещён до успешного чтения.',
        });
      }
    }
    let trusted = null;
    if (registry && hasRouteProjectionIdentity(registry)
        && typeof factoryState.readTrustedAttempt === 'function') {
      try { trusted = await factoryState.readTrustedAttempt(id, registry); } catch { /* read-only */ }
    }
    // Исполнители не зависят от состояния задачи: каталог установленных адаптеров
    // плюс project primary выбранного профиля как дефолт формы.
    const runners = await listInstalledRunners(config);
    const defaultRunner = resolveProjectRunnerState(
      loadRunnerConfig(config.profilesDir, profile),
    ).primary;
    const body = {
      task: id,
      profile,
      profiles,
      runners,
      defaultRunner,
      onConveyor: Boolean(registry),
      running: Boolean(registry && factoryState.isDaemonAlive(registry.ORCH_PID, id)),
      readOnly: Boolean(registry && !trusted),
      routes: [],
      defaultRoute: null,
      routeSuggestion: null,
      catalogHash: null,
      routeOptions: {},
      repositories: [],
      instrumentationSuggestions: [],
      diagnosisSuggestion: { kind: 'functional', signal: '' },
      // Объём из триажа не зависит от каталога: человеку он нужен и при fail-closed профиле
      scopeSuggestion: scopeSuggestion(analysis),
      profileContractError: null,
    };
    if (body.readOnly) {
      return {
        ...body,
        error: hasRouteProjectionIdentity(registry) ? 'attempt_integrity_failed' : 'legacy_task_read_only',
        message: hasRouteProjectionIdentity(registry)
          ? 'Проекция прогона не подтверждена trusted control ledger; start/resume запрещён.'
          : 'Старый реестр доступен только для просмотра; новый start/resume запрещён.',
      };
    }

    const catalog = catalogs.get(profile);
    if (!catalog) {
      return { ...body, error: 'no_catalog', message: 'каталог маршрутов профиля не опубликован — публикует его человек из «Маршрутов»' };
    }
    const routes = catalog.routes;
    let launchProfile = null;
    let profileContractError = null;
    try {
      launchProfile = await loadFactoryLaunchProfile(config, profile, id);
    } catch (e) {
      profileContractError = e instanceof FactoryLaunchContractError
        ? errorMessage(e)
        : 'profile launch contract недоступен';
    }
    const repositories = (launchProfile?.repositories || []).map((repo) => ({
      name: repo.name,
      targetBranch: repo.targetBranch,
    }));
    // Рекомендацию триажа принимаем только от ЭТОГО каталога: маршруты могли быть
    // переопубликованы после оценки, и подсказка на снятый маршрут ведёт в отказ движка.
    // Пересчёт по ответам человека считается уже по текущему каталогу, поэтому
    // протухание проверяем только у записанной оценки.
    const live = await liveRouteDecision(id, profile, analysis, catalog);
    const suggestionIsStale = !live && typeof analysis?.route_catalog_hash === 'string'
      && analysis.route_catalog_hash !== catalog.catalogHash;
    const routeGuess = live?.route || analysis?.route_guess;
    const suggestedRoute = !suggestionIsStale && typeof routeGuess === 'string'
      && routes.includes(routeGuess)
      ? routeGuess
      : null;
    return {
      ...body,
      routes,
      defaultRoute: suggestedRoute || (routes.includes('feature') ? 'feature' : (routes[0] || null)),
      // Почему предложен именно этот маршрут — человек видит основание, а не вердикт.
      routeSuggestion: suggestedRoute
        ? {
          route: suggestedRoute,
          depth: live?.depth || analysis?.route_depth || null,
          reason: live
            ? `${live.reason} — с учётом ответов человека`
            : analysis?.route_reason || '',
        }
        : null,
      catalogHash: catalog.catalogHash,
      routeOptions: Object.fromEntries(routes.map((routeId) => [routeId, {
        deliveryMode: catalog.routeOptions?.[routeId]?.deliveryMode || null,
        instrumentationMode: catalog.routeOptions?.[routeId]?.instrumentationMode || null,
        instrumentationRequired: catalog.routeOptions?.[routeId]?.instrumentationRequired === true,
        title: catalog.routeOptions?.[routeId]?.title || '',
      }])),
      repositories,
      instrumentationSuggestions: instrumentationSuggestions(
        analysis,
        launchProfile?.repositories || [],
      ),
      diagnosisSuggestion: diagnosisSuggestion(analysis),
      profileContractError,
    };
  });

  // Запуск задачи на конвейер (замена входа через хук на mcp__b24__b24_task).
  fastify.post<FactoryRoute>('/api/tasks/:id/launch', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const r = await withTaskLaunchLock(id, () => startPipeline(id, request.body || {}));
    return r.status ? reply.code(r.status).send(r.body) : r.body;
  });

  // Занятость слотов стенда: чем заняты, что зарезервировано, сколько свободно.
  // Нужна человеку, когда запуск отказал с no_slot — иначе непонятно, что освобождать.
  fastify.get<FactoryRoute>('/api/factory/slots', async (request, reply) => {
    const profile = request.query.profile || config.factoryProfile || (await factoryState.primaryProfile());
    if (!profile) return reply.code(400).send({ error: 'no_profile', message: 'профиль конвейера не определён' });
    return slotsOverview({
      factoryBin: config.factoryBin,
      stateDir: config.stateDir,
      profilesDir: config.profilesDir,
      profile,
    });
  });

  // Ответ отдельной разведке — короткий CAS exact stop; запуск остаётся отдельным resume.
  // Ошибка запуска продолжения не может потерять уже принятое решение человека.
  fastify.post<FactoryRoute>('/api/tasks/:id/bootstrap-answer', async (request, reply) => {
    const id = request.params.id || '';
    const body = request.body || {};

    if (!/^[1-9][0-9]{0,18}$/.test(id) || body.phase !== 'bootstrap' || body.node !== 'scout'
        || typeof body.visitId !== 'string' || !/^b_[a-f0-9]{32}$/.test(body.visitId)
        || typeof body.stopHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.stopHash)
        || typeof body.answer !== 'string') {
      return reply.code(400).send({ error: 'bad_bootstrap_answer' });
    }

    const answer = body.answer;

    // Ответ адресует конкретный stop и сохраняет весь введённый текст.
    // Предел считаем по Unicode-символам, как CLI; неподдержанные controls отвергаем.
    if (!answer.trim() || [...answer].length > HUMAN_COMMENT_LIMIT
        || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(answer)) {
      return reply.code(400).send({
        error: 'bad_bootstrap_answer',
        message: `Нужен непустой ответ до ${HUMAN_COMMENT_LIMIT} символов без управляющих знаков.`,
      });
    }

    const managed = await managedRegistry(id, reply);

    if (!managed) {
      return reply;
    }

    const { trusted } = managed;
    const stop = trusted.bootstrapStop;

    if (trusted.terminal || body.profile !== trusted.profile || body.attempt !== trusted.attempt
        || !stop || stop.visitId !== body.visitId || stop.recordHash !== body.stopHash) {
      return reply.code(409).send({
        error: 'bootstrap_visit_changed',
        message: 'Визит изменился — обнови карточку.',
      });
    }

    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-bootstrap-answer-'));

    try {
      const answerFile = path.join(temporary, 'answer.txt');

      await fs.writeFile(answerFile, answer, { mode: 0o600 });

      const recorded = await runRouteEngine(config, routeBootstrapAnswerArgs(config, {
        task: id,
        profile: trusted.profile || '',
        attempt: trusted.attempt,
        visitId: body.visitId,
        stopHash: body.stopHash,
        answerFile,
      }));

      if (!recorded.ok) {
        return reply.code(409).send({ error: 'bootstrap_answer_conflict', message: recorded.message });
      }

      const decision = JSON.parse(recorded.stdout);

      if (decision.kind !== 'decision' || decision.visitId !== body.visitId
          || decision.stopHash !== body.stopHash || decision.taskId !== id
          || decision.attemptId !== trusted.attempt || decision.profile !== trusted.profile
          || decision.answer !== answer || !/^[a-f0-9]{64}$/.test(decision.recordHash)) {
        throw new Error('Движок не подтвердил exact решение.');
      }

      return {
        ok: true,
        outcome: 'recorded',
        decision,
      };
    } catch (error) {
      return reply.code(409).send({ error: 'bootstrap_answer_unconfirmed', message: errorMessage(error) });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  // Ворота: принять/отклонить (+ комментарий агенту при отклонении).
  fastify.post<FactoryRoute>('/api/tasks/:id/gate/:key/:decision', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const key = String(request.params.key).toUpperCase();
    const decision = request.params.decision;
    // Только GATE_*: других ворот у движка нет. DEMO_ASK был исключением, пока демо стояло
    // в цепочке; после удаления этого этапа возвращать ключ некуда.
    if (!id || !key.startsWith('GATE_')) return reply.code(400).send({ error: 'bad_gate' });
    if (decision !== 'approve' && decision !== 'reject') {
      return reply.code(400).send({ error: 'bad_decision' });
    }
    // Решение применяет единственный движок (immutable журнал попытки), а
    // продолжение уезжает в ОТВЯЗАННЫЙ systemd-юнит — он переживает рестарты
    // сервера, а фиксированное имя юнита не даёт двум resume бежать параллельно.
    // --commit-only тут обязателен: без него gate сам ведёт маршрут дальше и
    // висит столько, сколько работает следующий этап. Тогда execFile исчерпывает таймаут:
    // решение уже записано, TERM убивает оркестратор, TESTS
    // остался сиротой, а человек увидел «Command failed» на принятом плане.
    const managed = await managedRegistry(id, reply);
    if (!managed) return reply;
    const { trusted } = managed;
    if (trusted.terminal) {
      return reply.code(409).send({ error: 'attempt_terminal', message: `попытка закрыта (${trusted.terminal})` });
    }
    // CAS ворот в движке принимает решение только для узла, на котором стоит
    // курсор журнала (ready|paused). Реестровая проекция опережает журнал, когда
    // диспетчер встал fail-closed после захода узла: кокпит рисовал ворота, до
    // которых маршрут не дошёл, и клик уезжал в гарантированный отказ 75.
    // Проверяем сами — ответ «что сейчас делать» вместо голого кода движка.
    const gateNode = key.toLowerCase();
    const { cursor } = trusted;
    if (!cursor || cursor.node !== gateNode || !['ready', 'paused'].includes(cursor.state)) {
      return reply.code(409).send({
        error: 'gate_not_current',
        message: cursor
          ? `маршрут не стоит на этих воротах: журнал на узле ${cursor.node} (${cursor.state}) — сначала продолжи или верни прогон`
          : 'маршрут ещё не дошёл до ворот: курсор журнала не инициализирован — решение принять нельзя',
      });
    }
    if ((request.body?.attempt && request.body.attempt !== trusted.attempt)
        || (request.body?.profile && request.body.profile !== trusted.profile)) {
      return reply.code(409).send({
        error: 'attempt_changed',
        message: 'Попытка изменилась — обнови карточку.',
      });
    }
    const attempt = trusted.attempt;
    const value = decision === 'approve' ? 'approved' : 'rejected';
    const sanitized = humanComment((request.body || {}).comment);
    if (!sanitized.ok) {
      return reply.code(400).send({ error: 'comment_too_long', message: sanitized.message });
    }
    const comment = sanitized.value;
    const committed = await runRouteEngine(config, routeGateArgs(config, {
      task: id,
      profile: trusted.profile,
      attempt,
      node: gateNode,
      decision: value,
      comment,
    }));
    if (!committed.ok) {
      return reply.code(409).send({ error: 'gate_rejected', message: committed.message });
    }
    const resumed = await resumeRouteAttempt(id, { profile: trusted.profile, attempt, why: 'после ворот' });
    return {
      ok: true,
      key,
      value,
      resumed: resumed.ok,
      resumeError: resumed.message || null,
      resumeFailure: resumed.failure || null,
    };
  });

  // Доверенный человеческий возврат курсора. Произвольная запись статуса удалена.
  fastify.post<FactoryRoute>('/api/tasks/:id/stage/:key/:status', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const key = String(request.params.key).toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const status = request.params.status;
    if (!id || !key) return reply.code(400).send({ error: 'bad_input' });
    if (status !== 'running') {
      return reply.code(409).send({
        error: 'engine_owned_state',
        message: 'Доступен только возврат на пройденный узел («перейти сюда»).',
      });
    }
    const managed = await managedRegistry(id, reply);
    if (!managed) return reply;
    const { trusted } = managed;
    if (trusted.terminal) {
      return reply.code(409).send({ error: 'attempt_terminal', message: `попытка закрыта (${trusted.terminal})` });
    }
    const graph = await factoryState.getTaskGraph(id).catch(() => null);
    const node = graph && Object.keys(graph.keys || {}).find((nid) => graph.keys[nid] === key);
    if (!node) {
      return reply.code(409).send({ error: 'node_unknown', message: `узел ${key} не найден в маршруте попытки` });
    }
    const sanitized = humanComment((request.body || {}).comment, { fallback: 'возврат из кокпита' });
    if (!sanitized.ok) {
      return reply.code(400).send({ error: 'comment_too_long', message: sanitized.message });
    }
    const comment = sanitized.value;
    const rewound = await runRouteEngine(config, routeGotoArgs(config, {
      task: id, profile: trusted.profile, attempt: trusted.attempt, node, reason: comment,
    }));
    if (!rewound.ok) return reply.code(409).send({ error: 'goto_rejected', message: rewound.message });
    const resumed = await resumeRouteAttempt(id, {
      profile: trusted.profile, attempt: trusted.attempt, why: 'после возврата',
    });
    return {
      ok: true,
      key,
      status: 'running',
      node,
      resumed: resumed.ok,
      resumeError: resumed.message || null,
      resumeFailure: resumed.failure || null,
    };
  });

  // Арбитр типизированной остановки: снимает тупик вместо человека и предъявляет решение.
  //
  // Механика ровно та, которую человек выполняет руками, и заменяется здесь именно его
  // КУРЬЕРСКАЯ часть: собрать оба вердикта дуги, посмотреть артефакты и рабочее дерево,
  // сформулировать указание и вернуть курсор. Замер по журналам: 28 типизированных
  // остановок, сумма ожидания 59.7 часа, из них 53 — пять ночных стоянок.
  //
  // Три границы, каждая проверяется до побочного действия:
  //   1. разбирается ТОЛЬКО `no-progress`; `human` — прямой вызов человека, не топтание;
  //   2. решение, меняющее границу задачи, арбитр принять не вправе и отдаёт человеку;
  //   3. потолок арбитражей на попытку, потому что возврат арбитра (как и человеческий)
  //      обнуляет замкнутый набор дуги.
  // Событие журнала помечается `--actor`, поэтому машинное решение не выдаёт себя за
  // человеческое ни в ленте попытки, ни в промпте узла.
  //
  // Тело вынесено из роута, потому что зовут его ДВОЕ: кнопка человека и автоматический
  // вотчер. Одно тело — одни границы: у автоматического пути не должно быть ни своей
  // проверки остановки, ни своего потолка арбитражей.
  // `actor` не влияет на границы разбора — он только объясняет человеку, ПОЧЕМУ задача
  // едет сама: нажатую кнопку он и так помнит, а обход вотчера выглядит самодвижением.
  const runArbitration = async (
    id: string,
    reply: RejectionReply,
    { actor = 'human' }: { actor?: string } = {},
  ) => {
    const managed = await managedRegistry(id, reply);
    if (!managed) return null;
    const { trusted } = managed;
    if (trusted.terminal) {
      reply.code(409).send({
        error: 'attempt_terminal',
        message: `попытка закрыта (${trusted.terminal})`,
      });
      return null;
    }

    const context = await readArbitrationContext({
      controlDir: config.factoryControlDir, task: id, attempt: trusted.attempt,
    });
    const gate = arbitrationGate(context, trusted.cursor, {
      loop: managed.registry.LOOP_MODE === '1',
    });
    if (!gate.ok || !context.ok || !context.target) {
      reply.code(409).send({ error: gate.error, message: gate.message });
      return null;
    }

    const settings = normalizeArbiterSettings(prefs?.read()?.arbiter);
    const target = await resolveArbiterTarget({
      modelRef: { ...(settings.modelRef || {}), effort: settings.effort },
      config,
      modelsRegistry: () => getModelsRegistry(config),
      executorResolver: arbiterExecutor,
      resolveRef: resolveModelRef,
      log: fastify.log,
    });
    if (!target.ok) {
      reply.code(409).send({ error: target.error, message: target.message });
      return null;
    }

    // Рабочее дерево задачи. Пустой или повреждённый реестр worktree — отказ: арбитр без
    // дерева видит только вердикты, то есть ровно ту слепоту, ради снятия которой он есть.
    const parsed = parseSandboxRepositories(await factoryState.readEnv(id));
    const primaryRepo = parsed.repos[0];
    if (parsed.kind === 'invalid' || !primaryRepo) {
      reply.code(409).send({
        error: 'arbiter_workspace_unavailable',
        message: 'у задачи нет рабочего дерева — арбитру нечего проверять',
      });
      return null;
    }
    const cwd = primaryRepo.path;
    const extraDirs = [...parsed.repos.slice(1).map((repo) => repo.path), config.stateDir];

    // Своего таймаута у `executor.run` НЕТ: лимит хода считает watchdog модуля чата, а у
    // арбитра его нет. Без ограничения зависший ход держал бы и HTTP-запрос, и процесс CLI
    // без конца. Десять минут — с запасом на чтение артефактов и пару опытов.
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), ARBITER_TURN_LIMIT_MS);
    // Отметку ставим здесь, а не в начале: до этой строки идут дешёвые проверки, и
    // мигать «разбирается» на отказе за миллисекунду нечестно. Снимаем в `finally` —
    // потерянная отметка держала бы задачу «в разборе» до перезапуска сервера.
    const doneLive = arbiterLive?.begin(id, {
      actor,
      model: `${target.ref.provider}/${target.ref.model}`,
    }) || (() => {});
    let output: ArbiterRunOutput;
    try {
      const providerSettings = prefs?.read()?.providerSettings as
        Record<string, Record<string, unknown> | undefined> | undefined;
      output = await target.executor.run({
        signal: ac.signal,
        config,
        message: buildArbiterPrompt({
          task: id,
          node: context.node,
          target: context.target,
          reason: context.reason,
          series: context.series,
          stateDir: config.stateDir,
          stop: context.stop,
          budgetMin: ARBITER_TURN_LIMIT_MIN,
        }),
        cwd,
        extraDirs,
        model: target.ref.model,
        effort: target.effort || undefined,
        permissionMode: 'plan',
        providerSettings: providerSettings?.[target.ref.provider] || {},
        log: fastify.log,
      });
    } catch (err) {
      if (ac.signal.aborted) {
        fastify.log.warn(
          { task: id, limitMin: ARBITER_TURN_LIMIT_MIN, steps: errorStepCount(err) },
          'арбитр: ход оборван по лимиту времени',
        );
      }
      else fastify.log.warn({ err, task: id }, 'арбитр: ход не состоялся');
      reply.code(409).send({
        error: 'arbiter_run_failed',
        message: ac.signal.aborted ? 'арбитр не уложился в лимит хода' : 'арбитр не отработал',
      });
      // Эта ветка уходит мимо общего `finally` ниже, поэтому отметку снимаем здесь:
      // забытая запись держала бы задачу «в разборе» до перезапуска сервера.
      doneLive();
      return null;
    } finally {
      clearTimeout(deadline);
    }

    // Разбор ответа и возврат курсора идут ПОСЛЕ хода, но занимают ещё секунды:
    // `factory goto` — это отдельный процесс движка. Пока он работает, задача обязана
    // оставаться «в разборе», иначе в это окно вклинится вотчер или второе окно.
    try {
      const decision = parseArbiterDecision(output?.reply);
      if (!decision.ok) {
        reply.code(409).send({ error: decision.error, message: decision.message });
        return null;
      }
      if (decision.verdict === 'human') {
        // Не отказ и не ошибка: арбитр отработал и вернул то, что обязан вернуть, когда
        // решение меняет границу задачи. Карточку СОХРАНЯЕМ, а не только возвращаем в ответ:
        // у автоматического пути ответа некому показать, и разбор пропадал вместе с
        // потраченным ходом живого агента.
        await arbiterCards?.save(id, {
          attempt: trusted.attempt,
          verdict: 'human',
          card: decision.card,
          scopeChange: decision.scopeChange,
          model: `${target.ref.provider}/${target.ref.model}`,
          node: context.node,
          stop: context.stop,
        });
        return {
          ok: true,
          resolved: false,
          verdict: 'human',
          card: decision.card,
          scopeChange: decision.scopeChange,
          model: `${target.ref.provider}/${target.ref.model}`,
        };
      }

      const sanitized = humanComment(formatArbiterReason(decision), { fallback: '' });
      if (!sanitized.ok) {
        reply.code(409).send({ error: 'comment_too_long', message: sanitized.message });
        return null;
      }
      const rewound = await runRouteEngine(config, routeGotoArgs(config, {
        task: id,
        profile: trusted.profile,
        attempt: trusted.attempt,
        node: context.target,
        reason: sanitized.value,
        actor: ARBITER_ACTOR,
      }));
      if (!rewound.ok) {
        reply.code(409).send({ error: 'goto_rejected', message: rewound.message });
        return null;
      }
      const resumed = await resumeRouteAttempt(id, {
        profile: trusted.profile, attempt: trusted.attempt, why: 'после арбитража',
      });
      // Снятый тупик тоже объясняется человеку: он увидит на схеме возврат курсора и обязан
      // понимать, кто и почему его сделал, — иначе машинное решение неотличимо от сбоя.
      // `deferred` — то же самое движение курсора, но решение задело границу задачи, и
      // арбитр выбрал минимальный вариант вместо остановки. Разница только в пометке:
      // человек увидит такое решение сводкой в воротах, а не будильником посреди работы.
      await arbiterCards?.save(id, {
        attempt: trusted.attempt,
        verdict: decision.verdict,
        card: decision.card,
        scopeChange: decision.scopeChange,
        model: `${target.ref.provider}/${target.ref.model}`,
        node: context.target,
        stop: context.stop,
      });
      return {
        ok: true,
        resolved: true,
        verdict: decision.verdict,
        scopeChange: decision.scopeChange,
        node: context.target,
        card: decision.card,
        model: `${target.ref.provider}/${target.ref.model}`,
        resumed: resumed.ok,
        resumeError: resumed.message || null,
        resumeFailure: resumed.failure || null,
      };
    } finally {
      doneLive();
    }
  };

  fastify.post<FactoryRoute>('/api/tasks/:id/arbitrate', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_input' });
    const result = await runArbitration(id, reply);
    return result === null ? reply : result;
  });
  fastify.decorate('factoryArbitrate', runArbitration);

  // Ручное переключение ТОЛЬКО активной попытки и ТОЛЬКО на provider из уже
  // разрешённой цепочки этого этапа. Сам engine применяет CAS к run/epoch и завершает
  // точную process group; Cockpit не пишет control-файлы напрямую.
  fastify.post<FactoryRoute>('/api/tasks/:id/runner/switch', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const stage = String(request.body?.stage || '').toUpperCase();
    const target = String(request.body?.target || '');
    if (!id || !/^[A-Z][A-Z0-9_]*$/.test(stage) || !/^[a-z][a-z0-9_-]*$/.test(target)) {
      return reply.code(400).send({ error: 'bad_runner_switch' });
    }
    const managed = await managedRegistry(id, reply);
    if (!managed) return reply;
    if (managed.trusted.terminal) {
      return reply.code(409).send({
        error: 'attempt_terminal',
        message: `попытка закрыта (${managed.trusted.terminal})`,
      });
    }
    try {
      const graph = await factoryState.getTaskGraph(id);
      const nodeId = Object.keys(graph.runnerKeys || {}).find((nid) => graph.runnerKeys[nid] === stage)
        || Object.keys(graph.keys || {}).find((nid) => graph.keys[nid] === stage)
        || Object.keys(graph.nodes || {}).find((nid) => nid.toUpperCase() === stage);
      const runner = graphRunner(graph, nodeId);
      if (!nodeId || !runnerStageIsLive(graph, managed.registry, nodeId, stage) || !runner?.actual) {
        return reply.code(409).send({
          error: 'runner_not_active',
          message: graph.daemonAlive
            ? 'У этапа нет активного запуска для переключения.'
            : 'Прогон остановлен: выберите исполнителя этапа, затем нажмите «Продолжить прогон».',
        });
      }
      if (target === runner.actual || !runner.chain.includes(target)) {
        return reply.code(409).send({
          error: 'runner_not_allowed',
          message: 'Исполнитель не входит в разрешённую резервную цепочку этапа.',
        });
      }
      return await runnerControl.switch({ task: id, stage, target });
    } catch (err) {
      if (err instanceof RunnerControlInputError) {
        return reply.code(400).send({ error: 'bad_runner_switch', message: errorMessage(err) });
      }
      if (err instanceof RunnerControlCommandError) {
        return reply.code(409).send({ error: 'runner_switch_rejected', message: errorMessage(err) });
      }
      return reply.code(500).send({ error: 'runner_switch_failed', message: errorMessage(err) });
    }
  });

  // Stage-level override исполнителя: set пишет RUNNER_OVERRIDE_STAGE_<STAGE> через
  // CLI движка и вступает в силу на СЛЕДУЮЩЕМ запуске этапа. Активный этап меняется
  // только через runner/switch — иначе override и фактический процесс разъедутся.
  // Пустой primary — снять override (идемпотентно).
  fastify.post<FactoryRoute>('/api/tasks/:id/runner/override', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const stage = String(request.body?.stage || '').toUpperCase();
    const primary = String(request.body?.primary || '');
    if (!id || !/^[A-Z][A-Z0-9_]*$/.test(stage)
        || (primary && !/^[a-z][a-z0-9_-]*$/.test(primary))) {
      return reply.code(400).send({ error: 'bad_runner_override' });
    }
    const managed = await managedRegistry(id, reply);
    if (!managed) return reply;
    if (managed.trusted.terminal) {
      return reply.code(409).send({
        error: 'attempt_terminal',
        message: `попытка закрыта (${managed.trusted.terminal})`,
      });
    }
    try {
      const graph = await factoryState.getTaskGraph(id);
      const nodeId = Object.keys(graph.runnerKeys || {}).find((nid) => graph.runnerKeys[nid] === stage)
        || Object.keys(graph.keys || {}).find((nid) => graph.keys[nid] === stage)
        || Object.keys(graph.nodes || {}).find((nid) => nid.toUpperCase() === stage);
      if (!nodeId) {
        return reply.code(409).send({
          error: 'stage_unknown',
          message: `этап ${stage} не найден в маршруте попытки`,
        });
      }
      if (runnerStageIsLive(graph, managed.registry, nodeId, stage)
          && graphRunner(graph, nodeId)?.actual) {
        return reply.code(409).send({
          error: 'runner_active_use_switch',
          message: 'Этап сейчас выполняется — меняйте исполнителя переключением активного запуска.',
        });
      }
      if (primary) {
        const runners = await listInstalledRunners(config);
        if (!runners.includes(primary)) {
          return reply.code(409).send({
            error: 'runner_unknown',
            message: `исполнитель ${primary} не установлен`,
          });
        }
        return await runnerControl.setStage({ task: id, stage, primary });
      }
      return await runnerControl.clearStage({ task: id, stage });
    } catch (err) {
      if (err instanceof RunnerControlInputError) {
        return reply.code(400).send({ error: 'bad_runner_override', message: errorMessage(err) });
      }
      if (err instanceof RunnerControlCommandError) {
        return reply.code(409).send({ error: 'runner_override_rejected', message: errorMessage(err) });
      }
      return reply.code(500).send({ error: 'runner_override_failed', message: errorMessage(err) });
    }
  });

  // Указание агенту (side-файл, читается на границе этапов). Пусто — снять.
  fastify.get<FactoryRoute>('/api/tasks/:id/instruction', async (request) => ({
    text: readInstruction({ ...cfg, task: String(request.params.id).replace(/[^0-9]/g, '') }),
  }));
  fastify.post<FactoryRoute>('/api/tasks/:id/instruction', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const managed = await managedRegistry(id, reply);
    if (!managed) return reply;
    return reply.code(409).send({
      error: 'engine_owned_instruction',
      message: 'Side-file instruction writer удалён; указание должно стать командой движка.',
    });
  });

  // Живая активность прогона (для поллинга в модалке).
  fastify.get<FactoryRoute>('/api/tasks/:id/activity', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      const dir = await factoryState.taskStateDir(id);
      const { registry } = await factoryState.readRegistry(id);
      const activity = readActivity({ ...cfg, stateDir: dir, task: id, registry });
      const live = readAgentLive({ stateDir: dir, task: id, registry });
      return { ...activity, live };
    } catch (err) { return reply.code(404).send({ error: 'not_found', message: errorMessage(err) }); }
  });

  // Команда сноса стенда: COCKPIT_SANDBOX_DOWN_CMD ({task} подставляется); без неё —
  // down.sh только из профиля, подтверждённого trusted attempt ledger. Нет ни того
  // ни другого → null.
  const NOT_CONFIGURED = 'снос не настроен: нет COCKPIT_SANDBOX_DOWN_CMD и down.sh у профиля';
  async function sandboxDownCmd(id: string, trustedProfile: string) {
    if (config.sandboxDownCmd) return config.sandboxDownCmd.replaceAll('{task}', id);
    const script = trustedProfile && path.join(config.profilesDir, trustedProfile, 'down.sh');
    if (script && await fs.access(script).then(() => true).catch(() => false)) return `bash ${script} ${id}`;
    return null;
  }

  // Выполнить снос. Решение по ответу оставляем вызывающему: снос — это и отдельная
  // кнопка, и первый шаг перезапуска стенда, а реагируют они на отказ по-разному.
  //
  // STATE_DIR передаём явно: lifecycle script и server читают один runtime root.
  //
  // FACTORY_DOWN_WORKTREE=force — сносить worktree задачи вместе с незакоммиченным.
  // Оба вызывающих сначала закрывают попытку (abandon), то есть работа этапа уже
  // ничья, а бережно «оставленный» грязный worktree ровно ничего не спасал: сам он
  // из интерфейса не виден, зато следующий подъём упирается в гард частично
  // созданной песочницы (env реестра снесён, каталоги на месте) и задача встаёт
  // с кодом 75 ещё до первого агента. Работа при этом не пропадает — профиль перед
  // удалением кладёт патч в archive/ (t<id>.<репозиторий>-<worktree>.patch).
  function runSandboxDown(id: string, cmd: string, stateDir: string): Promise<SandboxDownResult> {
    return new Promise<SandboxDownResult>((resolve) => {
      execFile('sh', ['-c', cmd], {
        timeout: 120000,
        env: {
          ...process.env,
          STATE_DIR: stateDir,
          FACTORY_STATE: stateDir,
          FACTORY_DOWN_WORKTREE: 'force',
        },
      }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, message: (stderr || errorMessage(err)).slice(-500) });
        else {
          // Стенда больше нет — незачем держать за задачей резервацию до истечения TTL.
          releaseSlot({ stateDir: config.stateDir, task: id });
          resolve({ ok: true, output: (stdout || '').slice(-500) });
        }
      });
    });
  }

  // Снос стенда — терминальное действие для ТЕКУЩЕГО прогона: инфраструктуру удаляем,
  // проекцию реестра переносим в архив, и задача сразу снова доступна для отправки на
  // конвейер. Worktree задачи уходит вместе со стендом (незакоммиченное сохраняется
  // патчем в archive/), ветки не трогаем — коммиты в безопасности. Одной архивации
  // файлов недостаточно: открытую попытку сначала обязан терминализировать сам движок,
  // иначе следующий start получит 73 («попытка уже активна»).
  fastify.post<FactoryRoute>('/api/tasks/:id/sandbox/down', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return withTaskLaunchLock(id, async () => {
    const lifecycle = await managedLifecycle(id, reply);
    if (!lifecycle) return reply;
    const { registry, trusted } = lifecycle;
    if (trusted.workspaceMode === 'shared' || trusted.standOwnership === 'external') {
      return reply.code(409).send({
        error: 'shared_workspace_lifecycle_forbidden',
        message: 'Общий checkout и существующий стенд нельзя сносить из Cockpit.',
      });
    }
    const stateDir = config.stateDir;
    // Архивировать реестр из-под живого процесса нельзя:
    // оркестратор продолжит писать в исчезнувшую проекцию и оставит полупрогон.
    if (registry && factoryState.isDaemonAlive(registry.ORCH_PID, id)) {
      return reply.code(409).send({ error: 'running', message: 'прогон идёт — сначала останови его' });
    }
    const cmd = await sandboxDownCmd(id, trusted.profile);
    if (!cmd) return reply.code(501).send({ error: 'not_configured', message: NOT_CONFIGURED });

    let attemptClosed = null;
    const attempt = trusted.attempt;
    const terminal = Boolean(trusted.terminal);
    if (!terminal) {
      const done = await runRouteEngine(config, routeAbandonArgs(config, {
        task: id,
        profile: trusted.profile,
        attempt,
        reason: 'стенд снесён из кокпита',
      }));
      // 73 означает, что попытка успела стать терминальной сама — сносу это не мешает.
      if (!done.ok && done.code !== 73) {
        return reply.code(409).send({ error: 'abandon_failed', message: done.message });
      }
      attemptClosed = done.ok ? 'abandoned' : 'already_terminal';
    } else {
      attemptClosed = trusted.terminal;
    }

    const down = await runSandboxDown(id, cmd, stateDir);
    if (!down.ok) return reply.code(500).send({ error: 'sandbox_down_failed', message: down.message });
    try {
      const archived = await archiveTaskFiles(id, stateDir);
      taskLaunchPending.delete(String(id));
      return { ok: true, output: down.output, archived, attempt: attemptClosed };
    } catch (err) {
      fastify.log.error({ task: id, err: errorMessage(err) }, 'стенд снесён, но реестр не перенесён в архив');
      return reply.code(500).send({
        error: 'sandbox_archive_failed',
        message: `стенд снесён, но убрать прогон с экрана не удалось: ${errorMessage(err)}`,
      });
    }
    });
  });

  // Отдельное закрытие остаётся запасным действием для задачи БЕЗ живого стенда
  // (например, подъём оборвался до выдачи порта). В отличие от обычного сноса оно
  // дополнительно удаляет ПУСТУЮ ветку. Ветку с коммитами не трогаем никогда.
  fastify.post<FactoryRoute>('/api/tasks/:id/close', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return withTaskLaunchLock(id, async () => {
    const lifecycle = await managedLifecycle(id, reply);
    if (!lifecycle) return reply;
    const { registry, trusted, env, sandbox } = lifecycle;
    const stateDir = config.stateDir;
    if (factoryState.isDaemonAlive(registry.ORCH_PID, id)) {
      return reply.code(409).send({ error: 'running', message: 'конвейер идёт — сначала останови прогон' });
    }
    const shared = trusted.workspaceMode === 'shared' || trusted.standOwnership === 'external';
    if (!shared && env.FE_PORT) {
      return reply.code(409).send({ error: 'sandbox_alive', message: 'стенд ещё жив — сначала снеси стенд' });
    }

    // Активную попытку обязан закрыть движок. Без этого следующий прогон той же
    // задачи упрётся в 73 («попытка уже активна»), а человек увидит отказ на пустом
    // месте. Судить о завершении по WF_STATUS нельзя: это только вторичная
    // проекция активности; точный terminal marker несёт trusted attempt-ledger.
    let attemptClosed = null;
    const attempt = trusted.attempt;
    const terminal = Boolean(trusted.terminal);
    if (!terminal) {
      const done = await runRouteEngine(config, routeAbandonArgs(config, {
        task: id, profile: trusted.profile, attempt, reason: 'задача закрыта из кокпита',
      }));
      // 73 здесь означает «попытка и так уже терминальна» — закрытию это не мешает.
      if (!done.ok && done.code !== 73) {
        return reply.code(409).send({ error: 'abandon_failed', message: done.message });
      }
      attemptClosed = done.ok ? 'abandoned' : 'already_terminal';
    } else {
      attemptClosed = trusted.terminal;
    }

    // Ветки задачи ищем по worktree-путям из env прогона; репозиторий — их основной
    // checkout. Пустая (0 коммитов от базы) удаляется, непустая остаётся с отчётом.
    const branches = [];
    const sandboxRepos = sandbox.repos;
    const branch = trusted.sourceBranch;
    // Shared checkout никогда не участвует в branch lifecycle: даже read-only probe,
    // за которым следует `branch -D`, слишком опасен для основного рабочего дерева.
    const repos = shared
      ? []
      : trusted.repositories.map((repo) => ({ key: repo.name, name: repo.name, path: repo.source }));
    for (const repo of repos) {
      const repoBranch = sandboxRepos.find((item) => item.name === (repo.key || repo.name))?.branch
        || branch;
      if (!repoBranch || !repo?.path) continue;
      const kept = await new Promise((resolve) => {
        execFile('git', ['-C', repo.path, 'rev-list', '--count', `HEAD..refs/heads/${repoBranch}`],
          { timeout: 15000 }, (err, stdout) => {
            if (err) return resolve({ repo: repo.name || repo.path, state: 'нет ветки' });
            if (String(stdout).trim() !== '0') return resolve({ repo: repo.name || repo.path, state: `оставлена: коммитов ${String(stdout).trim()}` });
            execFile('git', ['-C', repo.path, 'branch', '-D', repoBranch], { timeout: 15000 }, (delErr) => {
              resolve({ repo: repo.name || repo.path, state: delErr ? `не удалена: ${delErr.message.slice(-120)}` : 'удалена (пустая)' });
            });
          });
      });
      branches.push(kept);
    }

    const moved = await archiveTaskFiles(id, stateDir);
    taskLaunchPending.delete(String(id));
    return {
      ok: true, archived: moved, branch: branch || null, branches, attempt: attemptClosed,
      workspaceMode: trusted.workspaceMode,
    };
    });
  });

  // Перезапуск стенда после провала подъёма.
  //
  // Кнопка «снести стенд» показывается только у ЖИВОГО стенда (её условие — известный
  // порт фронта), а когда подъём упал, порта нет — и вернуть задачу в работу из
  // интерфейса было нечем. Движок при этом ставит STALLED_HUMAN=1 и выходит, НИЧЕГО за
  // собой не убирая (намеренно: следы падения нужны для разбора). Первая попытка может
  // умереть на занятом порту, а вторая — на гарде «схема db_t<TASK> уже существует»,
  // потому что остатки первой никто не снёс. Поэтому кнопка делает ДВА
  // шага: сносит остатки (down.sh идемпотентен — дропает по точным именам, чего нет,
  // то и не трогает) и поднимает конвейер заново. Заново — это resume: разведка,
  // маршрут и пройденные этапы в реестре уцелеют, стенд соберётся фоном.
  //
  // Isolated-стенд принадлежит ПОПЫТКЕ: `resume` не строит его с нуля, а повторный
  // `start` упирается в гард уже существующего прогона. Поэтому порядок жёсткий:
  // закрыть попытку (`abandon`) → снести остатки → убрать проекцию реестра
  // в архив → новый `start` С ТОЙ ЖЕ постановкой. Журнал попытки при этом цел: он
  // живёт в доверенном control-каталоге и переживает и снос, и архив.
  fastify.post<FactoryRoute>('/api/tasks/:id/sandbox/retry', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return withTaskLaunchLock(id, async () => {

      const lifecycle = await managedLifecycle(id, reply);
      if (!lifecycle) return reply;
      const { registry: reg, trusted } = lifecycle;
      if (trusted.workspaceMode === 'shared' || trusted.standOwnership === 'external') {
        return reply.code(409).send({
          error: 'shared_workspace_lifecycle_forbidden',
          message: 'Общий checkout и существующий стенд нельзя сносить или пересобирать из Cockpit.',
        });
      }
      // Сносить песочницу под работающим конвейером нельзя: агент этапа потеряет и код,
      // и базу под собой.
      if (factoryState.isDaemonAlive(reg.ORCH_PID, id)) {
        return reply.code(409).send({ error: 'running', message: 'конвейер идёт — перезапускать стенд нечего' });
      }
      // Прогон закрыт (или ещё не начинался): resume продолжать нечего, а start без тикета
      // ушёл бы работать вслепую. Для этого есть кнопка «на конвейер» — с описанием задачи.
      if (trusted.terminal === 'completed') {
        return reply.code(409).send({ error: 'not_running', message: 'прогон не открыт — запускай задачу кнопкой «на конвейер»' });
      }

      const stateDir = config.stateDir;
      if (trusted.terminal !== 'abandoned') {
        const done = await runRouteEngine(config, routeAbandonArgs(config, {
          task: id, profile: trusted.profile, attempt: trusted.attempt, reason: 'перезапуск стенда из кокпита',
        }));
        if (!done.ok && done.code !== 73) {
          return reply.code(409).send({ error: 'abandon_failed', message: done.message });
        }
      }

      const cmd = await sandboxDownCmd(id, trusted.profile);
      if (!cmd) return reply.code(501).send({ error: 'not_configured', message: NOT_CONFIGURED });
      const down = await runSandboxDown(id, cmd, stateDir);
      if (!down.ok) return reply.code(500).send({ error: 'sandbox_down_failed', message: down.message });

      // Проекция реестра не даёт стартовать заново — убираем её в архив своего же
      // каталога (не удаляем: следы упавшего подъёма нужны для разбора). Этим человек
      // также явно разрешает старый uncertain bootstrap, если такой marker остался.
      await archiveTaskFiles(id, stateDir);
      taskLaunchPending.delete(String(id));

      const r = await startPipeline(id, {
        profile: trusted.profile,
        route: trusted.route,
        reuseTicket: true,
      });
      // Снос уже прошёл, поэтому его вывод отдаём в ЛЮБОМ случае: там видны отказы,
      // из-за которых новый подъём упадёт снова (например «worktree ОСТАВЛЕН как есть» —
      // не удалось снять патч, и гард частично созданной песочницы упрётся именно в это).
      if (r.status) return reply.code(r.status).send({ ...r.body, downOutput: down.output });
      return { ...r.body, retried: true, downOutput: down.output };
    });
  });

  // «Продолжить» — единственный способ поднять упавший прогон из интерфейса.
  // Автовосстановление отключено, `/launch` открытый прогон отбивает, а resume
  // до сих пор вызывался только из ворот и возврата: прогон, у которого умер
  // оркестратор (перезагрузка машины, OOM), продолжить было нечем.
  // Автоматики здесь нет и не будет — только по кнопке человека.
  fastify.post<FactoryRoute>('/api/tasks/:id/resume', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const managed = await managedRegistry(id, reply);
    if (!managed) return reply;
    const { registry, trusted } = managed;

    if ((request.body?.attempt && request.body.attempt !== trusted.attempt)
        || (request.body?.profile && request.body.profile !== trusted.profile)) {
      return reply.code(409).send({
        error: 'attempt_changed',
        message: 'Попытка изменилась — обнови карточку.',
      });
    }
    if (trusted.bootstrapStop?.state === 'waiting') {
      return reply.code(409).send({
        error: 'bootstrap_answer_required',
        message: 'Сначала ответь на вопрос разведки SCOUT.',
      });
    }
    if (factoryState.isDaemonAlive(registry.ORCH_PID, id)) {
      return { ok: true, outcome: 'already_running' };
    }
    if (trusted.terminal) {
      return reply.code(409).send({ error: 'attempt_terminal', message: `попытка закрыта (${trusted.terminal}) — продолжать нечего` });
    }
    const attempt = trusted.attempt;
    const launch = await resumeRouteAttempt(id, { profile: trusted.profile, attempt, why: 'по кнопке' });
    if (!launch.ok) {
      return reply.code(500).send({
        error: launch.failure?.error || 'resume_failed',
        ...(launch.failure ? { runners: launch.failure.runners } : {}),
        message: launch.message,
      });
    }
    return { ok: true, outcome: 'launched', attempt };
  });

  // «Стоп» — ручная остановка работающего конвейера. Движок получает TERM,
  // сам гасит runner и снимает инструментацию; попытка остаётся открытой,
  // поэтому после остановки карточка показывает обычное «продолжить прогон».
  fastify.post<FactoryRoute>('/api/tasks/:id/stop', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const managed = await managedRegistry(id, reply);
    if (!managed) return reply;
    const { registry } = managed;
    const stop = await stopRouteOrchestrator({
      task: id,
      orchPid: Number(registry.ORCH_PID),
      isAlive: () => factoryState.isDaemonAlive(registry.ORCH_PID, id),
    });
    if (!stop.ok) return reply.code(500).send({ error: 'stop_failed', message: stop.message });
    return stop;
  });

  // Полный граф конвейера задачи (для SVG-отрисовки): схема + статусы узлов + возвраты.
  fastify.get<FactoryRoute>('/api/tasks/:id/graph', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      return await factoryState.getTaskGraph(id);
    } catch (err) {
      return reply.code(404).send({ error: 'not_found', message: errorMessage(err) });
    }
  });
}

export default fp(factoryModule, { name: 'module-factory' });
