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
import { randomUUID } from 'node:crypto';
import type { ChatRunMetadata } from '../../../../shared/chatRun.ts';
import type { PreparedNativeSettings } from '../executorSettings/types.ts';
import { verifyNativeSettings } from '../executorSettings/capability.ts';
import { decodeSettingsJson } from '../../../../shared/providerSettingsContracts.ts';

import { contextCacheStatus, reportedContextCache } from '../chat/contextCache.ts';
import type { ContextCache } from '../chat/contextCache.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import type { ChatStep, StepSink } from '../chat/streamSteps.ts';
import type {
  InTurnAssistantEvent,
  InTurnPort,
  InTurnReceiptEvent,
  InTurnUnavailableReason,
} from '../../../../shared/chatInTurnContracts.ts';
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

/**
 * Есть ли в событии вызов инструмента. CLI присылает его отдельным content-блоком
 * с id сообщения: текст перед вызовом к этому моменту уже дописан.
 */
function claudeMessageCallsTool(message: { content?: unknown } | undefined): boolean {
  const blocks = Array.isArray(message?.content) ? message.content : [];

  return blocks.some((block) => (block as { type?: unknown } | null)?.type === 'tool_use');
}

// Событие stream-json CLI. Форма зависит от типа, поэтому объявлено ровно читаемое.
interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  model?: string;
  compactMetadata?: unknown;
  message?: {
    id?: unknown;
    model?: string;
    usage?: Record<string, unknown>;
    content?: unknown;
  };
  usage?: Record<string, unknown>;
  // system/thinking_tokens: оценка рассуждений текущего обращения — накопительно и дельтой.
  estimated_tokens?: unknown;
  estimated_tokens_delta?: unknown;
  result?: string;
  num_turns?: number;
  permission_denials?: Array<{ tool_name?: unknown }>;
  total_cost_usd?: number;
  response?: { request_id?: unknown };
  request_id?: unknown;
  command_uuid?: string;
  state?: string;
  uuid?: string;
  isReplay?: boolean;
  user_message_uuid?: string;
}

/**
 * Длина вывода модели в символах: текст и аргументы вызовов инструментов. Рассуждения
 * не считаются — их оценку CLI присылает сам (system/thinking_tokens), а несериализуемые
 * аргументы честно считаются нулём.
 */
function claudeOutputChars(message: { content?: unknown } | undefined): number {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let chars = 0;

  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    const item = block as { type?: unknown; text?: unknown; input?: unknown };

    if (item.type === 'text' && typeof item.text === 'string') {
      chars += item.text.length;
    } else if (item.type === 'tool_use' && item.input !== undefined) {
      try {
        chars += JSON.stringify(item.input).length;
      } catch { /* аргументы без представления — ноль */ }
    }
  }

  return chars;
}

// Грубая оценка вывода по символам, пока ход идёт: тот же способ оценки, что у DeepSeek.
const CHARS_PER_TOKEN = 3;
// Дельты рассуждений идут часто; в окно уходит не каждая — как у остальных исполнителей.
const PROGRESS_THROTTLE_MS = 400;

// Состояние одного хода: что уже сказал CLI про токены, модель и сессию.
interface TurnState {
  resultEv: ClaudeEvent | null;
  // Расход ВЫВОДА хода. Пока ход идёт — оценка по потоку (spentIsEstimate = true):
  // `usage.output_tokens` в assistant-событиях — снимок НАЧАЛА ответа (единицы токенов,
  // проверено на CLI: 4 и 2 при 188 по итогу), расходом он не является. Точная цифра за ход
  // приезжает только с `result.usage.output_tokens` — тогда оценка заменяется ею.
  spentTokens: number;
  spentIsEstimate: boolean;
  // Слагаемые оценки: рассуждения считает сам CLI (system/thinking_tokens, по запросу
  // накопительно — берём дельты), текст и аргументы инструментов — по символам.
  thinkingEstimated: number;
  contentChars: number;
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
export function createClaudeTurnCollector({ onStep, onProgress, onRunMetadata, log }: {
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, extra: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
  log?: StreamLog;
} = {}): ClaudeTurnCollector {
  const stepSink = createStepSink(onStep);
  let lastReportAt = 0;

  const state: TurnState = {
    resultEv: null,
    spentTokens: 0,
    spentIsEstimate: true,
    thinkingEstimated: 0,
    contentChars: 0,
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
      onRunMetadata?.({ actualModelId: ev.model, modelSource: 'session' });
      return;
    }

    if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
      // Старый замер после сжатия уже недействителен. Это отсутствие нового
      // измерения, а не пустой контекст; ближайший запрос вернёт точную цифру.
      state.lastTurnInput = null;
      state.lastContextCache = contextCacheStatus('unavailable');
      reportProgress();
      log?.info?.({ meta: ev.compactMetadata || null }, 'чат: CLI сжал контекст сам');
      return;
    }

