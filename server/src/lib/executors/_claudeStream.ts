// Долгоживущая сессия Claude Code: ОДИН процесс CLI на чат вместо процесса на ход.
//
// Зачем: в режиме `claude -p "текст"` процесс умирает вместе с ответом, поэтому всё,
// что агент оставил после себя, умирает тоже — фоновые команды, субагенты и любое
// ожидание. Обещание «послежу и сообщу, когда закончится» в такой модели невыполнимо
// физически. Режим `--input-format stream-json` («realtime streaming input») — тот же,
// в котором работает расширение VS Code: процесс остаётся живым между ходами, помнит
// разговор без `--resume` и САМ выдаёт новый ход, когда фоновая задача завершилась.
//
// Замер, ради которого это написано (haiku, /tmp): ход закончен на 9.1 с, а на 21.4 с
// в тот же поток пришёл второй ответ — без единого сообщения от клиента.
//
// Разбор потока здесь общий с разовым `run()`: событие CLI одно и то же, и вторая
// копия правил про usage, компакт и пустой ответ разошлась бы с первой.
import { spawn } from 'node:child_process';

import { contextCacheStatus, reportedContextCache } from '../chat/contextCache.ts';
import type { ContextCache } from '../chat/contextCache.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import type { ChatStep, StepSink } from '../chat/streamSteps.ts';
import { toClaudeSteps } from './_claudeSteps.ts';
import { defaultWorkToolDescriptors } from './work-tools/index.ts';

// Служебная модель внутренних вызовов CLI: её usage к контексту разговора не относится.
export const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Текст assistant-сообщения потока: блоки content склеиваются, всё нетекстовое
 * (tool_use, thinking) отбрасывается.
 */
function claudeMessageText(message: { content?: unknown } | undefined): string {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const item = block as { type?: unknown; text?: unknown };
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

// Событие stream-json CLI. Форма зависит от типа, поэтому объявлено ровно читаемое.
interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  model?: string;
  compactMetadata?: unknown;
  message?: { model?: string; usage?: Record<string, unknown>; content?: unknown };
  usage?: Record<string, unknown>;
  result?: string;
  num_turns?: number;
  permission_denials?: Array<{ tool_name?: unknown }>;
  total_cost_usd?: number;
  response?: { request_id?: unknown };
  request_id?: unknown;
}

// Состояние одного хода: что уже сказал CLI про токены, модель и сессию.
interface TurnState {
  resultEv: ClaudeEvent | null;
  spentTokens: number;
  lastTurnInput: number | null;
  lastContextCache: ContextCache | null;
  actualModel: string;
  streamSessionId: string;
  // Текст последнего сообщения, которое CLI сочинил САМ (модель <synthetic>): сбой
  // доставки, обрыв соединения, «No response requested.». Сбрасывается, как только
  // заговорила настоящая модель, — тогда ход сбой пережил.
  lastSyntheticText: string;
}

// Сборщик хода: лента шагов плюс его состояние.
export interface ClaudeTurnCollector {
  push: (ev: unknown) => void;
  state: TurnState;
  stepSink: StepSink;
  readonly steps: ChatStep[];
}

