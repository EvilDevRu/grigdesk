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

import { usagePercentOrNull } from '../providerUsage.ts';
import type { ProviderUsagePatch, UsageBar } from '../providerUsage.ts';
import type { ChatRunMetadata } from '../../../../shared/chat/chatRun.ts';
import type { PreparedNativeSettings } from '../executorSettings/types.ts';
import { verifyNativeSettings } from '../executorSettings/capability.ts';
import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';

import { contextCacheStatus, reportedContextCache } from '../chat/contextCache.ts';
import type { ContextCache } from '../chat/contextCache.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import type { ChatStep, StepSink } from '../chat/streamSteps.ts';
import type {
  InTurnAssistantEvent,
  InTurnPort,
  InTurnReceiptEvent,
  InTurnUnavailableReason,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import { toClaudeSteps } from './_claudeSteps.ts';
import { claudeTurnFailure } from './_claudeTurnFailures.ts';
import { defaultWorkToolDescriptors } from './work-tools/index.ts';
import { createClaudeTokenMeter } from './_claudeTokenMeter.ts';

// Служебная модель внутренних вызовов CLI: её usage к контексту разговора не относится.
export const SYNTHETIC_MODEL = '<synthetic>';

const CLAUDE_RATE_WINDOWS = [
  {
    native: 'five_hour',
    key: 'session',
    label: 'Сессия (5ч)',
    minutes: 300
  },
  {
    native: 'seven_day',
    key: 'weekly_all',
    label: 'Неделя (7д)',
    minutes: 10080
  },
] as const;

/**
 * Событие аккаунта перехватывается до коллектора хода, включая простой процесса.
 * Доли CLI переводятся в проценты один раз; модельные недели обновляет только опрос.
 */
export function consumeClaudeRateLimitEvent(
  value: unknown,
  onProviderUsage?: (patch: ProviderUsagePatch) => unknown,
): boolean {
  const event = value as { type?: unknown; rate_limit_info?: unknown } | null;

  if (event?.type !== 'rate_limit_event') {
    return false;
  }

  const info = event.rate_limit_info as Record<string, unknown> | null;

  if (!info || typeof info !== 'object') {
    return true;
  }

  const windows = info.unifiedWindows as Record<string, unknown> | null;
  const bars: UsageBar[] = [];

  for (const window of CLAUDE_RATE_WINDOWS) {
    const raw = windows?.[window.native] ?? (info.rateLimitType === window.native ? info : null);
    const source = raw as { utilization?: unknown; resetsAt?: unknown } | null;
    const fraction = source?.utilization;
    const pct = typeof fraction === 'number' ? usagePercentOrNull(fraction * 100) : null;

    if (pct === null) {
      continue;
    }

    const seconds = source?.resetsAt;
    const reset = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000) : null;

    bars.push({
      key: window.key,
      group: 'subscription',
      label: window.label,
      pct,
      resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
      windowMinutes: window.minutes,
    });
  }

  if (bars.length) {
    try {
      onProviderUsage?.({ bars });
    } catch {
      // Сбой доставки аккаунтных квот не меняет исход модельного хода.
    }
  }

  return true;
}

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

/**
 * Положительная дельта оценки рассуждений текущего обращения. Ноль, отсутствие поля
 * и нечисловое значение работой не являются: CLI шлёт такие события и на служебных
 * шагах, где модель ничего не сказала.
 */
function claudeThinkingDelta(ev: ClaudeEvent): boolean {
  if (ev.type !== 'system' || ev.subtype !== 'thinking_tokens') {
    return false;
  }

  const delta = Number(ev.estimated_tokens_delta);

  return Number.isFinite(delta) && delta > 0;
}

/**
 * Работала ли модель в этом событии. Считается ТОЛЬКО настоящий вывод текущей попытки:
 * непустой текст, размышление или вызов инструмента. Synthetic-сообщение CLI (сбой
 * доставки), повторно показанные старые сообщения, init, result, нулевой usage, события
 * субагентов и границы сжатия работой не являются — иначе сбой сам себе подтверждал бы
 * продвижение и бюджет автопродолжения сбрасывался бы на пустом месте.
 */
