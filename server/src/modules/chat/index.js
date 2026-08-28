// Модуль chat — интерактивное обсуждение с CLI-агентом прямо из кокпита.
// Два режима:
//   • по задаче  — выбранный executor в worktree задачи, контекст через его sessionId;
//   • без задачи — свободный вопрос в корне репозитория Cockpit.
// Интерактивные права реализованы Claude executor-ом через permission-prompt-tool
// (lib/chat/permission-mcp.js): запрос показывается всплывашкой в браузере.
import fp from 'fastify-plugin';
import { promises as fs, createWriteStream, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCompanionSettings } from '../../lib/companion-settings.js';
import { createWorkTools, getExecutor } from '../../lib/executors/index.js';
import { createWorkIpc } from '../../lib/executors/work-ipc.js';
import { getModelsRegistry } from '../../lib/models-registry.js';
import { resolveRequestedEffort } from '../../lib/model-effort.js';
import {
  ChatHistoryError,
  ChatHistoryStore,
  companionLogicalIdentity,
  normalizeCompanionTaskId,
} from '../../lib/chat/history-store.js';
import { ChatSessionBindingStore } from '../../lib/chat/session-binding-store.js';
import { ChatTurnLocks } from '../../lib/chat/turn-locks.js';
import { ChatLiveSessions } from '../../lib/chat/live-sessions.js';
import { createPermissionQueue } from '../../lib/chat/permission-queue.js';
import { mayRetryEmptyRun } from '../../lib/chat/retry-contract.js';
import { resolveChatAttachment } from '../../lib/chat/attachments.js';
import { stoppedTurnBrief } from '../../lib/chat/stopped-brief.js';
import { autoDecision } from '../../lib/chat/auto-approve.js';
import { normalizeContextCache } from '../../lib/chat/context-cache.js';
import { MAX_CHAT_STEPS } from '../../lib/chat/stream-steps.js';
import {
  contextPrefix,
  normalizeUiContext,
  pageHint,
} from '../../lib/chat/ui-context.js';
import { DISCUSSION_SECTION_TITLE, stripDiscussionSection } from '../../lib/telegram/discussion.js';
import {
  KIMI_AUTH_PROFILE_ID,
  kimiSecurityProfile,
} from '../../lib/kimi/profile.js';
import {
  normalizeModelRef,
  resolveLegacyModel,
  resolveModelRef,
  sameModelRef,
} from '../../lib/chat/model-ref.js';
import {
  finishChatTitleHook,
  visibleChatTitleStep,
  withChatTitleHook,
} from '../../lib/chat/title-hook.js';
import { parseSandboxRepositories } from '../../lib/sandbox-env.js';
import { PROFILE_RE, listProjects } from '../../lib/profiles.js';
import { normalizeSpeechSettings, speechSettingsRevision } from '../../lib/speech-settings.js';
import {
  SPEECH_STREAM_AUDIO,
  SPEECH_STREAM_PROTOCOL_VERSION,
} from '../../lib/speech/stream-process.js';

