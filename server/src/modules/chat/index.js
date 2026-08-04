// Модуль chat — интерактивное обсуждение с CLI-агентом прямо из кокпита.
// Два режима:
//   • по задаче  — выбранный executor в worktree задачи, контекст через его sessionId;
//   • без задачи — свободный вопрос в корне фабрики (страница Agents переопределяет cwd).
// Интерактивные права реализованы Claude executor-ом через permission-prompt-tool
// (lib/chat/permission-mcp.js): запрос показывается всплывашкой в браузере.
import fp from 'fastify-plugin';
import { promises as fs, createWriteStream, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRecording } from '../../lib/media/ingest.js';
import { getExecutor } from '../../lib/executors/index.js';
import { getModelsRegistry } from '../../lib/models-registry.js';
import { resolveRequestedEffort } from '../../lib/model-effort.js';
import { ChatHistoryStore } from '../../lib/chat/history-store.js';
import { ChatSessionBindingStore } from '../../lib/chat/session-binding-store.js';
import { ChatTurnLocks } from '../../lib/chat/turn-locks.js';
import { mayRetryEmptyRun } from '../../lib/chat/retry-contract.js';
import { kimiAutoDecision } from '../../lib/chat/auto-approve.js';
import { MAX_CHAT_STEPS } from '../../lib/chat/stream-steps.js';
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