// Журнал сервера в том минимуме, который использует поток.
interface StreamLog {
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Сборщик одного хода: копит шаги, токены и телеметрию контекста из потока событий.
 * Живёт ровно один ход, потому что лента шагов и счётчик токенов — свойства хода,
 * а не сессии: в долгоживущем процессе их иначе пришлось бы обнулять руками.
 */
export function createClaudeTurnCollector({ onStep, onProgress, log }: {
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, extra: Record<string, unknown>) => void;
  log?: StreamLog;
} = {}): ClaudeTurnCollector {
  const stepSink = createStepSink(onStep);

  const state: TurnState = {
    resultEv: null,
    spentTokens: 0,
    lastTurnInput: null,
    lastContextCache: null,
    actualModel: '',
    streamSessionId: '',
    lastSyntheticText: '',
  };

  function push(value: unknown): void {
    if (!value || typeof value !== 'object') return;

    const ev = value as ClaudeEvent;

    stepSink.emitAll(toClaudeSteps(ev));

    // В том же потоке идут обращения субагентов. Их отдельные окна не заменяют
    // контекст основного разговора, хотя сами шаги остаются в ленте.
    if (ev.parent_tool_use_id) return;

    // session_id CLI проставляет во всех событиях, начиная с init. Забираем сразу:
    // у оборванного хода финального result нет, а продолжать разговор всё равно нужно.
    if (ev.session_id) state.streamSessionId = ev.session_id;

    if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
      state.actualModel = ev.model;
      return;
    }

    if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
      // Старый замер после сжатия уже недействителен. Это отсутствие нового
      // измерения, а не пустой контекст; ближайший запрос вернёт точную цифру.
      state.lastTurnInput = null;
      state.lastContextCache = contextCacheStatus('unavailable');
      try {
        onProgress?.(state.spentTokens, {
          contextTokens: 0,
          contextMetric: 'unavailable',
          contextIsEstimate: false,
          contextCache: state.lastContextCache,
        });
      } catch { /* прогресс не критичен */ }
      log?.info?.({ meta: ev.compactMetadata || null }, 'чат: CLI сжал контекст сам');
      return;
    }

    // Сообщение, сочинённое самим CLI: до модели запрос не дошёл («API Error: …»,
    // «Connection closed mid-response», «No response requested.»). Токенов оно не несёт,
    // ответом агента не является — запоминаем только текст, чтобы отличить ход,
    // который таким сообщением и ЗАКОНЧИЛСЯ, от нормального ответа.
    if (ev.type === 'assistant' && ev.message?.model === SYNTHETIC_MODEL) {
      state.lastSyntheticText = claudeMessageText(ev.message);
      return;
    }

    if (ev.type === 'assistant' && ev.message?.usage && ev.message.model !== SYNTHETIC_MODEL) {
      // Модель заговорила после сбоя — ход его пережил, прежняя отметка недействительна.
      state.lastSyntheticText = '';
      const usage = ev.message.usage as Record<string, number>;
      state.spentTokens += usage.output_tokens || 0;
      if (ev.message.model) state.actualModel = ev.message.model;
      const inputs = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
      const input = usage.input_tokens;
      const validInput = typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
        && inputs.every((tokens) => tokens === undefined || (Number.isSafeInteger(tokens) && tokens >= 0));
      state.lastTurnInput = validInput
        ? inputs.reduce<number>((sum, tokens) => sum + (tokens ?? 0), 0)
        : null;

      // Поля кэша относятся именно к ТЕКУЩЕМУ обращению к модели; накопительный
      // result.usage для этого не годится.
      const cacheFields: Record<string, unknown> = {};
      if (Object.hasOwn(usage, 'cache_read_input_tokens')) {
        cacheFields.readTokens = usage.cache_read_input_tokens;
      }
      if (Object.hasOwn(usage, 'cache_creation_input_tokens')) {
        cacheFields.writeTokens = usage.cache_creation_input_tokens;
      }
      if (Object.hasOwn(usage, 'input_tokens')) cacheFields.uncachedTokens = usage.input_tokens;
      state.lastContextCache = reportedContextCache(cacheFields);

      try {
        onProgress?.(state.spentTokens, {
          contextTokens: state.lastTurnInput ?? 0,
          contextMetric: state.lastTurnInput === null ? 'unavailable' : 'active-input-v1',
          contextIsEstimate: false,
          contextCache: state.lastContextCache,
        });
      } catch { /* прогресс не критичен */ }
      return;
    }

    if (ev.type === 'result') state.resultEv = ev;
  }

  return { push, state, stepSink, get steps() { return stepSink.steps; } };
}

/**
 * Итог хода из собранного состояния. Пустой result — не ошибка транспорта: агент мог
 * упереться в лимит шагов или в запрет действия, и человеку нужен диагноз, а не молчание.
 */