const PERM_MCP_PATH = fileURLToPath(new URL('../../lib/chat/permission-mcp.js', import.meta.url));
const SPEECH_STREAM_START_MAX_BYTES = 4 * 1024;
const SPEECH_STREAM_START_TIMEOUT_MS = 10_000;
const SPEECH_STREAM_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SPEECH_SAFE_STEP_KINDS = new Set(['start', 'text', 'think']);
const SPEECH_STREAM_PUBLIC_ERRORS = Object.freeze({
  speech_model_missing: 'Локальная модель речи не установлена.',
  speech_unavailable: 'Локальное распознавание сейчас недоступно.',
  speech_stream_busy: 'Сейчас уже выполняется слишком много локальных диктовок.',
  speech_stream_protocol: 'Поток речи нарушил протокол.',
  speech_stream_too_long: 'Достигнут предел длительности диктовки.',
  speech_stream_backpressure: 'Распознавание не успевает за диктовкой.',
  speech_stream_timeout: 'Не удалось завершить распознавание вовремя.',
  stale_speech_settings: 'Настройки речи изменились — начни диктовку заново.',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeExecutorContextCache(out) {
  if (!isPlainObject(out) || !Object.hasOwn(out, 'contextCache')) return out;
  const contextCache = normalizeContextCache(out.contextCache);
  if (contextCache) return { ...out, contextCache };
  const clean = { ...out };
  delete clean.contextCache;
  return clean;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function sameSpeechStreamAudio(value) {
  return hasExactKeys(value, ['encoding', 'sampleRate', 'channels', 'frameSamples'])
    && value.encoding === SPEECH_STREAM_AUDIO.encoding
    && value.sampleRate === SPEECH_STREAM_AUDIO.sampleRate
    && value.channels === SPEECH_STREAM_AUDIO.channels
    && value.frameSamples === SPEECH_STREAM_AUDIO.frameSamples;
}

/** WebSocket с cookie принимаем только со строгого origin самого Cockpit. */
export function speechStreamOriginMatches(request) {
  const rawOrigin = request?.headers?.origin;
  const host = request?.host || request?.headers?.host;
  if (typeof rawOrigin !== 'string' || !rawOrigin || typeof host !== 'string' || !host) return false;
  try {
    const origin = new URL(rawOrigin);
    const expected = new URL(`${request.protocol}://${host}`);
    // Header Origin не содержит path/query/credentials. Сравнение только `.origin`
    // приняло бы искусственный `https://cockpit/evil`, что уже не является exact form.
    return rawOrigin === origin.origin && origin.origin === expected.origin;
  } catch {
    return false;
  }
}

function parseSpeechStreamStart(raw) {
  if (raw.length > SPEECH_STREAM_START_MAX_BYTES) return null;
  let message;
  try { message = JSON.parse(raw.toString('utf8')); } catch { return null; }
  if (!hasExactKeys(message, ['type', 'protocolVersion', 'sessionId', 'revision', 'audio'])) return null;
  if (message.type !== 'start' || message.protocolVersion !== SPEECH_STREAM_PROTOCOL_VERSION) return null;
  if (typeof message.sessionId !== 'string' || !SPEECH_STREAM_SESSION_RE.test(message.sessionId)) return null;
  if (typeof message.revision !== 'string' || !message.revision || message.revision.length > 128) return null;
  if (!sameSpeechStreamAudio(message.audio)) return null;
  return message;
}

function parseSpeechStreamControl(raw) {
  if (raw.length > SPEECH_STREAM_START_MAX_BYTES) return null;
  let message;
  try { message = JSON.parse(raw.toString('utf8')); } catch { return null; }
  if (hasExactKeys(message, ['type']) && message.type === 'cancel') return message;
  if (hasExactKeys(message, ['type', 'seq'])
    && message.type === 'stop'
    && Number.isSafeInteger(message.seq)
    && message.seq >= 0
    && message.seq <= 0xffffffff) return message;
  return null;
}

// Заказ выжимки для исполнителей без родного компакта (см. compaction в lib/executors).
// Просим ИМЕННО рабочее состояние, а не пересказ реплик: выжимка станет первым сообщением
// новой сессии, и агент должен продолжить работу, а не заново выяснять, что происходит.
const SUMMARY_PROMPT = `Сожми наш разговор в рабочую выжимку, чтобы продолжить его в новой сессии с чистым контекстом.
Верни ТОЛЬКО текст выжимки, без вступлений и без вопросов. Обязательно сохрани:
— задачу, которую решаем, и текущее состояние;
— уже принятые решения и причины, по которым они приняты;
— файлы и места в коде, которых касались (с путями);
— что уже сделано и что осталось;
— договорённости и ограничения, о которых просил человек.`;

async function chatModule(fastify, opts) {
  const {
    factoryState, config, claudeAuth, internalToken, prefs, speechRuntime,
  } = opts;
  const sshBroker = opts.sshBroker || fastify.sshBroker || null;
  const permissionQueue = opts.permissionQueue || createPermissionQueue();
  const workIpcs = new Map();
  const speechStreamStartTimeoutMs = Number.isInteger(opts.speechStreamStartTimeoutMs)
    && opts.speechStreamStartTimeoutMs > 0
    ? opts.speechStreamStartTimeoutMs
    : SPEECH_STREAM_START_TIMEOUT_MS;
  const modelsRegistry = opts.modelsRegistry || ((cfg) => getModelsRegistry(cfg));
  const executorResolver = opts.executorResolver || getExecutor;
  const taskExistsResolver = typeof opts.taskExists === 'function'
    ? opts.taskExists
    : async (taskId) => {
      if (typeof factoryState?.readRegistry !== 'function') return false;
      try { await factoryState.readRegistry(taskId); return true; }
      catch { return false; }
    };
  // Несколько вкладок могут одновременно запросить одну логическую идентичность. Проверка задачи
  // способна обратиться к живому трекеру, поэтому объединяем только текущую проверку без устаревающего кэша.
  const taskVerificationJobs = new Map();

  /** Project scope рабочего инструмента берётся только из trusted attempt ledger. */
  async function trustedWorkProject(taskId) {
    if (!taskId || typeof factoryState?.readTrustedAttempt !== 'function') {
      return null;
    }
    try {
      const registry = typeof factoryState.readRegistry === 'function'
        ? (await factoryState.readRegistry(taskId))?.registry
        : undefined;
      const attempt = await factoryState.readTrustedAttempt(taskId, registry);
      const projectId = String(attempt?.profile || '');
      if (!PROFILE_RE.test(projectId)) {
        return null;
      }
      const projects = await listProjects(config, prefs);
      return projects.includes(projectId) ? projectId : null;
    } catch {
      return null;
    }
  }

  /** Один UDS живёт вместе с chat scope и переиспользуется живым CLI-процессом. */
  async function ensureWorkIpc(scopeKey, workToolsValue) {
    const current = workIpcs.get(scopeKey);
    if (current) {
      return current;
    }
    const ipc = await createWorkIpc({ workTools: workToolsValue });
    workIpcs.set(scopeKey, ipc);
    return ipc;
  }

  fastify.addHook('onClose', async () => {
    const values = [...workIpcs.values()];
    workIpcs.clear();
    await Promise.all(values.map((ipc) => ipc.close().catch(() => {})));
  });

  async function companionTaskExists(taskId) {
    if (taskId == null) return true;
    const key = String(taskId);
    if (taskVerificationJobs.has(key)) return taskVerificationJobs.get(key);
    const job = Promise.resolve()
      .then(() => taskExistsResolver(key))
      .then((exists) => exists === true, () => false);
    taskVerificationJobs.set(key, job);
    job.finally(() => {
      if (taskVerificationJobs.get(key) === job) taskVerificationJobs.delete(key);
    });
    return job;
  }

  async function companionTaskSandbox(taskId) {
    if (!taskId || typeof factoryState?.readRegistry !== 'function'
      || typeof factoryState?.readTrustedAttempt !== 'function'
      || typeof factoryState?.readEnv !== 'function'
      || typeof factoryState?.verifyTrustedEnvironment !== 'function') return null;
    try {
      // Существующей задачи Б24 достаточно для владения долгой историей, но быстрый ход
      // компаньона не должен переходить в корень Cockpit при отсутствии точного рабочего дерева.
      // `.pipeline` и `.env` — доступные провайдеру для записи проекции; исполняемые пути берутся
      // только из неизменяемого журнала попытки после точной проверки окружения.
      const { registry } = await factoryState.readRegistry(taskId);
      const trusted = await factoryState.readTrustedAttempt(taskId, registry);
      const env = await factoryState.readEnv(taskId);
      factoryState.verifyTrustedEnvironment(trusted, env);
      const repositories = Array.isArray(trusted?.repositories) ? trusted.repositories : [];
      if (!repositories.length || !['isolated', 'shared'].includes(trusted?.workspaceMode)) return null;
      const repos = repositories.map((repo) => ({
        name: repo?.name,
        path: repo?.workspace,
        branch: repo?.branch,
      }));
      if (repos.some((repo) => typeof repo.name !== 'string' || !repo.name
        || typeof repo.path !== 'string' || !path.isAbsolute(repo.path)
        || /[\u0000\r\n\t]/u.test(repo.path)
        || typeof repo.branch !== 'string' || !repo.branch)) return null;
      // Ledger задаёт доверенный путь, но не доказывает, что worktree всё ещё существует.
      // Непосредственно перед ходом канонизируем каждый репозиторий: удалённый worktree
      // и не-каталог дают fail-closed, а executor получает canonical path без symlink-алиаса.
      const canonicalRepos = await Promise.all(repos.map(async (repo) => {
        const declaredStat = await fs.lstat(repo.path);
        if (declaredStat.isSymbolicLink() || !declaredStat.isDirectory()) {
          throw new Error('доверенный worktree должен быть непосредственным каталогом');
        }
        const canonicalPath = await fs.realpath(repo.path);
        const stat = await fs.stat(canonicalPath);
        if (!stat.isDirectory() || canonicalPath !== path.resolve(repo.path)) {
          throw new Error('доверенный worktree перенаправлен через symlink');
        }
        return { ...repo, path: canonicalPath };
      }));
      return { kind: 'generic', workspaceMode: trusted.workspaceMode, repos: canonicalRepos };
    } catch {
      return null;
    }
  }

  function sameCompanionTaskSandbox(left, right) {
    if (!left || !right || left.kind !== right.kind
      || left.workspaceMode !== right.workspaceMode
      || !Array.isArray(left.repos) || !Array.isArray(right.repos)
      || left.repos.length !== right.repos.length) return false;
    return left.repos.every((repo, index) => {
      const other = right.repos[index];
      return repo.name === other?.name && repo.path === other?.path && repo.branch === other?.branch;
    });
  }

  // История является server-owned источником surface/modelRef. Binding лежит отдельно:
  // никакой PUT чата не может назначить Kimi resume id или его generation.
  const history = new ChatHistoryStore({
    chatsDir: config.chatsDir,
    legacyPath: config.chatStoreLegacyPath,
    log: fastify.log,
    registryProvider: () => modelsRegistry(config),
    defaultSurface: 'chats',
  });
  const bindingStore = new ChatSessionBindingStore({
    dir: config.chatBindingsDir || path.join(config.chatsDir, '.bindings'),
  });
  const turnLocks = new ChatTurnLocks();
  // Приём хода и DELETE согласуются синхронно до первого await. Так история не исчезнет,
  // пока ход ещё только проходит strict preflight и потому не виден ни activeRuns,
  // ни turnLocks.
  const acceptedTurns = new Map(); // chatKey -> число preflight/queued/locked/running ходов
  const savingChats = new Map(); // chatKey -> число принятых point/full PUT
  const deletingChats = new Set();

  function beginAcceptedTurn(chatKey) {
    if (!chatKey) return () => {};
    acceptedTurns.set(chatKey, (acceptedTurns.get(chatKey) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (acceptedTurns.get(chatKey) || 1) - 1;
      if (remaining > 0) acceptedTurns.set(chatKey, remaining);
      else acceptedTurns.delete(chatKey);
    };
  }

  function beginChatSaves(chatIds) {
    const ids = [...new Set(chatIds.filter(Boolean).map(String))];
    for (const id of ids) savingChats.set(id, (savingChats.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const remaining = (savingChats.get(id) || 1) - 1;
        if (remaining > 0) savingChats.set(id, remaining);
        else savingChats.delete(id);
      }
    };
  }

  // Потолок описания в конверте: поле ticket.description допускает до 100 000 символов
  // (TICKET_LIMITS), тащить всё в каждый ход чата расточительно — детали агент при
  // надобности дочитает из самого файла, путь к которому указан в маркере обрезки.
  const TICKET_DESCRIPTION_MAX = 6000;

  /**
   * Проект задачи — он же профиль её прогона: по нему allowlist телеграма решает,
   * показывать ли переписку. Реестра может не быть вовсе (задача ещё не
   * запускалась, ручная, историческая) — тогда проект неизвестен, и это не повод
   * ни закрыть привязанный чат, ни открыть непривязанный: сверка проекта
   * пропускается, сам allowlist остаётся (lib/telegram/link-scope.js).
   */
  async function taskProject(task) {
    try {
      const { registry } = await factoryState.readRegistry(task);
      return String(registry?.PROFILE || '').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Контекст выбранной в чате задачи: тикет лежит в server-owned хранилище
   * (config.ticketsDir, lib/factory-ticket.js) и до сих пор агенту не передавался —
   * выбор задачи влиял только на cwd. Чтение лучшее усилие: задача без тикета
   * (ручная, историческая) или битый файл не должны ронять ход чата.
   */
  async function taskTicketBlock(id) {
    const task = String(id ?? '');
    if (!/^[1-9][0-9]{0,18}$/.test(task) || !config.ticketsDir) return '';
    try {
      const file = path.join(config.ticketsDir, `t${task}.ticket.json`);
      const ticket = JSON.parse(await fs.readFile(file, 'utf8'));
      const title = String(ticket?.title || '').trim();
      const lines = [`В чате выбрана задача #${task}${title ? `: «${title}»` : ''}.`];
      // Секцию обсуждения, вклеенную в описание при запуске, выбрасываем: тикет —
      // замороженный снимок постановки, а разговор в чате продолжается. Свежую
      // версию соберём ниже сами.
      let description = stripDiscussionSection(String(ticket?.description || '')).trim();
      const source = [title, description].filter(Boolean).join('\n');
      if (description) {
        if (description.length > TICKET_DESCRIPTION_MAX) {
          description = `${description.slice(0, TICKET_DESCRIPTION_MAX)}\n[описание обрезано; полный текст: ${file}]`;
        }
        lines.push(`Описание задачи:\n${description}`);
      }
      const criteria = (Array.isArray(ticket?.acceptanceCriteria) ? ticket.acceptanceCriteria : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      if (criteria.length) {
        lines.push(`Критерии приёмки:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
      }
      const sourceUrl = String(ticket?.sourceUrl || '').trim();
      if (sourceUrl) lines.push(`Источник: ${sourceUrl}`);

      // Переписка по телеграм-ссылкам — ПОСЛЕ подрезки описания и своей секцией,
      // а не внутри него: потолок выше режет с конца, и обсуждение, стоящее в
      // хвосте, срезалось бы первым и молча. Свой лимит у разворота есть
      // (DISCUSSION_LIMITS). Ищем по очищенному описанию: ссылки, попавшие в
      // прошлый разворот, охват не расширяют.
      // Ссылка на декоратор ленивая — модуль telegram регистрируется позже нас,
      // а выключенный плагин и любой сбой отдают пустоту (см. modules/telegram).
      if (source && typeof fastify.telegramDiscussion === 'function') {
        const view = await fastify.telegramDiscussion(source, { project: await taskProject(task) });
        if (view.text) lines.push(`${DISCUSSION_SECTION_TITLE}\n${view.text}`);
      }

      lines.push('Используй контекст задачи, только если просьба к нему относится. На отвлечённые вопросы отвечай как обычно, без упоминания задачи.');
      return `[Задача чата]\n${lines.join('\n')}\n[/Задача чата]\n\n`;
    } catch {
      return '';
    }
  }

  /**
   * Единый запуск выбранного executor-а. cwd/доп-директории зависят от наличия задачи
   * и UI-контекста (страницы, с которой пишет пользователь).
   * Возвращает { reply, sessionId, cost, contextTokens } или reply-ошибку.
   */
  // ── Активные запуски агента: перезагруженная страница восстанавливает «думает…»
  // и уже показанную ленту шагов текущего хода. ──
  const activeRuns = new Map(); // ключ чата → { startedAt, tokens, steps[], ac, compact }

  // ── Живые сессии исполнителей ────────────────────────────────────────────────
  // Процесс агента переживает свой ход, поэтому фоновые команды и субагенты не гибнут
  // вместе с ответом, а CLI сам будит модель, когда они закончились. Такой НЕПРОШЕНЫЙ
  // ход некому вернуть ответом на HTTP-запрос — он уезжает тем же путём, что и ответы
  // после закрытого окна (chats/pending + SSE), поэтому доезжает во все окна разом.
  const liveSessions = new ChatLiveSessions({
    log: fastify.log,
    onBackgroundStep: ({ chatKey, step }) => {
      fastify.sse.broadcast('chat-step', { chatKey, step });
    },
    onBackgroundProgress: ({ chatKey, tokens, extra }) => {
      fastify.sse.broadcast('chat-progress', {
        chatKey,
        tokens,
        ...(Number.isFinite(extra?.contextTokens) ? { contextTokens: extra.contextTokens } : {}),
      });
    },
    // Состав живых процессов виден человеку («Настройки → Запуски»), поэтому его
    // изменения не должны ждать опроса. Событие означает «перечитай список», а не
    // несёт сам список: окно с закрытой карточкой не обязано за него платить.
    onChange: () => {
      fastify.sse.broadcast('chat-sessions', {});
    },
    onBackgroundTurn: async ({ chatKey, result }) => {
      try {
        await writeOrphan({
          id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          chatKey,
          role: 'assistant',
          ...normalizeExecutorContextCache(result),
          // Ход агент начал сам, значит человек его не заказывал и озвучивать нечего:
          // speechSafe остаётся выключенным, как у любого хода с действиями.
          speechSafe: false,
          unsolicited: true,
          at: Date.now(),
        });
        fastify.sse.broadcast('chat-orphan', { chatKey });
        fastify.log.info({ chatKey }, 'чат: непрошеный ход агента доставлен');
      } catch (error) {
        fastify.log.error({ chatKey, err: error?.message }, 'чат: непрошеный ход не сохранён');
      }
    },
  });
  fastify.addHook('onClose', async () => {
    await liveSessions.closeAll('остановка сервера');
  });

  // ── Очередь ходов на чат ─────────────────────────────────────────────────────
  // ДВА CLI НА ОДНУ СЕССИЮ НЕ ЖИВУТ: второй `claude --resume <тот же id>` падает
  // мгновенно (result без текста, subtype error_during_execution, turns=0, cost=0),
  // а человек видит «⚠ Агент завершил ход без текстового ответа» и повторяет вопрос —
  // порождая ещё один процесс-смертник. Такие повторы теряются до входа в CLI-сессию,
  // поэтому агент их не увидит.
  // Поэтому сообщение, пришедшее во время чужого хода, НЕ отклоняем и ввод не блокируем
  // (человек имеет право готовить следующее сообщение) — ставим в очередь: запрос висит,
  // пока не дойдёт черёд, и уходит сразу после текущего хода.
  const lastSession = new Map();  // chatKey → sessionId последнего завершённого хода

  /**
   * Сделать текущую Kimi session непригодной для resume, не удаляя сам vendor transcript.
   * Пустой binding остаётся server-owned маркером: старое окно ещё может прислать прежний
   * sessionId, но сервер его проигнорирует и заведёт новую сессию вместо forged resume.
   */
  async function invalidateKimiSession(chatKey, {
    expectedSessionId = '',
    reason = 'reset',
  } = {}) {
    const current = await bindingStore.read(chatKey);
    if (!current) return null;
    if (current.provider !== 'kimi') throw new Error('binding provider не совпал с Kimi');
    if (expectedSessionId && current.sessionId && current.sessionId !== expectedSessionId) {
      throw new Error('Kimi binding изменился до сброса session');
    }
    const next = current.sessionId
      ? await bindingStore.rotate(current, current.generation)
      : current;
    lastSession.delete(chatKey);
    fastify.log.info({ chatKey, reason }, 'Kimi session binding сброшен');
    return next;
  }

  // Допустимые режимы прав исполнителя: спрашиваем у CLI (executor.modes), кэшируем —
  // это запуск подпроцесса, гонять его на каждое сообщение незачем.
  const modesCache = new Map(); // providerId → { at, ids: Set }
  const MODES_TTL = 10 * 60 * 1000;

  async function allowedMode(executor, want) {
    if (!want || typeof executor?.modes !== 'function') return '';
    let entry = modesCache.get(executor.id);
    if (!entry || Date.now() - entry.at > MODES_TTL) {
      const list = await executor.modes(config).catch(() => null);
      entry = { at: Date.now(), ids: new Set((list || []).map((m) => m.id)) };
      modesCache.set(executor.id, entry);
    }
    // Список не прочитался — доверяем клиенту (он берёт значения из того же реестра).
    if (!entry.ids.size) return want;
    if (entry.ids.has(want)) return want;
    fastify.log.warn({ want, provider: executor.id }, 'чат: неизвестный режим прав — беру режим по умолчанию');
    return '';
  }

  fastify.get('/api/chat/active', async () => ({
    // `ac` наружу не отдаём: это AbortController хода, не данные для UI.
    active: [...activeRuns.entries()].map(([chatKey, v]) => ({
      chatKey,
      startedAt: v.startedAt,
      tokens: v.tokens,
      steps: v.steps,
      compact: !!v.compact,
      // Живой размер контекста идущего хода — чтобы F5 посреди часового хода не
      // возвращал кольцо к цифре с прошлого хода (у claude она бывает ДО автокомпакта).
      contextTokens: v.contextTokens || 0,
      ...(v.contextCache ? { contextCache: v.contextCache } : {}),
    })),
  }));

  /**
   * Живые процессы исполнителей: кто сейчас держит память, MCP-серверы и незакрытые
   * фоновые команды. Отдельная ручка от `/api/chat/active`: там ИДУЩИЕ ходы, здесь —
   * процессы, которые живут и между ходами. Свободная сессия ходом не занята, но
   * ресурсы держит, и увидеть её иначе нечем — в `ps` она выглядит обычным CLI.
   */
  fastify.get('/api/chat/sessions', async () => {
    const sessions = await Promise.all(liveSessions.stats().map(async (session) => {
      const head = await chatHeadOf(session.chatKey);
      return {
        ...session,
        chatTitle: head.title,
        taskId: head.taskId,
        // Ход может идти и вне живой сессии (её тумблер выключили после старта), поэтому
        // занятость сверяем с реестром ходов, а не только с признаком самого пула.
        running: activeRuns.has(session.chatKey) || turnLocks.isBusy({ chatKey: session.chatKey }),
      };
    }));
    return {
      enabled: (prefs?.read?.() || {}).chatLiveSessions !== false,
      ...liveSessions.limits(),
      sessions,
    };
  });

  /**
   * Погасить один процесс. По умолчанию отказываем на идущем ходе: убить процесс под
   * работающим агентом — это потерять его работу без предупреждения. Явный `force=1`
   * (второе нажатие человека) сначала обрывает ход, чтобы окно получило понятное
   * «Ход остановлен», а не необъяснимый обрыв.
   */
  fastify.delete('/api/chat/sessions/:chatKey', async (request, reply) => {
    const chatKey = String(request.params?.chatKey || '');
    if (!chatKey) return reply.code(400).send({ error: 'bad_chat_key' });
    if (!liveSessions.has(chatKey)) return reply.code(404).send({ error: 'no_live_session' });

    const force = String(request.query?.force || '') === '1';
    const busy = activeRuns.has(chatKey) || turnLocks.isBusy({ chatKey });
    if (busy && !force) {
      return reply.code(409).send({
        error: 'chat_busy',
        message: 'в этом чате идёт ход: останови его или погаси сессию вместе с ходом',
      });
    }
    if (busy) {
      dropPending(chatKey, 'Сессия агента погашена');
      activeRuns.get(chatKey)?.ac?.abort();
    }
    await liveSessions.close(chatKey, force ? 'погашена человеком вместе с ходом' : 'погашена человеком');
    fastify.log.info({ chatKey, forced: busy }, 'чат: живая сессия погашена человеком');
    return { ok: true, forced: busy };
  });

  /**
   * Погасить всё свободное. Занятые ходом сессии пропускаются намеренно: массовое
   * действие не должно молча обрывать работу, поэтому их гасят по одной и осознанно.
   */
  fastify.delete('/api/chat/sessions', async () => {
    let closed = 0;
    let skipped = 0;
    for (const session of liveSessions.stats()) {
      const busy = session.busy
        || activeRuns.has(session.chatKey)
        || turnLocks.isBusy({ chatKey: session.chatKey });
      if (busy) {
        skipped += 1;
        continue;
      }
      await liveSessions.close(session.chatKey, 'погашены свободные сессии');
      closed += 1;
    }
    fastify.log.info({ closed, skipped }, 'чат: живые сессии погашены человеком');
    return { ok: true, closed, skipped };
  });

  /**
   * Явный «сброс памяти» из UI. Для Kimi одного client-side `sessionId = null`
   * недостаточно: resume id принадлежит sidecar-у сервера и намеренно не доверяет
   * браузеру. Поэтому пользовательское действие подтверждается отдельным API-вызовом,
   * который только инвалидирует binding этого же сохранённого чата.
   */
  fastify.post('/api/chat/session/reset', async (request, reply) => {
    const chatKey = String(request.body?.chatKey || '');
    if (!chatKey) return reply.code(400).send({ error: 'bad_chat_key' });
    const record = await history.readOne(chatKey);
    if (!record) return reply.code(404).send({ error: 'unknown_chat' });
    const requestedRef = normalizeModelRef(request.body?.modelRef);
    if (requestedRef && !sameModelRef(record.modelRef, requestedRef)) {
      return reply.code(409).send({
        error: 'stale_chat_model',
        message: 'модель чата уже изменена в другом окне; перечитай чат перед сбросом памяти',
      });
    }
    // Живая сессия помнит разговор ВНУТРИ процесса, а не по --resume: пока она открыта,
    // локального обнуления sessionId в окне мало — агент продолжил бы помнить всё.
    const hasLive = liveSessions.has(chatKey);
    if ((hasLive || record.modelRef?.provider === 'kimi')
      && (activeRuns.has(chatKey) || turnLocks.isBusy({ chatKey }))) {
      return reply.code(409).send({
        error: 'chat_busy',
        message: 'сначала останови текущий ход, затем сбрось память агента',
      });
    }
    if (hasLive) await liveSessions.close(chatKey, 'сброс памяти агента');
    if (record.modelRef?.provider !== 'kimi') return { ok: true, reset: hasLive };
    // Проверка busy и постановка собственного chat lock идут без await между ними:
    // новый ход либо успевает первым (тогда 409 выше), либо ждёт уже пустой binding.
    const binding = await turnLocks.run({ chatKey }, () => (
      invalidateKimiSession(chatKey, { reason: 'user_reset' })
    ));
    return { ok: true, reset: !!binding, generation: binding?.generation ?? null };
  });

  /**
   * Стоп: агент ушёл не туда или завис. Executor, который поддерживает AbortSignal,
   * убивает процесс CLI — ход завершится
   * ошибкой `stopped`, и чат покажет «Ход остановлен» вместо бесконечного «думает…».
   * Ждущий ответа запрос разрешения тоже снимаем: отвечать уже некому.
   */
  fastify.post('/api/chat/stop', async (request) => {
    const chatKey = String(request.body?.chatKey || '');
    const run = activeRuns.get(chatKey);
    if (!run) return { ok: false, reason: 'нет активного хода' };
    dropPending(chatKey, 'Ход остановлен пользователем');
    run.ac?.abort();
    fastify.log.info({ chatKey }, 'чат: ход остановлен пользователем');
    return { ok: true };
  });

  // ── Всплывашка разрешений и диалог с агентом: ожидающие ответа пользователя запросы ──
  // pid → { resolve, direct, isQuestion, tool, input, chatKey, at }
  // `direct` — исполнитель ждёт ответа сам (kimi по ACP, ollama внутри цикла инструментов),
  // без локального HTTP MCP-процесса Claude. От него зависит только ФОРМА ответа, поэтому
  // вендорных веток здесь нет: новый исполнитель ничего не добавляет в ядро.
  const pendingPerms = permissionQueue.entries;
  // Ждём ответ СКОЛЬКО НУЖНО: «не успел за 4 минуты» — не повод продолжать без человека.
  // Сутки — верхняя граница здравого смысла, столько же держит вызов сам CLI
  // (MCP_TOOL_TIMEOUT, см. runChat). Раньше снимает только «стоп» или конец хода.
  const PERM_WAIT_MS = 24 * 60 * 60 * 1000;

  permissionQueue.subscribe?.((event) => {
    if (event.origin !== 'ssh' && event.entry?.origin !== 'ssh') {
      return;
    }
    if (event.type === 'waiting') {
      fastify.sse.broadcast('ssh-permission', { pid: event.entry.pid });
    } else {
      fastify.sse.broadcast('chat-permission-done', { pid: event.pid });
      fastify.sse.broadcast('ssh-permission', { pid: event.pid });
    }
  });

  /** Снять висящие запросы чата: ход кончился или остановлен — отвечать уже некому. */
  function dropPending(chatKey, message) {
    for (const [pid, p] of pendingPerms) {
      if (p.chatKey !== chatKey) continue;
      if (p.origin === 'ssh') {
        permissionQueue.cancel(pid, { allow: false, error: 'session_lost' });
        continue;
      }
      pendingPerms.delete(pid);
      p.resolve(p.direct
        ? { outcome: { outcome: 'cancelled' }, allow: false, message }
        : { behavior: 'deny', message });
      fastify.sse.broadcast('chat-permission-done', { pid });
    }
  }

  /** Та же всплывашка, но ответ возвращается исполнителю напрямую: ACP reverse-RPC
   * у Kimi, вызов внутри цикла инструментов у Ollama — локального HTTP MCP-процесса,
   * как у Claude, в этом пути нет. */
  function requestDirectInteraction(presentation, chatKey) {
    const pid = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const at = Date.now();
    const isQuestion = !!presentation?.isQuestion;
    const input = isQuestion
      ? { questions: presentation.questions || [] }
      : (presentation?.input || {});
    const tool = presentation?.tool || 'Действие агента';
    return new Promise((resolve) => {
      pendingPerms.set(pid, {
        resolve,
        direct: true,
        acceptsComment: !!presentation?.acceptsComment,
        // Свой текст в ответе на вопрос — тоже свойство канала: ACP-мост Kimi
        // возвращает только выбранный optionId, поэтому текст туда не влезает.
        // Умолчание «влезает» оставляет прежнее поведение остальным исполнителям.
        acceptsText: presentation?.acceptsText !== false,
        isQuestion,
        tool,
        input,
        chatKey: chatKey || '',
        at,
      });
      if (isQuestion) {
        fastify.sse.broadcast('chat-question', {
          pid, chatKey: chatKey || '', questions: input.questions, at,
        });
      } else {
        fastify.sse.broadcast('chat-permission', {
          pid, tool, input, chatKey: chatKey || '', at,
        });
      }
    });
  }

  /**
   * Шапка чата для висящего спроса: название и задача. Своего стора у окна кокпита
   * достаточно, но у ВНЕШНИХ потребителей (телеграм-пульт) истории нет вовсе, и вопрос
   * «Что именно выпиливаем?» без имени чата не отвечаем — их у человека несколько.
   * Кэш короткий: `/api/chat/waiting` зовёт каждое окно на каждый `hello`, а чтение
   * файла на этом пути не должно дорожать от числа окон.
   */
  const waitingChatInfo = new Map(); // chatKey → { at, title, taskId }
  const WAITING_INFO_TTL_MS = 30_000;
  async function chatHeadOf(chatKey) {
    if (!chatKey) return { title: '', taskId: null };
    const cached = waitingChatInfo.get(chatKey);
    if (cached && Date.now() - cached.at < WAITING_INFO_TTL_MS) return cached;
    let head = { at: Date.now(), title: '', taskId: null };
    try {
      const chat = await history.peek(chatKey);
      if (chat) {
        head = {
          at: Date.now(),
          title: typeof chat.title === 'string' ? chat.title : '',
          taskId: chat.taskId == null ? null : String(chat.taskId),
        };
      }
    } catch (error) {
      fastify.log.warn({ err: error.message }, 'шапка чата для висящего спроса не прочиталась');
    }
    waitingChatInfo.set(chatKey, head);
    if (waitingChatInfo.size > 200) {
      for (const [key, value] of waitingChatInfo) {
        if (Date.now() - value.at >= WAITING_INFO_TTL_MS) waitingChatInfo.delete(key);
      }
    }
    return head;
  }

  // Что сейчас ждёт человека — чтобы окно после F5 (и второе окно) подняло всплывашки:
  // SSE доставляет событие один раз, а запрос висит, пока на него не ответят.
  fastify.get('/api/chat/waiting', async (request) => {
    const includeSsh = request.query?.include === 'ssh' && request.authKind === 'session';
    const entries = [...pendingPerms.entries()].filter(([, pending]) => (
      pending.origin !== 'ssh' || includeSsh
    ));
    return {
      waiting: await Promise.all(entries.map(async ([pid, p]) => {
      const head = await chatHeadOf(p.chatKey);
      if (p.origin === 'ssh') {
        return {
          pid,
          origin: 'ssh',
          chatKey: p.chatKey,
          at: p.at,
          chatTitle: head.title,
          taskId: head.taskId,
          canRemember: false,
          ...p.presentation,
        };
      }
      return {
        pid, chatKey: p.chatKey, at: p.at,
        chatTitle: head.title,
        taskId: head.taskId,
        ...(p.isQuestion ? { questions: p.input?.questions || [] } : { tool: p.tool, input: p.input }),
      };
      })),
    };
  });

  /**
   * Ответ пользователя на вопрос агента (AskUserQuestion) в виде текста для агента.
   * ПОЧЕМУ deny: в headless-режиме сам инструмент отвечать некому — выполненный
   * AskUserQuestion возвращает агенту пустое «User has answered your questions: .».
   * Единственный канал, по которому текст доезжает дословно, — message отказа
   * (проверено: агент читает его как обычный результат инструмента и продолжает).
   */
  function answerText(answers) {
    const lines = (answers || [])
      .filter((a) => a && (a.selected?.length || a.text))
      .map((a) => `• ${a.header || a.question || 'ответ'}: ${[...(a.selected || []), a.text].filter(Boolean).join(', ')}`);
    if (!lines.length) return 'Пользователь не стал отвечать на вопрос. Действуй по своему усмотрению или спроси иначе.';
    return `Ответ пользователя из кокпита:\n${lines.join('\n')}\nПродолжай с учётом этого ответа, повторно спрашивать не нужно.`;
  }

  /**
   * Текст отказа для агента. Пояснение из модалки прилагаем дословно — иначе агент
   * получает голое «отклонил» и не знает, что менять (для плана это разница между
   * доработкой по замечаниям и гаданием). Канал тот же, что у ответов на вопросы.
   */
  function denyText(tool, comment) {
    if (!comment) return 'Пользователь отклонил действие в кокпите';
    return tool === 'ExitPlanMode'
      ? `Пользователь отправил план на доработку. Что изменить: ${comment}`
      : `Пользователь отклонил действие в кокпите. Пояснение: ${comment}`;
  }

  // Сюда стучится permission-mcp.js (child-процесс claude). Держим запрос открытым,
  // пока пользователь не нажмёт кнопку во всплывашке / не ответит на вопрос (или таймаут).
  fastify.post('/api/chat/permission-request', async (request, reply) => {
    const { tool_name, input, chatKey } = request.body || {};
    // MCP разрешений Claude — отдельный локальный HTTP-канал, поэтому он обходит
    // runArgs.onPermission. Небезопасный след закрепляем за ходом до ожидания человека:
    // поздний скользящий хвост из 400 шагов не должен его стереть.
    const permissionRun = activeRuns.get(chatKey);
    if (permissionRun) permissionRun.speechSafe = false;
    const pid = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    // Вопрос агента — не разрешение, а диалог: показываем варианты, а не «разрешить/отклонить».
    const isQuestion = tool_name === 'AskUserQuestion';
    const at = Date.now();
    return new Promise((resolve) => {
      // chatKey запоминаем, чтобы «стоп» и конец хода сняли именно запросы этого чата.
      pendingPerms.set(pid, { resolve, provider: 'claude', isQuestion, tool: tool_name || '?', input: input || {}, chatKey: chatKey || '', at });
      // Агент умер, пока мы ждали человека (упал, убит извне) — снимаем спрос сами,
      // иначе он остался бы висеть на экране навсегда: отвечать в мёртвый процесс некому.
      //
      // Слушаем ОТВЕТ, а не запрос. `request.raw` здесь — уже дочитанный поток тела:
      // json-парсер Fastify высасывает его до конца ДО обработчика, поток автоуничтожается
      // и шлёт свой 'close' на ближайшем тике — то есть сразу, при живом агенте. С
      // `request.raw.on('close')` каждый вопрос мгновенно отклонялся с «Агент отключился»,
      // а всплывашка успевала лишь мигнуть на экране. У `reply.raw` 'close' означает то,
      // что нужно: ответ дописан (тогда pid уже снят — сработает guard ниже) либо
      // соединение оборвалось раньше времени, то есть агента не стало.
      // На GET без тела (SSE, plugins/sse.js) подвоха нет: там тело никто не читает.
      reply.raw.on('close', () => {
        if (!pendingPerms.has(pid)) return;
        pendingPerms.delete(pid);
        fastify.sse.broadcast('chat-permission-done', { pid });
        resolve({ behavior: 'deny', message: 'Агент отключился' });
      });
      if (isQuestion) {
        fastify.sse.broadcast('chat-question', { pid, chatKey: chatKey || '', questions: input?.questions || [], at });
      } else {
        fastify.sse.broadcast('chat-permission', { pid, tool: tool_name || '?', input: input || {}, chatKey: chatKey || '', at });
      }
    });
  });

  // Ответ пользователя из браузера: разрешение (allow) либо ответы на вопросы (answers).
  fastify.post('/api/chat/permission/:pid', async (request, reply) => {
    const pid = String(request.params.pid);
    const p = pendingPerms.get(pid);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.origin === 'ssh') {
      return reply.code(409).send({ error: 'origin_mismatch' });
    }
    pendingPerms.delete(pid);
    fastify.sse.broadcast('chat-permission-done', { pid });
    const body = request.body || {};
    // Пояснение к отказу из модалки. У claude едет агенту в deny-message (канал ответов
    // на вопросы), у прямых исполнителей отдельного текстового канала нет — фронт по
    // флагу commentDelivered отправит его отдельным сообщением в очередь чата.
    const comment = String(body.comment || '').trim().slice(0, 4000);
    if (p.direct && p.isQuestion) {
      const answers = Array.isArray(body.answers) ? body.answers : [];
      const text = answers.map((answer) => answer?.text || '').find(Boolean) || '';
      p.resolve({
        selected: answers.flatMap((answer) => answer?.selected || []).filter(Boolean),
        text,
      });
      // Свой текст в ответе доезжает не всегда (см. acceptsText): молчаливая потеря
      // выглядела бы как «агент проигнорировал ответ», поэтому говорим прямо — фронт
      // отправит его обычным сообщением в очередь чата.
      return text && !p.acceptsText ? { ok: true, textDelivered: false } : { ok: true };
    } else if (p.direct) {
      // `remember` («разрешать до конца сессии») и `choice` (кнопка плана) — часть
      // ответа КАНАЛУ: у ACP это выбор конкретного optionId (allow_always, plan_*),
      // а не отдельная политика кокпита. Исполнитель, который таких вариантов не
      // предлагает, поля просто игнорирует.
      p.resolve({
        allow: body.allow === true,
        comment,
        remember: body.remember === true,
        choice: typeof body.choice === 'string' ? body.choice.slice(0, 100) : '',
      });
      // Дойдёт ли пояснение до агента — свойство КАНАЛА, а не вендора: ACP-outcome Kimi
      // текста не несёт, а результат инструмента Ollama несёт. Канал сам об этом и
      // сообщает при создании запроса (presentation.acceptsComment).
      return comment && !p.acceptsComment ? { ok: true, commentDelivered: false } : { ok: true };
    } else if (p.isQuestion) {
      p.resolve({ behavior: 'deny', message: answerText(body.answers) });
    } else {
      p.resolve(body.allow
        ? { behavior: 'allow', updatedInput: p.input }
        : { behavior: 'deny', message: denyText(p.tool, comment) });
    }
    return { ok: true };
  });

  // ── Недоставленные ответы: клиент умер (F5/закрытие вкладки), пока агент работал ──
  // Ответ пишем в chats/pending/<id>.json; фронт при загрузке подбирает их
  // (GET /api/chat/pending), раскладывает по чатам и подтверждает (DELETE).
  const pendingDir = path.join(config.chatsDir, 'pending');

  async function writeOrphan(entry) {
    await fs.mkdir(pendingDir, { recursive: true });
    const p = path.join(pendingDir, `${entry.id}.json`);
    await fs.writeFile(p + '.tmp', JSON.stringify(entry));
    await fs.rename(p + '.tmp', p);
  }

  fastify.get('/api/chat/pending', async () => {
    const pending = [];
    let files = [];
    try { files = await fs.readdir(pendingDir); } catch { return { pending }; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { pending.push(JSON.parse(await fs.readFile(path.join(pendingDir, f), 'utf8'))); }
      catch { /* битый файл — подберём/удалят руками */ }
    }
    return { pending };
  });

  fastify.delete('/api/chat/pending/:id', async (request) => {
    const id = String(request.params.id).replace(/[^\w.-]/g, '');
    if (id) await fs.rm(path.join(pendingDir, `${id}.json`), { force: true });
    return { ok: true };
  });

  /**
   * Точка входа роутов: ход либо стартует сразу, либо встаёт в очередь чата.
   * Ответ на HTTP-запрос приходит по завершении СВОЕГО хода — клиенту ждать дольше,
   * зато сообщение не теряется и агент видит его в правильном порядке.
   */
  /** Model/chat identity без side effects binding-а: strict companion gate использует
   * этот срез до очереди и до любого session state. */
  async function resolveModelTarget(opts, knownRecord = undefined) {
    const registry = await modelsRegistry(config);
    const chatKey = String(opts.chatKey || '');
    const record = knownRecord === undefined
      ? (chatKey ? await history.readOne(chatKey) : null)
      : knownRecord;
    if (chatKey && !record) {
      return { ok: false, error: 'unknown_chat', message: 'чат ещё не сохранён на сервере' };
    }

    const requestedRef = normalizeModelRef(opts.modelRef);
    if (record?.modelRef && requestedRef && !sameModelRef(record.modelRef, requestedRef)) {
      return {
        ok: false,
        error: 'stale_chat_model',
        message: 'модель чата уже изменена в другом окне; перечитай чат перед запуском',
      };
    }
    // При наличии chatKey источником является только сохранённая запись. Legacy-поля
    // запроса допускаются лишь для старых вызовов без chat record.
    const resolution = record
      ? resolveModelRef(record.modelRef, registry)
      : (requestedRef
        ? resolveModelRef(requestedRef, registry)
        : resolveLegacyModel(opts.model, registry));
    if (!resolution.ok) {
      const messages = {
        invalid_model_ref: 'ссылка на модель повреждена',
        missing_model: 'модель чата не выбрана',
        ambiguous_model: 'legacy model неоднозначна — выбери provider и модель заново',
        unknown_provider: 'исполнитель модели неизвестен',
        unknown_model: 'модель отсутствует в актуальном реестре',
      };
      return {
        ok: false,
        error: resolution.error,
        message: messages[resolution.error] || 'модель чата нельзя разрешить',
      };
    }
    const provider = resolution.modelRef.provider;
    return {
      ok: true,
      record,
      provider,
      model: resolution.modelRef.model,
      modelInfo: resolution.model,
    };
  }

  async function resolveRunTarget(opts, modelTarget = null) {
    const resolved = modelTarget || await resolveModelTarget(opts);
    if (!resolved.ok) return resolved;
    const {
      record, provider, model, modelInfo,
    } = resolved;
    const chatKey = String(opts.chatKey || '');
    let binding = null;
    let sessionId = opts.sessionId || null;
    if (provider === 'kimi') {
      if (record?.surface !== 'chats') {
        return { ok: false, error: 'provider_surface_denied', message: 'Kimi доступен только пользовательским чатам' };
      }
      binding = await bindingStore.read(chatKey);
      // Клиентский sessionId никогда не участвует в Kimi resume. При живом binding
      // несовпадающее значение считаем forged/stale. Пустой binding — намеренная
      // инвалидация после reset/пустого хода: старый id из отставшего окна безопасно
      // игнорируем, потому что executor всё равно получит null и создаст новую session.
      if (opts.sessionId && (!binding || (binding.sessionId && opts.sessionId !== binding.sessionId))) {
        return { ok: false, error: 'forged_session', message: 'sessionId не принадлежит этому чату' };
      }
      sessionId = binding?.sessionId || null;
    }
    return {
      ok: true,
      record,
      binding,
      provider,
      model,
      modelInfo,
      sessionId,
    };
  }

  function companionFailure(error, message, statusCode = 409) {
    return { ok: false, statusCode, error, message };
  }

  /**
   * Restrictive marker не является полномочием: он принимается только для durable
   * server-created companion identity и exact route scope. Каталог plan читается
   * свежим и fail-closed ДО Kimi binding, turnLocks и activeRuns.
   */
  async function strictCompanionPreflight(opts) {
    const chatKey = String(opts.chatKey || '');
    const record = chatKey ? await history.readOne(chatKey) : null;
    let recordTaskId;
    let expectedIdentity = '';
    if (record?.purpose === 'companion') {
      try {
        recordTaskId = normalizeCompanionTaskId(record.taskId);
        expectedIdentity = companionLogicalIdentity(recordTaskId);
      } catch { /* повреждённая запись не становится execution identity */ }
      if (!expectedIdentity || record.logicalIdentity !== expectedIdentity) {
        return companionFailure(
          'companion_chat_required',
          'Chat key не принадлежит корректной server-owned companion identity.',
        );
      }
      let routeTaskId;
      try { routeTaskId = normalizeCompanionTaskId(opts.id); }
      catch {
        return companionFailure('companion_scope_mismatch', 'Маршрут хода не совпадает со scope companion-чата.');
      }
      if (routeTaskId !== recordTaskId) {
        return companionFailure('companion_scope_mismatch', 'Маршрут хода не совпадает со scope companion-чата.');
      }
    }

    // Durable companion identity определяет task route даже на полной странице /chats.
    // Только дополнительные ограничения быстрого bubble-turn зависят от marker-а.
    if (opts.companionTurn !== true) return { ok: true, record };
    if (!chatKey || record?.purpose !== 'companion' || !expectedIdentity) {
      return companionFailure('companion_chat_required', 'Companion turn требует сохранённый companion-чат.');
    }
    if (opts.mode !== 'plan') {
      return companionFailure('companion_plan_required', 'Companion turn допускает только точный режим plan.');
    }
    if (opts.attachments != null || opts.slashCommand != null) {
      return companionFailure(
        'companion_turn_unsupported',
        'Companion turn v1 принимает только typed/voice text без вложений и slash-команд.',
      );
    }
    let taskSandbox = null;
    if (recordTaskId) {
      if (!await companionTaskExists(recordTaskId)) {
        return companionFailure(
          'companion_task_unavailable',
          'Задача больше не подтверждается server-owned реестром.',
        );
      }
      taskSandbox = await companionTaskSandbox(recordTaskId);
      if (!taskSandbox) {
        return companionFailure(
          'companion_task_sandbox_unavailable',
          'Для задачи ещё нет подтверждённого worktree; продолжите в полном чате или запустите конвейер.',
        );
      }
    }

    const modelTarget = await resolveModelTarget(opts, record);
    if (!modelTarget.ok) return modelTarget;
    let executor = null;
    let planDeclared = false;
    try {
      executor = await executorResolver(modelTarget.provider);
      if (typeof executor?.modes === 'function') {
        const catalog = await Promise.resolve(executor.modes(config));
        planDeclared = Array.isArray(catalog) && catalog.some((mode) => mode?.id === 'plan');
      }
    } catch { /* любой сбой каталога означает fail-closed */ }
    if (!planDeclared) {
      return companionFailure(
        'companion_plan_unavailable',
        `Исполнитель ${modelTarget.provider} не подтвердил безопасный режим plan.`,
      );
    }
    return {
      ok: true, record, modelTarget, executor, taskSandbox,
    };
  }

  async function runChat(reply, request, opts) {
    const chatKey = String(opts.chatKey || '');
    // DELETE ставит marker до первого filesystem await; новый ход не имеет права
    // вклиниться между busy-check и удалением durable identity.
    if (chatKey && deletingChats.has(chatKey)) {
      return reply.code(409).send({
        error: 'chat_busy',
        message: 'Чат сейчас удаляется; повторите действие после синхронизации истории.',
      });
    }
    const releaseAcceptedTurn = beginAcceptedTurn(chatKey);
    try {
      const strict = await strictCompanionPreflight(opts);
      if (!strict.ok) {
        return reply.code(strict.statusCode || 400).send({
          error: strict.error,
          message: strict.message,
        });
      }
      // Client context — только bounded prompt data. Нормализуем ровно один раз до
      // очереди хода; contextPrefix узнаёт созданный здесь объект и повторно его не читает.
      const droppedContext = [];
      const normalizedContext = normalizeUiContext(opts.context, {
        onDrop({ code, key = '' }) {
          if (droppedContext.length >= 16) return;
          const item = `${code}:${key}`;
          if (!droppedContext.includes(item)) droppedContext.push(item);
        },
      });
      if (droppedContext.length) {
        fastify.log.warn({ dropped: droppedContext }, 'часть UI-контекста чата отброшена');
      }
      const modelTarget = strict.modelTarget || await resolveModelTarget(opts, strict.record);
      const target = await resolveRunTarget(opts, modelTarget);
      if (!target.ok) return reply.code(400).send({ error: target.error, message: target.message });
      if (strict.executor) {
        target.strictExecutor = strict.executor;
        target.strictPermissionMode = 'plan';
      }
      const scope = { chatKey, provider: target.provider, sessionId: target.sessionId };
      const queued = turnLocks.isBusy(scope);
      if (queued) {
        fastify.log.info({ chatKey }, 'чат: ход уже идёт — сообщение поставлено в очередь');
        // Второму окну (и своему же, если оно захочет показать «в очереди») — сигнал.
        fastify.sse.broadcast('chat-queued', { chatKey, at: Date.now() });
      }
      const result = await turnLocks.run(scope, async () => {
        let lockedStrict = strict;
        let lockedSandbox = strict.taskSandbox || null;
        if (opts.companionTurn === true) {
          // За время в очереди могли измениться каталог, durable identity или attempt.
          // Повторяем проверку внутри chat lock до binding/activeRuns/executor spawn.
          lockedStrict = await strictCompanionPreflight(opts);
          if (!lockedStrict.ok) {
            return reply.code(lockedStrict.statusCode || 400).send({
              error: lockedStrict.error,
              message: lockedStrict.message,
            });
          }
          if (lockedStrict.modelTarget.provider !== target.provider
            || lockedStrict.modelTarget.model !== target.model) {
            return reply.code(409).send({
              error: 'companion_target_changed',
              message: 'Исполнитель companion-чата изменился во время ожидания; повторите ход.',
            });
          }
          // После свежего modes() ещё раз читаем sandbox, чтобы между authoritative
          // snapshot и передачей cwd в runChatTurn не было другого await.
          lockedSandbox = opts.id ? await companionTaskSandbox(opts.id) : null;
          if (opts.id && !lockedSandbox) {
            return reply.code(409).send({
              error: 'companion_task_sandbox_unavailable',
              message: 'Worktree задачи изменился или исчез во время ожидания; ход не запущен.',
            });
          }
          target.strictExecutor = lockedStrict.executor;
          target.strictPermissionMode = 'plan';
        }
        return runChatTurn(reply, request, {
          ...opts,
          context: normalizedContext,
          model: target.model,
          sessionId: target.sessionId,
          target,
          companionTaskSandbox: lockedSandbox,
          queued,
        });
      });
      return result;
    } finally {
      releaseAcceptedTurn();
    }
  }

  async function runChatTurn(reply, request, {
    id, message, model, effort, mode: wantMode, sessionId, context, attachments,
    chatKey, queued, requestTitle, sentAt, compact, slashCommand, target,
    companionTaskSandbox: trustedCompanionSandbox, companionTurn,
  }) {
    // Клиент фиксирует момент нажатия «отправить» до durable save. Он нужен только
    // страховочной записи pending: если окно закрылось и вопрос пришлось восстановить,
    // его точное время не должно превращаться во время готовности ответа.
    const userSentAt = Number.isSafeInteger(sentAt) && sentAt > 0 ? sentAt : 0;
    const orphanUser = {
      userText: message || '',
      hadAttachments: !!attachments?.length,
      ...(userSentAt ? { userSentAt } : {}),
    };
    // Сообщение ждало в очереди — его sessionId устарел: пока оно стояло, предыдущий ход
    // мог завести новый id, и запуск со старым потерял бы контекст разговора. Пустой
    // sessionId не трогаем: это осознанный старт нового разговора, а не устаревшая копия.
    if (queued && sessionId && lastSession.get(chatKey)) sessionId = lastSession.get(chatKey);
    // Чат без задачи стартует из корня репозитория кокпита: исполнитель сразу видит
    // корневые AGENTS.md/CLAUDE.md, а engine/ остаётся внутри рабочего дерева.
    let cwd = config.rootDir;
    // Настройка читается перед каждым ходом: кнопка в настройках действует сразу,
    // без рестарта сервера и без изменения глобальных конфигов конкретных CLI.
    const extraDirs = [...(prefs?.read().trustedDirectories || [])];
    if (id) {
      const parsed = trustedCompanionSandbox
        || parseSandboxRepositories(await factoryState.readEnv(id));
      if (parsed.kind === 'invalid') {
        return reply.code(409).send({
          error: 'invalid_sandbox_env',
          message: 'Реестр worktree задачи повреждён — task-chat не запущен.',
        });
      }
      const { repos } = parsed;
      if (repos.length) {
        cwd = repos[0].path;
        extraDirs.push(...repos.slice(1).map((repo) => repo.path));
      }
    }
    // Вложения: клиент присылает имена файлов, ранее загруженных через /api/chat/upload.
    // Пути строим сами (только внутри attachDir) и открываем агенту доступ через --add-dir.
    let attachBlock = '';
    const attachPaths = (await Promise.all(
      (attachments || []).map((a) => attachFile(a?.file)),
    )).filter(Boolean);
    if (attachPaths.length) {
      // Kimi получает private staging только из перечисленных файлов. Весь каталог
      // вложений в его mount namespace не попадает.
      if (target.provider !== 'kimi') extraDirs.push(attachDir);
      attachBlock = `[Вложения]\nПользователь приложил файлы (открой их инструментом Read):\n${attachPaths.map((p) => `- ${p}`).join('\n')}\n[/Вложения]\n\n`;
    }
    // Один и тот же каталог может прийти из доверенного списка, worktree и вложений.
    // Повторные --add-dir не опасны, но засоряют командную строку и диагностику.
    const uniqueExtraDirs = [...new Set(extraDirs.map((dir) => path.resolve(dir)))];

    // Target уже разрешён строго по сохранённому modelRef до взятия locks. Никакого
    // fallback к Claude здесь больше нет.
    const info = { provider: target.provider, model: target.modelInfo };
    const executor = target.strictExecutor || await executorResolver(target.provider);

    // Служебный слэш-ход провайдерской команды (меню «/» в чате). Признак принимаем
    // строго: команда обязана быть в списке commands() исполнителя с run:'prompt', а
    // текст хода — ей самой (с необязательными аргументами через пробел). Иначе полем
    // можно было бы обойти титул-хук и договорённости о повторах для обычного текста.
    let slash = null;
    if (!compact && slashCommand != null) {
      const want = String(slashCommand);
      const text = String(message || '').trim();
      // `$skill` тоже лежит в каталоге commands(), но это обычный model prompt:
      // служебный флаг разрешён только настоящим `/`-командам CLI. Форму проверяем
      // ДО чтения каталога: у codex это подъём app-server, а ответ всё равно 400.
      const list = /^\/\S+$/.test(want) && typeof executor?.commands === 'function'
        ? await Promise.resolve(executor.commands(config)).catch(() => [])
        : [];
      slash = list.find((c) => c.cmd === want && c.run === 'prompt'
        && (text === c.cmd || text.startsWith(`${c.cmd} `))) || null;
      if (!slash) {
        return reply.code(400).send({
          error: 'unknown_slash_command',
          message: `Команда ${want} не поддерживается исполнителем ${target.provider}.`,
        });
      }
    }
    // Служебному ходу титул-хук не приклеиваем: склейка превратила бы точную команду
    // в обычный промпт (kimi матчит ACP-команды побуквенно — гейт §3.2).
    const wantsTitle = requestTitle === true && !slash;

    // Сжатие контекста (кнопка на кольце) — служебный ход, а не сообщение человека: ни
    // контекст страницы, ни вложения, ни хук заголовка ему не нужны. План берём у
    // исполнителя: родная слэш-команда CLI (сессия сохраняется) либо выжимка текстом,
    // если слэш-команд в неинтерактивном режиме он не понимает (lib/executors/index.js).
    const plan = compact ? (executor?.compaction || { kind: 'summary' }) : null;
    // Тикет выбранной задачи — только обычному ходу: служебному сжатию он не нужен.
    const ticket = plan ? '' : await taskTicketBlock(id);
    // Досье прерванного хода — запасная память, когда resume невозможен: binding
    // мёртв (sessionId нет — после empty-run инвалидации), а последний ход был
    // остановлен. При живом binding следующий ход продолжит session резюмом, и
    // полный контекст не нужно дублировать выжимкой. Только Kimi и только обычный
    // ход: сжатию/слэш-команде ни досье, ни тикет не нужны.
    const stoppedBrief = (!plan && !slash && target.provider === 'kimi' && !target.binding?.sessionId)
      ? stoppedTurnBrief(target.record?.messages)
      : '';
    const fullMessage = plan
      ? (plan.kind === 'native' ? plan.message : SUMMARY_PROMPT)
      : withChatTitleHook(
        contextPrefix(context, pageHint(context?.path)) + ticket + attachBlock
        + (stoppedBrief ? `${stoppedBrief}\n\n` : '') + (message || 'Посмотри вложения.'),
        wantsTitle,
      );
    // Режим прав выбирает только пользователь в чате. UI-context не является
    // authorization surface и не даёт ни cwd, ни fallback permission mode.
    const permissionMode = target.strictPermissionMode || await allowedMode(executor, wantMode);
    if (!executor) return reply.code(400).send({ error: 'unknown_provider', message: `нет исполнителя для модели ${model}` });

    const workProjectId = await trustedWorkProject(id);
    const workToolScopeKey = `${workProjectId || 'none'}:${chatKey || id || 'free'}`;
    const workToolsValue = createWorkTools({
      projectId: workProjectId,
      chatKey,
      invoke: (scope, input) => (sshBroker
        ? sshBroker.invoke(scope, input)
        : Promise.resolve({ ok: false, error: 'not_available' })),
    });
    const workIpc = executor.workToolsTransport === 'mcp'
      ? await ensureWorkIpc(workToolScopeKey, workToolsValue)
      : null;

    // Уровень эффорта CLI не прощает: неизвестное значение приводит к ошибке
    // валидации. Не придумываем замену — принимаем только точное значение каталога.
    const levels = info?.model?.efforts || [];
    const resolvedEffort = resolveRequestedEffort(effort, levels);
    if (!resolvedEffort.ok) {
      return reply.code(400).send({
        error: 'unsupported_effort',
        message: levels.length
          ? `Уровень effort «${effort}» не поддерживается моделью ${model}. Доступно: ${levels.join(', ')}`
          : `Модель ${model} не сообщила поддерживаемые уровни effort. Отправь запрос без явного effort.`,
      });
    }
    const runEffort = resolvedEffort.effort;

    // Подготовка prompt/ticket/provider выше могла ждать произвольный I/O. Перед первой
    // мутацией binding/activeRuns/executor ещё раз подтверждаем физический exact worktree:
    // ранний canonical-снимок не даёт права запускаться по уже удалённому пути.
    if (companionTurn === true && id) {
      const currentSandbox = await companionTaskSandbox(id);
      if (!sameCompanionTaskSandbox(trustedCompanionSandbox, currentSandbox)) {
        return reply.code(409).send({
          error: 'companion_task_sandbox_unavailable',
          message: 'Worktree задачи изменился во время подготовки хода; ход не запущен.',
        });
      }
    }

    // Kimi session принадлежит не браузеру, а sidecar-у Cockpit. Все медленные части
    // prompt уже готовы; только теперь перечитываем binding и резервируем generation.
    let kimiBinding = null;
    let kimiIdentity = null;
    if (target.provider === 'kimi') {
      const cwdRealpath = trustedCompanionSandbox ? cwd : await fs.realpath(cwd);
      kimiIdentity = {
        chatKey,
        provider: 'kimi',
        cwdRealpath,
        model,
        authProfileId: KIMI_AUTH_PROFILE_ID,
        securityProfile: kimiSecurityProfile(config),
      };
      const current = await bindingStore.read(chatKey);
      const identityMatches = current
        && ['provider', 'cwdRealpath', 'model', 'authProfileId', 'securityProfile']
          .every((field) => current[field] === kimiIdentity[field]);
      if (!current || !identityMatches) {
        kimiBinding = await bindingStore.rotate(kimiIdentity, current?.generation ?? null);
      } else {
        kimiBinding = current;
      }
      sessionId = kimiBinding.sessionId || null;
      if (sessionId) {
        await bindingStore.assertResumeOwner({ chatKey, provider: 'kimi', sessionId });
      }
      cwd = cwdRealpath;
      // Binding I/O тоже могло занять время. Не запускаем executor со stale cwd даже
      // после уже созданного recoverable sidecar-а.
      if (companionTurn === true && id) {
        const currentSandbox = await companionTaskSandbox(id);
        if (!sameCompanionTaskSandbox(trustedCompanionSandbox, currentSandbox)) {
          return reply.code(409).send({
            error: 'companion_task_sandbox_unavailable',
            message: 'Worktree задачи исчез до запуска исполнителя; ход не запущен.',
          });
        }
      }
    }

    // Разрешения (claude): default-режим, на действия агент спрашивает через
    // наш MCP-инструмент → всплывашка в браузере.
    const mcpConfig = {
      mcpServers: {
        'cockpit-perm': {
          command: process.execPath,
          args: [PERM_MCP_PATH],
          // Сколько CLI готов ждать ответа на вызов инструмента. Без этого он обрывает
          // ожидание своим дефолтом (минуты) — и вопрос «висел» бы только у нас на экране,
          // а агент уже пошёл дальше. Дублируется переменной MCP_TOOL_TIMEOUT ниже.
          timeout: PERM_WAIT_MS,
          env: {
            COCKPIT_PERM_URL: `http://127.0.0.1:${config.port}/api/chat/permission-request`,
            COCKPIT_CHAT_KEY: chatKey || '',
            // Секрет процесса: у дочернего claude нет сессионной cookie, а вход в кокпит
            // закрывает весь /api — без этого заголовка разрешения и вопросы упирались бы в 401.
            COCKPIT_INTERNAL: internalToken || '',
          },
        },
        ...(workIpc ? { 'cockpit-work': workIpc.mcpServer } : {}),
      },
    };

    // Ход можно оборвать кнопкой «стоп»: контроллер живёт в activeRuns, POST /api/chat/stop
    // дёргает abort, execFile убивает CLI.
    const ac = new AbortController();
    // compact — служебный ход сжатия: окна показывают его не «думает…», а вертящимся
    // кольцом контекста. Флаг обязан быть здесь, а не только в затеявшем окне: у родного
    // компакта нет ни шагов, ни прогресса (см. ниже), так что второму устройству
    // догадаться о сжатии больше неоткуда.
    const runRec = {
      startedAt: Date.now(),
      tokens: 0,
      steps: [],
      ac,
      compact: !!plan,
      speechSafe: companionTurn === true,
      speechTraceSeen: false,
    };
    if (chatKey) {
      activeRuns.set(chatKey, runRec);
      // Ход пошёл: окна снимают со своего сообщения метку «ждёт очереди».
      fastify.sse.broadcast('chat-turn-start', { chatKey, at: runRec.startedAt, compact: !!plan });
    }
    // Ожидание ответа человека не должно упираться в таймаут вызова MCP-инструмента.
    const baseEnv = claudeAuth ? claudeAuth.env() : process.env;
    // Порог автокомпакта из «Настроек → Запуски» — только тем CLI, у кого такая ручка
    // вообще есть (executor.autoCompactEnv). Читаем перед каждым ходом: правка настройки
    // действует сразу, без рестарта сервера. 0 — не вмешиваемся, у CLI остаётся свой.
    const currentPrefs = prefs?.read?.() || {};
    const compactWindow = Math.max(0, Number(currentPrefs.chatAutoCompactWindow) || 0);
    const compactEnv = compactWindow && executor.autoCompactEnv
      ? { [executor.autoCompactEnv]: String(compactWindow) }
      : {};

    // Живая сессия: процесс исполнителя переживает свой ход. Только так фоновая команда
    // и субагент доживают до конца, а CLI получает возможность разбудить модель сам —
    // разовый запуск умирал вместе с ответом, и обещание «сообщу, когда закончится»
    // выполнить было физически нечем. Умеет ли исполнитель жить между ходами, объявляет
    // он сам (executor.session), а тумблер prefs оставлен для отката: живой процесс
    // держит память и свои MCP-серверы.
    const liveTurn = currentPrefs.chatLiveSessions !== false
      && executor.session?.mode === 'persistent'
      && !!chatKey;
    if (liveTurn) {
      // Кнопка «стоп» остаётся прежней ручкой: она дёргает abort, а мы превращаем его
      // в прерывание ХОДА. Убивать процесс больше нельзя — вместе с ним умрёт разговор.
      ac.signal.addEventListener('abort', () => {
        liveSessions.interrupt(chatKey).catch((error) => {
          fastify.log.warn({ chatKey, err: error?.message }, 'чат: не удалось прервать ход живой сессии');
        });
      }, { once: true });
    }

    try {
      const runArgs = {
        config,
        chatKey,
        signal: ac.signal,
        env: { ...baseEnv, MCP_TOOL_TIMEOUT: String(PERM_WAIT_MS), ...compactEnv },
        message: fullMessage,
        cwd,
        extraDirs: uniqueExtraDirs,
        model,
        effort: runEffort,
        sessionId,
        attachmentPaths: attachPaths,
        permissionMode,
        mcpConfig,
        mcpServers: workIpc ? [{ name: 'cockpit-work', ...workIpc.mcpServer }] : [],
        permissionPromptTool: 'mcp__cockpit-perm__approve',
        workTools: workToolsValue,
        workToolScopeKey,
        providerSettings: currentPrefs.providerSettings?.[executor.id] || {},
        // Server-owned снапшот истории чата: stateless HTTP-исполнители (Ollama)
        // реплеят из него разговор; CLI-исполнители поле игнорируют. Содержит и
        // текущее сообщение (клиент сохранил его до POST) — дубликат срезает executor.
        chatHistory: target.record?.messages,
        // Claude получает порог через env выше, Codex — как официальный config override
        // в своих exec-args. Одно значение настроек, transport выбирает сам executor.
        compactWindow,
        log: fastify.log,
        // ACP возвращает id новой сессии до prompt. Фиксируем его CAS-записью ДО
        // передачи пользовательского текста, чтобы другой чат не мог присвоить id.
        onSessionCreated: target.provider === 'kimi' ? async (newSessionId) => {
          const saved = await bindingStore.compareAndSwap({
            ...kimiIdentity,
            sessionId: newSessionId,
          }, kimiBinding.generation);
          kimiBinding = saved;
          sessionId = saved.sessionId;
          lastSession.set(chatKey, saved.sessionId);
        } : undefined,
        // Мост всплывашки для исполнителей, которые спрашивают кокпит напрямую (kimi по
        // ACP, ollama из своего цикла инструментов). Выдаётся всем: не поддерживающий
        // его executor просто не вызовет колбэк, а вендорной ветки в ядре не остаётся.
        onPermission: (presentation) => {
          runRec.speechSafe = false;
          // Кокпит-режим «auto»: исполнитель продолжает спрашивать (у Kimi ACP остаётся
          // в default), а на безопасные запросы отвечает общий классификатор.
          // Деструктивные и неизвестные формы по-прежнему уходят человеку во всплывашку.
          if (permissionMode === 'auto') {
            const decision = autoDecision(presentation);
            if (decision.verdict === 'allow') return { allow: true };
            fastify.log.info({ chatKey, tool: presentation?.tool, reason: decision.reason }, 'Авто-режим: действие — на подтверждение человеку');
          }
          return requestDirectInteraction(presentation, chatKey);
        },
        // Живой счётчик потраченных токенов → SSE → «думает… · N ток.» в чате.
        // Второе (необязательное) поле — ЗАПОЛНЕННОСТЬ контекста прямо сейчас: её знает
        // тот исполнитель, чей поток сообщает вход каждого обращения к модели (claude).
        // Не сообщил — кольцо живёт как раньше, цифрой с прошлого хода.
        onProgress: chatKey ? (tokens, info) => {
          const contextTokens = Number(info?.contextTokens) || 0;
          const contextCache = normalizeContextCache(info?.contextCache);
          const a = activeRuns.get(chatKey);
          if (a) {
            a.tokens = tokens;
            if (contextTokens) a.contextTokens = contextTokens;
            if (contextCache) a.contextCache = contextCache;
          }
          fastify.sse.broadcast('chat-progress', {
            chatKey, tokens, contextTokens,
            ...(contextCache ? { contextCache } : {}),
          });
        } : undefined,
        // Лента хода (размышления, инструменты, их результаты) — живьём в окно.
        // Копия в activeRuns: перезагрузка страницы посреди хода не теряет показанное.
        onStep: chatKey ? (step) => {
          // Эта аттестация монотонна и намеренно выполняется до фильтрации заголовка и
          // ограниченного хранения шагов. Озвучиваемый ход дают только допустимые нормализованные
          // виды; свидетельство ошибки, неизвестного вида или действия нельзя забывать.
          const speechKind = isPlainObject(step) && typeof step.k === 'string' && step.k
            ? step.k
            : null;
          if (speechKind) runRec.speechTraceSeen = true;
          if (!speechKind || !SPEECH_SAFE_STEP_KINDS.has(speechKind)) runRec.speechSafe = false;
          // Служебный маркер заголовка не показываем ни в живой ленте, ни после F5.
          const visibleStep = visibleChatTitleStep(step, wantsTitle);
          if (!visibleStep) return;
          const a = activeRuns.get(chatKey);
          // Тем же скользящим окном, что и sink: копия нужна окну, открытому ПОСРЕДИ
          // хода, а ему важно свежее. Раньше здесь копились первые 400 шагов, и после
          // F5 длинный ход показывал начало часовой давности вместо того, что идёт.
          if (a) {
            a.steps.push(visibleStep);
            if (a.steps.length > MAX_CHAT_STEPS) a.steps.splice(0, a.steps.length - MAX_CHAT_STEPS);
          }
          fastify.sse.broadcast('chat-step', { chatKey, step: visibleStep });
        } : undefined,
      };
      // Один вход для обоих путей: живая сессия отдаёт то же, что разовый запуск,
      // поэтому остальной код хода про смену модели работы ничего не знает.
      const runTurn = () => (liveTurn
        ? liveSessions.run({ ...runArgs, executor }, {
          message: runArgs.message,
          onStep: runArgs.onStep,
          onProgress: runArgs.onProgress,
        })
        : executor.run(runArgs));

      let out = await runTurn();
      // Пустой ход (ноль шагов, ноль стоимости) = CLI умер на старте и НИЧЕГО не сделал.
      // Повторить его безопасно — и честнее, чем отдать человеку заглушку и ждать, что
      // он пришлёт сообщение заново (а он пришлёт — и получит то же самое).
      // Ход сжатия не повторяем: у родного компакта stdout пуст ВСЕГДА (вывод слэш-команды
      // локальный, в поток он не идёт), так что «пустой ход» тут — норма, а второй прогон
      // сжал бы уже сжатое. Та же логика у служебного слэш-хода: команда выполнена, повтор
      // небезопасен (например claude /clear начал бы ещё одну сессию).
      if (!slash && mayRetryEmptyRun(executor, out, { compact: !!plan })) {
        fastify.log.warn({ chatKey, subtype: out.subtype }, 'чат: ход пустой (ноль шагов) — повторяю один раз');
        out = await runTurn();
      }
      out = normalizeExecutorContextCache(out);
      // ACP может вернуть end_turn без единого chunk/шага. После принятого prompt
      // повторять нельзя: модель могла выполнить действие, а ответ потеряться. Но и
      // выдавать `(пусто)` как успешный ответ нельзя. На pinned Kimi 0.31.1 так ход
      // завершался после resume отменённой сессии (на 0.33.0 не воспроизводится, см.
      // tools/kimi-resume-smoke.mjs); ветка остаётся страховкой: инвалидируем только
      // binding, чтобы следующий ЯВНЫЙ запрос пользователя начал чистую session без
      // автоповтора, а досье (stopped-brief) передаст туда выжимку сделанного.
      // Служебный слэш-ход под эту ловушку не попадает: молчание команды — штатно.
      if (!slash && !plan && target.provider === 'kimi' && out?.emptyRun) {
        try {
          await invalidateKimiSession(chatKey, {
            expectedSessionId: out.sessionId || sessionId || '',
            reason: 'empty_post_prompt',
          });
        } catch (resetError) {
          fastify.log.error({ chatKey, err: resetError.message }, 'Kimi binding после пустого хода не сброшен');
          const error = new Error('Kimi завершил ход без ответа, но сессию сбросить не удалось. Выполни явный сброс памяти перед повтором.');
          error.code = 'kimi_session_reset_failed';
          error.sessionResetFailed = true;
          throw error;
        }
        const error = new Error('Kimi завершил ход без ответа. Сессия сброшена; повтори сообщение явно.');
        error.code = 'kimi_empty_response';
        error.sessionReset = true;
        throw error;
      }
      // Название — метаданные Cockpit, маркер из видимого ответа/истории уже удалён.
      out = finishChatTitleHook(out, wantsTitle);
      // Итог сжатия. Наружу — короткая строка для ленты: сырой вывод тут либо пуст
      // (родной компакт), либо это сама выжимка — она не ответ агента человеку, а семя
      // новой сессии, поэтому уезжает отдельным полем. contextTokens этого хода —
      // размер контекста ДО сжатия (выжимку писали, читая всю переписку), поэтому его
      // не отдаём вовсе: настоящий размер измерит следующий обычный ход.
      if (plan) {
        const seed = plan.kind === 'summary' ? String(out.reply || '').trim() : '';
        if (plan.kind === 'summary' && !seed) throw new Error('Исполнитель не вернул выжимку — контекст не сжат.');
        out = {
          ...out,
          reply: '🗜 Контекст сжат.',
          contextTokens: 0,
          compact: { kind: plan.kind, seed },
        };
      }
      // Служебная команда без вывода — не «пустой ход», а штатное молчание локальной
      // команды: подтверждаем плашкой (role: note на клиенте), как это делает сжатие.
      if (slash && !String(out?.reply || '').trim()) {
        out = { ...out, reply: `✓ Команда ${slash.cmd} выполнена локально — вывода нет.`, note: true };
      }
      // Актуальный id разговора: с ним пойдут сообщения, ждущие в очереди этого чата.
      if (chatKey && out?.sessionId) lastSession.set(chatKey, out.sessionId);
      // Окончательный вердикт при последней записи принадлежит серверу: исполнитель не может
      // сам подтвердить это поле, а ограниченный хвост `out.steps` не доказывает отсутствие раннего действия.
      const speechSafe = companionTurn === true
        && runRec.speechSafe === true
        && runRec.speechTraceSeen === true
        && !plan
        && !slash
        && !out?.note;
      // Клиент не дождался (перезагрузка/закрытие вкладки) — ответ в pending, подберётся при загрузке.
      if (request.socket.destroyed && chatKey) {
        // userText — страховка от гонки last-write-wins: если вопрос пользователя
        // не успел сохраниться в стор, клиент восстановит его перед ответом.
        await writeOrphan({ id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          chatKey, role: out?.note ? 'note' : 'assistant', ...out, model: model || null, effort: runEffort || null,
          speechSafe,
          ...orphanUser, at: Date.now() });
        fastify.sse.broadcast('chat-orphan', { chatKey });
        return reply;
      }
      // model — что просили, actualModel — чем CLI отработал (алиас он резолвит сам),
      // effort — что реально ушло в запуск. По этой тройке в UI видно любой рассинхрон.
      return { ...out, model: model || null, effort: runEffort || null, speechSafe };
    } catch (err) {
      // Остановка по кнопке — не ошибка: отдаём обычный ответ с уже показанной лентой,
      // чтобы в истории осталось, что агент успел сделать до стопа.
      if (err.stopped) {
        // Оборванную session СОХРАНЯЕМ: следующий ход сделает resume и агент продолжит
        // с полным контекстом — не теряется ни работа, ни память. Баг pinned 0.31.1
        // (после cancel CLI принимал prompt без нового llm.request) на 0.33.0 не
        // воспроизводится в tools/kimi-resume-smoke.mjs.
        // Страховка на регресс: если resume всё же проглотит prompt, empty-run ветка
        // выше инвалидирует binding, а повторное сообщение получит досье сделанного
        // (stopped-brief.js) уже в новую session. Binding не трогаем и с точки зрения
        // гонок: его единственный владелец — эта цепочка ходов чата (turnLocks).
        const contextCache = normalizeContextCache(err.contextCache);
        const stoppedOut = finishChatTitleHook({
          reply: '⏹ Ход остановлен.', steps: err.steps || [],
          sessionId: err.sessionId || sessionId || null,
          // Размер контекста берём тот, что исполнитель успел увидеть в потоке: раньше здесь
          // стоял жёсткий 0, клиент его игнорировал (нули не пишем), и после «стопа» кольцо
          // врало — у новой сессии оставалось пустым, хотя контекст в ней уже набрался.
          contextTokens: err.contextTokens || 0, contextIsEstimate: !!err.contextIsEstimate,
          ...(contextCache ? { contextCache } : {}),
          cost: null, model: model || null, effort: runEffort || null, stopped: true, sessionReset: false,
        }, wantsTitle);
        // Следующему ходу из очереди нужен фактический id оборванного разговора:
        // именно с ним он сделает resume, а не заведёт пустую session.
        if (chatKey && stoppedOut.sessionId) lastSession.set(chatKey, stoppedOut.sessionId);
        if (request.socket.destroyed && chatKey) {
          await writeOrphan({ id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
            chatKey, role: 'assistant', ...stoppedOut, ...orphanUser, at: Date.now() });
          fastify.sse.broadcast('chat-orphan', { chatKey });
          return reply;
        }
        return { ...stoppedOut, speechSafe: false };
      }
      if (request.socket.destroyed && chatKey) {
        await writeOrphan({ id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          chatKey, role: 'error', reply: err.message, ...orphanUser,
          sessionReset: !!err.sessionReset, sessionResetFailed: !!err.sessionResetFailed,
          at: Date.now() });
        fastify.sse.broadcast('chat-orphan', { chatKey });
        return reply;
      }
      return reply.code(500).send({
        error: err.code || 'chat_failed',
        message: err.message,
        ...(err.sessionReset ? { sessionReset: true } : {}),
        ...(err.sessionResetFailed ? { sessionResetFailed: true } : {}),
      });
    } finally {
      if (chatKey) {
        activeRuns.delete(chatKey);
        // Ход кончился (в т.ч. упал), а запрос всё ещё висит — снимаем: без хода
        // отвечать на него некому, а чип «ждёт ответа» висел бы вечно.
        dropPending(chatKey, 'Ход завершён — ответ уже не нужен');
        // Сигнал всем окнам: ход завершён (снимают «думает…», даже если ответ пришёл не к ним).
        fastify.sse.broadcast('chat-done', { chatKey });
      }
    }
  }

  // ── Вложения чата: файлы в chats/attachments/ (самогитигнор через chats/.gitignore) ──
  const attachDir = path.join(config.chatsDir, 'attachments');

  function safeName(name) {
    return String(name || 'file').replace(/[^\w.\-а-яё]+/gi, '_');
  }

  /**
   * Имя файла вложения (от клиента) → абсолютный путь строго внутри attachDir.
   * Защита от подстановки произвольного пути в --add-dir/сообщение.
   */
  async function attachFile(file) {
    const resolved = await resolveChatAttachment(attachDir, file, { imageOnly: false });
    return resolved?.path || null;
  }

  // Загрузка вложения (картинка и т.п.) → { file, name, url }. Файл потом
  // прикладывается к сообщению (attachments) и читается агентом через Read.
  fastify.post('/api/chat/upload', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });
    await fs.mkdir(attachDir, { recursive: true });
    const file = `${Date.now()}-${safeName(data.filename)}`;
    await pipeline(data.file, createWriteStream(path.join(attachDir, file)));
    // path — абсолютный путь на диске: его вписывают в комментарии/уточнения,
    // чтобы АГЕНТ (чата или триажа) мог открыть файл инструментом Read.
    return { file, name: data.filename || file, url: `/api/chat/attachment/${file}`, path: path.join(attachDir, file), mime: data.mimetype || '' };
  });

  // Отдача вложения (превью в истории чата).
  const ATTACH_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', pdf: 'application/pdf' };
  fastify.get('/api/chat/attachment/:file', async (request, reply) => {
    const p = await attachFile(request.params.file);
    if (!p) return reply.code(400).send({ error: 'bad_file' });
    try {
      const buf = await fs.readFile(p);
      const ext = path.extname(p).slice(1).toLowerCase();
      return reply.type(ATTACH_MIME[ext] || 'application/octet-stream').send(buf);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  // Диктовка с микрофона: multipart-аудио (webm/ogg) → whisper → { text }.
  // Синхронно: записи короткие, ответ нужен сразу в поле ввода.
  fastify.post('/api/chat/transcribe/warmup', async (request, reply) => {
    if (!speechRuntime?.warmup) {
      return reply.code(503).send({
        error: 'speech_unavailable',
        message: 'Прогрев локального распознавания недоступен.',
      });
    }
    try {
      const settings = prefs.read().speech;
      const storedRevision = prefs.readStored?.().speech?._revision || null;
      const result = await speechRuntime.warmup({
        settings,
        optionsRevision: speechSettingsRevision(settings, storedRevision),
      });
      return reply.code(202).send(result);
    } catch (err) {
      const status = err.code === 'speech_warmup_busy' ? 429
        : err.code === 'speech_model_missing' ? 409
          : err.code === 'speech_unavailable' ? 503
          : 500;
      return reply.code(status).send({
        error: err.code || 'speech_warmup_failed',
        message: err.message,
      });
    }
  });

  fastify.delete('/api/chat/transcribe/warmup/:warmupId', async (request, reply) => {
    if (!speechRuntime?.cancelWarmup) {
      return reply.code(503).send({
        error: 'speech_unavailable',
        message: 'Прогрев локального распознавания недоступен.',
      });
    }
    try {
      const cancelled = await speechRuntime.cancelWarmup(request.params.warmupId);
      return { warmupId: request.params.warmupId, cancelled };
    } catch (err) {
      return reply.code(500).send({
        error: err.code || 'speech_warmup_cancel_failed',
        message: err.message,
      });
    }
  });

  // Live Whisper: PCM16 идёт по авторизованному same-origin WebSocket, а модель и
  // все исполняемые options берутся только из server-owned snapshot по opaque revision.
  fastify.get('/api/chat/transcribe/stream', {
    websocket: true,
    async preValidation(request, reply) {
      if (speechStreamOriginMatches(request)) return;
      return reply.code(403).send({
        error: 'speech_stream_origin_forbidden',
        message: 'Origin live-распознавания не совпадает с Cockpit.',
      });
    },
  }, (socket, request) => {
    let state = 'awaiting-start';
    let clientSessionId = '';
    let acceptedRevision = '';
    let stream = null;
    let pendingReady = null;
    let terminalEventSent = false;
    let socketClosed = false;
    const startAbort = new AbortController();
    let startTimer = setTimeout(() => {
      startTimer = null;
      if (state === 'awaiting-start') publicError('speech_stream_timeout', 1008);
    }, speechStreamStartTimeoutMs);
    startTimer?.unref?.();

    const clearStartTimer = () => {
      if (startTimer) clearTimeout(startTimer);
      startTimer = null;
    };

    const sendJson = (payload) => {
      if (socketClosed || socket.readyState !== 1) return false;
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    };
    const closeSocket = (code, reason) => {
      if (socketClosed) return;
      try { socket.close(code, reason); } catch { /* сокет уже закрыт */ }
    };
    const cancelRuntime = () => {
      startAbort.abort();
      try { Promise.resolve(stream?.cancel?.()).catch(() => {}); }
      catch { /* runtime уже завершил cleanup */ }
    };
    const publicError = (rawCode, closeCode = 1011) => {
      if (terminalEventSent || state === 'cancelled' || state === 'done') return;
      clearStartTimer();
      const code = Object.hasOwn(SPEECH_STREAM_PUBLIC_ERRORS, rawCode)
        ? rawCode : 'speech_unavailable';
      terminalEventSent = true;
      state = 'failed';
      sendJson({
        type: 'error',
        sessionId: clientSessionId || undefined,
        optionsRevision: acceptedRevision || undefined,
        code,
        message: SPEECH_STREAM_PUBLIC_ERRORS[code],
      });
      cancelRuntime();
      closeSocket(closeCode, code);
    };
    const protocolFailure = () => publicError('speech_stream_protocol', 1008);

    // Поля публичного события перечислены явно: traceback, argv и локальные пути
    // не могут случайно попасть в браузер даже при ошибке нижнего слоя.
    const forwardRuntimeEvent = (event) => {
      if (!isPlainObject(event) || typeof event.type !== 'string') {
        protocolFailure();
        return;
      }
      if (event.type === 'ready') {
        if (state !== 'starting') { protocolFailure(); return; }
        if (!stream) {
          pendingReady = event;
          return;
        }
        sendJson({
          type: 'ready',
          sessionId: clientSessionId,
          optionsRevision: acceptedRevision,
          protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
          audio: SPEECH_STREAM_AUDIO,
        });
        return;
      }
      if (event.type === 'error') {
        publicError(event.code);
        return;
      }
      if (event.type === 'ack') {
        sendJson({
          type: 'ack', sessionId: clientSessionId, optionsRevision: acceptedRevision,
          seq: event.seq, ackSeq: event.ackSeq, receivedUntilMs: event.receivedUntilMs,
        });
        return;
      }
      if (event.type === 'partial' || event.type === 'final' || event.type === 'done') {
        const payload = {
          type: event.type,
          sessionId: clientSessionId,
          optionsRevision: acceptedRevision,
          text: typeof event.text === 'string' ? event.text : '',
          committed: typeof event.committed === 'string' ? event.committed : '',
          partial: typeof event.partial === 'string' ? event.partial : '',
          ackSeq: event.ackSeq,
          processedUntilMs: event.processedUntilMs,
          receivedUntilMs: event.receivedUntilMs,
          lagMs: event.lagMs,
        };
        sendJson(payload);
        if (event.type === 'done') {
          terminalEventSent = true;
          state = 'done';
          closeSocket(1000, 'done');
        }
        return;
      }
      protocolFailure();
    };

    const beginStream = async (message) => {
      clearStartTimer();
      clientSessionId = message.sessionId;
      let settings;
      let storedRevision = null;
      try {
        if (typeof prefs.readStored === 'function') {
          // Один синхронный снимок: settings A нельзя склеить с revision B даже
          // при внешней атомарной замене prefs.json между двумя чтениями.
          const stored = prefs.readStored();
          settings = normalizeSpeechSettings(stored?.speech);
          storedRevision = stored?.speech?._revision || null;
        } else {
          settings = normalizeSpeechSettings(prefs.read().speech);
        }
      }
      catch { publicError('speech_unavailable'); return; }
      acceptedRevision = speechSettingsRevision(settings, storedRevision);
      if (message.revision !== acceptedRevision) {
        publicError('stale_speech_settings', 1008);
        return;
      }
      if (settings.engine !== 'whisper' || typeof speechRuntime?.startStream !== 'function') {
        publicError('speech_unavailable');
        return;
      }
      state = 'starting';
      try {
        const started = await speechRuntime.startStream({
          settings,
          optionsRevision: acceptedRevision,
          clientSessionId,
          signal: startAbort.signal,
          onEvent: forwardRuntimeEvent,
        });
        if (socketClosed || state === 'cancelled' || startAbort.signal.aborted) {
          try { await started.cancel?.(); } catch { /* cleanup best-effort */ }
          return;
        }
        stream = started;
        state = 'recording';
        if (pendingReady) {
          const ready = pendingReady;
          pendingReady = null;
          // ready должен уйти только после публикации stream: клиент сразу следом
          // сбрасывает накопленные за cold start PCM frames.
          state = 'starting';
          forwardRuntimeEvent(ready);
          if (state === 'starting') state = 'recording';
        }
      } catch (error) {
        if (socketClosed || state === 'cancelled' || startAbort.signal.aborted) return;
        request.log.warn({ err: error }, 'speech stream: session start failed');
        // Session сама присылает санитизированный error. Если сбой случился раньше
        // её создания (busy/readiness), здесь формируем единственное публичное событие.
        if (!terminalEventSent) {
          publicError(error?.code, error?.code === 'speech_stream_busy' ? 1013 : 1011);
        }
      }
    };

    const handleBinary = (raw) => {
      if (state !== 'recording' || !stream) { protocolFailure(); return; }
      const packet = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (packet.length < 6 || packet.length > 4 + 64 * 1024 || (packet.length - 4) % 2 !== 0) {
        protocolFailure();
        return;
      }
      const seq = packet.readUInt32LE(0);
      try {
        stream.pushFrame(seq, packet.subarray(4));
      } catch (error) {
        state = 'failed';
        request.log.warn({ err: error }, 'speech stream: rejected PCM frame');
        // pushFrame запускает собственный fail/cleanup и пришлёт ровно один
        // санитизированный event; подробности исключения остаются только в логе.
      }
    };

    const handleText = (raw) => {
      if (state === 'awaiting-start') {
        const message = parseSpeechStreamStart(raw);
        if (!message) { protocolFailure(); return; }
        void beginStream(message);
        return;
      }
      const message = parseSpeechStreamControl(raw);
      if (!message) { protocolFailure(); return; }
      if (message.type === 'cancel') {
        clearStartTimer();
        state = 'cancelled';
        cancelRuntime();
        closeSocket(1000, 'cancelled');
        return;
      }
      if (state !== 'recording' || !stream || message.seq !== stream.snapshot().lastSeq) {
        protocolFailure();
        return;
      }
      state = 'stopping';
      Promise.resolve(stream.stop()).catch((error) => {
        if (state === 'cancelled' || state === 'done' || terminalEventSent) return;
        request.log.warn({ err: error }, 'speech stream: final drain failed');
        publicError(error?.code);
      });
    };

    socket.on('message', (raw, isBinary) => {
      if (socketClosed || state === 'done' || state === 'failed' || state === 'cancelled') return;
      if (isBinary) handleBinary(raw);
      else handleText(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    });
    socket.on('close', () => {
      clearStartTimer();
      socketClosed = true;
      if (state !== 'done') {
        state = 'cancelled';
        cancelRuntime();
      }
    });
    socket.on('error', () => {
      clearStartTimer();
      if (state === 'done' || state === 'cancelled') return;
      state = 'cancelled';
      cancelRuntime();
    });
  });

  fastify.post('/api/chat/transcribe', async (request, reply) => {
    if (!speechRuntime?.transcribe) {
      return reply.code(503).send({
        error: 'speech_unavailable',
        message: 'Локальное распознавание речи недоступно.',
      });
    }
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-dictate-'));
    const audioPath = path.join(workDir, safeName(data.filename || 'dictation.webm'));
    const abort = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, 120_000);
    const abortRequest = () => abort.abort();
    const abortResponse = () => {
      // После полного multipart request уже complete и событие `aborted` не приходит.
      // Закрытая клиентом response-сторона — единственный сигнал Esc/unmount в этот момент.
      if (!reply.raw.writableEnded) abort.abort();
    };
    request.raw.once('aborted', abortRequest);
    reply.raw.once('close', abortResponse);
    try {
      await pipeline(data.file, createWriteStream(audioPath));
      const streamSessionId = data.fields?.streamSessionId?.value || null;
      if (streamSessionId != null
        && (typeof streamSessionId !== 'string' || !SPEECH_STREAM_SESSION_RE.test(streamSessionId))) {
        return reply.code(400).send({
          error: 'bad_stream_session',
          message: 'Некорректный идентификатор live-сессии речи.',
        });
      }
      const result = await speechRuntime.transcribe({
        filePath: audioPath,
        workDir,
        settings: prefs.read().speech,
        warmupId: data.fields?.warmupId?.value || null,
        streamSessionId,
        signal: abort.signal,
      });
      const { transcript } = result;
      const text = (transcript.segments || []).map((s) => s.text).join(' ').trim();
      return {
        text,
        duration: transcript.duration ?? result.duration ?? null,
        diagnostics: result.diagnostics || {
          hotwordsTokens: transcript.hotwordsTokens ?? null,
          hotwordsTruncated: transcript.hotwordsTruncated ?? false,
        },
        execution: result.execution || { engine: 'whisper', mode: 'one-shot' },
      };
    } catch (err) {
      const code = timedOut ? 'speech_timeout' : err.code;
      const status = code === 'speech_model_missing' ? 409
        : code === 'speech_unavailable' || code === 'speech_stream_busy' ? 503
          : code === 'speech_timeout' ? 504
            : 500;
      return reply.code(status).send({
        error: code || 'transcribe_failed',
        message: timedOut ? 'Распознавание речи превысило лимит времени.' : err.message,
      });
    } finally {
      clearTimeout(timeout);
      request.raw.off('aborted', abortRequest);
      reply.raw.off('close', abortResponse);
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* мусор в tmp не критичен */ }
    }
  });

  // Чат по задаче (worktree задачи).
  fastify.post('/api/tasks/:id/chat', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const {
      message, model, modelRef, effort, mode, sessionId, context, attachments, chatKey,
      requestTitle, sentAt, slashCommand, companionTurn,
    } = request.body || {};
    if (!(message || '').trim() && !attachments?.length) return reply.code(400).send({ error: 'empty_message' });
    return runChat(reply, request, {
      id, message, model, modelRef, effort, mode, sessionId, context, attachments, chatKey,
      requestTitle, sentAt, slashCommand, companionTurn,
    });
  });

  // Свободный чат без задачи (корень фабрики).
  fastify.post('/api/chat', async (request, reply) => {
    const {
      message, model, modelRef, effort, mode, sessionId, context, attachments, chatKey,
      requestTitle, sentAt, slashCommand, companionTurn,
    } = request.body || {};
    if (!(message || '').trim() && !attachments?.length) return reply.code(400).send({ error: 'empty_message' });
    return runChat(reply, request, {
      id: null, message, model, modelRef, effort, mode, sessionId, context, attachments, chatKey,
      requestTitle, sentAt, slashCommand, companionTurn,
    });
  });

  // ── Сжатие контекста чата (кнопка на кольце) ────────────────────────────────────
  // Идёт ТОЙ ЖЕ очередью, что обычные сообщения: два CLI на одну сессию не живут, а
  // сжатие — полноценный ход агента. Без sessionId сжимать нечего: разговора ещё нет.
  function compactBody(request) {
    const { model, modelRef, effort, mode, sessionId, chatKey } = request.body || {};
    return { model, modelRef, effort, mode, sessionId, chatKey, compact: true };
  }

  fastify.post('/api/chat/compact', async (request, reply) => {
    const body = compactBody(request);
    if (!body.sessionId) return reply.code(400).send({ error: 'no_session' });
    return runChat(reply, request, { id: null, ...body });
  });

  fastify.post('/api/tasks/:id/compact', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const body = compactBody(request);
    if (!body.sessionId) return reply.code(400).send({ error: 'no_session' });
    return runChat(reply, request, { id, ...body });
  });

  // Вместе с историей отдаём порог сжатия из настроек: по нему кольцо контекста решает,
  // где желтеть и краснеть. Своего эндпоинта порогу не завели — клиент чата этот и так
  // тянет при загрузке, а меняется порог только в «Настройках» (оттуда же обновляется стор).
  fastify.get('/api/chat/store', async () => {
    const settings = prefs.read().speech;
    const storedRevision = prefs.readStored?.().speech?._revision || null;
    // История чата не должна ждать Python/CUDA diagnostics на cold start. Sync
    // snapshot содержит последний известный readiness; async оставлен только для
    // совместимых runtime, у которых нового шва ещё нет.
    const publicSpeech = speechRuntime?.publicSnapshot
      ? speechRuntime.publicSnapshot(settings)
      : await speechRuntime?.publicSnapshotAsync?.(settings);
    return {
      ...(await history.read()),
      compactWindow: Math.max(0, Number(prefs?.read()?.chatAutoCompactWindow) || 0),
      // Чем уходит быстрый ход компаньона. Едет тем же путём, что порог сжатия: модель
      // резолвит браузер перед отправкой, а настройка server-owned и общая для окон.
      companion: normalizeCompanionSettings(prefs?.read()?.companion),
      speech: {
        ...publicSpeech,
        revision: speechSettingsRevision(settings, storedRevision),
      },
    };
  });

  // Атомарное создание или восстановление по логической идентичности, принадлежащей серверу. Тело намеренно
  // не является заготовкой записи чата: id/model/cwd/mode и details здесь не читаются.
  fastify.post('/api/chat/store/ensure', async (request, reply) => {
    const { purpose, taskId = null, origin = '' } = request.body || {};
    try {
      // Назначение и каноническая область задачи проверяются до серверного резолвера: сырой
      // taskId, похожий на путь, не должен становиться аргументом поиска в файловой системе или трекере.
      if (purpose !== 'companion') {
        return reply.code(400).send({
          error: 'bad_chat_purpose',
          message: 'Поддерживается только purpose companion.',
        });
      }
      const canonicalTaskId = normalizeCompanionTaskId(taskId);
      if (canonicalTaskId && !await companionTaskExists(canonicalTaskId)) {
        return reply.code(404).send({
          error: 'companion_task_not_found',
          message: 'Задача не найдена в server-owned реестре.',
        });
      }
      const result = await history.ensureByPurpose({ purpose, taskId: canonicalTaskId });
      if (result.created || result.restored) {
        fastify.sse.broadcast('chat-store', {
          id: result.chat.id,
          archived: false,
          origin: String(origin || ''),
          at: Date.now(),
          ensured: true,
        });
      }
      return {
        chat: result.chat,
        created: result.created,
        restored: result.restored,
      };
    } catch (error) {
      if (!(error instanceof ChatHistoryError)) throw error;
      return reply.code(error.statusCode || 409).send({
        error: error.code,
        message: error.message,
        ...(error.conflicts?.length ? {
          conflicts: error.conflicts,
          chatIds: error.conflicts.map((chat) => chat.id),
        } : {}),
      });
    }
  });

  // Полная запись стора. Осталась для миграции со старой схемы и восстановления
  // из браузерного снимка; в обычной работе клиент ею НЕ пользуется — с ростом истории
  // тело перерастало лимит запроса, сервер отвечал 413, и переписка не сохранялась вообще.
  fastify.put('/api/chat/store', async (request, reply) => {
    const body = request.body || {};
    const chatIds = [
      ...(Array.isArray(body.sessions) ? body.sessions : []),
      ...(Array.isArray(body.archived) ? body.archived : []),
    ].map((chat) => String(chat?.id || '')).filter(Boolean);
    if (chatIds.some((id) => deletingChats.has(id))) {
      return reply.code(409).send({
        error: 'chat_busy',
        message: 'Один из чатов сейчас удаляется; перечитайте историю перед сохранением.',
      });
    }
    // PUT и DELETE объявляют намерение синхронно до первого await. Если PUT принят
    // первым, DELETE вернёт chat_busy; если DELETE — поздний PUT не воскресит файл.
    const releaseChatSaves = beginChatSaves(chatIds);
    try {
      try {
        await history.save(body);
        return { ok: true };
      } catch (error) {
        if (!(error instanceof ChatHistoryError)) throw error;
        return reply.code(error.statusCode || 409).send({ error: error.code, message: error.message });
      }
    } finally {
      releaseChatSaves();
    }
  });

  // ── Точечное сохранение: одно тело — один чат ──
  // Объём запроса больше не зависит от того, сколько чатов накопилось всего.
  //
  // Изменения РАЗЪЕЗЖАЮТСЯ по окнам сами (SSE `chat-store`): историю читают все устройства
  // сразу, а узнать об изменении им было неоткуда — начатый на планшете разговор появлялся
  // на компьютере только после F5. Пишущее окно помечает запрос своим `origin`, чтобы не
  // принимать собственное эхо; остальные тянут ровно изменившийся чат
  // (`GET /api/chat/store/chat/:id`), а не всю историю.
  fastify.put('/api/chat/store/chat', async (request, reply) => {
    const { chat, archived, origin } = request.body || {};
    if (!chat?.id) return reply.code(400).send({ error: 'bad_chat' });
    const chatId = String(chat.id);
    if (deletingChats.has(chatId)) {
      return reply.code(409).send({
        error: 'chat_busy',
        message: 'Чат сейчас удаляется; перечитайте историю перед сохранением.',
      });
    }
    const releaseChatSave = beginChatSaves([chatId]);
    try {
      let result;
      try {
        result = await history.saveOne(chat, !!archived);
      } catch (error) {
        if (!(error instanceof ChatHistoryError)) throw error;
        return reply.code(error.statusCode || 409).send({ error: error.code, message: error.message });
      }
      const { written, restored, dropped, stale, chat: saved } = result;
      // Ничего не изменилось — молчим: лишний persist не повод будить остальные окна.
      if (written) {
        fastify.sse.broadcast('chat-store', {
          id: chat.id, archived: !!archived, origin: origin || '', at: Date.now(),
        });
      }
      // Окно прислало отставшую копию, сервер дописал в неё недостающее (см. merge-chat.js) —
      // значит у самого окна лента неполная и перечитать её должно и оно. Своё эхо оно
      // пропускает по `origin`, поэтому шлём второе событие уже НИЧЬИМ. С задержкой: без неё
      // событие обгоняет ответ на этот же PUT, окно считает свою копию неотправленной
      // («грязной») и отказывается принимать серверную.
      if (restored || dropped) {
        fastify.log.warn({ chat: chat.id, restored, dropped }, 'история чата слита с серверной копией');
        setTimeout(() => {
          fastify.sse.broadcast('chat-store', {
            id: chat.id, archived: !!archived, origin: '', at: Date.now(), merged: true,
          });
        }, 500).unref?.();
      }
      return {
        ok: true,
        written,
        restored,
        dropped,
        stale,
        revision: saved?.revision ?? null,
        schema: saved?.schema ?? null,
        surface: saved?.surface ?? null,
        modelRef: saved?.modelRef ?? null,
        modelRefState: saved?.modelRefState ?? null,
      };
    } finally {
      releaseChatSave();
    }
  });

  fastify.get('/api/chat/store/chat/:id', async (request, reply) => {
    const chat = await history.readOne(String(request.params.id));
    if (!chat) return reply.code(404).send({ error: 'no_chat' });
    return { chat };
  });

  fastify.delete('/api/chat/store/chat/:id', async (request, reply) => {
    const id = String(request.params.id);
    // Проверка и marker выполняются без await: ход либо уже принят и блокирует DELETE,
    // либо увидит deletingChats и не сможет стартовать по удаляемой durable identity.
    if ((acceptedTurns.get(id) || 0) > 0 || (savingChats.get(id) || 0) > 0 || deletingChats.has(id)
      || activeRuns.has(id) || turnLocks.isBusy({ chatKey: id })) {
      return reply.code(409).send({
        error: 'chat_busy',
        message: 'Нельзя удалить чат, пока идёт его сохранение, ожидание или ход.',
      });
    }
    deletingChats.add(id);
    try {
      // Живой процесс агента удалённого чата держать не за чем: разговора больше нет,
      // а он занимает память и свои MCP-серверы.
      await liveSessions.close(id, 'чат удалён');
      const removed = await history.remove(id);
      // origin в query: DELETE у нас без тела (см. shared/api-client.js).
      if (removed) {
        fastify.sse.broadcast('chat-store', {
          id, gone: true, origin: String(request.query?.origin || ''), at: Date.now(),
        });
      }
      // Sidecar сохраняется до retention deadline: удаление истории не должно неожиданно
      // удалять vendor session, а случайно удалённый чат остаётся recoverable.
      if (removed) {
        const state = await history.read();
        const activeChatKeys = [...state.sessions, ...state.archived].map((chat) => chat.id);
        await bindingStore.cleanup({ activeChatKeys }).catch((error) => {
          fastify.log.warn({ err: error.message }, 'cleanup session bindings не выполнен');
        });
      }
      return { ok: true, removed };
    } finally {
      deletingChats.delete(id);
    }
  });

  // Мета отдельно: переключение вкладки не тащит за собой переписку.
  fastify.put('/api/chat/store/meta', async (request) => {
    const { origin, ...body } = request.body || {};
    const meta = await history.saveMeta(body);
    fastify.sse.broadcast('chat-store-meta', { meta, origin: origin || '', at: Date.now() });
    return { ok: true, meta };
  });
}

export default fp(chatModule, { name: 'module-chat' });