function claudeEventIsRealWork(ev: ClaudeEvent): boolean {
  if (ev.type !== 'assistant' || ev.isReplay || ev.parent_tool_use_id) {
    return false;
  }

  const model = ev.message?.model;

  if (!model || model === SYNTHETIC_MODEL) {
    return false;
  }

  if (claudeMessageCallsTool(ev.message)) {
    return true;
  }

  const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];

  return blocks.some((block) => {
    const item = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
    } | null;
    const text = item?.type === 'text'
      ? String(item.text ?? '')
      : (item?.type === 'thinking' ? String(item.thinking ?? '') : '');

    return text.trim().length > 0;
  });
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
  // Корневое поле synthetic-сообщения: код причины сбоя доставки от самого CLI
  // (authentication_failed, overloaded, rate_limit и т.п.). Обычные ответы его не несут.
  error?: unknown;
}

// Дельты рассуждений идут часто; в окно уходит не каждая — как у остальных исполнителей.
const PROGRESS_THROTTLE_MS = 400;

// Состояние одного хода: что уже сказал CLI про токены, модель и сессию.
interface TurnState {
  resultEv: ClaudeEvent | null;
  // Последние измерения обращений заменяют оценки, result исправляет весь ход.
  // Reasoning уже входит в точный output и повторно не прибавляется.
  spentTokens: number;
  spentIsEstimate: boolean;
  lastTurnInput: number | null;
  lastContextCache: ContextCache | null;
  actualModel: string;
  streamSessionId: string;
  // Текст последнего сообщения, которое CLI сочинил САМ (модель <synthetic>): сбой
  // доставки, обрыв соединения, «No response requested.». Сбрасывается, как только
  // заговорила настоящая модель, — тогда ход сбой пережил.
  lastSyntheticText: string;
  // Код причины из корневого `error` того же synthetic-сообщения. Пустая строка —
  // CLI кода не назвал, и вид сбоя решают общие слова реестра.
  lastSyntheticError: string;
  // Монотонный признак работы ТЕКУЩЕЙ попытки: настоящее слово модели или её
  // инструмент. Лента шагов для этого не годится — она усечена и содержит служебные
  // строки; повторно показанные старые сообщения работой не являются.
  madeProgress: boolean;
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
  let hadCompactBoundary = false;

  const tokenMeter = createClaudeTokenMeter();
  const state: TurnState = {
    resultEv: null,
    spentTokens: 0,
    spentIsEstimate: true,
    lastTurnInput: null,
    lastContextCache: null,
    actualModel: '',
    streamSessionId: '',
    lastSyntheticText: '',
    lastSyntheticError: '',
    madeProgress: false,
  };

  /**
   * Приём одного события потока: лента шагов, метрики хода и признак реальной работы.
   * Служебные и повторные события работу не подтверждают, поэтому порядок проверок
   * здесь важнее экономии строк.
   */
  function push(value: unknown): void {
    if (!value || typeof value !== 'object') return;

    const ev = value as ClaudeEvent;

    // Признак работы читается ДО усечения ленты и независимо от неё: вытесненный из
    // sink инструмент работу не отменяет, а synthetic-текст её не подтверждает.
    if (claudeEventIsRealWork(ev) || claudeThinkingDelta(ev)) {
      state.madeProgress = true;
    }

    stepSink.emitAll(toClaudeSteps(ev));

    // В том же потоке идут обращения субагентов. Их отдельные окна не заменяют
    // контекст основного разговора, хотя сами шаги остаются в ленте.
    if (ev.parent_tool_use_id) return;

    // Assistant-replay в CLI 2.1.302 не наблюдался; это защита парсера повторов.
    // Лента уже восстановлена выше, а повторный кадр метрики не изменяет.
    if (ev.isReplay === true) {
      return;
    }

    tokenMeter.push(ev);
    refreshTokens();

    if (ev.type === 'stream_event') {
      const partial = (ev as { event?: {
        type?: string;
      } }).event;

      if (partial?.type === 'message_delta' || Date.now() - lastReportAt >= PROGRESS_THROTTLE_MS) {
        reportProgress();
      }

      return;
    }

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
      hadCompactBoundary = true;
      reportProgress();
      log?.info?.({ meta: ev.compactMetadata || null }, 'чат: CLI сжал контекст сам');
      return;
    }

    // Рассуждения модели CLI оценивает сам и присылает накопительно ПО ТЕКУЩЕМУ обращению:
    // складываем дельты, иначе следующий запрос обнулил бы счётчик хода. В окно уходит не
    // каждая дельта — ближайшее событие всё равно унесёт накопленное.
    if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
      if (claudeThinkingDelta(ev)) {
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
      state.lastSyntheticError = typeof ev.error === 'string' ? ev.error : '';
      return;
    }