    // Рассуждения модели CLI оценивает сам и присылает накопительно ПО ТЕКУЩЕМУ обращению:
    // складываем дельты, иначе следующий запрос обнулил бы счётчик хода. В окно уходит не
    // каждая дельта — ближайшее событие всё равно унесёт накопленное.
    if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
      const delta = Number(ev.estimated_tokens_delta);

      if (Number.isFinite(delta) && delta > 0) {
        state.thinkingEstimated += delta;
        refreshEstimate();

        if (Date.now() - lastReportAt >= PROGRESS_THROTTLE_MS) {
          reportProgress();
        }
      }

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

    if (ev.type === 'assistant' && ev.message?.model && ev.message.model !== SYNTHETIC_MODEL) {
      state.actualModel = ev.message.model;
      onRunMetadata?.({ actualModelId: ev.message.model, modelSource: 'response' });
    }

    if (ev.type === 'assistant' && ev.message?.usage && ev.message.model !== SYNTHETIC_MODEL) {
      // Модель заговорила после сбоя — ход его пережил, прежняя отметка недействительна.
      state.lastSyntheticText = '';
      const usage = ev.message.usage as Record<string, number>;

      // Событие несёт один блок содержимого. Текст и аргументы инструмента — вывод модели,
      // считаем по символам; рассуждения уже сосчитал CLI, второй раз их не берём.
      // `usage.output_tokens` здесь — снимок начала ответа, к расходу отношения не имеет.
      state.contentChars += claudeOutputChars(ev.message);
      refreshEstimate();

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
      reportProgress();

      return;
    }