export function buildClaudeTurnResult(collector: ClaudeTurnCollector, {
  fallbackSessionId = null,
  stderrTail = '',
  log,
}: {
  fallbackSessionId?: string | null;
  stderrTail?: string;
  log?: StreamLog;
} = {}) {
  const { state, steps } = collector;
  const ev = state.resultEv || {} as ClaudeEvent;
  const contextTokens = state.lastTurnInput ?? 0;

  let reply = ev.result || '';
  // Ход, в котором не случилось ни одного обращения к модели: запуск ничего не сделал
  // и ничего не стоил — только такой безопасно повторять автоматически.
  const emptyRun = !reply && !ev.num_turns;

  if (!reply) {
    log?.warn?.({
      subtype: ev.subtype,
      turns: ev.num_turns,
      denials: ev.permission_denials,
      stderr: String(stderrTail || '').trim().slice(-400),
    }, 'чат: пустой result от claude');

    // AskUserQuestion кокпит «отклоняет» намеренно — так ответ человека доезжает до
    // агента. Это не отказ в действии, в текст предупреждения его не тащим.
    const denied = [...new Set((ev.permission_denials || [])
      .map((entry) => entry.tool_name)
      .filter((name) => name && name !== 'AskUserQuestion'))];
    const why = ev.subtype && ev.subtype !== 'success' ? ` (${ev.subtype})` : '';
    const tail = String(stderrTail || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(-300);
    const cliNote = tail ? `\n\nCLI сказал: ${tail}` : '';

    if (ev.subtype === 'error_max_turns') {
      reply = '⚠ Агент упёрся в лимит шагов и не успел сформулировать ответ. '
        + 'Переформулируй запрос или разбей его на части.';
    } else if (denied.length) {
      reply = `⚠ Действия не были разрешены (${denied.join(', ')}) — агент завершил ход без ответа. `
        + 'Разреши действие во всплывашке или переформулируй запрос.';
    } else if (emptyRun) {
      reply = `⚠ Агент не начал работу${why}: ни одного шага, ход пуст. `
        + `Обычно это упавший запуск CLI — нет сети/VPN, лимит Anthropic или занятая сессия.${cliNote}`;
    } else {
      reply = `⚠ Агент завершил ход без текстового ответа${why}. Повтори вопрос — контекст сохранён.${cliNote}`;
    }
  }

  // Ход ЗАКОНЧИЛСЯ сообщением, которое CLI сочинил сам: до модели запрос так и не
  // дошёл (сеть, TLS, 529, обрыв соединения). Такой текст CLI кладёт и в result —
  // раньше он уезжал в историю как ответ агента, и вся работа хода выглядела
  // выброшенной. Сверяем именно с ПОСЛЕДНИМ синтетическим сообщением: если после него
  // модель успела ответить, отметка уже сброшена и ход считается обычным.
  const cliCut = String(state.lastSyntheticText || '').trim();
  const deliveryFailure = !!cliCut && cliCut === String(reply || '').trim();

  return {
    reply,
    sessionId: ev.session_id || state.streamSessionId || fallbackSessionId || null,
    cost: ev.total_cost_usd ?? null,
    contextTokens,
    contextMetric: state.lastTurnInput === null ? 'unavailable' : 'active-input-v1',
    contextIsEstimate: false,
    contextCache: state.lastContextCache || contextCacheStatus('unavailable'),
    actualModel: state.actualModel,
    steps,
    emptyRun,
    deliveryFailure,
    subtype: ev.subtype || '',
  };
}

/**
 * Аргументы запуска долгоживущей сессии. Всё, что здесь перечислено, фиксируется на
 * ЖИЗНЬ процесса: модель, усилие, режим прав, доверенные каталоги и MCP-конфиг —
 * это флаги командной строки, менять их на лету нечем. Смена любого из них означает
 * перезапуск сессии по сохранённому sessionId (см. restartOn в контракте исполнителя).
 */
export function claudeSessionArgs({
  model, effort, permissionMode, sessionId, extraDirs = [],
  mcpConfig, permissionPromptTool, providerSettingsArgs = [], workTools,
}: {
  model?: string;
  effort?: string;
  permissionMode?: string;
  sessionId?: string | null;
  extraDirs?: readonly string[];
  mcpConfig?: { mcpServers?: Record<string, unknown> } | null;
  permissionPromptTool?: string;
  providerSettingsArgs?: readonly string[];
  workTools?: { descriptors?: unknown } | null;
}): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode || 'default',
  ];
  args.push(...providerSettingsArgs);
  if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig));
  if (mcpConfig?.mcpServers?.['cockpit-work']) {
    const descriptors = Array.isArray(workTools?.descriptors)
      ? workTools.descriptors
      : defaultWorkToolDescriptors('claude');
    const allowed = (descriptors as Array<{
      name?: unknown;
      function?: { name?: unknown };
    } | null>)
      .map((descriptor) => descriptor?.name || descriptor?.function?.name)
      .filter(Boolean)
      .map((name) => `mcp__cockpit-work__${name}`)
      .join(',');
    if (allowed) {
      args.push('--allowedTools', allowed);
    }
  }
  if (permissionPromptTool) args.push('--permission-prompt-tool', permissionPromptTool);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);
  for (const dir of extraDirs) args.push('--add-dir', dir);
  return args;
}

const INTERRUPT_WAIT_MS = 5_000;
const CLOSE_WAIT_MS = 3_000;
const STDERR_TAIL = 4_000;