    if (ev.type === 'assistant' && ev.message?.model && ev.message.model !== SYNTHETIC_MODEL) {
      state.actualModel = ev.message.model;
      onRunMetadata?.({ actualModelId: ev.message.model, modelSource: 'response' });
    }

    if (ev.type === 'assistant' && ev.message?.usage && ev.message.model !== SYNTHETIC_MODEL) {
      // Модель заговорила после сбоя — ход его пережил, обе отметки недействительны.
      state.lastSyntheticText = '';
      state.lastSyntheticError = '';
      const usage = ev.message.usage as Record<string, number>;

      // Событие несёт один блок содержимого. Текст и аргументы инструмента — вывод модели,
      // считаем по символам; рассуждения уже сосчитал CLI, второй раз их не берём.
      // `usage.output_tokens` здесь — снимок начала ответа, к расходу отношения не имеет.

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

      // Итог сегмента авторитетно исправляет сумму его обращений, в том числе вниз.
      // Без числового usage последняя оценка остаётся оценкой, а 0 принимается явно.
      const output = ev.usage?.output_tokens;

      if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) {
        reportProgress();
      }
    }
  }

  /**
   * Публикует сумму независимых обращений с общей достоверностью измерения.
   * Точная поправка result уже учтена счётчиком и не удерживается прежним максимумом.
   */
  function refreshTokens(): void {
    const total = tokenMeter.total();

    state.spentTokens = total.tokens;
    state.spentIsEstimate = total.tokensIsEstimate;
  }

  // Событие прогресса: расход хода и снимок контекста ПОСЛЕДНЕГО обращения к модели.
  // До первого замера прежний контекст сохраняется; только сжатие явно его инвалидирует.
  function reportProgress(): void {
    lastReportAt = Date.now();

    const context = state.lastTurnInput !== null || hadCompactBoundary ? {
      contextTokens: state.lastTurnInput ?? 0,
      contextMetric: state.lastTurnInput === null ? 'unavailable' : 'active-input-v1',
      contextIsEstimate: false,
      contextCache: state.lastContextCache,
    } : {};

    try {
      onProgress?.(state.spentTokens, {
        tokensIsEstimate: state.spentIsEstimate,
        ...context,
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

    // AskUserQuestion GrigDesk «отклоняет» намеренно — так ответ человека доезжает до
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
  // Автоматика продолжает ход только по явному подтверждению адаптера: ход принят в
  // сохранённый разговор, попытка окончательно завершена и разговор можно продолжить.
  // Настоящий result текущего collector и id сессии из его событий обязательны —
  // одного fallbackSessionId при неполном потоке для этого недостаточно.
  const canContinue = deliveryFailure && !!ev.type && !!state.streamSessionId;

  if (deliveryFailure && !canContinue) {
    log?.warn?.({
      resultType: ev.type || '',
      hasEventSession: !!state.streamSessionId,
    }, 'чат: сбой доставки claude без подтверждения Р2 — автопродолжение недоступно');
  }

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
    ...(deliveryFailure ? {
      turnFailure: claudeTurnFailure(cliCut, state.lastSyntheticError),
      turnRecovery: { canContinue, madeProgress: state.madeProgress },
    } : {}),
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
    '--include-partial-messages',
    '--output-format', 'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--permission-mode', permissionMode || 'default',
  ];
  args.push(...providerSettingsArgs);
  if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig));
  if (mcpConfig?.mcpServers?.['grigdesk-work']) {
    const descriptors = Array.isArray(workTools?.descriptors)
      ? workTools.descriptors
      : defaultWorkToolDescriptors('claude');
    const allowed = (descriptors as Array<{
      name?: unknown;
      function?: { name?: unknown };
    } | null>)
      .map((descriptor) => descriptor?.name || descriptor?.function?.name)
      .filter(Boolean)
      .map((name) => `mcp__grigdesk-work__${name}`)
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
      // UUID главного ввода хода: по его lifecycle видно, когда CLI взялся именно за этот ход.
      mainUuid: string;
    } | null;
    background: ClaudeTurnCollector | null;
    backgroundInterrupted: boolean;
    interruptRequested: boolean;
  } = {
    sessionId: sessionId || null,
    exited: false,
    exitReason: '',
    turn: null,          // активный заказанный ход
    background: null,    // непрошеный ход, начавшийся сам
    backgroundInterrupted: false,
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
  const backgroundWaiters: Array<() => void> = [];
  const preBackground: ClaudeEvent[] = [];
  let detachedActive = '';
  // CLI сообщает lifecycle команд (флаг --replay-user-messages). Без него начало хода не видно.
  let lifecycleSeen = false;
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

  /**
   * Непрошеный ход открывают содержательные события главного агента и начало запроса
   * модели (system/init); прочие служебные события ждут в буфере. Коллектор передаёт
   * шаги и метрики после объявления цикла пулу.
   */
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

  /**
   * Естественный result закрывает фон, сохраняя отдельный итог для публикации.
   * Остановка без текста получает привычную отметку и будит ожидающий ввод.
   */
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

    const stopped = state.backgroundInterrupted;

    state.backgroundInterrupted = false;
    hooks.onBackground?.((stopped ? {
      ...result,
      stopped: true,
      reply: collector.state.resultEv?.result?.trim() ? result.reply : '⏹ Ход остановлен.',
    } : result) as never);

    for (const resolve of backgroundWaiters.splice(0)) {
      resolve();
    }
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
   * Lifecycle связывается с UUID входа, а не с id сообщения GrigDesk или порядком result.
   * Отложенные после stop команды принадлежат фону даже при новом заказанном ходе.
   */
  function handleCommandLifecycle(ev: ClaudeEvent): void {
    const uuid = ev.command_uuid || '';

    if (uuid) {
      lifecycleSeen = true;
    }

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

      // CLI взялся за наш ход — значит, предыдущий ход в нём закончен. Незакрытый фон
      // (result не дошёл) закрываем здесь, иначе он навсегда держал бы очередь чата.
      if (uuid === turn.mainUuid && state.background) {
        finishBackground();
      }

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
   * Заказанный ход владеет потоком с момента, когда CLI начал его главную команду.
   * До этого CLI ещё ведёт предыдущий ход — проснувшегося агента — и его события не наши.
   * Старый CLI без lifecycle начало не сообщает: тогда ход владеет потоком сразу.
   */
  function turnOwnsStream(turn: NonNullable<typeof state.turn>): boolean {
    if (!lifecycleSeen || !turn.mainUuid) {
      return true;
    }

    return !!turn.commands.get(turn.mainUuid)?.started;
  }

  /**
   * События CLI обновляют ленту и закрывают реплики на подтверждённых границах сообщений.
   * После result ждать разрешено только подтверждённую очередь без started; stop закрывает всё.
   */
  function handleEvent(ev: ClaudeEvent): void {
    if (consumeClaudeRateLimitEvent(ev, (patch) => hooks.onProviderUsage?.(patch as never))) {
      return;
    }

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
      const main = state.turn?.commands.get(ev.uuid || '');

      if (main && ev.uuid === state.turn?.mainUuid) {
        main.started = true;
      }

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

    // Пока CLI не начал команду заказанного хода, он ведёт другой ход — проснувшегося агента.
    const turnWaits = !detached && !!state.turn && !turnOwnsStream(state.turn);
    const activeTurn = detached || turnWaits ? null : state.turn;

    if (!activeTurn && !detached && !turnWaits && !state.background) {
      const opensBackground = !ev.parent_tool_use_id
        && (['assistant', 'result', 'user'].includes(ev.type || '')
          || (ev.type === 'system' && ev.subtype === 'init'));

      if (!opensBackground) {
        if (ev.type !== 'stream_event' && preBackground.length < 20) {
          preBackground.push(ev);
        }

        return;
      }
    }

    const collector = activeTurn ? activeTurn.collector : backgroundCollector();

    if (!activeTurn) {
      for (const buffered of preBackground.splice(0)) {
        collector.push(buffered);
      }
    }

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
    state.backgroundInterrupted = false;
    preBackground.length = 0;
    detachedActive = '';
    detachedCommands.clear();

    for (const resolve of detachedWaiters.splice(0)) {
      resolve();
    }

    for (const resolve of backgroundWaiters.splice(0)) {
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

        while (state.background && !state.exited && revision === interruptRevision) {
          await new Promise<void>((resolve) => backgroundWaiters.push(resolve));
          await waitForDetachedCommands(revision);
        }
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
          mainUuid: '',
        };

        try {
          const uuid = randomUUID();

          state.turn.mainUuid = uuid;

          state.turn.commands.set(uuid, {
            messageId: '',
            queued: false,
            started: false,
            completed: false,
            failed: false,
          });
          preBackground.length = 0;
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

      if (state.background && (!state.turn || !turnOwnsStream(state.turn))) {
        state.backgroundInterrupted = true;
      }

      for (const resolve of backgroundWaiters.splice(0)) {
        resolve();
      }

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
