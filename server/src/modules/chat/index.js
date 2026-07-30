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
import { modelInfo } from '../../lib/models-registry.js';
import { resolveRequestedEffort } from '../../lib/model-effort.js';
import { ChatHistoryStore } from '../../lib/chat/history-store.js';
import {
  finishChatTitleHook,
  visibleChatTitleStep,
  withChatTitleHook,
} from '../../lib/chat/title-hook.js';

const PERM_MCP_PATH = fileURLToPath(new URL('../../lib/chat/permission-mcp.js', import.meta.url));

async function chatModule(fastify, opts) {
  const {
    factoryState, config, claudeAuth, internalToken, prefs,
  } = opts;

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
  const activeRuns = new Map(); // chatKey → { startedAt, tokens, steps[], ac }

  // ── Очередь ходов на чат ─────────────────────────────────────────────────────
  // ДВА CLI НА ОДНУ СЕССИЮ НЕ ЖИВУТ: второй `claude --resume <тот же id>` падает
  // мгновенно (result без текста, subtype error_during_execution, turns=0, cost=0),
  // а человек видит «⚠ Агент завершил ход без текстового ответа» и повторяет вопрос —
  // порождая ещё один процесс-смертник (инцидент 27.07.2026: три повтора подряд,
  // три потерянных сообщения; в сессию CLI они не попали вовсе, агент их не увидел).
  // Поэтому сообщение, пришедшее во время чужого хода, НЕ отклоняем и ввод не блокируем
  // (человек имеет право готовить следующее сообщение) — ставим в очередь: запрос висит,
  // пока не дойдёт черёд, и уходит сразу после текущего хода.
  const chatQueues = new Map();   // chatKey → промис последнего поставленного в очередь хода
  const lastSession = new Map();  // chatKey → sessionId последнего завершённого хода

  /** Поставить ход в очередь чата (FIFO). Без chatKey очередь не построить — гоним сразу. */
  function enqueueTurn(chatKey, job) {
    if (!chatKey) return job();
    const prev = chatQueues.get(chatKey) || Promise.resolve();
    // .catch до then: упавший ход не должен вешать очередь — следующий обязан пойти.
    const next = prev.catch(() => {}).then(job);
    chatQueues.set(chatKey, next);
    next.catch(() => {}).finally(() => {
      // Чистим ТОЛЬКО собственный хвост: иначе снесли бы ссылку на чужой, уже вставший в очередь ход.
      if (chatQueues.get(chatKey) === next) chatQueues.delete(chatKey);
    });
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
      chatKey, startedAt: v.startedAt, tokens: v.tokens, steps: v.steps,
    })),
  }));

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
      p.resolve({ behavior: 'deny', message });
      fastify.sse.broadcast('chat-permission-done', { pid });
    }
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
      pendingPerms.set(pid, { resolve, isQuestion, tool: tool_name || '?', input: input || {}, chatKey: chatKey || '', at });
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
    if (p.isQuestion) {
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
  async function runChat(reply, request, opts) {
    const chatKey = opts.chatKey || '';
    const queued = !!chatKey && (activeRuns.has(chatKey) || chatQueues.has(chatKey));
    if (queued) {
      fastify.log.info({ chatKey }, 'чат: ход уже идёт — сообщение поставлено в очередь');
      // Второму окну (и своему же, если оно захочет показать «в очереди») — сигнал.
      fastify.sse.broadcast('chat-queued', { chatKey, at: Date.now() });
    }
    return enqueueTurn(chatKey, () => runChatTurn(reply, request, { ...opts, queued }));
  }

  async function runChatTurn(reply, request, {
    id, message, model, effort, mode: wantMode, sessionId, context, attachments,
    chatKey, queued, requestTitle,
  }) {
    const wantsTitle = requestTitle === true;
    // Сообщение ждало в очереди — его sessionId устарел: пока оно стояло, предыдущий ход
    // мог завести новый id, и запуск со старым потерял бы контекст разговора. Пустой
    // sessionId не трогаем: это осознанный старт нового разговора, а не устаревшая копия.
    if (queued && sessionId && lastSession.get(chatKey)) sessionId = lastSession.get(chatKey);
    let cwd = config.factoryHome;
    // Настройка читается перед каждым ходом: кнопка в настройках действует сразу,
    // без рестарта сервера и без изменения глобальных конфигов конкретных CLI.
    const extraDirs = [...(prefs?.read().trustedDirectories || [])];
    if (id) {
      const env = await factoryState.readEnv(id);
      if (env.BE_WT) cwd = env.BE_WT;
      if (env.FE_WT) extraDirs.push(env.FE_WT);
    }
    const mode = pageMode(context, !!id);
    if (mode.cwd) cwd = mode.cwd;

    // Вложения: клиент присылает имена файлов, ранее загруженных через /api/chat/upload.
    // Пути строим сами (только внутри attachDir) и открываем агенту доступ через --add-dir.
    let attachBlock = '';
    const attachPaths = (attachments || [])
      .map((a) => attachFile(a?.file))
      .filter(Boolean);
    if (attachPaths.length) {
      extraDirs.push(attachDir);
      attachBlock = `[Вложения]\nПользователь приложил файлы (открой их инструментом Read):\n${attachPaths.map((p) => `- ${p}`).join('\n')}\n[/Вложения]\n\n`;
    }
    // Один и тот же каталог может прийти из доверенного списка, worktree и вложений.
    // Повторные --add-dir не опасны, но засоряют командную строку и диагностику.
    const uniqueExtraDirs = [...new Set(extraDirs.map((dir) => path.resolve(dir)))];
    const fullMessage = withChatTitleHook(
      contextPrefix(context, mode.hint) + attachBlock + (message || 'Посмотри вложения.'),
      wantsTitle,
    );

    // Исполнитель — по модели из реестра (lib/models-registry). Неизвестная модель → claude.
    const info = await modelInfo(model, config);
    const provId = info?.provider || 'claude';
    const executor = await getExecutor(provId);
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
    const runRec = { startedAt: Date.now(), tokens: 0, steps: [], ac };
    if (chatKey) {
      activeRuns.set(chatKey, runRec);
      // Ход пошёл: окна снимают со своего сообщения метку «ждёт очереди».
      fastify.sse.broadcast('chat-turn-start', { chatKey, at: runRec.startedAt });
    }
    // Ожидание ответа человека не должно упираться в таймаут вызова MCP-инструмента.
    const baseEnv = claudeAuth ? claudeAuth.env() : process.env;
    try {
      const runArgs = {
        config,
        signal: ac.signal,
        env: { ...baseEnv, MCP_TOOL_TIMEOUT: String(PERM_WAIT_MS) },
        message: fullMessage,
        cwd,
        extraDirs: uniqueExtraDirs,
        model,
        effort: runEffort,
        sessionId,
        permissionMode,
        mcpConfig,
        permissionPromptTool: 'mcp__cockpit-perm__approve',
        log: fastify.log,
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
          if (a && a.steps.length < 400) a.steps.push(visibleStep);
          fastify.sse.broadcast('chat-step', { chatKey, step: visibleStep });
        } : undefined,
      };
      let out = await executor.run(runArgs);
      // Пустой ход (ноль шагов, ноль стоимости) = CLI умер на старте и НИЧЕГО не сделал.
      // Повторить его безопасно — и честнее, чем отдать человеку заглушку и ждать, что
      // он пришлёт сообщение заново (а он пришлёт — и получит то же самое).
      if (out?.emptyRun) {
        fastify.log.warn({ chatKey, subtype: out.subtype }, 'чат: ход пустой (ноль шагов) — повторяю один раз');
        out = await executor.run(runArgs);
      }
      // Название — метаданные Cockpit, маркер из видимого ответа/истории уже удалён.
      out = finishChatTitleHook(out, wantsTitle);
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
        // sessionId — тот, что CLI успел завести в этом ходе (executor ловит его из потока).
        // Раньше сюда уходил ВХОДНОЙ id, а у первого хода в чате он пустой: после «стопа»
        // следующий вопрос шёл без --resume, и агент не помнил ничего из разговора.
        const stoppedOut = finishChatTitleHook({
          reply: '⏹ Ход остановлен.', steps: err.steps || [], sessionId: err.sessionId || sessionId || null,
          contextTokens: 0, cost: null, model: model || null, effort: runEffort || null, stopped: true,
        }, wantsTitle);
        // Оборванный ход всё равно завёл разговор: следующему из очереди нужен ЕГО id,
        // иначе сообщение уйдёт со старым и агент не вспомнит, на чём его прервали.
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
          chatKey, role: 'error', reply: err.message, userText: message || '', at: Date.now() });
        fastify.sse.broadcast('chat-orphan', { chatKey });
        return reply;
      }
      return reply.code(500).send({ error: 'chat_failed', message: err.message });
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
      message, model, effort, mode, sessionId, context, attachments, chatKey, requestTitle,
    } = request.body || {};
    if (!(message || '').trim() && !attachments?.length) return reply.code(400).send({ error: 'empty_message' });
    return runChat(reply, request, {
      id, message, model, effort, mode, sessionId, context, attachments, chatKey, requestTitle,
    });
  });

  // Свободный чат без задачи (корень фабрики).
  fastify.post('/api/chat', async (request, reply) => {
    const {
      message, model, effort, mode, sessionId, context, attachments, chatKey, requestTitle,
    } = request.body || {};
    if (!(message || '').trim() && !attachments?.length) return reply.code(400).send({ error: 'empty_message' });
    return runChat(reply, request, {
      id: null, message, model, effort, mode, sessionId, context, attachments, chatKey, requestTitle,
    });
  });

  // ── Хранилище истории чатов: файлы chats/YYYY-MM/<id>.json (см. lib/chat/history-store) ──
  const history = new ChatHistoryStore({
    chatsDir: config.chatsDir,
    legacyPath: config.chatStoreLegacyPath,
    log: fastify.log,
  });

  fastify.get('/api/chat/store', async () => history.read());

  // Полная запись стора. Осталась для миграции со старой схемы и восстановления
  // из браузерного снимка; в обычной работе клиент ею НЕ пользуется — с ростом истории
  // тело перерастало лимит запроса, сервер отвечал 413, и переписка не сохранялась вообще.
  fastify.put('/api/chat/store', async (request) => {
    await history.save(request.body || {});
    return { ok: true };
  });

  // ── Точечное сохранение: одно тело — один чат ──
  // Объём запроса больше не зависит от того, сколько чатов накопилось всего.
  fastify.put('/api/chat/store/chat', async (request, reply) => {
    const { chat, archived } = request.body || {};
    if (!chat?.id) return reply.code(400).send({ error: 'bad_chat' });
    const written = await history.saveOne(chat, !!archived);
    return { ok: true, written };
  });

  fastify.delete('/api/chat/store/chat/:id', async (request) => {
    const removed = await history.remove(String(request.params.id));
    return { ok: true, removed };
  });

  // Мета отдельно: переключение вкладки не тащит за собой переписку.
  fastify.put('/api/chat/store/meta', async (request) => ({ ok: true, meta: await history.saveMeta(request.body || {}) }));
}

export default fp(chatModule, { name: 'module-chat' });