    if (ev.type === 'result') {
      state.resultEv = ev;

      // Точный расход вывода — только здесь, и он за ЭТОТ ход, а не за сессию (проверено
      // двумя ходами одного процесса: 75 и 68, а не 75 и 143). Оценка заменяется им, и
      // окно с пультом узнают итог уже без «≈». Пустой usage (ход без обращений к модели)
      // цифры не выдумывает.
      const output = Number(ev.usage?.output_tokens);
      const known = Number.isSafeInteger(output) && output >= 0;

      if (known && (output > 0 || state.spentTokens > 0)) {
        state.spentTokens = output;
        state.spentIsEstimate = false;
        reportProgress();
      }
    }
  }

  // Оценка расхода по потоку: рассуждения — от CLI, текст и аргументы — по символам.
  // После точной цифры из result оценка уже не нужна и её не перезатирает.
  function refreshEstimate(): void {
    if (!state.spentIsEstimate) {
      return;
    }

    state.spentTokens = state.thinkingEstimated + Math.round(state.contentChars / CHARS_PER_TOKEN);
  }

  // Событие прогресса: расход хода и снимок контекста ПОСЛЕДНЕГО обращения к модели.
  // После границы сжатия замера нет — и это честно уходит как «unavailable», а не ноль.
  function reportProgress(): void {
    lastReportAt = Date.now();

    try {
      onProgress?.(state.spentTokens, {
        tokensIsEstimate: state.spentIsEstimate,
        contextTokens: state.lastTurnInput ?? 0,
        contextMetric: state.lastTurnInput === null ? 'unavailable' : 'active-input-v1',
        contextIsEstimate: false,
        contextCache: state.lastContextCache,
      });
    } catch { /* прогресс не критичен */ }
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
 * ЖИЗНЬ процесса: модель, усилие, режим прав, дополнительные рабочие корни и MCP-конфиг —
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
    '--replay-user-messages',
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

interface ClaudeInputCommand {
  messageId: string;
  queued: boolean;
  started: boolean;
  completed: boolean;
  failed: boolean;
  // Ход закрылся раньше, чем CLI подтвердил очередь: квитанция уходит прежнему ходу.
  late?: boolean;
  onReceipt?: (event: InTurnReceiptEvent) => void | Promise<void>;
}

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
  bin, args, cwd, env, sessionId = null, nativeSettings, log, hooks = {},
}: {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string | null;
  nativeSettings?: PreparedNativeSettings;
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
      // Канал уточнений: CLI принимает дополнительные user-сообщения в тот же процесс.
      onInTurnReady?: (port: InTurnPort) => void;
      onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
      onInTurnReceipt?: (event: InTurnReceiptEvent) => void | Promise<void>;
      onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
      assistantRevision: number;
      commands: Map<string, ClaudeInputCommand>;
      // Открытый блок: id сообщения CLI и опубликованный id (с суффиксом части).
      assistantSourceId: string;
      assistantMessageId: string;
      assistantText: string;
      // Сколько блоков уже закрыто у сообщения: текст после вызова инструмента — новая часть.
      assistantParts: Map<string, number>;
      lastAssistant: InTurnAssistantEvent | null;
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
  const detachedCommands = new Map<string, ClaudeInputCommand>();
  const detachedWaiters: Array<() => void> = [];
  let detachedActive = '';
  let waitingSend = false;
  let interruptRevision = 0;

  const exitWaiters: Array<() => void> = [];

  /**
   * Следующий stdin-ввод нельзя влить в уточнение, оставшееся в CLI после stop.
   * Ожидаем только подтверждённую очередь; отсутствие lifecycle не блокирует новые ходы.
   */
  async function waitForDetachedCommands(revision: number): Promise<void> {
    while (!state.exited && revision === interruptRevision
      && (detachedActive || [...detachedCommands.values()]
      .some((command) => command.queued && !command.completed))) {
      await new Promise<void>((resolve) => {
        detachedWaiters.push(resolve);
      });
    }
  }

  function writeLine(payload: unknown): void {
    if (state.exited || child.stdin?.destroyed) {
      throw new Error('Сессия агента уже закрыта.');
    }
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * Порт уточнений активного хода. Пишем дополнительное user-сообщение в тот же stdin:
   * CLI в режиме stream-json принимает его, не завершая процесс. Запись даёт forwarded,
   * а lifecycle started подтверждает включение уточнения в контекст модели.
   */
  function inTurnPortForTurn(): InTurnPort {
    const owner = state.turn;

    return {
      /**
       * Запись дополнительного вопроса в stdin активного хода. Подтверждается только факт
       * записи: CLI может влить текст в текущий ход или запустить следующим ходом.
       */
      async deliver({ messageId, text }: { messageId: string; text: string }) {
        const turn = state.turn;

        if (!turn || turn !== owner || state.exited || state.interruptRequested) {
          return {
            ok: false,
            code: 'turn_changed',
            message: 'Активный ход уже завершился.',
          };
        }

        const uuid = randomUUID();

        turn.commands.set(uuid, {
          messageId,
          queued: false,
          started: false,
          completed: false,
          failed: false,
        });

        try {
          writeLine({
            type: 'user',
            uuid,
            message: { role: 'user', content: [{ type: 'text', text }] },
          });
        } catch (error) {
          turn.commands.delete(uuid);

          return {
            ok: false,
            code: 'transport_lost',
            message: (error as Error).message,
            uncertain: true,
          };
        }

        return { ok: true, state: 'forwarded' };
      },
      close() {},
    };
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

  /**
   * Граница сообщения закрывает накопленный текст с прежним id до финала всего хода.
   * Сброс буфера предотвращает повторное завершение на следующем result.
   */
  function finishAssistantMessage(): InTurnAssistantEvent | null {
    const turn = state.turn;

    if (!turn?.assistantMessageId || !turn.assistantText) {
      return null;
    }

    const event: InTurnAssistantEvent = {
      assistantMessageId: turn.assistantMessageId,
      text: turn.assistantText,
      sourceRevision: ++turn.assistantRevision,
      complete: true,
    };
    const closed = turn.assistantParts.get(turn.assistantSourceId) || 0;

    turn.assistantParts.set(turn.assistantSourceId, closed + 1);
    turn.assistantSourceId = '';
    turn.assistantMessageId = '';
    turn.assistantText = '';
    turn.lastAssistant = event;
    void turn.onAssistantMessage?.(event);

    return event;
  }

  /**
   * CLI присылает отдельные content-блоки одного сообщения с общим id. Текст до вызова
   * инструмента склеивается; новый id завершает предыдущую реплику даже без текста.
   * Вызов инструмента закрывает текст перед ним: результата команды можно ждать минутами,
   * а реплика всё это время висела «Пишет…». Текст после вызова — следующая часть с суффиксом.
   */
  function rememberAssistantMessage(ev: ClaudeEvent): void {
    const turn = state.turn;
    const id = String(ev.message?.id || '');

    if (!turn || !id) {
      return;
    }
    if (turn.assistantSourceId && turn.assistantSourceId !== id) {
      finishAssistantMessage();
    }

    const text = claudeMessageText(ev.message);

    if (text) {
      const closed = turn.assistantParts.get(id) || 0;

      turn.assistantSourceId = id;
      turn.assistantMessageId ||= closed ? `${id}-${closed + 1}` : id;
      turn.assistantText = turn.assistantText ? `${turn.assistantText}\n${text}` : text;
      turn.assistantRevision += 1;
      void turn.onAssistantMessage?.({
        assistantMessageId: turn.assistantMessageId,
        text: turn.assistantText,
        sourceRevision: turn.assistantRevision,
        complete: false,
      });
    }
    if (claudeMessageCallsTool(ev.message)) {
      finishAssistantMessage();
    }
  }

  /**
   * Lifecycle связывается с UUID входа, а не с id сообщения Кокпита или порядком result.
   * Отложенные после stop команды принадлежат фону даже при новом заказанном ходе.
   */
  function handleCommandLifecycle(ev: ClaudeEvent): void {
    const uuid = ev.command_uuid || '';

    const detached = detachedCommands.get(uuid);

    if (detached) {
      if (ev.state === 'started') {
        detached.started = true;
        detachedActive = uuid;

        if (detached.failed) {
          stopDetachedCommand();
        } else if (detached.late && detached.messageId) {
          void detached.onReceipt?.({ messageId: detached.messageId, state: 'consumed' });
        }
      } else if (ev.state === 'queued') {
        detached.queued = true;
      } else if (ev.state === 'completed') {
        detached.completed = true;
      } else if (ev.state === 'cancelled') {
        detachedCommands.delete(uuid);

        if (detachedActive === uuid) {
          detachedActive = '';
        }

        for (const resolve of detachedWaiters.splice(0)) {
          resolve();
        }
      }

      return;
    }

    const turn = state.turn;
    const command = turn?.commands.get(uuid);

    if (!turn || !command) {
      return;
    }

    if (ev.state === 'queued') {
      command.queued = true;
    } else if (ev.state === 'started' && !command.started) {
      command.started = true;

      if (command.messageId && !command.failed) {
        void turn.onInTurnReceipt?.({ messageId: command.messageId, state: 'consumed' });
      }
    } else if (ev.state === 'completed') {
      command.completed = true;
    }
  }

  /**
   * После stop CLI всё равно запускает уточнение из своей очереди и продолжает работу.
   * Человек нажал «Стоп», а квитанция уже сказала failed, поэтому такой запуск сразу гасим.
   */
  function stopDetachedCommand(): void {
    void control('interrupt').catch((error) => {
      log?.warn?.(
        { err: (error as Error)?.message },
        'чат: отложенное уточнение после остановки не прервано',
      );
    });
  }

  /**
   * Итог отложенной команды снимает её из очереди и будит ожидающий send().
   * Один result может закрыть сразу несколько уточнений, слитых самим CLI.
   */
  function settleDetachedCommands(ev: ClaudeEvent): void {
    for (const [uuid, command] of detachedCommands) {
      if (command.started || command.completed || uuid === ev.user_message_uuid) {
        detachedCommands.delete(uuid);
      }
    }

    detachedActive = '';

    for (const resolve of detachedWaiters.splice(0)) {
      resolve();
    }
  }

  /**
   * Ход закрылся до queued уточнения: CLI запустит его отдельным ходом после финала.
   * Такой ввод переходит в отложенные, чтобы подтвердить потребление и не влить в него новый send.
   */
  function detachLateCommands(turn: NonNullable<typeof state.turn>): void {
    for (const [uuid, command] of turn.commands) {
      if (!command.messageId || command.started || command.completed || command.failed) {
        continue;
      }

      command.late = true;
      command.onReceipt = turn.onInTurnReceipt;
      detachedCommands.set(uuid, command);
    }
  }

  /**
   * Stop закрывает канал и явно отклоняет уточнения, которые CLI ещё не начал.
   * Их UUID сохраняются отдельно для маршрутизации возможного позднего запуска в фон.
   */
  function failUnstartedCommands(): void {
    const turn = state.turn;

    if (!turn) {
      return;
    }

    for (const [uuid, command] of turn.commands) {
      if (!command.messageId || command.started || command.failed) {
        continue;
      }

      command.failed = true;
      detachedCommands.set(uuid, command);
      void turn.onInTurnReceipt?.({ messageId: command.messageId, state: 'failed' });
    }
  }

  /**
   * События CLI обновляют ленту и закрывают реплики на подтверждённых границах сообщений.
   * После result ждать разрешено только подтверждённую очередь без started; stop закрывает всё.
   */
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

    if (ev.type === 'command_lifecycle') {
      handleCommandLifecycle(ev);

      return;
    }

    if (ev.type === 'user' && ev.isReplay) {
      return;
    }

    const detachedCommand = detachedActive
      ? detachedCommands.get(detachedActive)
      : ev.type === 'result' ? detachedCommands.get(ev.user_message_uuid || '') : undefined;
    const detached = !!detachedActive || !!detachedCommand;

    // Отменённое уточнение не попадает ни в ленту, ни в фон: его прерывание уже запрошено.
    if (detachedCommand?.failed) {
      if (ev.type === 'result') {
        settleDetachedCommands(ev);
      }

      return;
    }

    const activeTurn = detached ? null : state.turn;
    const collector = activeTurn ? activeTurn.collector : backgroundCollector();
    collector.push(ev);

    // Ответы субагента остаются вложенными шагами и не закрывают реплику главного агента.
    // Результат инструмента означает, что все content-блоки его вызова уже получены.
    if (activeTurn && !ev.parent_tool_use_id) {
      if (ev.type === 'assistant') {
        rememberAssistantMessage(ev);
      } else if (ev.type === 'result' || (ev.type === 'user'
        && Array.isArray(ev.message?.content)
        && ev.message.content.some((block) => block?.type === 'tool_result'))) {
        finishAssistantMessage();
      }
    }

    // Id сессии известен с первого события хода: сообщаем его вызывающему сразу, а не
    // в конце хода, — иначе перезапуск сервера посреди первого хода оставлял чат без
    // сессии, и следующее сообщение начинало разговор с нуля.
    if (activeTurn && !activeTurn.sessionAnnounced && ev.session_id) {
      const turn = activeTurn;
      turn.sessionAnnounced = true;
      if (!state.sessionId) state.sessionId = ev.session_id;
      void Promise.resolve()
        .then(() => turn.onSessionCreated?.(ev.session_id as string))
        .catch((error) => {
          log?.warn?.({ err: (error as Error)?.message }, 'чат: id сессии не принят вызывающим');
        });
    }

    if (ev?.type !== 'result') return;

    if (activeTurn && !state.interruptRequested && [...activeTurn.commands.values()]
      .some((command) => command.messageId && command.queued && !command.started
        && !command.completed && !command.failed)) {

      return;
    }

    if (activeTurn) {
      const turn = activeTurn;
      state.turn = null;
      const result = buildClaudeTurnResult(turn.collector, {
        fallbackSessionId: state.sessionId,
        stderrTail,
        log,
      });
      state.sessionId = result.sessionId || state.sessionId;

      turn.onInTurnAvailability?.({ available: false, reason: 'not_ready' });

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

      detachLateCommands(turn);

      // Явный id связывает финал с уже показанным блоком и после очистки маркера названия.
      // При другом тексте result итог остаётся самостоятельным сообщением.
      turn.resolve({
        ...result,
        ...(turn.lastAssistant?.text === String(ev.result || '').trim()
          ? { assistantMessageId: turn.lastAssistant.assistantMessageId }
          : {}),
      });
      return;
    }
    finishBackground();
    settleDetachedCommands(ev);
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
      turn.onInTurnAvailability?.({ available: false, reason: 'not_ready' });
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
    detachedActive = '';
    detachedCommands.clear();

    for (const resolve of detachedWaiters.splice(0)) {
      resolve();
    }

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

  const nativeReady = nativeSettings ? (async () => {
    await control('initialize');

    const envelope = await control('get_settings') as { subtype?: string; response?: {
      effective?: unknown; applied?: unknown;
    } };

    if (envelope.subtype !== 'success') {
      throw new Error('Claude не подтвердил чтение нативного слоя');
    }

    const read = envelope.response ?? {};
    const at = (root: unknown, path: string[]) => path.reduce<unknown>((value, key) => (
      value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
    ), root);
    const evidence = verifyNativeSettings(nativeSettings, nativeSettings.accepted.map((entry) => {
      const applied = at(read.applied, entry.path);
      const effective = at(read.effective, entry.path);
      const value = applied !== undefined ? applied : effective;

      return {
        fieldId: entry.fieldId,
        basis: applied !== undefined ? 'applied' as const
          : effective !== undefined ? 'effective' as const : 'unavailable' as const,
        ...(value !== undefined ? { value: decodeSettingsJson(value) } : {}),
      };
    }));

    if (evidence.some((item) => item.result === 'overridden' || item.result === 'rejected')) {
      throw new Error('Claude не принял нативный слой конфигурации');
    }
  })() : undefined;

  void nativeReady?.catch(() => {});

  return {
    get pid() { return child.pid; },
    get sessionId() { return state.sessionId; },
    get alive() { return !state.exited; },
    get busy() { return !!state.turn || waitingSend; },

    /** Заказанный ход: пишем сообщение в stdin и ждём его result. */
    /**
     * Заказанный ход: пишем сообщение в stdin и ждём его result. Порт уточнений отдаётся
     * сразу после записи: CLI в режиме stream-json принимает дополнительные сообщения,
     * не завершая процесс.
     */
    async send({
      message, onStep, onProgress, onSessionCreated, onRunMetadata,
      onInTurnReady, onInTurnAvailability, onInTurnReceipt, onAssistantMessage,
    }: {
      message?: unknown;
      onStep?: (step: ChatStep) => void;
      onProgress?: (tokens: number, extra: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
      onSessionCreated?: (sessionId: string) => unknown;
      onInTurnReady?: (port: InTurnPort) => void;
      onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
      onInTurnReceipt?: (event: InTurnReceiptEvent) => void | Promise<void>;
      onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
    }) {
      if (nativeReady) {
        await nativeReady;
      }

      if (state.exited) {
        return Promise.reject(new Error(state.exitReason || 'Сессия агента закрыта.'));
      }
      if (state.turn || waitingSend) {
        return Promise.reject(new Error('В этой сессии уже идёт ход.'));
      }

      const revision = interruptRevision;

      // Поздний ввод без lifecycle (старый CLI) не должен копиться между ходами.
      for (const [uuid, command] of detachedCommands) {
        if (command.late && !command.queued) {
          detachedCommands.delete(uuid);
        }
      }

      waitingSend = true;

      try {
        await waitForDetachedCommands(revision);
      } finally {
        waitingSend = false;
      }

      if (revision !== interruptRevision) {
        onInTurnAvailability?.({ available: false, reason: 'not_ready' });

        throw Object.assign(new Error('Ход остановлен.'), {
          stopped: true,
          steps: [],
          sessionId: state.sessionId,
        });
      }

      if (state.exited) {
        return Promise.reject(new Error(state.exitReason || 'Сессия агента закрыта.'));
      }
      if (state.turn) {
        return Promise.reject(new Error('В этой сессии уже идёт ход.'));
      }

      // Непрошеный ход не может идти одновременно с заказанным: CLI обрабатывает
      // сообщения по очереди. Если он ещё не закрыт — закрываем его сейчас, иначе
      // его шаги прилипли бы к новому ходу.
      if (state.background && !detachedActive) {
        finishBackground();
      }

      const collector = createClaudeTurnCollector({
        onStep,
        onProgress,
        onRunMetadata,
        log,
      });

      return new Promise<unknown>((resolve, reject) => {
        state.turn = {
          collector,
          resolve,
          reject,
          onSessionCreated,
          sessionAnnounced: false,
          ...(onInTurnReady ? { onInTurnReady } : {}),
          ...(onInTurnAvailability ? { onInTurnAvailability } : {}),
          ...(onInTurnReceipt ? { onInTurnReceipt } : {}),
          ...(onAssistantMessage ? { onAssistantMessage } : {}),
          assistantRevision: 0,
          commands: new Map(),
          assistantSourceId: '',
          assistantMessageId: '',
          assistantText: '',
          assistantParts: new Map(),
          lastAssistant: null,
        };

        try {
          const uuid = randomUUID();

          state.turn.commands.set(uuid, {
            messageId: '',
            queued: false,
            started: false,
            completed: false,
            failed: false,
          });
          writeLine({
            type: 'user',
            uuid,
            message: { role: 'user', content: [{ type: 'text', text: String(message || '') }] },
          });

          onInTurnAvailability?.({ available: true });
          onInTurnReady?.(inTurnPortForTurn());
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

      interruptRevision += 1;

      for (const resolve of detachedWaiters.splice(0)) {
        resolve();
      }

      if (state.turn) {
        state.interruptRequested = true;
        state.turn.onInTurnAvailability?.({ available: false, reason: 'not_ready' });
        failUnstartedCommands();
      }

      try {
        await control('interrupt');
      } catch (error) {
        // Ход мог закончиться сам, пока запрос летел: это не повод падать.
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