const PERM_MCP_PATH = fileURLToPath(new URL('../../lib/chat/permission-mcp.js', import.meta.url));

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
    factoryState, config, claudeAuth, internalToken, prefs,
  } = opts;
  const modelsRegistry = opts.modelsRegistry || ((cfg) => getModelsRegistry(cfg));
  const executorResolver = opts.executorResolver || getExecutor;

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

  /**
   * Режим страницы по UI-контексту: подсказка агенту о том, что открыто, и —
   * для страницы агентов — право реально править файлы базы (cwd = agents/,
   * acceptEdits). Просьба «поправь этого агента» выполняется правкой <id>.md.
   */
  function pageMode(context, hasTask) {
    const p = context?.path || '';
    if (p.startsWith('/agents')) {
      const mode = hasTask ? {} : { cwd: config.agentsDir, permissionMode: 'acceptEdits' };
      return { ...mode, hint: `Открыта библиотека ШАБЛОНОВ агентов конвейера: каждый агент — файл <id>.md (frontmatter с метаданными + заготовка промпта) в ${config.agentsDir}. Просьбу «поправить агента» выполняй правкой соответствующего файла. Боевые промпты этапов живут не здесь, а в схемах: routes/<проект>/<маршрут>/<этап>.md.` };
    }
    if (p.startsWith('/routes')) return { hint: `Открыты маршруты конвейера фабрики (${config.factoryHome}): графы стадий по типам задач. Промпт каждого узла схемы — сайдкар routes/<проект>/<маршрут>/<этап>.md в кокпите.` };
    if (p.startsWith('/board')) return { hint: 'Открыта доска задач Битрикс24.' };
    if (p.startsWith('/pipeline')) return { hint: 'Открыт конвейер фабрики — задачи в работе и их стадии.' };
    if (p.startsWith('/settings')) return { hint: 'Открыты настройки кокпита.' };
    return {};
  }

  /**
   * Префикс с UI-контекстом перед сообщением пользователя. Явно говорим агенту:
   * контекст задействовать только если просьба к нему относится — свободные
   * вопросы отвечаются как обычно.
   */
  function contextPrefix(context, hint) {
    if (!context?.path) return '';
    const lines = [
      `Сообщение отправлено из веб-интерфейса кокпита, открыта страница «${context.page || context.path}» (${context.path}).`,
    ];
    if (hint) lines.push(hint);
    if (context.details && Object.keys(context.details).length) {
      lines.push(`Детали страницы: ${JSON.stringify(context.details)}`);
    }
    lines.push('Используй этот контекст, только если просьба к нему относится («здесь», «этот агент», «на этой странице»). На отвлечённые вопросы отвечай как обычно, без упоминания контекста.');
    return `[Контекст кокпита]\n${lines.join('\n')}\n[/Контекст]\n\n`;
  }

  /**
   * Единый запуск выбранного executor-а. cwd/доп-директории зависят от наличия задачи
   * и UI-контекста (страницы, с которой пишет пользователь).
   * Возвращает { reply, sessionId, cost, contextTokens } или reply-ошибку.
   */
  // ── Активные запуски агента: перезагруженная страница восстанавливает «думает…»
  // и уже показанную ленту шагов текущего хода. ──
  const activeRuns = new Map(); // ключ чата → { startedAt, tokens, steps[], ac, compact }

  // ── Очередь ходов на чат ─────────────────────────────────────────────────────
  // ДВА CLI НА ОДНУ СЕССИЮ НЕ ЖИВУТ: второй `claude --resume <тот же id>` падает
  // мгновенно (result без текста, subtype error_during_execution, turns=0, cost=0),
  // а человек видит «⚠ Агент завершил ход без текстового ответа» и повторяет вопрос —
  // порождая ещё один процесс-смертник (инцидент 27.07.2026: три повтора подряд,
  // три потерянных сообщения; в сессию CLI они не попали вовсе, агент их не увидел).
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
      chatKey, startedAt: v.startedAt, tokens: v.tokens, steps: v.steps, compact: !!v.compact,
    })),
  }));

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
    if (record.modelRef?.provider !== 'kimi') return { ok: true, reset: false };
    if (activeRuns.has(chatKey) || turnLocks.isBusy({ chatKey })) {
      return reply.code(409).send({
        error: 'chat_busy',
        message: 'сначала останови текущий ход, затем сбрось память агента',
      });
    }
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
  const pendingPerms = new Map(); // pid → { resolve, isQuestion, tool, input, chatKey, at }
  // Ждём ответ СКОЛЬКО НУЖНО: «не успел за 4 минуты» — не повод продолжать без человека.
  // Сутки — верхняя граница здравого смысла, столько же держит вызов сам CLI
  // (MCP_TOOL_TIMEOUT, см. runChat). Раньше снимает только «стоп» или конец хода.
  const PERM_WAIT_MS = 24 * 60 * 60 * 1000;

  /** Снять висящие запросы чата: ход кончился или остановлен — отвечать уже некому. */
  function dropPending(chatKey, message) {
    for (const [pid, p] of pendingPerms) {
      if (p.chatKey !== chatKey) continue;
      pendingPerms.delete(pid);
      p.resolve(p.provider === 'kimi'
        ? { outcome: { outcome: 'cancelled' }, message }
        : { behavior: 'deny', message });
      fastify.sse.broadcast('chat-permission-done', { pid });
    }
  }

  /** ACP reverse-RPC Kimi использует ту же всплывашку, но ответ возвращается
   * напрямую transport-у, без локального HTTP MCP-процесса Claude. */
  function requestKimiInteraction(presentation, chatKey) {
    const pid = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const at = Date.now();
    const isQuestion = !!presentation?.isQuestion;
    const input = isQuestion
      ? { questions: presentation.questions || [] }
      : (presentation?.input || {});
    return new Promise((resolve) => {
      pendingPerms.set(pid, {
        resolve,
        provider: 'kimi',
        isQuestion,
        tool: presentation?.tool || 'Действие Kimi',
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
          pid, tool: presentation?.tool || 'Действие Kimi', input,
          chatKey: chatKey || '', at,
        });
      }
    });
  }

  // Что сейчас ждёт человека — чтобы окно после F5 (и второе окно) подняло всплывашки:
  // SSE доставляет событие один раз, а запрос висит, пока на него не ответят.
  fastify.get('/api/chat/waiting', async () => ({
    waiting: [...pendingPerms.entries()].map(([pid, p]) => ({
      pid, chatKey: p.chatKey, at: p.at,
      ...(p.isQuestion ? { questions: p.input?.questions || [] } : { tool: p.tool, input: p.input }),
    })),
  }));

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

  // Сюда стучится permission-mcp.js (child-процесс claude). Держим запрос открытым,
  // пока пользователь не нажмёт кнопку во всплывашке / не ответит на вопрос (или таймаут).
  fastify.post('/api/chat/permission-request', async (request, reply) => {
    const { tool_name, input, chatKey } = request.body || {};
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
    pendingPerms.delete(pid);
    fastify.sse.broadcast('chat-permission-done', { pid });
    const body = request.body || {};
    if (p.provider === 'kimi' && p.isQuestion) {
      const answers = Array.isArray(body.answers) ? body.answers : [];
      p.resolve({
        selected: answers.flatMap((answer) => answer?.selected || []).filter(Boolean),
        text: answers.map((answer) => answer?.text || '').find(Boolean) || '',
      });
    } else if (p.provider === 'kimi') {
      p.resolve({ allow: body.allow === true });
    } else if (p.isQuestion) {
      p.resolve({ behavior: 'deny', message: answerText(body.answers) });
    } else {
      p.resolve(body.allow
        ? { behavior: 'allow', updatedInput: p.input }
        : { behavior: 'deny', message: 'Пользователь отклонил действие в кокпите' });
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
  async function resolveRunTarget(opts) {
    const registry = await modelsRegistry(config);
    const chatKey = String(opts.chatKey || '');
    const record = chatKey ? await history.readOne(chatKey) : null;
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
    let binding = null;
    let sessionId = opts.sessionId || null;
    if (provider === 'kimi') {
      if (record?.surface !== 'chats') {
        return { ok: false, error: 'provider_surface_denied', message: 'Kimi доступен только пользовательским чатам' };
      }
      binding = await bindingStore.read(chatKey);
      // Клиентский sessionId никогда не участвует в Kimi resume. При живом binding
      // несовпадающее значение считаем forged/stale. Пустой binding — намеренная
      // инвалидация после stop/reset: старый id из отставшего окна безопасно игнорируем,
      // потому что executor всё равно получит null и создаст новую provider session.
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
      model: resolution.modelRef.model,
      modelInfo: resolution.model,
      sessionId,
    };
  }

  async function runChat(reply, request, opts) {
    const chatKey = opts.chatKey || '';
    const target = await resolveRunTarget(opts);
    if (!target.ok) return reply.code(400).send({ error: target.error, message: target.message });
    const scope = { chatKey, provider: target.provider, sessionId: target.sessionId };
    const queued = turnLocks.isBusy(scope);
    if (queued) {
      fastify.log.info({ chatKey }, 'чат: ход уже идёт — сообщение поставлено в очередь');
      // Второму окну (и своему же, если оно захочет показать «в очереди») — сигнал.
      fastify.sse.broadcast('chat-queued', { chatKey, at: Date.now() });
    }
    return turnLocks.run(scope, () => runChatTurn(reply, request, {
      ...opts,
      model: target.model,
      sessionId: target.sessionId,
      target,
      queued,
    }));
  }

  async function runChatTurn(reply, request, {
    id, message, model, effort, mode: wantMode, sessionId, context, attachments,
    chatKey, queued, requestTitle, compact, target,
  }) {
    const wantsTitle = requestTitle === true;
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
      const env = await factoryState.readEnv(id);
      const parsed = parseSandboxRepositories(env);
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
    const mode = pageMode(context, !!id);
    if (mode.cwd) cwd = mode.cwd;

    // Kimi session принадлежит не браузеру, а sidecar-у Cockpit. Под фактическим
    // chat lock перечитываем binding, вращаем его при смене cwd/model/profile и
    // резервируем generation ещё до session/new.
    let kimiBinding = null;
    let kimiIdentity = null;
    if (target.provider === 'kimi') {
      const cwdRealpath = await fs.realpath(cwd);
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
    }

    // Вложения: клиент присылает имена файлов, ранее загруженных через /api/chat/upload.
    // Пути строим сами (только внутри attachDir) и открываем агенту доступ через --add-dir.
    let attachBlock = '';
    const attachPaths = (attachments || [])
      .map((a) => attachFile(a?.file))
      .filter(Boolean);
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
    const executor = await executorResolver(target.provider);

    // Сжатие контекста (кнопка на кольце) — служебный ход, а не сообщение человека: ни
    // контекст страницы, ни вложения, ни хук заголовка ему не нужны. План берём у
    // исполнителя: родная слэш-команда CLI (сессия сохраняется) либо выжимка текстом,
    // если слэш-команд в неинтерактивном режиме он не понимает (lib/executors/index.js).
    const plan = compact ? (executor?.compaction || { kind: 'summary' }) : null;
    const fullMessage = plan
      ? (plan.kind === 'native' ? plan.message : SUMMARY_PROMPT)
      : withChatTitleHook(
        contextPrefix(context, mode.hint) + attachBlock + (message || 'Посмотри вложения.'),
        wantsTitle,
      );
    // Режим прав выбирает пользователь в чате; страница даёт лишь дефолт для своих
    // сценариев (например «Агенты» — правки без спроса). Значение сверяем со списком
    // самого CLI: неизвестное он не принимает, а падает с ошибкой валидации.
    const permissionMode = (await allowedMode(executor, wantMode)) || mode.permissionMode;
    if (!executor) return reply.code(400).send({ error: 'unknown_provider', message: `нет исполнителя для модели ${model}` });

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
      },
    };

    // Ход можно оборвать кнопкой «стоп»: контроллер живёт в activeRuns, POST /api/chat/stop
    // дёргает abort, execFile убивает CLI.
    const ac = new AbortController();
    // compact — служебный ход сжатия: окна показывают его не «думает…», а вертящимся
    // кольцом контекста. Флаг обязан быть здесь, а не только в затеявшем окне: у родного
    // компакта нет ни шагов, ни прогресса (см. ниже), так что второму устройству
    // догадаться о сжатии больше неоткуда.
    const runRec = { startedAt: Date.now(), tokens: 0, steps: [], ac, compact: !!plan };
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
        permissionPromptTool: 'mcp__cockpit-perm__approve',
        providerSettings: currentPrefs.providerSettings?.[executor.id] || {},
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
        onPermission: target.provider === 'kimi'
          ? (presentation) => {
            // Кокпит-режим «auto»: ACP остаётся в default (Kimi спрашивает), а на
            // безопасные запросы отвечает классификатор. Деструктивные и неизвестные
            // формы по-прежнему уходят человеку во всплывашку.
            if (permissionMode === 'auto') {
              const decision = kimiAutoDecision(presentation);
              if (decision.verdict === 'allow') return { allow: true };
              fastify.log.info({ chatKey, tool: presentation?.tool, reason: decision.reason }, 'Kimi auto: действие — на подтверждение человеку');
            }
            return requestKimiInteraction(presentation, chatKey);
          }
          : undefined,
        // Живой счётчик потраченных токенов → SSE → «думает… · N ток.» в чате.
        onProgress: chatKey ? (tokens) => {
          const a = activeRuns.get(chatKey);
          if (a) a.tokens = tokens;
          fastify.sse.broadcast('chat-progress', { chatKey, tokens });
        } : undefined,
        // Лента хода (размышления, инструменты, их результаты) — живьём в окно.
        // Копия в activeRuns: перезагрузка страницы посреди хода не теряет показанное.
        onStep: chatKey ? (step) => {
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
      let out = await executor.run(runArgs);
      // Пустой ход (ноль шагов, ноль стоимости) = CLI умер на старте и НИЧЕГО не сделал.
      // Повторить его безопасно — и честнее, чем отдать человеку заглушку и ждать, что
      // он пришлёт сообщение заново (а он пришлёт — и получит то же самое).
      // Ход сжатия не повторяем: у родного компакта stdout пуст ВСЕГДА (вывод слэш-команды
      // локальный, в поток он не идёт), так что «пустой ход» тут — норма, а второй прогон
      // сжал бы уже сжатое.
      if (mayRetryEmptyRun(executor, out, { compact: !!plan })) {
        fastify.log.warn({ chatKey, subtype: out.subtype }, 'чат: ход пустой (ноль шагов) — повторяю один раз');
        out = await executor.run(runArgs);
      }
      // ACP может вернуть end_turn без единого chunk/шага. После принятого prompt
      // повторять нельзя: модель могла выполнить действие, а ответ потеряться. Но и
      // выдавать `(пусто)` как успешный ответ нельзя. Для pinned Kimi 0.31.1 это также
      // наблюдалось после resume отменённого хода; инвалидируем только binding, чтобы
      // следующий ЯВНЫЙ запрос пользователя начал чистую session без автоповтора.
      if (!plan && target.provider === 'kimi' && out?.emptyRun) {
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
      // Актуальный id разговора: с ним пойдут сообщения, ждущие в очереди этого чата.
      if (chatKey && out?.sessionId) lastSession.set(chatKey, out.sessionId);
      // Клиент не дождался (перезагрузка/закрытие вкладки) — ответ в pending, подберётся при загрузке.
      if (request.socket.destroyed && chatKey) {
        // userText — страховка от гонки last-write-wins: если вопрос пользователя
        // не успел сохраниться в стор, клиент восстановит его перед ответом.
        await writeOrphan({ id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          chatKey, role: 'assistant', ...out, model: model || null, effort: runEffort || null,
          userText: message || '', hadAttachments: !!attachments?.length, at: Date.now() });
        fastify.sse.broadcast('chat-orphan', { chatKey });
        return reply;
      }
      // model — что просили, actualModel — чем CLI отработал (алиас он резолвит сам),
      // effort — что реально ушло в запуск. По этой тройке в UI видно любой рассинхрон.
      return { ...out, model: model || null, effort: runEffort || null };
    } catch (err) {
      // Остановка по кнопке — не ошибка: отдаём обычный ответ с уже показанной лентой,
      // чтобы в истории осталось, что агент успел сделать до стопа.
      if (err.stopped) {
        let sessionReset = false;
        if (target.provider === 'kimi') {
          try {
            await invalidateKimiSession(chatKey, {
              expectedSessionId: err.sessionId || sessionId || '',
              reason: 'stopped',
            });
            sessionReset = true;
          } catch (resetError) {
            fastify.log.error({ chatKey, err: resetError.message }, 'Kimi binding после stop не сброшен');
            const resetMessage = 'Kimi остановлен, но сессию сбросить не удалось. Выполни явный сброс памяти перед следующим сообщением.';
            if (request.socket.destroyed && chatKey) {
              await writeOrphan({
                id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
                chatKey,
                role: 'error',
                reply: resetMessage,
                userText: message || '',
                sessionResetFailed: true,
                at: Date.now(),
              });
              fastify.sse.broadcast('chat-orphan', { chatKey });
              return reply;
            }
            return reply.code(500).send({
              error: 'kimi_session_reset_failed',
              message: resetMessage,
              sessionResetFailed: true,
            });
          }
        }
        // Для Kimi оборванную session намеренно не возобновляем: pinned 0.31.1 после
        // cancel способен принять следующий prompt без нового llm.request. Остальные
        // исполнители сохраняют прежний контракт и возвращают заведённый ими id.
        const stoppedOut = finishChatTitleHook({
          reply: '⏹ Ход остановлен.', steps: err.steps || [],
          sessionId: sessionReset ? null : (err.sessionId || sessionId || null),
          // Размер контекста берём тот, что исполнитель успел увидеть в потоке: раньше здесь
          // стоял жёсткий 0, клиент его игнорировал (нули не пишем), и после «стопа» кольцо
          // врало — у новой сессии оставалось пустым, хотя контекст в ней уже набрался.
          contextTokens: err.contextTokens || 0, contextIsEstimate: !!err.contextIsEstimate,
          cost: null, model: model || null, effort: runEffort || null, stopped: true, sessionReset,
        }, wantsTitle);
        // У исполнителей без принудительного reset следующему ходу из очереди нужен
        // фактический id оборванного разговора. Для Kimi здесь null и чистая session.
        if (chatKey && stoppedOut.sessionId) lastSession.set(chatKey, stoppedOut.sessionId);
        if (request.socket.destroyed && chatKey) {
          await writeOrphan({ id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
            chatKey, role: 'assistant', ...stoppedOut, userText: message || '', at: Date.now() });
          fastify.sse.broadcast('chat-orphan', { chatKey });
          return reply;
        }
        return stoppedOut;
      }
      if (request.socket.destroyed && chatKey) {
        await writeOrphan({ id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          chatKey, role: 'error', reply: err.message, userText: message || '',
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
  function attachFile(file) {
    if (!file) return null;
    const p = path.join(attachDir, safeName(path.basename(String(file))));
    return p.startsWith(attachDir + path.sep) ? p : null;
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
    const p = attachFile(request.params.file);
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
  fastify.post('/api/chat/transcribe', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });
    const workDir = path.join(os.tmpdir(), `cockpit-dictate-${Date.now()}`);
    await fs.mkdir(workDir, { recursive: true });
    const audioPath = path.join(workDir, safeName(data.filename || 'dictation.webm'));
    try {
      await pipeline(data.file, createWriteStream(audioPath));
      const { transcript } = await ingestRecording({ filePath: audioPath, workDir, model: 'medium', lang: 'ru' });
      const text = (transcript.segments || []).map((s) => s.text).join(' ').trim();
      return { text, duration: transcript.duration ?? null };
    } catch (err) {
      return reply.code(500).send({ error: 'transcribe_failed', message: err.message });
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* мусор в tmp не критичен */ }
    }
  });

  // Чат по задаче (worktree задачи).
  fastify.post('/api/tasks/:id/chat', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const {
      message, model, modelRef, effort, mode, sessionId, context, attachments, chatKey, requestTitle,
    } = request.body || {};
    if (!(message || '').trim() && !attachments?.length) return reply.code(400).send({ error: 'empty_message' });
    return runChat(reply, request, {
      id, message, model, modelRef, effort, mode, sessionId, context, attachments, chatKey, requestTitle,
    });
  });

  // Свободный чат без задачи (корень фабрики).
  fastify.post('/api/chat', async (request, reply) => {
    const {
      message, model, modelRef, effort, mode, sessionId, context, attachments, chatKey, requestTitle,
    } = request.body || {};
    if (!(message || '').trim() && !attachments?.length) return reply.code(400).send({ error: 'empty_message' });
    return runChat(reply, request, {
      id: null, message, model, modelRef, effort, mode, sessionId, context, attachments, chatKey, requestTitle,
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
  fastify.get('/api/chat/store', async () => ({
    ...(await history.read()),
    compactWindow: Math.max(0, Number(prefs?.read()?.chatAutoCompactWindow) || 0),
  }));

  // Полная запись стора. Осталась для миграции со старой схемы и восстановления
  // из браузерного снимка; в обычной работе клиент ею НЕ пользуется — с ростом истории
  // тело перерастало лимит запроса, сервер отвечал 413, и переписка не сохранялась вообще.
  fastify.put('/api/chat/store', async (request) => {
    await history.save(request.body || {});
    return { ok: true };
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
    const { written, restored, dropped, stale, chat: saved } = await history.saveOne(chat, !!archived);
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
  });

  fastify.get('/api/chat/store/chat/:id', async (request, reply) => {
    const chat = await history.readOne(String(request.params.id));
    if (!chat) return reply.code(404).send({ error: 'no_chat' });
    return { chat };
  });

  fastify.delete('/api/chat/store/chat/:id', async (request) => {
    const id = String(request.params.id);
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