/**
 * Живая сессия: процесс поднимается один раз и обслуживает все ходы чата, пока его
 * не погасят по простою, по смене модели или вместе с сервером.
 *
 * Два вида ходов приходят одним потоком, и различить их может только владелец:
 * ход, который кто-то заказал через send(), и НЕПРОШЕНЫЙ — когда CLI сам разбудил
 * модель (фоновая задача закончилась, субагент отчитался). Второй некому вернуть
 * ответом на HTTP-запрос, поэтому он уезжает в hooks.onBackground и дальше в историю
 * чата и SSE — тем же путём, которым доезжают ответы после закрытого окна.
 */
export function openClaudeStreamSession({
  bin, args, cwd, env, sessionId = null, log, hooks = {},
}: {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string | null;
  log?: StreamLog;
  hooks?: Record<string, ((...values: never[]) => unknown) | undefined>;
}) {
  const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  const state: {
    sessionId: string | null;
    exited: boolean;
    exitReason: string;
    turn: {
      collector: ClaudeTurnCollector;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      onSessionCreated?: (sessionId: string) => unknown;
      sessionAnnounced: boolean;
    } | null;
    background: ClaudeTurnCollector | null;
    interruptRequested: boolean;
  } = {
    sessionId: sessionId || null,
    exited: false,
    exitReason: '',
    turn: null,          // активный заказанный ход
    background: null,    // непрошеный ход, начавшийся сам
    // Прерванный ход CLI закрывает обычным result с subtype error_during_execution.
    // Без этой отметки «стоп» выглядел бы как ход без ответа, а человеку нужна лента
    // сделанного и пометка остановки — ровно как у разового запуска.
    interruptRequested: false,
  };
  const controls = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  let controlSeq = 0;
  let stdoutBuf = '';
  let stderrTail = '';

  const exitWaiters: Array<() => void> = [];

  function writeLine(payload: unknown): void {
    if (state.exited || child.stdin?.destroyed) {
      throw new Error('Сессия агента уже закрыта.');
    }
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  // Непрошеный ход начинается с любого события, пришедшего вне заказанного хода.
  function backgroundCollector() {
    if (!state.background) {
      state.background = createClaudeTurnCollector({
        onStep: (step) => hooks.onBackgroundStep?.(step as never),
        onProgress: (tokens, extra) => (
          hooks.onBackgroundProgress?.(tokens as never, extra as never)
        ),
        log,
      });
      hooks.onBackgroundStart?.();
    }
    return state.background;
  }

  function finishBackground() {
    const collector = state.background;
    state.background = null;
    if (!collector) return;
    const result = buildClaudeTurnResult(collector, {
      fallbackSessionId: state.sessionId,
      stderrTail,
      log,
    });
    state.sessionId = result.sessionId || state.sessionId;
    hooks.onBackground?.(result as never);
  }

  function handleEvent(ev: ClaudeEvent): void {
    if (ev?.type === 'control_response') {
      const requestId = String(ev.response?.request_id || ev.request_id || '');
      const waiter = controls.get(requestId);
      if (waiter) {
        controls.delete(requestId);
        waiter.resolve(ev.response || {});
      }
      return;
    }

    const collector = state.turn ? state.turn.collector : backgroundCollector();
    collector.push(ev);

    // Id сессии известен с первого события хода: сообщаем его вызывающему сразу, а не
    // в конце хода, — иначе перезапуск сервера посреди первого хода оставлял чат без
    // сессии, и следующее сообщение начинало разговор с нуля.
    if (state.turn && !state.turn.sessionAnnounced && ev.session_id) {
      const turn = state.turn;
      turn.sessionAnnounced = true;
      if (!state.sessionId) state.sessionId = ev.session_id;
      void Promise.resolve()
        .then(() => turn.onSessionCreated?.(ev.session_id as string))
        .catch((error) => {
          log?.warn?.({ err: (error as Error)?.message }, 'чат: id сессии не принят вызывающим');
        });
    }

    if (ev?.type !== 'result') return;

    if (state.turn) {
      const turn = state.turn;
      state.turn = null;
      const result = buildClaudeTurnResult(turn.collector, {
        fallbackSessionId: state.sessionId,
        stderrTail,
        log,
      });
      state.sessionId = result.sessionId || state.sessionId;

      if (state.interruptRequested) {
        state.interruptRequested = false;
        const stopped = Object.assign(new Error('Ход остановлен.'), {
          stopped: true,
          steps: result.steps,
          sessionId: state.sessionId,
          contextTokens: result.contextTokens,
          contextMetric: result.contextMetric,
          contextIsEstimate: result.contextIsEstimate,
          contextCache: result.contextCache,
        });
        turn.reject(stopped);
        return;
      }
      turn.resolve(result);
      return;
    }
    finishBackground();
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let ev: ClaudeEvent;
      try { ev = JSON.parse(line); } catch { continue; }
      try {
        handleEvent(ev);
      } catch (error) {
        log?.warn?.(
          { err: (error as Error)?.message },
          'чат: сбой разбора события живой сессии claude',
        );
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL);
  });

  child.on('error', (error: Error) => {
    state.exitReason = error?.message || 'процесс агента не запустился';
  });

  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    state.exited = true;
    if (!state.exitReason) {
      state.exitReason = signal
        ? `процесс агента завершён сигналом ${signal}`
        : `процесс агента завершился (код ${code ?? '?'})`;
    }
    // Незакрытый ход больше никто не завершит: поток кончился вместе с процессом.
    if (state.turn) {
      const turn = state.turn;
      state.turn = null;
      const error = Object.assign(
        new Error(`${state.exitReason}${stderrTail.trim() ? `: ${stderrTail.trim().slice(-300)}` : ''}`),
        { sessionId: state.sessionId },
      );
      turn.reject(error);
    }
    for (const waiter of controls.values()) waiter.reject(new Error(state.exitReason));
    controls.clear();
    // Непрошеный ход, оборванный на середине, наружу не отдаём: у него нет result,
    // а придуманный ответ хуже отсутствующего.
    state.background = null;
    hooks.onExit?.({ code, signal, reason: state.exitReason } as never);
    for (const resolve of exitWaiters.splice(0)) resolve();
  });

  async function control(subtype: string, extra: Record<string, unknown> = {}) {
    const requestId = `req_${++controlSeq}`;
    const waiting = new Promise<unknown>((resolve, reject) => {
      controls.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (!controls.has(requestId)) return;
        controls.delete(requestId);
        reject(new Error(`Агент не ответил на управляющий запрос ${subtype}.`));
      }, INTERRUPT_WAIT_MS).unref?.();
    });
    writeLine({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } });
    return waiting;
  }

  return {
    get pid() { return child.pid; },
    get sessionId() { return state.sessionId; },
    get alive() { return !state.exited; },
    get busy() { return !!state.turn; },

    /** Заказанный ход: пишем сообщение в stdin и ждём его result. */
    send({ message, onStep, onProgress, onSessionCreated }: {
      message?: unknown;
      onStep?: (step: ChatStep) => void;
      onProgress?: (tokens: number, extra: Record<string, unknown>) => void;
      onSessionCreated?: (sessionId: string) => unknown;
    }) {
      if (state.exited) return Promise.reject(new Error(state.exitReason || 'Сессия агента закрыта.'));
      if (state.turn) return Promise.reject(new Error('В этой сессии уже идёт ход.'));

      // Непрошеный ход не может идти одновременно с заказанным: CLI обрабатывает
      // сообщения по очереди. Если он ещё не закрыт — закрываем его сейчас, иначе
      // его шаги прилипли бы к новому ходу.
      if (state.background) finishBackground();

      const collector = createClaudeTurnCollector({ onStep, onProgress, log });
      return new Promise<unknown>((resolve, reject) => {
        state.turn = {
          collector, resolve, reject, onSessionCreated, sessionAnnounced: false,
        };
        try {
          writeLine({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: String(message || '') }] },
          });
        } catch (error) {
          state.turn = null;
          reject(error);
        }
      });
    },

    /**
     * «Стоп» прерывает ХОД, а не сессию: замер показывает, что после control_request
     * interrupt процесс жив и принимает следующий вопрос с полным контекстом.
     * Прежняя модель убивала процесс, потому что другого способа не было.
     */
    async interrupt() {
      if (state.exited) return;
      if (state.turn) state.interruptRequested = true;
      try {
        await control('interrupt');
      } catch (error) {
        // Ход мог закончиться сам, пока запрос летел: это не повод падать.
        state.interruptRequested = false;
        log?.warn?.({ err: (error as Error)?.message }, 'чат: прерывание хода не подтверждено');
      }
    },

    async close({ waitMs = CLOSE_WAIT_MS } = {}) {
      if (state.exited) return;
      const exited = new Promise<void>((resolve) => { exitWaiters.push(resolve); });
      try { child.stdin?.end(); } catch { /* уже закрыт */ }
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* уже мёртв */ }
      }, waitMs);
      timer.unref?.();
      await exited;
      clearTimeout(timer);
    },
  };
}
