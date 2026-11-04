// Исполнитель GPT (OpenAI Codex CLI).
// Установка: npm i -g @openai/codex && codex login — после этого провайдер оживает сам.
// Ходы идут через `codex app-server`: новый разговор делает `thread/start`, следующий
// `thread/resume`, затем `turn/start`. Песочница workspace-write: текущий cwd и явно
// дополнительные рабочие корни доступны для правок, сеть включена для gh/git/package CLI,
// остальная файловая система закрыта.
import { execFile, spawn } from '../providerInstall/externalCliProcess.ts';
import type { ChatRunMetadata } from '../../../../shared/chat/chatRun.ts';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { npmLatest } from './_npmLatest.ts';
import type { ProviderInstallationContext } from './index.ts';
import { npmInstallCommand } from '../providerInstall/commands.ts';
import { withRetry } from '../retry.ts';
import { usagePercentOrNull } from '../providerUsage.ts';
import type { ProviderUsagePatch, UsageBar } from '../providerUsage.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import { CODEX_TURN_FAILURE_RULES, codexTurnFailure } from './_codexTurnFailures.ts';
import { contextCacheStatus, reportedContextCache } from '../chat/contextCache.ts';
import { createCodexStepNormalizer } from './_codexSteps.ts';
import { createCodexToolImages } from './_codexToolImages.ts';
import { CODEX_UNTRUSTED_INPUT, runCodexUntrusted } from './_codexUntrusted.ts';
import type { PreparedExecutorRuntime, PreparedNativeSettings } from '../executorSettings/types.ts';
import { codexNativeSettings } from '../executorSettings/codex.ts';
import { nativeSettingsTomlArgs, settingsTomlArgs } from '../executorSettings/toml.ts';
import {
  assertCodexWorkspaceMcp, assertCodexWorkspaceProfile, codexWorkspaceMcpOverrides,
  codexWorkspaceProfile, codexWorkspaceProtocol,
} from './_codexScopedWorkspace.ts';
import { verifyNativeSettings } from '../executorSettings/capability.ts';
import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';
import {
  codexElicitationPresentation,
  codexElicitationResponse,
} from './_codexElicitation.ts';
import {
  DIRECT_SSH_HOOK_COMMAND,
  DIRECT_SSH_HOOK_MATCHER,
  directCommandHook,
  directSshSetting,
} from './_directSshPolicy.ts';

import type { ChildProcess } from 'node:child_process';
import type { ChatStep, StepSink } from '../chat/streamSteps.ts';
import type {
  InTurnAssistantEvent,
  InTurnPort,
  InTurnReceiptEvent,
  InTurnUnavailableReason,
} from '../../../../shared/chat/chatInTurnContracts.ts';

import {
  assertCodexRuntime, assertCodexRuntimeBeforeSpawn, codexModeProfile, availableCodexPermissionModes,
  codexRuntimeFingerprint, normalizeCodexPermissionMode, prepareCodexPermissionRuntime,
} from './_codexPermissionModes.ts';
import { createCodexInteractionWaiters } from './_codexApprovals.ts';
import { ExecutorRuntimeError } from './errors.ts';
import {
  codexAsyncQuestionPresentation, codexAsyncQuestionResponse,
  codexQuestionPresentation, codexQuestionResponse,
} from './_codexQuestions.ts';

const APP_SERVER_TIMEOUT_MS = 15_000;

// Серверный config в объёме, который читает исполнитель. Полная его форма
// объявлена в config.ts; адаптер получает его целиком.
type CodexConfig = {
  codexBin: string;
  rootDir?: string;
  artifactsDir?: string;
};

// Сохранённые ручки исполнителя из prefs: их состав объявляет он же.
interface CodexSettings {
  blockDirectSsh?: unknown;
  blockDirectDb?: unknown;
  strictUnknownDbClient?: unknown;
}

// Окно лимита внутри ведра: сколько выбрано, какой длительности и когда сбросится.
interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

// Ведро лимитов аккаунта: набор окон плюс поля контроля трат. Имена слотов
// придумывает сервис, поэтому набор полей открыт.
interface CodexBucket {
  limitId?: unknown;
  limitName?: unknown;
  individualLimit?: { remainingPercent?: unknown; used?: unknown; limit?: unknown } | null;
  spendControlReached?: unknown;
  rateLimitReachedType?: unknown;
  credits?: unknown;
  [slot: string]: unknown;
}

// Полоса лимита для всплывашки: ведро, подпись, процент и длина окна в минутах —
// по ней прогноз отличает неделю от сессии и считает средний темп с начала окна.
interface CodexUsageBar extends UsageBar {
  key: string;
  group: string;
  label: string;
  pct: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

// Ответ одноразового JSON-RPC клиента app-server.
interface CodexRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string } | null;
}

// Сообщение JSON-RPC в потоке живой сессии: ответ, уведомление или server request.
interface CodexRpcMessage {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string } | null;
}

// Параметры уведомления app-server. Форма зависит от метода, поэтому объявлено
// ровно то, что читает диспетчер.
interface CodexNotificationParams {
  threadId?: unknown;
  thread_id?: unknown;
  thread?: { id?: string };
  turnId?: unknown;
  turn_id?: unknown;
  turn?: { id?: string; status?: unknown; error?: unknown };
  item?: {
    type?: string;
    id?: unknown;
    text?: unknown;
    phase?: unknown;
    delivery?: unknown;
    questions?: unknown;
  };
  itemId?: unknown;
  delta?: unknown;
  requestId?: unknown;
  tokenUsage?: unknown;
  [field: string]: unknown;
}

// Событие старого (exec --json) протокола: у него свои имена полей.
interface CodexLegacyEvent {
  type?: string;
  thread_id?: unknown;
  thread?: { id?: unknown };
  model?: unknown;
  item?: { model?: unknown; type?: string; text?: unknown; content?: unknown };
  usage?: {
    input_tokens?: unknown;
    cached_input_tokens?: unknown;
    output_tokens?: unknown;
    reasoning_output_tokens?: unknown;
  };
  [field: string]: unknown;
}

// Запись `model/list`. Значения приходят от app-server и приводятся на месте.
interface CodexModelEntry {
  id?: string;
  model?: string;
  displayName?: string;
  supportedReasoningEfforts?: unknown;
  upgrade?: unknown;
  defaultReasoningEffort?: unknown;
  description?: string;
  inputModalities?: unknown;
  isDefault?: unknown;
  hidden?: unknown;
  contextWindow?: unknown;
}

// Разобранная метрика контекста: активный вход, окно и состояние кэша.
interface CodexContextInfo {
  contextTokens: number;
  contextWindow: number;
  contextMetric: string;
  contextIsEstimate: boolean;
  contextCache: unknown;
  totalInputTokens: number;
  cachedInputTokens: number;
}

// Запись MCP-сервера для панели исполнителя.
interface CodexMcpServer {
  name: string;
  target: string;
  scope: string;
  state: string;
  detail: string;
  hint?: string;
}

// Ограниченная рабочая область хода: какие корни доступны и что открыто песочнице.
interface CodexWorkspaceAccess {
  readableRoots?: readonly unknown[];
  writableRoots?: readonly unknown[];
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

// Рабочие инструменты GrigDesk: ход знает их описания и способ вызвать по имени.
interface CodexWorkToolsPort {
  descriptors?: Array<{ name?: string; [field: string]: unknown }>;
  invoke: (name: string, args: unknown) => Promise<unknown>;
}

// Журнал сервера в том минимуме, который использует сессия.
interface CodexLog {
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

// Состояние ОДНОГО хода: лента, счётчики и итог принадлежат ходу, не сессии.
interface CodexTurn {
  message: unknown;
  stepSink: StepSink;
  normalizeStep: (value: unknown) => ChatStep[];
  toolImages: ReturnType<typeof createCodexToolImages>;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
  onPermission?: (ask: Record<string, unknown>) => unknown;
  messageDeltas: Map<string, string>;
  reply: string;
  // Id видимого блока, чей текст стал итогом: финал прикрепляется к нему без дубля.
  replyMessageId: string;
  lastCommentary: string;
  lastCommentaryId: string;
  appContext: CodexContextInfo | null;
  progressTokens: number;
  // Накопитель вывода ПОТОКА к началу этого хода: расход хода — прирост, а не последний
  // запрос. `last` у каждого обращения к модели свой и обнуляется, поэтому счётчик
  // «думает… · N ток.» прыгал вниз посреди хода. null — сессия ещё ничего не мерила
  // (первый ход после запуска или thread/resume): базу посеет первый замер.
  baseOutputTokens: number | null;
  totalInputTokens: number;
  cachedInputTokens: number;
  turnId: string | null;
  // Последняя ОКОНЧАТЕЛЬНАЯ причина сбоя из уведомления `error` (willRetry === false).
  // Промежуточное уведомление о повторе финальности не доказывает, поэтому им
  // запасная причина не подменяется.
  lastError: unknown;
  // Монотонный признак работы ТЕКУЩЕГО хода: настоящий текст модели, её рассуждения
  // или инструмент. Лента шагов для этого не годится — она усечена до хвоста.
  madeProgress: boolean;
  workCalls: Map<string, { signature: string; outcome: Promise<Record<string, unknown>> }>;
  // Канал уточнений: порт отдаётся, когда провайдер назвал id активного хода.
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
  onInTurnReceipt?: (event: InTurnReceiptEvent) => void | Promise<void>;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  inTurnAnnounced: boolean;
  assistantRevision: number;
  settled: boolean;
  abortRequested: boolean;
  interruptSent: boolean;
  interruptTimer: ReturnType<typeof setTimeout> | null;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

// Async-вопрос не имеет RPC response: решение связывается с владельцем для turn/steer.
interface CodexAsyncQuestionAnswer {
  current: CodexTurn;
  text: string;
}

/**
 * Допуск триажа следует протоколу установленного CLI, включая новые permission profiles.
 * Отсутствие проверяемого ограничения чтения по-прежнему закрывает модель для триажа.
 */
export async function codexSupportsRestrictedWorkspace(bin: unknown): Promise<boolean> {
  return Boolean(bin && await codexWorkspaceProtocol(String(bin)));
}

function windowLabel(value: unknown) {
  const minutes = typeof value === 'number' ? value : Number.NaN;
  if (minutes === 300) return 'Сессия (5ч)';
  if (minutes === 10_080) return 'Неделя (7д)';
  if (Number.isFinite(minutes) && minutes > 0 && minutes % 1_440 === 0) {
    return `Окно (${minutes / 1_440}д)`;
  }
  if (Number.isFinite(minutes) && minutes > 0 && minutes % 60 === 0) {
    return `Окно (${minutes / 60}ч)`;
  }
  return Number.isFinite(minutes) && minutes > 0 ? `Окно (${minutes}м)` : 'Лимит';
}

function resetIso(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Общая квота аккаунта (ведро без собственного имени) всегда идёт первой: в неё
 * упираются раньше всего. Остальные сортируются по ВИДИМОЙ подписи, а не по
 * внутреннему id: по id `base_model_inference` встал бы впереди `codex`, хотя
 * человек читает «gpt-reserve» и «Неделя (7д)». Одинаковые подписи разводит id,
 * чтобы порядок оставался полным.
 */
function compareCodexBuckets(a: { scope: string; id: string }, b: { scope: string; id: string }) {
  const generalA = a.scope === '';
  const generalB = b.scope === '';

  if (generalA !== generalB) {
    return generalA ? -1 : 1;
  }

  return a.scope.localeCompare(b.scope, 'ru') || a.id.localeCompare(b.id);
}

/**
 * Слоты окна нельзя перечислять списком: `['primary', 'secondary']` — это снимок
 * СЕГОДНЯШНЕЙ схемы, и третий слот выпал бы молча, как выпадало бы новое ведро при
 * allowlist по id. Берём любое поле ведра, которое выглядит окном (числовой
 * `usedPercent`); `credits` и `individualLimit` под это не подходят — у первого
 * процента нет вовсе, у второго он называется `remainingPercent`.
 *
 * Порядок — от короткого окна к длинному (сессия перед неделей), а не по имени поля:
 * имена придумывает сервис, смысл несёт длительность. Ведро без длительности уходит
 * в конец, одинаковые разводит имя слота — иначе сортировка была бы неполной.
 */
function bucketWindows(bucket: CodexBucket) {
  const windows = Object.entries(bucket)
    .filter(([, window]) => window && typeof (window as CodexWindow).usedPercent === 'number')
    .map(([slot, window]) => ({ slot, window: window as CodexWindow }));

  return windows.sort((a, b) => {
    const left = typeof a.window.windowDurationMins === 'number' ? a.window.windowDurationMins : Infinity;
    const right = typeof b.window.windowDurationMins === 'number' ? b.window.windowDurationMins : Infinity;

    if (left !== right) {
      return left < right ? -1 : 1;
    }

    return a.slot.localeCompare(b.slot);
  });
}

/**
 * Уведомления квот разрежены: null в метаданных не стирает предыдущее окно.
 * Состояние принадлежит процессу, а подписи и ключи разбирает общий парсер опроса.
 */
function mergeCodexRateLimitSnapshot(previous: CodexBucket | undefined, next: CodexBucket): CodexBucket {
  const merged = { ...previous };

  for (const [key, value] of Object.entries(next)) {
    if (value == null) {
      continue;
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      const known = merged[key];

      merged[key] = {
        ...(known && typeof known === 'object' ? known : {}),
        ...Object.fromEntries(Object.entries(value).filter(([, field]) => field != null)),
      };
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Контракт app-server: account/rateLimits/read. `rateLimitsByLimitId` — текущий
 * многовёдерный вид, `rateLimits` остаётся совместимым запасным. Имена вёдер
 * приходят от сервиса, поэтому новое семейство Codex появляется в шапке без
 * релиза GrigDesk.
 *
 * Порядок полос принадлежит GrigDesk, а не сервису: `rateLimitsByLimitId` — объект,
 * и OpenAI отдаёт ключи в разном порядке на каждый ответ (замер: шесть запросов
 * подряд — три разных порядка). Минутное обновление шапки поэтому перетасовывало
 * полосы прямо под курсором. Поле `group` называет ведро, которому принадлежит
 * полоса: по нему всплывашка ставит разделитель, не зная про вендора.
 */
export function parseCodexRateLimits(value: unknown): CodexUsageBar[] {
  const result = value as {
    rateLimitsByLimitId?: Record<string, unknown>;
    rateLimits?: unknown;
  } | null;
  const byId = result?.rateLimitsByLimitId;
  const source = (byId && typeof byId === 'object' && Object.keys(byId).length
    ? Object.values(byId)
    : (result?.rateLimits ? [result.rateLimits] : [])) as CodexBucket[];

  const buckets: Array<{ id: string; bucket: CodexBucket; scope: string }> = [];

  for (const bucket of source) {
    if (!bucket || typeof bucket !== 'object') {
      continue;
    }

    const id = String(bucket.limitId || 'codex');
    buckets.push({
      id,
      bucket,
      scope: String(bucket.limitName || (id !== 'codex' ? id : '')),
    });
  }

  buckets.sort(compareCodexBuckets);

  const bars: CodexUsageBar[] = [];

  for (const { id, bucket, scope } of buckets) {
    for (const { slot, window } of bucketWindows(bucket)) {
      const pct = usagePercentOrNull(window.usedPercent);

      if (pct === null) {
        continue;
      }

      const base = windowLabel(window.windowDurationMins);

      bars.push({
        key: `${id}:${slot}`,
        group: id,
        label: scope ? `${base.replace(/ \([^)]+\)$/, '')} · ${scope}` : base,
        pct,
        resetsAt: resetIso(window.resetsAt),
        windowMinutes: typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null,
      });
    }
  }

  return bars;
}

// Почему аккаунт упёрся, сервис называет поимённо. Свои формулировки нужны потому,
// что коды приходят по сети и человеку ничего не говорят; незнакомый код показывается
// как есть — выдумывать за сервис перевод хуже, чем показать его слово.
const CODEX_REACHED_REASON: Record<string, string> = {
  rate_limit_reached: 'достигнут лимит запросов',
  workspace_owner_credits_depleted: 'кончились кредиты владельца рабочей области',
  workspace_member_credits_depleted: 'кончились кредиты участника рабочей области',
  workspace_owner_usage_limit_reached: 'достигнут лимит расхода владельца рабочей области',
  workspace_member_usage_limit_reached: 'достигнут лимит расхода участника рабочей области',
};

/**
 * Отдельный ресурс про КОНТРОЛЬ ТРАТ, а не про окна лимитов: `individualLimit` — это
 * персональный денежный потолок, а `spendControlReached` — упёрлись ли в него. Оба поля
 * приходили в ответе с самого начала и не показывались нигде, поэтому исчерпанный
 * потолок выглядел как «всё молча встало» без единой подсказки во всплывашке.
 *
 * Ресурса нет, пока сервис молчит: `null`/`false` — это «нечего сказать», и пустая
 * строка в шапке была бы шумом. Суммы остаются СТРОКАМИ как пришли: это деньги, и
 * `Number` на них молча теряет точность.
 */
function codexSpendControl(result: unknown, buckets: CodexBucket[]) {
  const limit = buckets.map((bucket) => bucket.individualLimit)
    .find((value) => value && typeof value === 'object');
  const reached = buckets.some((bucket) => bucket.spendControlReached === true);
  const reason = buckets.map((bucket) => bucket.rateLimitReachedType)
    .find((value) => typeof value === 'string' && value);

  if (!limit && !reached && !reason) {
    return null;
  }

  const remaining = Number(limit?.remainingPercent);
  const notes: string[] = [];

  if (reached) {
    notes.push('Лимит трат исчерпан — ходы не пойдут до сброса.');
  }

  if (reason) {
    notes.push(`Причина от сервиса: ${CODEX_REACHED_REASON[String(reason)] || reason}.`);
  }

  return {
    key: 'spend-control',
    label: 'Контроль трат',
    summary: limit ? `${limit.used} из ${limit.limit}` : (reached ? 'исчерпан' : 'достигнут лимит'),
    tone: reached ? 'bad' : 'muted',
    ...(Number.isFinite(remaining) && { percent: Math.max(0, Math.min(100, Math.round(100 - remaining))) }),
    ...(notes.length && { note: notes.join(' ') }),
  };
}

/**
 * OpenAI отдаёт баланс кредитов строкой с десятью знаками после запятой.
 * Показываем до сотых с разрядами; нечисловое значение оставляем как есть.
 */
function codexCreditAmount(balance: unknown): string {
  const amount = typeof balance === 'number' || typeof balance === 'string' ? Number(balance) : NaN;

  if (typeof balance === 'string' && !balance.trim()) {
    return balance;
  }

  if (!Number.isFinite(amount)) {
    return String(balance);
  }

  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount);
}

/**
 * Дополнительные кредиты видны и без состояния счёта, если сервис вернул другие данные.
 * Пустой ответ не становится успешным из-за справочной карточки без баланса.
 */
export function parseCodexUsageResources(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  const result = value as {
    rateLimits?: unknown;
    rateLimitsByLimitId?: Record<string, unknown>;
    credits?: unknown;
    rateLimitResetCredits?: { availableCount?: unknown; credits?: unknown };
  };
  const buckets = [
    result.rateLimits,
    ...Object.values(result.rateLimitsByLimitId || {}),
  ].filter((bucket) => bucket && typeof bucket === 'object') as CodexBucket[];
  const creditState = [result.credits, ...buckets.map((bucket) => bucket.credits)]
    .find((credits) => credits && typeof credits === 'object') as {
      balance?: unknown;
      unlimited?: unknown;
      hasCredits?: unknown;
    } | undefined;
  const resources: Array<Record<string, unknown>> = [];

  // Первым: он один отвечает на «почему всё встало», остальные — справка о балансе.
  const spendControl = codexSpendControl(result, buckets);

  if (spendControl) {
    resources.push(spendControl);
  }

  const resetState = result.rateLimitResetCredits;
  const count = Number(resetState?.availableCount);
  const hasResets = Number.isFinite(count) && count > 0;

  if (!creditState && !spendControl && !hasResets && !parseCodexRateLimits(value).length) {
    return [];
  }

  let summary = 'Нет данных о кредитах';

  if (creditState) {
    const balance = creditState.balance == null
      ? (creditState.hasCredits ? 'доступен' : '0')
      : codexCreditAmount(creditState.balance);

    summary = creditState.unlimited ? 'Без ограничений' : `Баланс: ${balance}`;
  }

  resources.push({
    key: 'chatgpt-credits',
    label: 'Дополнительные кредиты',
    summary,
    tone: creditState?.unlimited || creditState?.hasCredits ? 'ok' : 'muted',
    note: 'Покупка и автопополнение управляются в ChatGPT.',
    controls: [{
      id: 'manage-credits',
      kind: 'link',
      label: 'Купить / управлять кредитами',
      href: 'https://chatgpt.com/codex/settings/usage',
    }],
  });

  if (hasResets) {
    const first = (Array.isArray(resetState?.credits)
      ? (resetState.credits as Array<{ status?: unknown; id?: unknown; description?: unknown }>)
        .find((credit) => credit?.status === 'available' && credit.id)
      : null) as { id?: unknown; description?: unknown } | null | undefined;
    resources.push({
      key: 'rate-limit-resets',
      label: 'Сброс лимита',
      summary: `Доступно: ${Math.floor(count)}`,
      tone: 'ok',
      note: first?.description || 'Сбрасывает подходящее окно лимита и расходует один заработанный сброс.',
      controls: [{
        id: 'consume-rate-limit-reset',
        kind: 'button',
        // Ответ на «всё встало, что делать сейчас» — держим рядом с полосами лимитов.
        scope: 'live',
        label: 'Использовать сброс лимита',
        action: 'consume-rate-limit-reset',
        ...(Boolean(first?.id) && { payload: { creditId: String(first?.id) } }),
        confirm: {
          text: 'Использовать один заработанный сброс лимита Codex? Отменить расход после подтверждения OpenAI нельзя.',
          label: 'Использовать',
          danger: true,
        },
      }],
    });
  }

  return resources;
}

// Два класса отказа, которые ожиданием не лечатся: устаревший CLI без метода и
// неавторизованный аккаунт. Всё остальное — сеть или занятый app-server, и повтор
// имеет смысл. Правило одно на классификатор и на ретрай: разъехавшись, они дали бы
// либо бессмысленные повторы на «нужен login», либо отсутствие повтора там, где он лечит.
const CODEX_USAGE_UNSUPPORTED_RE = /method not found/i;
const CODEX_USAGE_AUTH_RE = /login|required|sign.?in|unauthori[sz]ed|not authenticated|401/i;

export function codexUsageErrorIsPermanent(value: unknown) {
  if (!value) return false;
  const error = value as { message?: unknown; code?: unknown };
  const detail = String(error?.message || error || '').slice(0, 500);
  return error?.code === -32601
    || CODEX_USAGE_UNSUPPORTED_RE.test(detail)
    || CODEX_USAGE_AUTH_RE.test(detail);
}

export function classifyCodexUsageResponse({ result = null, error = null }: {
  result?: unknown;
  error?: { code?: number; message?: string } | null;
} = {}) {
  const detail = String(error?.message || error || '').slice(0, 500);
  if (error) {
    if (error?.code === -32601 || CODEX_USAGE_UNSUPPORTED_RE.test(detail)) {
      return {
        state: 'unsupported',
        bars: [],
        message: 'Установленная версия Codex не умеет отдавать лимиты. Обнови CLI в настройках.',
        detail,
        action: null,
      };
    }
    if (CODEX_USAGE_AUTH_RE.test(detail)) {
      return {
        state: 'auth_required',
        bars: [],
        message: 'Codex CLI не авторизован или сессия истекла. Выполни codex login.',
        detail,
        action: { kind: 'terminal', label: 'Войти в Codex', command: 'codex login' },
      };
    }
    return {
      state: 'unavailable',
      bars: [],
      message: 'Не удалось получить лимиты Codex. Повторим проверку автоматически.',
      detail,
      action: null,
    };
  }

  const bars = parseCodexRateLimits(result);
  const resources = parseCodexUsageResources(result);
  if (!bars.length && !resources.length) {
    return {
      state: 'unavailable',
      bars: [],
      resources: [],
      message: 'OpenAI не вернул данные о лимитах Codex.',
      action: null,
    };
  }
  return { state: 'ok', bars, resources, message: '', action: null };
}

/**
 * Каталог для модельного селектора из документированного `model/list`.
 * `model` — канонический slug, `id` может быть его алиасом. Алиасы схлопываем,
 * чтобы одна и та же модель не появлялась в интерфейсе дважды.
 */
export function codexModelFamily(modelId: unknown) {
  const id = String(modelId || '').trim().toLowerCase();
  const match = /^gpt-(?:\d+(?:\.\d+)*|next)-([a-z][a-z0-9-]*)$/.exec(id);
  return match?.[1] || '';
}

/**
 * `model/list` не обещает размер окна. Старый app-server мог прислать расширенное
 * поле, и его сохраняем, но отсутствие нельзя подменять паспортным окном API:
 * рабочий потолок Codex зависит от thread и точно приезжает только с token usage.
 */
function codexCatalogContext(entry: { contextWindow?: unknown } | null) {
  const context = Number(entry?.contextWindow);

  if (Number.isSafeInteger(context) && context > 0) {
    return { context };
  }

  return {
    context: 0,
    contextUnverified: true,
    contextRuntimeOnly: true,
  };
}

export function parseCodexModelList(value: unknown) {
  const result = value as { data?: unknown } | null;
  if (!Array.isArray(result?.data) || !result.data.length) return null;

  const entries = (result.data as CodexModelEntry[])
    .filter((entry) => entry && typeof entry === 'object' && (entry.model || entry.id));
  const canonicalByName = new Map<string, string>(entries
    .filter((entry) => entry.id === entry.model && !/^codex-/i.test(entry.id || ''))
    .map((entry) => [String(entry.displayName || '').trim().toLowerCase(), String(entry.model)]));
  const groups = new Map<string, { index: number; entries: CodexModelEntry[] }>();
  entries.forEach((entry, index) => {
    const slug = String(entry.model || entry.id).trim();
    const name = String(entry.displayName || '').trim().toLowerCase();
    // Некоторые rollout-алиасы (`codex-auto-review`) приходят отдельной строкой с
    // собственным slug, но теми же displayName/возможностями, что канонический GPT.
    const canonical = (/^codex-/i.test(slug) ? canonicalByName.get(name) : '') || slug;
    if (!groups.has(canonical)) groups.set(canonical, { index, entries: [] });
    groups.get(canonical)?.entries.push(entry);
  });

  const models: Array<Record<string, unknown>> = [];
  for (const group of groups.values()) {
    const exact = group.entries.find((entry) => entry.id === entry.model && !/^codex-/i.test(entry.id || ''))
      || group.entries[0];
    if (!exact) continue;
    const id = String(exact.model || exact.id);
    const family = codexModelFamily(id);
    const effortSource = (group.entries
      .map((entry) => entry.supportedReasoningEfforts)
      .find((efforts) => Array.isArray(efforts) && efforts.length) || []) as Array<{
        reasoningEffort?: unknown;
      }>;
    const efforts = [...new Set(effortSource
      .map((effort) => effort?.reasoningEffort)
      .filter((effort) => typeof effort === 'string' && effort))];
    const aliases = [...new Set(group.entries
      .flatMap((entry) => [entry.id, entry.model])
      .filter((alias) => alias && alias !== id))];
    const upgrade = exact.upgrade
      || group.entries.find((entry) => entry.upgrade)?.upgrade
      || null;

    models.push({
      id,
      ...(family && { family }),
      name: exact.displayName || id,
      ...codexCatalogContext(exact),
      tier: 10_000 - group.index,
      efforts: efforts.length ? efforts : null,
      defaultEffort: exact.defaultReasoningEffort || null,
      description: exact.description || '',
      inputModalities: Array.isArray(exact.inputModalities) ? exact.inputModalities : ['text', 'image'],
      isDefault: group.entries.some((entry) => entry.isDefault === true),
      // hidden — не входит в официальный picker; upgrade — оставлен только для миграции.
      // Оба доступны по общему флажку «Показывать все модели».
      extra: group.entries.every((entry) => entry.hidden === true) || !!upgrade,
      upgrade,
      ...(aliases.length && { aliases }),
    });
  }
  return models.sort((a, b) => Number(b.tier) - Number(a.tier));
}

/**
 * `codex exec --json` кладёт в `turn.completed.usage` НАКОПЛЕННЫЙ расход thread:
 * каждый вызов модели после tool-call ещё раз добавляет весь вход. Это полезная
 * метрика работы/лимита, но не заполненность context window — в долгом ходе она
 * закономерно вырастает до миллионов при окне в сотни тысяч.
 *
 * cached_input_tokens уже входит в input_tokens, повторно его не складываем.
 */
export function codexTotalInputTokens(usage: unknown) {
  const tokens = Number((usage as { input_tokens?: unknown } | null)?.input_tokens);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
}

const CODEX_CONTEXT_METRIC = 'active-input-v1';
const ROLLOUT_READ_CHUNK = 256 * 1024;

function tokenNumber(value: unknown, { positive = false }: { positive?: boolean } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 0 || (positive && value <= 0)) {
    return null;
  }

  return value;
}

/**
 * Вывод одного замера Codex в токенах. Рассуждения — ЧАСТЬ `output_tokens` (в аналитике
 * они лежат атрибутом той же метрики `output_tokens`, а не отдельным слагаемым), поэтому
 * отдельно их не прибавляем: прежняя сумма удваивала расход ровно на долю рассуждений.
 */
function codexOutputTokens(usage: unknown): number | null {
  return tokenNumber((usage as { outputTokens?: unknown } | null)?.outputTokens);
}

/**
 * Rollout пишет точную пару, которую показывает родной `/status`:
 * last_token_usage.input_tokens — вход ПОСЛЕДНЕГО model request (активный контекст),
 * model_context_window — эффективное окно уже с поправкой модели. total_token_usage
 * оставляем отдельной метрикой, чтобы не смешивать расход и заполненность.
 */
export function parseCodexTokenInfoLine(line: unknown): CodexContextInfo | null {
  let event: { payload?: { type?: string; info?: unknown } } | null;
  try { event = JSON.parse(String(line || '')); } catch { return null; }
  if (event?.payload?.type !== 'token_count') return null;
  const info = event.payload.info as {
    last_token_usage?: { input_tokens?: unknown; cached_input_tokens?: unknown };
    model_context_window?: unknown;
    total_token_usage?: { input_tokens?: unknown; cached_input_tokens?: unknown };
  } | null;
  const contextTokens = tokenNumber(info?.last_token_usage?.input_tokens);
  const cachedRequestTokens = tokenNumber(info?.last_token_usage?.cached_input_tokens);
  const contextWindow = tokenNumber(info?.model_context_window, { positive: true });
  if (contextTokens === null || contextWindow === null) return null;
  return {
    contextTokens,
    contextWindow,
    contextMetric: CODEX_CONTEXT_METRIC,
    contextIsEstimate: false,
    contextCache: cachedRequestTokens === null
      ? contextCacheStatus('unavailable')
      : reportedContextCache({
        readTokens: cachedRequestTokens,
        uncachedTokens: contextTokens - cachedRequestTokens,
      }),
    totalInputTokens: tokenNumber(info?.total_token_usage?.input_tokens) || 0,
    cachedInputTokens: tokenNumber(info?.total_token_usage?.cached_input_tokens) || 0,
  };
}

/** Читает rollout с конца: многомиллионный ход не грузим целиком в память. */
export async function readLatestCodexTokenInfo(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let position = size;
    let carry = '';
    while (position > 0) {
      const length = Math.min(ROLLOUT_READ_CHUNK, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const lines = `${chunk.subarray(0, bytesRead).toString('utf8')}${carry}`.split('\n');
      carry = position > 0 ? (lines.shift() || '') : '';
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const info = parseCodexTokenInfoLine(lines[i]);
        if (info) return info;
      }
    }
    return parseCodexTokenInfoLine(carry);
  } finally {
    await handle.close();
  }
}

function codexThreadDays(threadId: unknown) {
  const compact = String(threadId || '').replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  const timestamp = Number.parseInt(compact.slice(0, 12), 16);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  // Rollout-каталог использует календарный день хоста, UUIDv7 — UTC timestamp.
  // Вокруг полуночи они могут отличаться на сутки, поэтому проверяем соседние даты.
  return [-86_400_000, 0, 86_400_000]
    .map((shift) => new Date(timestamp + shift).toISOString().slice(0, 10).split('-'));
}

async function matchingRollout(dir: string, threadId: unknown) {
  try {
    const suffix = `-${threadId}.jsonl`;
    const names = await fs.readdir(dir);
    const name = names.find((candidate) => candidate.endsWith(suffix));
    return name ? path.join(dir, name) : null;
  } catch {
    return null;
  }
}

/** Находит только собственный UUID-файл thread; произвольный путь сюда не принимается. */
export async function readCodexThreadTokenInfo(threadId: unknown, { env = process.env }: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CodexContextInfo | null> {
  const days = codexThreadDays(threadId);
  if (!days) return null;
  const home = String(env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  let active: string | null = null;
  for (const day of days) {
    active = await matchingRollout(path.join(home, 'sessions', ...day), threadId);
    if (active) break;
  }
  const archived = active || await matchingRollout(path.join(home, 'archived_sessions'), threadId);
  if (!archived) return null;
  try { return await readLatestCodexTokenInfo(archived); } catch { return null; }
}

/**
 * Одноразовый read-only JSON-RPC клиент. Он не создаёт thread/turn и не вызывает
 * модель: поднимает `codex app-server`, выполняет один безопасный метод и завершает
 * именно запущенный им дочерний процесс.
 */
export function codexAppServerRequest(bin: string, { method, params }: {
  method?: string;
  params?: unknown;
} = {}, {
  timeoutMs = APP_SERVER_TIMEOUT_MS,
  spawnProcess = spawn,
}: {
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
} = {}): Promise<CodexRpcResponse> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error: { message: (error as Error)?.message || 'Codex app-server не запустился' } });
      return;
    }

    let settled = false;
    let stderr = '';
    let requestSent = false;
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    const timer = setTimeout(() => {
      finish({ error: { message: 'Codex app-server не ответил за отведённое время' } });
    }, timeoutMs);

    function finish(value: CodexRpcResponse) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      resolve(value);
    }

    function send(message: unknown) {
      if (!settled) child.stdin?.write(`${JSON.stringify(message)}\n`);
    }

    child.stdin?.on('error', (error: Error) => {
      finish({ error: { message: error?.message || 'Не удалось обратиться к Codex app-server' } });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    child.on('error', (error: Error) => {
      finish({ error: { message: error?.message || 'Codex app-server не запустился' } });
    });
    child.on('close', (code: number | null) => {
      if (!settled) {
        finish({
          error: {
            message: stderr.trim() || `Codex app-server завершился с кодом ${code ?? '?'}`,
          },
        });
      }
    });
    lines.on('line', (line: string) => {
      let message: CodexRpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1 && !requestSent) {
        if (message.error) {
          finish({ error: message.error });
          return;
        }
        requestSent = true;
        send({ method: 'initialized' });
        send({ method, id: 2, ...(params !== undefined && { params }) });
      } else if (message.id === 2) {
        finish(message.error ? { error: message.error } : { result: message.result });
      }
    });

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'grigdesk',
          title: 'GrigDesk',
          version: '0.1.0',
        },
        capabilities: null,
      },
    });
  });
}

/**
 * Потребление лимитов. Повтор здесь разрешён именно потому, что метод read-only и
 * идемпотентный: он не создаёт thread/turn, ничего не расходует и не меняет аккаунт.
 * Соседнему `consume` такого права не выдано — там повтор означал бы второй списанный
 * сброс лимита.
 *
 * Причина повтора не в самом app-server, а в сети под ним: моргание туннеля роняет
 * единственную попытку, и шапка показывает «не удалось получить лимиты» на живом
 * аккаунте. Пауза между попытками обязательна — мгновенный повтор попадает в то же
 * моргание.
 */
export async function readCodexRateLimits(bin: string, options: {
  sleep?: (ms: number) => Promise<void>;
  request?: typeof codexAppServerRequest;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
} = {}) {
  const { sleep, request = codexAppServerRequest, ...rest } = options;
  return withRetry(() => request(bin, { method: 'account/rateLimits/read' }, rest), {
    // Ответ без ошибки — готово. Устаревший CLI и неавторизованный аккаунт — тоже
    // окончательный ответ: повтор их не изменит, а человека задержит на секунды.
    retryWhen: (response: CodexRpcResponse) => (
      !!response?.error && !codexUsageErrorIsPermanent(response.error)
    ),
    ...(sleep ? { sleep } : {}),
  });
}

export async function consumeCodexRateLimitReset(bin: string, {
  requestId = '',
  creditId = '',
}: {
  requestId?: unknown;
  creditId?: unknown;
} = {}, {
  request = codexAppServerRequest,
}: { request?: typeof codexAppServerRequest } = {}) {
  const response = await request(bin, {
    method: 'account/rateLimitResetCredit/consume',
    params: {
      idempotencyKey: String(requestId || randomUUID()),
      ...(String(creditId || '') && { creditId: String(creditId) }),
    },
  });
  if (response?.error) {
    return { ok: false, error: response.error.message || 'Codex не применил сброс лимита' };
  }
  const outcome = (response?.result as { outcome?: unknown } | null)?.outcome;
  if (outcome === 'reset' || outcome === 'alreadyRedeemed') return { ok: true, outcome };
  const messages: Record<string, string> = {
    nothingToReset: 'Сейчас нет окна лимита, которое можно сбросить.',
    noCredit: 'Доступных сбросов лимита больше нет.',
  };
  return {
    ok: false,
    error: messages[String(outcome)] || 'Codex не применил сброс лимита',
    outcome,
  };
}

async function readCodexModelCatalog(bin: string) {
  const data: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const response = await codexAppServerRequest(bin, {
      method: 'model/list',
      params: {
        limit: 100,
        includeHidden: true,
        ...(cursor && { cursor }),
      },
    });
    const page = response.result as { data?: unknown; nextCursor?: unknown } | null;
    if (response.error || !Array.isArray(page?.data)) return null;
    data.push(...page.data);
    cursor = (page.nextCursor as string) || null;
    if (!cursor) break;
  }
  return parseCodexModelList({ data });
}

/**
 * `resume` is an exec subcommand. Sandbox and working-directory flags belong to
 * the parent `codex exec` parser and therefore must precede `resume`; otherwise
 * the second chat message fails before a turn starts.
 */
export function buildCodexExecArgs({
  message,
  cwd,
  extraDirs = [],
  model,
  effort,
  sessionId,
  compactWindow = 0,
}: {
  message?: string;
  cwd: string;
  extraDirs?: readonly string[];
  model?: string;
  effort?: string;
  sessionId?: string | null;
  compactWindow?: unknown;
}) {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-C', cwd,
  ];
  for (const dir of extraDirs) args.push('--add-dir', dir);
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  // Дефолтное summary у Codex короткое: в ленту приезжал огрызок фразы, и человек
  // видел «обрезанную информацию» вместо размышления. `detailed` просит CLI отдать
  // развёрнутое резюме; приватную цепочку (`raw_content`) normalizer по-прежнему
  // игнорирует. Ключ валидируется самим CLI (проверено: `bogus` → doctor fail).
  args.push('-c', 'model_reasoning_summary="detailed"');
  const compactAt = Math.max(0, Math.round(Number(compactWindow) || 0));
  if (compactAt) args.push('-c', `model_auto_compact_token_limit=${compactAt}`);
  if (sessionId) args.push('resume', '--json', sessionId);
  else args.push('--json');
  args.push(String(message ?? ''));
  return args;
}

function codexAppServerConfig(compactWindow: unknown) {
  const compactAt = Math.max(0, Math.round(Number(compactWindow) || 0));
  return {
    sandbox_workspace_write: { network_access: true },
    model_reasoning_summary: 'detailed',
    ...(compactAt && { model_auto_compact_token_limit: compactAt }),
  };
}

/**
 * Нативный слой передаётся отдельными argv вместе с обязательным командным hook.
 * Пустой план сохраняет прежний запуск и не добавляет сохранённых CLI-значений.
 */
function codexProcessArgs(
  providerSettings: CodexSettings | null | undefined,
  nativeSettings?: PreparedNativeSettings,
) {
  const hookCommand = directCommandHook({
    blockDirectSsh: providerSettings?.blockDirectSsh !== false,
    blockDirectDb: providerSettings?.blockDirectDb === true,
    strictUnknownDbClient: providerSettings?.strictUnknownDbClient === true,
  });
  const nativeArgs = nativeSettingsTomlArgs(nativeSettings);

  if (!hookCommand) {
    return [...nativeArgs, 'app-server'];
  }

  const hook = '[{ matcher = "^Bash$", hooks = [{ type = "command", '
    + `command = "${hookCommand}", timeout = 5 }] }]`;

  return [
    '--dangerously-bypass-hook-trust',
    '-c',
    `hooks.PreToolUse=${hook}`,
    ...nativeArgs,
    'app-server',
  ];
}

function directSshPolicyError(message: string) {
  return Object.assign(new Error(message), { code: 'direct_ssh_policy_unavailable' });
}

/**
 * Process flags недостаточно принять на веру: app-server мог отбросить их. До
 * thread/start сверяем опубликованный enabled sessionFlags-hook по всем опорным полям.
 */
function assertDirectSshHook(value: unknown, expectedCommand: string) {
  const result = value as { data?: unknown } | null;
  const hooks = ((Array.isArray(result?.data) ? result.data : []) as Array<{ hooks?: unknown }>)
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [])) as Array<{
      eventName?: unknown;
      handlerType?: unknown;
      command?: unknown;
      matcher?: unknown;
      source?: unknown;
      enabled?: unknown;
    }>;
  const found = hooks.some((hook) => (
    hook?.eventName === 'preToolUse'
    && hook?.handlerType === 'command'
    && hook?.command === expectedCommand
    && hook?.matcher === DIRECT_SSH_HOOK_MATCHER
    && hook?.source === 'sessionFlags'
    && hook?.enabled === true
  ));
  if (!found) {
    throw directSshPolicyError('Codex не подтвердил server-owned запрет прямого SSH.');
  }
}

function codexWorkspaceRoots(cwd: unknown, extraDirs: readonly unknown[] | null | undefined) {
  return [...new Set([cwd, ...(extraDirs || [])].filter(Boolean).map(String))];
}

function codexStoppedError({ sessionId, steps }: {
  sessionId?: string | null;
  steps?: unknown;
}) {
  return Object.assign(new Error('Ход остановлен.'), {
    stopped: true,
    steps,
    contextCache: contextCacheStatus('unavailable'),
    sessionId: sessionId || null,
  });
}

function codexRpcError(method: string, value: unknown) {
  const error = value as { message?: unknown; code?: unknown } | null;
  const detail = String(error?.message || error || 'неизвестная ошибка').slice(-600);
  const wrapped = new Error(`Codex app-server ${method}: ${detail}`);
  return error?.code !== undefined ? Object.assign(wrapped, { code: error.code }) : wrapped;
}

/**
 * Provider-neutral descriptor не должен знать wire-форму конкретного исполнителя.
 * App-server v2 требует явный discriminant `type: function`, поэтому добавляем его
 * только на границе Codex, не ломая MCP-представления тех же инструментов.
 */
function codexDynamicTools(descriptors: readonly unknown[] = []) {
  return descriptors.map((value) => {
    const descriptor = value as { type?: unknown } | null;
    return descriptor?.type ? descriptor : { type: 'function', ...descriptor };
  });
}

/**
 * Dynamic tool передаёт изображения типизированным content item, без base64 в тексте.
 * Обычный broker JSON сохраняет прежнюю текстовую wire-обёртку.
 */
export function codexDynamicToolResponse(value: unknown) {
  const source = value as {
    ok?: unknown;
    format?: unknown;
    content?: unknown;
  } | null;

  if (source?.format === 'grigdesk-work-content-v1') {
    const images = source.content as {
      type?: string;
      mimeType?: string;
      data?: string;
    }[];

    if (Array.isArray(images) && images.length === 1 && images[0]?.type === 'image'
      && images[0].mimeType === 'image/jpeg' && typeof images[0].data === 'string'
      && /^[A-Za-z0-9+/]+={0,2}$/u.test(images[0].data)
      && Buffer.byteLength(images[0].data, 'base64') <= 2 * 1024 * 1024) {
      return {
        contentItems: [{ type: 'inputImage', imageUrl: `data:image/jpeg;base64,${images[0].data}` }],
        success: true,
      };
    }

    value = { ok: false, error: 'tool_response_invalid' };
  }

  let text: string;
  let success = (value as { ok?: unknown } | null)?.ok !== false;

  try {
    text = JSON.stringify(value ?? null);

    if (typeof text !== 'string') {
      throw new TypeError('tool_response_invalid');
    }
  } catch {
    success = false;
    text = JSON.stringify({ ok: false, error: 'tool_response_invalid' });
  }

  return { contentItems: [{ type: 'inputText', text }], success };
}

/**
 * Живая сессия Codex: один процесс `codex app-server` держит thread и обслуживает все
 * ходы чата. Раньше он поднимался на КАЖДЫЙ ход и убивался сразу после `turn/completed`,
 * поэтому всё, что агент оставил после себя, умирало вместе с ответом.
 * Замер: два `turn/start` в одном процессе — pid тот же, thread живой, память цела.
 *
 * Разделение простое: соединение (процесс, JSON-RPC, thread) живёт, а ход — это
 * отрезок его потока со своей лентой шагов, своим счётчиком токенов и своим итогом.
 */
export function openCodexSession({
  config, env, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
  providerSettings, nativeSettings, log, hooks = {}, tokenInfoReader = readCodexThreadTokenInfo, workTools,
  workspaceAccess, permissionMode, modeSelection, preparedRuntime, runtimeProfileFingerprint,
}: {
  config: CodexConfig;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  extraDirs?: readonly string[];
  model?: string;
  effort?: string;
  sessionId?: string | null;
  compactWindow?: unknown;
  providerSettings?: CodexSettings | null;
  nativeSettings?: PreparedNativeSettings;
  log?: CodexLog;
  hooks?: {
    onExit?: (info: { code?: number | null; reason: string }) => void;
    onProviderUsage?: (patch: ProviderUsagePatch) => boolean;
  };
  tokenInfoReader?: typeof readCodexThreadTokenInfo;
  workTools?: CodexWorkToolsPort | null;
  workspaceAccess?: CodexWorkspaceAccess | null;
  permissionMode?: string;
  modeSelection?: unknown;
  preparedRuntime?: PreparedExecutorRuntime;
  runtimeProfileFingerprint?: string;
}) {
  const roots = workspaceAccess
    ? codexWorkspaceRoots(cwd, workspaceAccess.readableRoots)
    : codexWorkspaceRoots(cwd, extraDirs);
  const writableRoots = workspaceAccess
    ? codexWorkspaceRoots('', workspaceAccess.writableRoots)
    : roots;
  const runtimeInput = {
    config,
    cwd,
    extraDirs,
    workspaceAccess,
    permissionMode,
    modeSelection,
    runtimeProfileFingerprint
  };

  assertCodexRuntimeBeforeSpawn(preparedRuntime, runtimeInput);

  const modeProfile = codexModeProfile(permissionMode, workspaceAccess);
  const { approvalPolicy, approvalsReviewer } = modeProfile;
  const sandboxPolicy = modeProfile.sandbox === 'danger-full-access'
    ? { type: 'dangerFullAccess' }
    : {
      type: 'workspaceWrite',
      writableRoots,
      ...(workspaceAccess ? { readOnlyAccess: {
        type: 'restricted',
        includePlatformDefaults: true,
        readableRoots: roots,
      } } : {}),
      networkAccess: workspaceAccess?.networkAccess ?? true,
      excludeTmpdirEnvVar: workspaceAccess?.excludeTmpdirEnvVar ?? false,
      excludeSlashTmp: workspaceAccess?.excludeSlashTmp ?? false,
    };
  const newMode = !!permissionMode && permissionMode !== 'auto' && !workspaceAccess;
  const workspaceProfileId = `grigdesk-triage-${randomUUID()}`;
  const workspaceProfile = workspaceAccess
    ? codexWorkspaceProfile(config.codexBin, env ?? process.env, roots, writableRoots) : null;
  let namedWorkspaceProfile = false;

  /**
   * Новые профили подтверждают полную sandbox, включая roots, сеть и временные пути.
   * Legacy Auto сохраняет прежний effective handshake для совместимости версий CLI.
   */
  function assertEffectiveProfile(value: unknown) {
    const opened = value as {
      approvalPolicy?: unknown;
      approvalsReviewer?: unknown;
      sandbox?: Record<string, unknown>
    } | null;
    const actual = opened?.sandbox;
    const expected = sandboxPolicy as Record<string, unknown>;
    // Native readback не перечисляет cwd в writableRoots: он разрешён неявно.
    // Сверяем полное множество и не теряем проверку лишних внешних grants.
    const actualRoots = Array.isArray(actual?.writableRoots)
      ? [...new Set([...(cwd ? [cwd] : []), ...actual.writableRoots])].sort() : null;
    const expectedRoots = [...writableRoots].sort();
    const mismatch = opened?.approvalPolicy !== approvalPolicy
      || opened?.approvalsReviewer !== approvalsReviewer || actual?.type !== expected.type
      || (namedWorkspaceProfile && (actual?.networkAccess !== false
        || actual.excludeTmpdirEnvVar !== true || actual.excludeSlashTmp !== true
        || JSON.stringify(actualRoots) !== JSON.stringify(expectedRoots)))
      || (newMode && Object.keys(expected).some((key) => (
        key === 'writableRoots'
          ? JSON.stringify(actualRoots) !== JSON.stringify(expectedRoots)
          : JSON.stringify(actual?.[key]) !== JSON.stringify(expected[key])
      )));

    if (mismatch) {
      throw new ExecutorRuntimeError('mode_unavailable',
        'Codex не принял политику, reviewer или sandbox выбранного режима.');
    }
  }

  const rateLimitSnapshots = new Map<string, CodexBucket>();
  const pending = new Map<number, {
    method: string;
    owner: CodexTurn | null;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  let nextRequestId = 0;
  let threadId: string | null = sessionId || null;
  // Накопитель вывода потока, каким его видел последний замер. Его прирост за ход и есть
  // расход этого хода; сам накопитель живёт дольше хода, поэтому хранится в сессии.
  // null — замеров ещё не было: у возобновлённого thread `total` уже несёт всю его
  // историю, и ноль вместо неё выдал бы историю за расход первого хода.
  let threadOutputTokens: number | null = null;
  let actualModel = '';
  let confirmedSessionModel = '';
  let stderrTail = '';
  let protocol = 'pending';
  let exited = false;
  let exitReason = '';
  let turn: CodexTurn | null = null;
  let turnsStarted = 0;
  const elicitationControllers = new Map<string, {
    controller: AbortController;
    current: CodexTurn;
    threadId: string | null;
  }>();

  function rememberTail(current: string, chunk: unknown, limit = 4_000) {
    return `${current}${String(chunk || '')}`.slice(-limit);
  }

  const commandHook = workspaceAccess ? null : directCommandHook({
    blockDirectSsh: providerSettings?.blockDirectSsh !== false,
    blockDirectDb: providerSettings?.blockDirectDb === true,
    strictUnknownDbClient: providerSettings?.strictUnknownDbClient === true,
  });
  const processArgs = codexProcessArgs(workspaceAccess
    ? {
      blockDirectSsh: false,
      blockDirectDb: false,
      strictUnknownDbClient: false,
    }
    : providerSettings, nativeSettings);

  if (workspaceProfile) {
    processArgs.splice(processArgs.length - 1, 0, ...settingsTomlArgs({
      default_permissions: workspaceProfileId,
      permissions: { [workspaceProfileId]: workspaceProfile },
      mcp_servers: {},
      notify: [],
      features: {
        hooks: false,
        apps: false,
        plugins: false,
        remote_plugin: false,
      },
    }));
  }

  const child = spawn(config.codexBin, processArgs, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });

  function send(payload: unknown) {
    if (exited || child.stdin?.destroyed) throw new Error('Codex app-server stdin уже закрыт');
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  const interactions = createCodexInteractionWaiters({
    send(id, result) {
      if (!exited) {
        send({ id, result });
      }
    },
  });

  const asyncQuestions = createCodexInteractionWaiters({
    send(_id, result) {
      if (result) {
        void deliverAsyncQuestionAnswer(result as CodexAsyncQuestionAnswer);
      }
    },
  });

  function request(method: string, params?: unknown, owner: CodexTurn | null = null) {
    return new Promise<unknown>((requestResolve, requestReject) => {
      const id = ++nextRequestId;
      pending.set(id, {
        method,
        owner,
        resolve: requestResolve,
        reject: requestReject,
      });
      try {
        send({ method, id, ...(params !== undefined && { params }) });
      } catch (error) {
        pending.delete(id);
        requestReject(error);
      }
    });
  }

  function rejectPending(error: unknown) {
    const calls = [...pending.values()];
    pending.clear();
    for (const call of calls) call.reject(error);
  }

  /** Состояние ОДНОГО хода: лента, счётчики и итог принадлежат ходу, не сессии. */
  /**
   * Состояние одного хода вместе с каналом уточнений: лента, счётчики, ожидание порта и
   * видимые блоки ответа принадлежат ходу, а не сессии.
   */
  function createTurn({
    message, onStep, onProgress, onPermission,
    onInTurnReady, onInTurnAvailability, onInTurnReceipt, onAssistantMessage, onRunMetadata,
  }: {
    message?: unknown;
    onStep?: (step: ChatStep) => void;
    onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
    onPermission?: (ask: Record<string, unknown>) => unknown;
    onInTurnReady?: (port: InTurnPort) => void;
    onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
    onInTurnReceipt?: (event: InTurnReceiptEvent) => void | Promise<void>;
    onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  }): CodexTurn {
    const stepSink = createStepSink(onStep);
    const toolImages = createCodexToolImages(config.artifactsDir);

    return {
      message,
      stepSink,
      toolImages,
      normalizeStep: createCodexStepNormalizer({
        model,
        cwd,
        toolImagePath: toolImages.pathFor,
      }),
      onProgress,
      onRunMetadata,
      onPermission,
      messageDeltas: new Map(),
      reply: '',
      replyMessageId: '',
      lastCommentary: '',
      lastCommentaryId: '',
      appContext: null,
      progressTokens: 0,
      baseOutputTokens: threadOutputTokens,
      totalInputTokens: 0,
      cachedInputTokens: 0,
      turnId: null,
      lastError: null,
      madeProgress: false,
      workCalls: new Map(),
      ...(onInTurnReady ? { onInTurnReady } : {}),
      ...(onInTurnAvailability ? { onInTurnAvailability } : {}),
      ...(onInTurnReceipt ? { onInTurnReceipt } : {}),
      ...(onAssistantMessage ? { onAssistantMessage } : {}),
      inTurnAnnounced: false,
      assistantRevision: 0,
      settled: false,
      abortRequested: false,
      interruptSent: false,
      interruptTimer: null,
      // Заглушки: настоящие resolve/reject ставит тот же синхронный участок, что
      // создаёт ход, — до первого await они уже на месте.
      resolve: () => {},
      reject: () => {},
    };
  }

  /**
   * Ход перестал быть активным: снимаем таймер прерывания, закрываем ожидающие спросы и
   * объявляем канал уточнений закрытым, чтобы поздний текст не прилип к следующему ходу.
   */
  function closeTurn(current: CodexTurn) {
    interactions.cancel(current);
    asyncQuestions.cancel(current);
    clearTimeout(current.interruptTimer ?? undefined);
    abandonMessages(current);
    // Ход закрыт — канал уточнений больше не принимает: позднее сообщение не должно
    // выглядеть как часть следующего хода.
    current.onInTurnAvailability?.({ available: false, reason: 'not_ready' });
    for (const [requestId, pendingElicitation] of elicitationControllers) {
      if (pendingElicitation.current !== current) continue;
      elicitationControllers.delete(requestId);
      pendingElicitation.controller.abort();
    }
    if (turn === current) turn = null;
  }

  function finishTurnError(current: CodexTurn | null, error: unknown) {
    if (!current || current.settled) return;
    current.settled = true;
    closeTurn(current);
    current.reject(error);
  }

  function finishTurnStopped(current: CodexTurn | null) {
    if (!current || current.settled) return;
    const error = codexStoppedError({ sessionId: threadId, steps: current.stepSink.steps });

    finishTurnError(current, Object.assign(error, current.appContext || {}));
  }

  /**
   * Общие поля итога хода: контекст, кэш и модель одинаковы у успеха и у сбоя —
   * иначе окно после сбоя теряло бы замер контекста и имя фактической модели.
   */
  async function turnOutcomePayload(current: CodexTurn) {
    let context = current.appContext;
    if (!context) {
      try { context = await tokenInfoReader(threadId, { env }); } catch { /* точная метрика необязательна */ }
    }

    return {
      sessionId: threadId,
      cost: null,
      contextTokens: context?.contextTokens ?? 0,
      contextWindow: context?.contextWindow ?? 0,
      contextMetric: context?.contextMetric || 'unavailable',
      contextIsEstimate: context ? context.contextIsEstimate === true : true,
      contextCache: context?.contextCache || contextCacheStatus('unavailable'),
      totalInputTokens: context?.totalInputTokens ?? current.totalInputTokens,
      cachedInputTokens: context?.cachedInputTokens ?? current.cachedInputTokens,
      actualModel,
      steps: current.stepSink.steps,
    };
  }

  /**
   * Ход закрыт ОКОНЧАТЕЛЬНЫМ сбоем, но разговор цел: результат отдаёт сигнал сбоя и
   * явное подтверждение Р2. Это отдельный путь от finishTurnError — тот бросает
   * исключение и разрешения продолжать не даёт по определению.
   */
  async function finishTurnFailed(current: CodexTurn | null, source: unknown) {
    if (!current || current.settled) {
      return;
    }

    const signal = codexTurnFailure(source || 'ход завершился ошибкой');

    current.settled = true;
    closeTurn(current);

    current.resolve({
      ...(await turnOutcomePayload(current)),
      reply: signal.message,
      deliveryFailure: true,
      turnFailure: signal,
      turnRecovery: {
        canContinue: Boolean(threadId && current.turnId),
        madeProgress: current.madeProgress === true,
      },
    });
  }

  async function finishTurnSuccess(current: CodexTurn | null) {
    if (!current || current.settled) return;
    // Ход, завершившийся без `final_answer`, всё равно нёс работу: его итог остался
    // в последнем commentary. Финал прикрепляется к уже показанному блоку, а отказ
    // «codex не вернул ответ» на нормально закрытом turn читается как поломка.
    if (!current.reply.trim() && current.lastCommentary.trim()) {
      current.reply = current.lastCommentary;
      current.replyMessageId = current.lastCommentaryId;
    }
    if (!current.reply.trim()) {
      finishTurnError(current, new Error('codex не вернул ответ'));
      return;
    }
    current.settled = true;
    closeTurn(current);

    current.resolve({
      ...(await turnOutcomePayload(current)),
      reply: current.reply,
      ...(current.replyMessageId ? { assistantMessageId: current.replyMessageId } : {}),
    });
  }

  function rememberUsage(current: CodexTurn, params: CodexNotificationParams) {
    const usage = params?.tokenUsage as {
      last?: Record<string, unknown>;
      total?: Record<string, unknown>;
      modelContextWindow?: unknown;
    } | null;
    const last = usage?.last;
    const total = usage?.total;
    if (!last || !total || !usage) return;
    const contextTokens = tokenNumber(last.inputTokens);
    const contextWindow = tokenNumber(usage.modelContextWindow, { positive: true });
    const cachedRequestTokens = tokenNumber(last.cachedInputTokens);
    current.totalInputTokens = tokenNumber(total.inputTokens) || 0;
    current.cachedInputTokens = tokenNumber(total.cachedInputTokens) || 0;
    // Расход хода — прирост накопителя потока. `total` копится по всему thread и не
    // сбрасывается на новом обращении, поэтому цифра растёт до конца хода; `last` —
    // замер одного запроса, и по нему счётчик хода «врал и прыгал».
    const totalOutput = codexOutputTokens(total);
    if (totalOutput !== null) {
      // Первый замер сессии: всё, что накопитель несёт сверх текущего запроса, — история
      // thread до этого хода (возобновление), а не его расход.
      if (current.baseOutputTokens === null) {
        current.baseOutputTokens = Math.max(0, totalOutput - (codexOutputTokens(last) ?? 0));
      }

      threadOutputTokens = totalOutput;
      current.progressTokens = Math.max(0, totalOutput - current.baseOutputTokens);
    } else {
      // Старый app-server без накопителя: честного расхода хода взять негде, остаётся
      // замер последнего запроса — он хотя бы не ноль.
      current.progressTokens = codexOutputTokens(last) ?? 0;
    }
    const available = contextTokens !== null && contextWindow !== null;

    current.appContext = {
      contextTokens: contextTokens ?? 0,
      contextWindow: contextWindow ?? 0,
      contextMetric: available ? CODEX_CONTEXT_METRIC : 'unavailable',
      contextIsEstimate: false,
      contextCache: !available || cachedRequestTokens === null
        ? contextCacheStatus('unavailable')
        : reportedContextCache({
          readTokens: cachedRequestTokens,
          uncachedTokens: (contextTokens ?? 0) - cachedRequestTokens,
        }),
      totalInputTokens: current.totalInputTokens,
      cachedInputTokens: current.cachedInputTokens,
    };

    try {
      current.onProgress?.(current.progressTokens, { ...current.appContext });
    } catch { /* прогресс не должен ронять ход */ }
  }

  /**
   * Дельта видимого сообщения: копим текст по id и отдаём его наружу как незавершённый
   * блок. Полный текст идёт в событие, а не дельта, — окно не собирает строку само.
   */
  function appendMessage(current: CodexTurn, params: CodexNotificationParams) {
    const id = String(params?.itemId || '');

    if (!id || typeof params?.delta !== 'string') return;

    const text = `${current.messageDeltas.get(id) || ''}${params.delta}`.slice(0, 100_000);

    current.messageDeltas.set(id, text);
    current.assistantRevision += 1;
    void current.onAssistantMessage?.({
      assistantMessageId: id,
      text,
      sourceRevision: current.assistantRevision,
      complete: false,
    });
  }

  /**
   * Начатые реплики больше не продолжатся: при обрыве потока app-server повторяет запрос
   * модели с нуля и ответ приходит под новым id, а закрытый ход не допишет ничего.
   * Окну отдаём последний текст с отметкой обрыва вместо вечного «Пишет…».
   */
  function abandonMessages(current: CodexTurn) {
    for (const [id, text] of current.messageDeltas) {
      current.assistantRevision += 1;
      void current.onAssistantMessage?.({
        assistantMessageId: id,
        text,
        sourceRevision: current.assistantRevision,
        complete: false,
        abandoned: true,
      });
    }

    current.messageDeltas.clear();
  }

  /**
   * Порт уточнений конкретного хода. `turn/steer` адресуется активному provider-ходу:
   * `expectedTurnId` защищает от доставки в следующий turn, а RPC-ответ даёт только
   * `forwarded` — «прочитано моделью» транспорт не подтверждает.
   */
  function inTurnPortFor(current: CodexTurn) {
    return {
      /**
       * Передача уточнения в активный ход. Проверка ожидаемого turn id — часть протокола:
       * без неё app-server принял бы текст в другой ход того же thread.
       */
      async deliver({ messageId, text, images = [] }: {
        messageId: string;
        text: string;
        images?: ReadonlyArray<{ path: string }>;
      }) {
        if (!threadId || !current.turnId || current.settled) {
          return {
            ok: false,
            code: 'turn_changed',
            message: 'Активный ход уже завершился.',
          };
        }

        try {
          await request('turn/steer', {
            threadId,
            expectedTurnId: current.turnId,
            clientUserMessageId: messageId,
            input: [
              {
                type: 'text',
                text,
                text_elements: [],
              },
              // Картинка идёт в модель самим app-server: он читает файл по пути и сам
              // приводит размер, поэтому крупный скриншот не упирается в предел строки.
              ...images.map((image) => ({
                type: 'localImage',
                path: image.path,
              })),
              // Живой turn/steer трактует голый вопрос как новую цель и может
              // завершить ход, бросив исходную работу. Подсказка принадлежит
              // адаптеру; человек отправляет только свой вопрос.
              {
                type: 'text',
                text: 'Ответь на уточнение отдельным сообщением до итогового ответа. '
                  + 'После ответа самостоятельно вернись к ранее поставленной задаче и закончи её.',
                text_elements: [],
              },
            ],
          }, current);

          return { ok: true, state: 'forwarded' };
        } catch (error) {
          const code = (error as { code?: unknown })?.code;

          // Отказ JSON-RPC детерминирован; обрыв транспорта — неопределённый исход,
          // повторять его автоматически нельзя.
          if (code !== undefined) {
            return {
              ok: false,
              code: String(code),
              message: (error as Error).message,
            };
          }

          return {
            ok: false,
            code: 'transport_lost',
            message: (error as Error).message,
            uncertain: true,
          };
        }
      },
      close() {},
    } satisfies InTurnPort;
  }

  /**
   * Ответ async-карточки адресуется только её исходному живому ходу через штатный steer.
   * Отказ доставки виден в ленте; автоматический повтор мог бы задвоить пользовательское решение.
   */
  async function deliverAsyncQuestionAnswer({ current, text }: CodexAsyncQuestionAnswer) {
    if (turn !== current || current.settled || current.abortRequested || exited) {
      return;
    }

    const result = await inTurnPortFor(current).deliver({ messageId: randomUUID(), text });

    if (!result.ok && turn === current && !current.settled && !current.abortRequested) {
      current.stepSink.emit({
        k: 'note',
        level: 'warn',
        text: `Не удалось передать ответ на вопрос Codex: ${result.message}`,
      });
    }
  }

  /**
   * Для async-сообщения нет server request: карточка ждёт человека независимо от модели.
   * Отдельный набор waiter исключает смешение item ID с native request ID и снимается вместе с ходом.
   */
  function askAsyncQuestion(current: CodexTurn, item: NonNullable<CodexNotificationParams['item']>) {
    const presentation = codexAsyncQuestionPresentation(item);

    if (!presentation || typeof item.id !== 'string' || !item.id || !current.turnId
      || current.settled || current.abortRequested) {
      return;
    }

    asyncQuestions.ask(item.id, current, presentation, current.onPermission, (decision) => {
      const text = codexAsyncQuestionResponse(presentation, decision);

      return text ? { current, text } : null;
    }, null);
  }

  /**
   * Готовность канала объявляется ровно один раз — когда провайдер назвал id активного
   * хода. До этого сообщение некуда адресовать, и окно честно видит `not_ready`.
   */
  function announceInTurn(current: CodexTurn) {
    if (!current.turnId || current.inTurnAnnounced) {
      return;
    }

    current.inTurnAnnounced = true;
    current.onInTurnAvailability?.({ available: true });
    current.onInTurnReady?.(inTurnPortFor(current));
  }

  function maybeInterrupt(current: CodexTurn | null) {
    if (!current || !current.abortRequested || current.interruptSent || current.settled) return;
    if (protocol === 'legacy') {
      finishTurnStopped(current);
      return;
    }
    if (!threadId || !current.turnId) return;
    current.interruptSent = true;
    clearTimeout(current.interruptTimer ?? undefined);
    current.interruptTimer = setTimeout(() => finishTurnStopped(current), 3_000);
    request('turn/interrupt', { threadId, turnId: current.turnId })
      .catch(() => finishTurnStopped(current));
  }

  function appNotificationThreadId(params: CodexNotificationParams) {
    return String(params.threadId || params.thread_id || params.thread?.id || '');
  }

  function appNotificationTurnId(params: CodexNotificationParams) {
    return String(params.turnId || params.turn_id || params.turn?.id || '');
  }

  function rpcRequestKey(value: unknown) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const text = String(value);

    return text ? `${typeof value}:${text}` : '';
  }

  /**
   * Работала ли модель в этом уведомлении. Учитываются только настоящие признаки:
   * непустая дельта ответа или резюме рассуждений, шаг инструмента и его результат.
   * Уведомления о повторе, старте хода, расходе токенов и пустые блоки работой не
   * являются — иначе сбой сам себе подтверждал бы продвижение.
   */
  function makesProgress(method: string, params: CodexNotificationParams, steps: ChatStep[]) {
    if (method === 'item/agentMessage/delta') {
      return Boolean(String(params.delta || '').trim());
    }

    if (method === 'item/reasoning/summaryTextDelta') {
      return Boolean(String(params.delta || '').trim());
    }

    if (steps.some((step) => step.k === 'tool' || step.k === 'res')) {
      return true;
    }

    // Завершённое сообщение и резюме рассуждений приходят шагом text/think: пустые
    // блоки нормализатор отбрасывает, поэтому сам шаг уже означает сказанное слово.
    return method === 'item/completed'
      && steps.some((step) => step.k === 'text' || step.k === 'think');
  }

  /**
   * Один app-server мультиплексирует уведомления родителя и его субагентов. Чужой
   * `turn/completed` нельзя принимать за завершение текущего хода, а чужие items —
   * добавлять в его ленту. Пустые id оставляем совместимыми со старыми уведомлениями:
   * отбрасываем событие только когда сервер явно назвал другой thread или turn.
   */
  function ownsAppNotification(params: CodexNotificationParams, current: CodexTurn | null) {
    const eventThreadId = appNotificationThreadId(params);
    if (eventThreadId && threadId && eventThreadId !== threadId) return false;

    const eventTurnId = appNotificationTurnId(params);
    // До ответа `turn/start` у хода ещё нет авторитетного id. Уведомление в этот
    // момент не может доказать владение: app-server тем же потоком шлёт субагентов.
    if (eventTurnId && current && !current.turnId) return false;
    if (eventTurnId && current?.turnId && eventTurnId !== current.turnId) return false;
    return true;
  }

  function consumeAppNotification(event: CodexRpcMessage) {
    const method = String(event.method || '');
    const params = (event.params && typeof event.params === 'object'
      ? event.params
      : {}) as CodexNotificationParams;
    const current = turn;

    if (method === 'serverRequest/resolved') {
      const requestKey = rpcRequestKey(params.requestId);
      const pendingElicitation = elicitationControllers.get(requestKey);
      const resolvedThreadId = typeof params.threadId === 'string' ? params.threadId : '';
      if (pendingElicitation
        && resolvedThreadId
        && resolvedThreadId === threadId
        && resolvedThreadId === pendingElicitation.threadId) {
        elicitationControllers.delete(requestKey);
        pendingElicitation.controller.abort();
      }
      return;
    }

    if (!ownsAppNotification(params, current)) return;

    if (method === 'account/rateLimits/updated') {
      const snapshot = params.rateLimits as CodexBucket | null;

      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        const id = String(snapshot.limitId || 'codex');
        const merged = mergeCodexRateLimitSnapshot(rateLimitSnapshots.get(id), snapshot);
        const bars = parseCodexRateLimits({ rateLimits: merged });

        rateLimitSnapshots.set(id, merged);

        if (bars.length) {
          try {
            hooks.onProviderUsage?.({ bars });
          } catch {
            log?.warn?.({}, 'чат: квоты Codex не приняты обработчиком');
          }
        }
      }

      return;
    }

    if (method === 'thread/started') {
      threadId = params.thread?.id || threadId;
      // Уведомление может опередить ответ handshake. Старт ленты публикует send()
      // после onSessionCreated: иначе интерфейс уже видит ход без привязки сессии.
      return;
    }

    if (!current) {
      // Событие вне хода: у Codex это служебные уведомления открытой сессии.
      // Ходов «сам заговорил» он не выдаёт (session.unsolicited = false).
      return;
    }

    const normalized = current.normalizeStep(event);

    // Признак работы фиксируется на ТЕКУЩЕМ событии до попадания в ограниченный sink:
    // вытесненный из хвоста инструмент работу не отменяет.
    if (makesProgress(method, params, normalized)) {
      current.madeProgress = true;
    }

    current.stepSink.emitAll(normalized);

    if (method === 'turn/started') {
      current.turnId = params.turn?.id || current.turnId;
      announceInTurn(current);
      maybeInterrupt(current);
    } else if (method === 'item/agentMessage/delta') {
      appendMessage(current, params);
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      const item = params.item;
      const id = String(item.id || '');
      const text = String(item.text || current.messageDeltas.get(id) || '');
      current.messageDeltas.delete(id);

      if (item.delivery === 'async') {
        current.madeProgress ||= Boolean(text.trim());

        if (appNotificationThreadId(params) === threadId
          && appNotificationTurnId(params) === current.turnId) {
          askAsyncQuestion(current, item);
        }
      }

      if (!text.trim()) {
        return;
      }

      // Commentary уже ушёл отдельным text-шагом. Ответом считается явный final
      // либо legacy-модель без phase. Async-вопрос не становится итогом или fallback commentary.
      if (item.delivery !== 'async' && (item.phase === 'final_answer' || item.phase == null)) {
        current.reply = text;
        current.replyMessageId = id;
      } else if (item.delivery !== 'async') {
        current.lastCommentary = text;
        current.lastCommentaryId = id;
      }
      // Итог тоже был виден черновиком по дельтам: без завершения он висел бы «Пишет…»
      // до конца хода, а финал не нашёл бы свой блок.
      current.assistantRevision += 1;
      void current.onAssistantMessage?.({
        assistantMessageId: id,
        text,
        sourceRevision: current.assistantRevision,
        complete: true,
      });
    } else if (method === 'error') {
      // Ошибка потока: при повторе ответ модели начнётся заново, без повтора ход упадёт.
      abandonMessages(current);

      // Запасной причиной годится только ОКОНЧАТЕЛЬНОЕ уведомление: willRetry true
      // означает, что Codex сам повторит запрос, и финальность ещё не наступила.
      if (params.willRetry === false) {
        current.lastError = params.error || null;
      }
    } else if (method === 'thread/tokenUsage/updated') {
      rememberUsage(current, params);
    } else if (method === 'turn/completed') {
      const status = String(params.turn?.status || 'completed');
      current.turnId = params.turn?.id || current.turnId;
      if (current.progressTokens > 0) {
        try { current.onProgress?.(current.progressTokens); } catch { /* счётчик не должен ронять ход */ }
      }
      if (current.abortRequested || status === 'interrupted') {
        finishTurnStopped(current);
      } else if (status === 'failed') {
        // Причина берётся из самого хода; пустой turn.error заменяется последним
        // ОКОНЧАТЕЛЬНЫМ уведомлением error — промежуточное финальности не доказывает.
        void finishTurnFailed(current, params.turn?.error || current.lastError);
      } else {
        void finishTurnSuccess(current);
      }
    }
  }

  function consumeLegacyEvent(event: CodexLegacyEvent) {
    protocol = 'legacy';
    if (event.type === 'thread.started') {
      threadId = String(event.thread_id || event.thread?.id || threadId || '') || null;
    }
    if (typeof event.model === 'string' && event.model) actualModel = event.model;
    if (typeof event.item?.model === 'string' && event.item.model) actualModel = event.item.model;
    const current = turn;
    if (!current) return;
    current.stepSink.emitAll(current.normalizeStep(event));
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      const text = event.item.text || event.item.content;
      if (typeof text === 'string' && text.trim()) current.reply = text;
    }
    if (event.type === 'turn.completed' && event.usage) {
      current.totalInputTokens = codexTotalInputTokens(event.usage);
      current.cachedInputTokens = tokenNumber(event.usage.cached_input_tokens) || 0;
      // У legacy-протокола usage относится к самому ходу: рассуждения уже входят в
      // output_tokens, отдельным слагаемым они удваивали бы расход.
      const spent = tokenNumber((event.usage as { output_tokens?: unknown }).output_tokens) ?? 0;
      current.progressTokens = spent;
      if (spent > 0) {
        try { current.onProgress?.(spent); } catch { /* счётчик не должен ронять ход */ }
      }
    }
  }

  /**
   * MCP elicitation — не permission Codex и не dynamic tool: downstream-сервер
   * просит хост показать человеку форму или внешнюю страницу. Любой сбой UI
   * превращаем в cancel, чтобы не ронять весь ход неизвестным server request.
   */
  function consumeElicitationRequest(messageObject: CodexRpcMessage) {
    const current = turn;
    const params = messageObject.params as {
      threadId?: unknown;
      turnId?: unknown;
      serverName?: unknown;
    } | null;
    const requestKey = rpcRequestKey(messageObject.id);
    const validParams = params !== null
      && typeof params === 'object'
      && !Array.isArray(params)
      && typeof params.threadId === 'string'
      && !!params.threadId
      && Object.hasOwn(params, 'turnId')
      && (params.turnId === null || (typeof params.turnId === 'string' && !!params.turnId));
    const validTurnId = params?.turnId === null
      || (typeof params?.turnId === 'string' && params.turnId === current?.turnId);
    const owned = !!current
      && !current.settled
      && !!threadId
      && validParams
      && params?.threadId === threadId
      && validTurnId
      && requestKey
      && !elicitationControllers.has(requestKey);
    if (!owned) {
      const duplicate = requestKey && elicitationControllers.has(requestKey);
      if (requestKey && validParams && !duplicate) {
        send({
          id: messageObject.id,
          result: { action: 'cancel', content: null, _meta: null },
        });
      } else {
        send({
          id: messageObject.id,
          error: { code: -32602, message: 'Некорректный запрос MCP elicitation' },
        });
      }
      return;
    }

    const presentation = codexElicitationPresentation(params as Record<string, unknown>);
    if (!presentation || typeof current?.onPermission !== 'function') {
      send({
        id: messageObject.id,
        result: { action: 'cancel', content: null, _meta: null },
      });
      return;
    }

    const controller = new AbortController();
    const pendingElicitation = { controller, current, threadId };
    elicitationControllers.set(requestKey, pendingElicitation);
    Promise.resolve(current.onPermission({
      ...presentation,
      signal: controller.signal,
    })).then(
      (decision) => {
        if (controller.signal.aborted || exited) return;
        send({
          id: messageObject.id,
          result: codexElicitationResponse(presentation, decision as Record<string, unknown>),
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted || exited) return;
        log?.warn?.(
          { err: String((error as Error)?.message || error), server: params?.serverName },
          'Codex: диалог MCP завершился ошибкой',
        );
        send({
          id: messageObject.id,
          result: { action: 'cancel', content: null, _meta: null },
        });
      },
    ).catch(() => {
      // Ошибка записи в уже закрытый app-server не должна стать unhandled rejection.
    }).finally(() => {
      if (elicitationControllers.get(requestKey) === pendingElicitation) {
        elicitationControllers.delete(requestKey);
      }
    });
  }

  /**
   * Ответ `turn/start` и следующий server request могут лежать в одном stdout chunk.
   * Promise continuation выполнится позднее, поэтому фиксируем id синхронно прямо в
   * JSONL-dispatcher: рабочий вызов уже сможет доказать принадлежность текущему ходу.
   */
  function rememberRpcOwnership(call: {
    method: string;
    owner: CodexTurn | null;
  }, value: unknown) {
    const result = value as {
      thread?: { id?: unknown; sessionId?: unknown };
      turn?: { id?: unknown };
    } | null;
    if (call.method === 'thread/start' || call.method === 'thread/resume') {
      const openedThreadId = result?.thread?.id || result?.thread?.sessionId;
      if (typeof openedThreadId === 'string' && openedThreadId) threadId = openedThreadId;
    }
    if (call.method !== 'turn/start' || !call.owner || call.owner !== turn || call.owner.settled) return;
    const openedTurnId = result?.turn?.id;
    if (typeof openedTurnId !== 'string' || !openedTurnId) return;
    call.owner.turnId = openedTurnId;
    maybeInterrupt(call.owner);
  }

  function invalidWorkCall(messageObject: CodexRpcMessage, reason: string) {
    send({
      id: messageObject.id,
      error: { code: -32602, message: 'Некорректный вызов рабочего инструмента' },
    });
    log?.warn?.({ reason }, 'Codex: отклонён некорректный рабочий вызов');
  }

  /**
   * Dynamic tool выполняется максимум один раз на callId внутри одного хода.
   * До ответа Codex сохраняем миниатюру, чтобы completed мог передать её путь в ленту.
   */
  function consumeWorkToolRequest(messageObject: CodexRpcMessage) {
    const params = messageObject.params as {
      tool?: string;
      callId?: unknown;
      threadId?: unknown;
      turnId?: unknown;
      arguments?: unknown;
    } | null;
    const current = turn;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      invalidWorkCall(messageObject, 'invalid_params');
      return;
    }
    const descriptor = (workTools?.descriptors || []).find((item) => item.name === params.tool);
    const callId = typeof params.callId === 'string' ? params.callId : '';
    let reason = '';
    if (!descriptor) reason = 'unknown_tool';
    else if (!current || current.settled) reason = 'no_active_turn';
    else if (params.threadId !== threadId) reason = 'foreign_thread';
    else if (!current.turnId || params.turnId !== current.turnId) reason = 'foreign_turn';
    else if (!callId) reason = 'invalid_call_id';
    if (reason || !current) {
      invalidWorkCall(messageObject, reason || 'no_active_turn');
      return;
    }

    let input: unknown = params.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        invalidWorkCall(messageObject, 'invalid_arguments');
        return;
      }
    }
    const signature = JSON.stringify([params.tool, input ?? null]);
    const remembered = current.workCalls.get(callId);
    if (remembered) {
      if (remembered.signature !== signature) {
        invalidWorkCall(messageObject, 'call_id_conflict');
        return;
      }
      remembered.outcome.then((outcome) => {
        try { send({ id: messageObject.id, ...outcome }); } catch { /* процесс уже закрыт */ }
      });
      return;
    }

    const outcome: Promise<Record<string, unknown>> = Promise.resolve().then(
      () => workTools?.invoke(String(params.tool), input ?? {}),
    ).then(
      async (result) => {
        const response = codexDynamicToolResponse(result);
        const image = response.contentItems[0];

        if (response.success && image?.type === 'inputImage' && 'imageUrl' in image) {
          try {
            await current.toolImages.save(callId, image.imageUrl);
          } catch {
            log?.warn?.({}, 'Codex: не удалось сохранить миниатюру результата инструмента');
          }
        }

        return { result: response };
      },
      (error: unknown) => ({
        error: { code: -32603, message: String((error as Error)?.message || error) },
      }),
    );
    current.workCalls.set(callId, { signature, outcome });
    outcome.then((response) => {
      try { send({ id: messageObject.id, ...response }); } catch { /* процесс уже закрыт */ }
    });
  }

  function consumeMessage(messageObject: CodexRpcMessage | null) {
    if (messageObject?.id !== undefined && !messageObject?.method
      && (Object.hasOwn(messageObject, 'result') || Object.hasOwn(messageObject, 'error'))) {
      protocol = 'app-server';
      const call = pending.get(Number(messageObject.id));
      if (!call) return;
      pending.delete(Number(messageObject.id));
      if (messageObject.error) call.reject(codexRpcError(call.method, messageObject.error));
      else {
        rememberRpcOwnership(call, messageObject.result);
        call.resolve(messageObject.result);
      }
      return;
    }

    if (messageObject?.method) {
      protocol = 'app-server';

      if (messageObject.method === 'serverRequest/resolved') {
        const params = messageObject.params as { threadId?: unknown; requestId?: unknown } | null;

        if (params?.threadId === threadId) {
          interactions.resolved(params.requestId);
        }
      }
      if (messageObject.id !== undefined && messageObject.method === 'item/tool/requestUserInput') {
        const id = messageObject.id;
        const params = messageObject.params as {
          threadId?: unknown;
          turnId?: unknown;
          itemId?: unknown;
        } | null;

        if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id))) {
          send({ id, error: { code: -32602, message: 'Некорректный ID вопроса Codex' } });

          return;
        }

        const presentation = codexQuestionPresentation(params);
        const current = turn;

        if (!presentation || !current || current.settled || !current.turnId
          || params?.threadId !== threadId || params?.turnId !== current.turnId
          || typeof params?.itemId !== 'string' || !params.itemId) {
          interactions.replyOnce(id, { answers: {} }, current || undefined);

          return;
        }

        interactions.ask(id, current, presentation, current.onPermission,
          (decision) => codexQuestionResponse(presentation, decision), { answers: {} });

        return;
      }
      if (messageObject.id !== undefined
        && messageObject.method === 'mcpServer/elicitation/request') {
        consumeElicitationRequest(messageObject);
        return;
      }
      if (messageObject.id !== undefined && messageObject.method === 'item/tool/call') {
        consumeWorkToolRequest(messageObject);
        return;
      }
      // Native Auto-review решает разрешения внутри Codex. Ручной запрос здесь
      // неподдерживаем: отвечаем ошибкой и останавливаем собственный native ход.
      if (messageObject.id !== undefined) {
        try {
          send({
            id: messageObject.id,
            error: { code: -32601, message: `GrigDesk не поддерживает server request ${messageObject.method}` },
          });
        } catch { /* основной отказ ниже */ }

        const params = messageObject.params as { threadId?: unknown; turnId?: unknown } | null;
        const requestThreadId = params?.threadId;
        const requestTurnId = params?.turnId;
        const foreignThread = typeof requestThreadId === 'string' && requestThreadId
          && threadId && requestThreadId !== threadId;
        const foreignTurn = typeof requestTurnId === 'string' && requestTurnId
          && turn?.turnId && requestTurnId !== turn.turnId;

        if (foreignThread || foreignTurn) {
          return;
        }

        finishTurnError(turn, new Error(`Codex запросил неподдерживаемое действие: ${messageObject.method}`));
        void closeSession(true);
        return;
      }
      consumeAppNotification(messageObject);
      return;
    }

    if ((messageObject as CodexLegacyEvent | null)?.type) {
      consumeLegacyEvent(messageObject as CodexLegacyEvent);
    }
  }

  lines.on('line', (line: string) => {
    const text = String(line || '').trim();
    if (!text.startsWith('{')) return;
    let event: CodexRpcMessage;
    try { event = JSON.parse(text); } catch { return; }
    consumeMessage(event);
  });

  child.stderr?.on('data', (chunk: Buffer) => { stderrTail = rememberTail(stderrTail, chunk); });
  child.stdin?.on('error', (error: Error) => { finishTurnError(turn, error); });

  child.once('error', (error: NodeJS.ErrnoException) => {
    exited = true;
    exitReason = error?.code === 'ENOENT'
      ? 'GPT-исполнитель не установлен: npm i -g @openai/codex && codex login'
      : (stderrTail || error?.message || 'codex app-server не запустился').slice(-600);
    const failure = new Error(exitReason);
    rejectPending(failure);
    finishTurnError(turn, failure);
    hooks.onExit?.({ reason: exitReason });
  });

  child.once('close', (code: number | null) => {
    exited = true;
    const current = turn;
    if (current && !current.settled) {
      if (current.abortRequested) {
        finishTurnStopped(current);
      } else if (protocol === 'legacy' && current.reply) {
        void finishTurnSuccess(current);
      } else {
        const detail = stderrTail.trim().slice(-300);
        finishTurnError(current, new Error(
          `codex app-server завершился до ответа${detail ? `: ${detail}` : ` (код ${code ?? '?'})`}`,
        ));
      }
    }
    if (!exitReason) exitReason = `codex app-server завершился (код ${code ?? '?'})`;
    rejectPending(new Error(exitReason));
    hooks.onExit?.({ code, reason: exitReason });
  });

  const ready = (async () => {
    if (workspaceAccess) {
      const protocol = await codexWorkspaceProtocol(config.codexBin);

      if (!protocol) {
        throw new Error('Установленный Codex не поддерживает ограниченные readable roots.');
      }

      namedWorkspaceProfile = protocol === 'profile';
    }

    await request('initialize', {
      clientInfo: { name: 'grigdesk', title: 'GrigDesk', version: '0.1.0' },
      // `experimentalApi` открывает `runtimeWorkspaceRoots`: без него app-server
      // отвечает «requires experimentalApi capability», и рабочим корнем остаётся
      // один cwd (в схеме: «Omitted defaults to cwd»). `requestAttestation` —
      // строго false: он включает server request `attestation/generate`. Расширенную
      // MCP-форму объявляем только потому, что typed UI и fail-closed ответ реализованы.
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    send({ method: 'initialized' });
    if (commandHook) {
      assertDirectSshHook(await request('hooks/list', {}), commandHook);
    }

    if (nativeSettings?.accepted.length) {
      const read = await request('config/read', { cwd, includeLayers: false }) as { config?: unknown };
      const evidence = verifyNativeSettings(nativeSettings, nativeSettings.accepted.map((entry) => {
        let value: unknown = read.config;

        for (const segment of entry.path) {
          value = value && typeof value === 'object'
            ? (value as Record<string, unknown>)[segment]
            : undefined;
        }

        return {
          fieldId: entry.fieldId,
          basis: entry.value === null ? 'unavailable' as const : 'effective' as const,
          ...(value !== undefined ? { value: decodeSettingsJson(value) } : {}),
        };
      }));

      if (evidence.some((item) => item.result === 'overridden' || item.result === 'rejected')) {
        throw new Error('Codex не принял нативный слой конфигурации');
      }
    }

    const disabledMcp = workspaceAccess ? codexWorkspaceMcpOverrides(
      await request('config/read', { cwd, includeLayers: false }),
    ) : null;
    const dynamicTools = codexDynamicTools(workTools?.descriptors || []);
    const common = {
      ...(model && { model }),
      cwd,
      approvalPolicy,
      approvalsReviewer,
      ...(namedWorkspaceProfile ? { permissions: workspaceProfileId } : { sandbox: modeProfile.sandbox }),
      // Доверенные каталоги «Настройки → Исполнители» обязаны быть рабочими корнями,
      // а не только writable-песочницей: `codex exec --add-dir` давал агенту именно
      // рабочую область, и после переезда на app-server она сузилась до cwd.
      runtimeWorkspaceRoots: roots,
      config: {
        ...(nativeSettings?.payload as Record<string, unknown> ?? {}),
        ...codexAppServerConfig(compactWindow),
        ...(disabledMcp ? { mcp_servers: disabledMcp } : {}),
        ...(newMode && modeProfile.sandbox === 'workspace-write' ? {
          'sandbox_workspace_write.writable_roots': writableRoots,
          'sandbox_workspace_write.network_access': true,
          'sandbox_workspace_write.exclude_tmpdir_env_var': false,
          'sandbox_workspace_write.exclude_slash_tmp': false,
        } : {}),
      },
    };
    const opened = (threadId
      ? await request('thread/resume', { threadId, ...common })
      : await request('thread/start', {
        ...common,
        serviceName: 'grigdesk',
        ...(dynamicTools.length ? { dynamicTools } : {}),
      })) as {
        thread?: { id?: string; sessionId?: string };
        model?: unknown;
        approvalPolicy?: unknown;
        approvalsReviewer?: unknown;
        sandbox?: { type?: unknown };
      } | null;

    // Проверяем effective ответ до отправки turn: managed requirements или другая
    // версия CLI могут отклонить режим, и тихо продолжать с иной политикой нельзя.
    const mismatch = opened?.approvalPolicy !== approvalPolicy
      ? 'политику approvalPolicy'
      : opened?.approvalsReviewer !== approvalsReviewer
        ? 'reviewer approvalsReviewer'
        : opened?.sandbox?.type !== (modeProfile.sandbox === 'danger-full-access'
          ? 'dangerFullAccess' : 'workspaceWrite')
          ? 'sandbox workspaceWrite'
          : '';

    if (mismatch) {
      throw new Error(`Codex не принял ${mismatch}. Проверьте версию CLI и управляемую политику.`);
    }

    assertEffectiveProfile(opened);

    if (namedWorkspaceProfile && workspaceProfile) {
      assertCodexWorkspaceProfile(opened,
        await request('config/read', { cwd, includeLayers: false }), workspaceProfileId, workspaceProfile);
      assertCodexWorkspaceMcp(await request('mcpServerStatus/list', {
        threadId: opened?.thread?.id || opened?.thread?.sessionId,
      }));
    }

    threadId = opened?.thread?.id || opened?.thread?.sessionId || threadId;
    actualModel = String(opened?.model || model || '');
    confirmedSessionModel = typeof opened?.model === 'string' ? opened.model : '';
    return threadId;
  })();

  /**
   * Закрываем принадлежащий сессии процесс, сохраняя thread для следующего resume.
   * Неподдерживаемый запрос требует SIGKILL: native процесс может игнорировать TERM.
   */
  async function closeSession(force = false) {
    interactions.cancel();
    asyncQuestions.cancel();

    if (exited) return;
    try { lines.close(); } catch { /* уже закрыт */ }
    try { child.stdin?.end(); } catch { /* уже закрыт */ }

    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
      } else {
        child.once('close', () => resolve());
      }
    });

    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* уже завершён */ }

    const killTimer = setTimeout(() => child.kill('SIGKILL'), 750);

    exited = true;

    try {
      await closed;
    } finally {
      clearTimeout(killTimer);
    }
  }

  // Отказ handshake разбирает тот, кто делает первый ход: без этого он остался бы
  // необработанным rejection и уронил бы процесс сервера. Сам процесс после отказа
  // бесполезен, но жив: app-server переживает неудачный thread/resume (нет rollout по
  // такому id), и живая сессия в пуле повторяла бы тот же отказ каждым следующим ходом.
  // Гасим его сами — пул увидит мёртвый процесс и откроет новый.
  ready.catch((error: unknown) => {
    const detail = String((error as Error)?.message || error || 'handshake не удался');
    exitReason = exitReason || `Codex app-server не открыл thread: ${detail}`.slice(-600);
    void closeSession();
  });

  return {
    get pid() { return child.pid; },
    get sessionId() { return threadId; },
    get alive() { return !exited; },
    get busy() { return !!turn; },

    /**
     * Заказанный ход: пишем turn/start и ждём его завершения, а параллельно отдаём наружу
     * порт уточнений — с этого момента в активный ход можно передать текст.
     */
    async send({
      message, onStep, onProgress, onPermission, onSessionCreated,
      onInTurnReady, onInTurnAvailability, onInTurnReceipt, onAssistantMessage, onRunMetadata,
      preparedRuntime: turnRuntime, runtimeProfileFingerprint: turnFingerprint,
      permissionMode: turnMode, modeSelection: turnSelection,
    }: {
      message?: unknown;
      preparedRuntime?: PreparedExecutorRuntime;
      runtimeProfileFingerprint?: string;
      permissionMode?: string;
      modeSelection?: unknown;
      onStep?: (step: ChatStep) => void;
      onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
      onPermission?: (ask: Record<string, unknown>) => unknown;
      onSessionCreated?: (sessionId: string) => unknown;
      onInTurnReady?: (port: InTurnPort) => void;
      onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
      onInTurnReceipt?: (event: InTurnReceiptEvent) => void | Promise<void>;
      onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
    }) {
      if (exited) throw new Error(exitReason || 'Сессия Codex закрыта.');
      if (turn) throw new Error('В этой сессии уже идёт ход.');

      // Ход объявляется ДО ожидания handshake: «стоп» может прийти, пока app-server
      // ещё поднимается, и прерывать тогда будет нечего — запрос повис бы до таймаута.
      const current = createTurn({
        message,
        onStep,
        onProgress,
      onRunMetadata,
        onPermission,
        ...(onInTurnReady ? { onInTurnReady } : {}),
        ...(onInTurnAvailability ? { onInTurnAvailability } : {}),
        ...(onInTurnReceipt ? { onInTurnReceipt } : {}),
        ...(onAssistantMessage ? { onAssistantMessage } : {}),
      });
      turn = current;
      const result = new Promise<unknown>((resolve, reject) => {
        current.resolve = resolve;
        current.reject = reject;
      });
      // Стоп может отклонить ход РАНЬШЕ, чем этот промис вернётся вызывающему: пустой
      // catch помечает его обработанным, не мешая настоящему await получить ту же ошибку.
      result.catch(() => {});

      try {
        await ready;

        const freshRuntime = turnRuntime ?? (permissionMode && permissionMode !== 'auto'
          ? undefined : preparedRuntime);
        const freshInput = {
          ...runtimeInput,
          permissionMode: turnMode ?? permissionMode,
          modeSelection: turnSelection ?? modeSelection,
          runtimeProfileFingerprint: turnFingerprint ?? runtimeProfileFingerprint
        };

        if (freshInput.runtimeProfileFingerprint !== runtimeProfileFingerprint) {
          throw new Error('Профиль Codex изменился: требуется новая сессия.');
        }

        await assertCodexRuntime(freshRuntime, freshInput, true);

        if (newMode && turnsStarted > 0) {
          assertEffectiveProfile(await request('thread/resume', {
            threadId,
            cwd,
            approvalPolicy,
            approvalsReviewer,
            sandbox: modeProfile.sandbox,
            runtimeWorkspaceRoots: roots,
            ...(model ? { model } : {}),
            config: {
              'sandbox_workspace_write.writable_roots': writableRoots,
              'sandbox_workspace_write.network_access': true,
              'sandbox_workspace_write.exclude_tmpdir_env_var': false,
              'sandbox_workspace_write.exclude_slash_tmp': false,
            },
          }));
        }

        if (current.settled) return result;
        if (confirmedSessionModel) {
          onRunMetadata?.({ actualModelId: confirmedSessionModel, modelSource: 'session' });
        }
        // Id thread известен сразу после handshake: сообщаем его до turn/start, чтобы
        // перезапуск сервера посреди хода не оставил чат без сессии для resume.
        if (threadId && onSessionCreated) {
          try {
            await onSessionCreated(threadId);
          } catch (error) {
            log?.warn?.({ err: (error as Error)?.message }, 'чат: id сессии не принят вызывающим');
          }
        }
        current.stepSink.emitAll(current.normalizeStep({
          type: 'thread.started', thread_id: threadId, model: actualModel,
        }));

        const started = await request('turn/start', {
          threadId,
          input: [{ type: 'text', text: String(message || ''), text_elements: [] }],
          cwd,
          approvalPolicy,
          approvalsReviewer,
          ...(namedWorkspaceProfile ? { permissions: workspaceProfileId } : { sandboxPolicy }),
          ...(model && { model }),
          ...(effort && { effort }),
          summary: 'detailed',
        }, current) as { turn?: { id?: string } } | null;
        current.turnId = started?.turn?.id || current.turnId;
        turnsStarted += 1;
        announceInTurn(current);
        maybeInterrupt(current);
      } catch (error) {
        finishTurnError(current, error);
      }
      return result;
    },

    /**
     * «Стоп» сразу отменяет callbacks человека перед штатным turn/interrupt.
     * Thread остаётся живым, поздний ответ не разрешает работу остановленного хода.
     */
    async interrupt() {
      const current = turn;
      if (!current || current.settled) return;

      interactions.cancel(current);
      asyncQuestions.cancel(current);
      current.abortRequested = true;
      maybeInterrupt(current);
      if (!current.interruptTimer && protocol !== 'legacy') {
        // Если стоп пришёл до turn/started, даём app-server короткое окно сообщить id.
        current.interruptTimer = setTimeout(() => finishTurnStopped(current), 3_000);
      }
    },

    /**
     * Сужение ждёт штатной очистки подтверждённых native terminal sessions.
     * Неизвестный ответ или остаток работы не разрешают пулу открыть новый профиль.
     */
    async prepareTransition(next: { permissionMode?: unknown }) {
      if (!newMode && (!next.permissionMode || next.permissionMode === 'auto')) {
        return;
      }

      await ready;

      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExecutorRuntimeError('mode_unavailable',
          'Codex не подтвердил остановку прежних инструментов.')), 3000);
      });

      try {
        await Promise.race([request('thread/backgroundTerminals/clean', { threadId }), deadline]);

        const response = await Promise.race([
          request('thread/backgroundTerminals/list', { threadId }), deadline,
        ]) as { data?: unknown; nextCursor?: unknown } | null;

        if (!Array.isArray(response?.data) || response.data.length || response.nextCursor !== null) {
          throw new ExecutorRuntimeError('mode_unavailable',
            'Сначала завершите прежние фоновые инструменты Codex.');
        }
      } finally {
        clearTimeout(timer!);
      }
    },

    close: closeSession,
  };
}

/**
 * Разовый ход: та же сессия, поднятая ради одного хода и погашенная сразу после.
 * Остаётся для исполнителей и путей, где живая сессия не нужна или отключена.
 */
export async function runCodexAppServer({
  config, env, message, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
  providerSettings, nativeSettings, signal, onProgress, onStep, tokenInfoReader = readCodexThreadTokenInfo,
  workTools, workspaceAccess, onPermission, log, onSessionCreated,
  onInTurnReady, onInTurnAvailability, onInTurnReceipt, onAssistantMessage, onRunMetadata,
  onProviderUsage, permissionMode, modeSelection, preparedRuntime, runtimeProfileFingerprint,
}: {
  config: CodexConfig;
  env?: NodeJS.ProcessEnv;
  message?: unknown;
  cwd?: string;
  extraDirs?: readonly string[];
  model?: string;
  effort?: string;
  sessionId?: string | null;
  compactWindow?: unknown;
  providerSettings?: CodexSettings | null;
  nativeSettings?: PreparedNativeSettings;
  signal?: AbortSignal;
  onProviderUsage?: (patch: ProviderUsagePatch) => boolean;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
  onStep?: (step: ChatStep) => void;
  tokenInfoReader?: typeof readCodexThreadTokenInfo;
  workTools?: CodexWorkToolsPort | null;
  workspaceAccess?: CodexWorkspaceAccess | null;
  permissionMode?: string;
  modeSelection?: unknown;
  preparedRuntime?: PreparedExecutorRuntime;
  runtimeProfileFingerprint?: string;
  onPermission?: (ask: Record<string, unknown>) => unknown;
  log?: CodexLog;
  onSessionCreated?: (sessionId: string) => unknown;
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
  onInTurnReceipt?: (event: InTurnReceiptEvent) => void | Promise<void>;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
}) {
  if (signal?.aborted) throw codexStoppedError({ sessionId, steps: [] });

  const session = openCodexSession({
    config,
    env,
    cwd,
    extraDirs,
    model,
    effort,
    sessionId,
    compactWindow,
    providerSettings,
    nativeSettings,
    tokenInfoReader,
    workTools,
    workspaceAccess,
    permissionMode,
    modeSelection,
    preparedRuntime,
    runtimeProfileFingerprint,
    log,
    hooks: { onProviderUsage },
  });
  const onAbort = () => { void session.interrupt(); };

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await session.send({
      permissionMode,
      modeSelection,
      preparedRuntime,
      runtimeProfileFingerprint,
      message,
      onStep,
      onProgress,
      onRunMetadata,
      onPermission,
      onSessionCreated,
      ...(onInTurnReady ? { onInTurnReady } : {}),
      ...(onInTurnAvailability ? { onInTurnAvailability } : {}),
      ...(onInTurnReceipt ? { onInTurnReceipt } : {}),
      ...(onAssistantMessage ? { onAssistantMessage } : {}),
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await session.close();
  }
}

// TUI-команды Codex. `codex exec` слэш-текст отдаёт модели как обычный промпт, поэтому
// весь список информационный (run: 'none'): исполнить их можно только в интерактивном
// TUI самого CLI. Состав сверен contract gate с codex-cli 0.145.0;
// /undo, /quit, /exit в этой версии отсутствуют.
const CODEX_TUI_HINT = 'Исполняется только в TUI Codex';
const CODEX_TUI_COMMANDS = [
  { cmd: '/model', desc: 'Сменить модель и уровень рассуждений' },
  { cmd: '/approvals', desc: 'Режим согласования действий агента' },
  { cmd: '/status', desc: 'Состояние сессии и конфигурации' },
  { cmd: '/review', desc: 'Ревизия изменений рабочего дерева' },
  { cmd: '/diff', desc: 'Показать diff рабочего дерева' },
  { cmd: '/new', desc: 'Начать новую сессию' },
  { cmd: '/resume', desc: 'Возобновить сохранённую сессию' },
  { cmd: '/fork', desc: 'Ответвить текущую сессию' },
  { cmd: '/init', desc: 'Сгенерировать AGENTS.md' },
  { cmd: '/mcp', desc: 'Состояние MCP-серверов' },
  { cmd: '/skills', desc: 'Список доступных скиллов' },
  { cmd: '/goal', desc: 'Поставить автономную цель' },
  { cmd: '/feedback', desc: 'Отправить отзыв разработчикам' },
  { cmd: '/help', desc: 'Справка по командам' },
  { cmd: '/compact', desc: 'Сжать контекст разговора' },
].map((c) => ({ ...c, run: 'none', hint: CODEX_TUI_HINT }));

/**
 * `skills/list` — канонический источник навыков самого Codex. В глобальный
 * `/api/providers` берём только cwd-независимые области: repo-skill может быть
 * доступен свободному чату, но исчезнуть в task-chat с другим worktree.
 */
export function parseCodexSkillCommands(value: unknown) {
  const result = value as { data?: unknown } | null;
  const rows = (Array.isArray(result?.data) ? result.data : []) as Array<{ skills?: unknown }>;
  const skills = rows.flatMap((row) => (Array.isArray(row?.skills) ? row.skills : [])) as Array<{
    name?: unknown;
    enabled?: unknown;
    scope?: unknown;
    interface?: { shortDescription?: unknown };
    shortDescription?: unknown;
    description?: unknown;
  }>;
  const seen = new Set<string>();
  const commands: Array<{ cmd: string; desc: string; run: string }> = [];
  for (const skill of skills) {
    const name = String(skill?.name || '').trim();
    if (skill?.enabled !== true || skill?.scope === 'repo'
      || !['user', 'admin', 'system'].includes(String(skill?.scope))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
      || seen.has(name)) continue;
    seen.add(name);
    const description = skill?.interface?.shortDescription
      || skill?.shortDescription
      || skill?.description
      || 'Навык Codex';
    commands.push({
      cmd: `$${name}`,
      desc: String(description).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Навык Codex',
      run: 'prompt',
    });
  }
  return commands;
}

export async function readCodexSkillCommands(bin: string | undefined, cwd: string | undefined, {
  request = codexAppServerRequest,
}: { request?: typeof codexAppServerRequest } = {}) {
  if (!bin || !cwd) return [];
  const response = await request(bin, {
    method: 'skills/list',
    params: { cwds: [cwd], forceReload: true },
  }, { timeoutMs: 5_000 });
  if (response?.error) return [];
  return parseCodexSkillCommands(response?.result);
}

const CODEX_MCP_RUNTIME: Record<string, { state: string; detail: string }> = {
  connected: { state: 'ok', detail: '' },
  authenticationRequired: {
    state: 'needs-auth',
    detail: 'Codex ожидает авторизацию этого MCP-сервера.',
  },
  failed: { state: 'failed', detail: 'Codex не смог подключиться к MCP-серверу.' },
  cancelled: { state: 'failed', detail: 'Подключение MCP-сервера отменено.' },
  disabled: { state: 'disabled', detail: 'Сервер выключен в конфигурации Codex.' },
  starting: { state: 'unknown', detail: 'Codex ещё подключает этот сервер.' },
  notStarted: { state: 'configured', detail: '' },
};
const CODEX_MCP_GROUPS = [{
  id: 'user',
  label: 'Codex',
  hint: '«Подключён» — живой статус app-server; «Настроен» — только запись конфигурации.',
}];

function codexMcpAuthHint(name: string) {
  return `Нужен вход: \`codex mcp login ${name}\` в терминале.`;
}

/** URL в карточке не должен раскрывать credential из query, fragment или userinfo. */
function safeMcpUrl(value: unknown) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return text.replace(/[?#].*$/, '').slice(0, 240);
  }
}

/**
 * Args полезны для различения двух stdio-серверов, но в них часто кладут ключи.
 * Скрываем значение после credential-подобного флага и ограничиваем длину строки;
 * env и headers из JSON CLI сюда вообще не попадают.
 */
function safeMcpCommand(command: unknown, args: unknown) {
  const parts = [String(command || '').trim()].filter(Boolean);
  const secretFlag = /(?:api[-_]?key|token|secret|password|authorization|header|env)/i;
  let hideNext = false;

  for (const raw of Array.isArray(args) ? args.slice(0, 12) : []) {
    const arg = String(raw);
    if (hideNext) {
      parts.push('•••');
      hideNext = false;
      continue;
    }
    const equal = arg.indexOf('=');
    const key = equal >= 0 ? arg.slice(0, equal) : arg;
    if (secretFlag.test(key)) {
      parts.push(equal >= 0 ? `${key}=•••` : arg);
      hideNext = equal < 0;
      continue;
    }
    parts.push(arg);
  }

  const target = parts.join(' ');
  return `${target.slice(0, 240)}${target.length > 240 ? '…' : ''}`;
}

function codexMcpTarget(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const transport = value as { type?: unknown; command?: unknown; args?: unknown; url?: unknown };
  if (transport.type === 'stdio') return safeMcpCommand(transport.command, transport.args);
  return safeMcpUrl(transport.url);
}

/**
 * `codex mcp list --json` — inventory, а не health-check. Поэтому включённая
 * запись получает `configured`, а не зелёный `ok`; живость ниже добавляет app-server.
 */
export function parseCodexMcpInventory(value: unknown): CodexMcpServer[] {
  let rows: unknown = value;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { return []; }
  }
  if (!Array.isArray(rows)) return [];

  return (rows as Array<{
    name?: unknown;
    auth_status?: unknown;
    enabled?: unknown;
    disabled_reason?: unknown;
    transport?: unknown;
  }>).flatMap((row) => {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return [];
    const auth = String(row.auth_status || '');
    const disabled = row.enabled === false;
    const needsAuth = !disabled && /not.?logged.?in|needs?.?auth|unauthor/i.test(auth);
    const state = disabled ? 'disabled' : (needsAuth ? 'needs-auth' : 'configured');
    const disabledReason = typeof row.disabled_reason === 'string'
      ? row.disabled_reason.trim().slice(0, 300)
      : '';
    return [{
      name,
      target: codexMcpTarget(row.transport),
      scope: 'user',
      state,
      detail: disabled ? (disabledReason || 'Сервер выключен в конфигурации Codex.') : '',
      ...(needsAuth ? { hint: codexMcpAuthHint(name) } : {}),
    }];
  });
}

/**
 * `codex_apps` в live-ответе — собственный runtime плагинов Codex, а не сервер,
 * который человек прописал в конфиге. В панели он стоял бы наравне с настроенными
 * и вводил в заблуждение: чинить и настраивать в нём нечего.
 */
function isCodexInternalRuntime(live: { serverInfo?: { name?: unknown } } | undefined) {
  return live?.serverInfo?.name === 'plugin-runtime';
}

/**
 * `runtimeStatus` заполнен только у app-server, который уже вёл этот сервер в текущем
 * процессе; у разового опроса он всегда null, и судить по нему нельзя — иначе живой
 * ответ вырождается в пересказ конфига. Рукопожатие видно в самих данных: имя сервера
 * и таблицу инструментов присылает сам сервер, а у не поднявшегося они пустые.
 */
function codexMcpHandshake(
  live: { serverInfo?: { name?: unknown } } | undefined,
  base: { state: string; detail: string },
) {
  if (live?.serverInfo?.name) {
    return { state: 'ok', detail: '' };
  }

  // Выключенный в конфиге сервер не поднимается намеренно — это не отказ.
  if (base.state === 'disabled') {
    return { state: base.state, detail: base.detail };
  }

  return {
    state: 'failed',
    detail: 'Codex не получил от сервера ни имени, ни инструментов — агенту он ничего не даёт.',
  };
}

/**
 * Живой app-server-статус обогащает безопасный inventory и не протаскивает в API
 * таблицы tools/resources. Плагины могут быть только в live-ответе — их тоже оставляем.
 */
export function composeCodexMcpServers(
  value: unknown,
  inventory: readonly CodexMcpServer[] = [],
): CodexMcpServer[] {
  const result = value as { data?: unknown } | null;
  const liveRows = (Array.isArray(result?.data) ? result.data : []) as Array<{
    name?: unknown;
    runtimeStatus?: unknown;
    authStatus?: unknown;
    serverInfo?: { name?: unknown };
  }>;
  const liveByName = new Map<string, typeof liveRows[number]>();
  for (const row of liveRows) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (name && !liveByName.has(name)) liveByName.set(name, row);
  }

  const configured = Array.isArray(inventory) ? inventory : [];
  const configuredByName = new Map<string, CodexMcpServer>(
    configured.map((server) => [server.name, server]),
  );
  const names = [...configuredByName.keys()];
  for (const [name, live] of liveByName) {
    if (configuredByName.has(name) || isCodexInternalRuntime(live)) continue;
    names.push(name);
  }

  return names.map((name) => {
    const base = configuredByName.get(name) || {
      name, target: '', scope: 'user', state: 'configured', detail: '',
    };
    const live = liveByName.get(name);
    if (!live) return base;

    const runtime = CODEX_MCP_RUNTIME[String(live.runtimeStatus)]
      || (live.runtimeStatus == null
        ? codexMcpHandshake(live, base)
        : { state: 'unknown', detail: `Неизвестное состояние Codex: ${live.runtimeStatus}` });
    const needsAuth = live.authStatus === 'notLoggedIn'
      || runtime.state === 'needs-auth';
    const publicBase: CodexMcpServer = { ...base };
    delete publicBase.hint;
    return {
      ...publicBase,
      state: needsAuth ? 'needs-auth' : runtime.state,
      detail: needsAuth ? 'Codex ожидает авторизацию этого MCP-сервера.' : runtime.detail,
      ...(needsAuth ? { hint: codexMcpAuthHint(name) } : {}),
    };
  });
}

function readCodexMcpInventory(bin: string, cwd: string | undefined, {
  execFileImpl = execFile,
}: { execFileImpl?: typeof execFile } = {}): Promise<{
  ok: boolean;
  error?: string;
  servers: CodexMcpServer[];
}> {
  return new Promise((resolve) => {
    execFileImpl(bin, ['mcp', 'list', '--json'], {
      cwd,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          error: String(stderr || error.message || 'Codex MCP inventory недоступен')
            .trim().slice(-300),
          servers: [],
        });
        return;
      }
      let rows: unknown;
      try { rows = JSON.parse(String(stdout || '')); } catch {
        resolve({ ok: false, error: 'Codex вернул некорректный JSON списка MCP', servers: [] });
        return;
      }
      resolve({ ok: true, servers: parseCodexMcpInventory(rows) });
    });
  });
}

export default {
  defaultPermissionMode: 'auto',
  permissionModeSelectionPolicy: 'preserve-explicit',
  permissionModesRequiringExplicitSelection: ['bypassPermissions'],
  normalizePermissionMode: normalizeCodexPermissionMode,
  modes: availableCodexPermissionModes,
  prepareRuntime: prepareCodexPermissionRuntime,
  runtimeProfileFingerprint: codexRuntimeFingerprint,
  workToolPolicy(mode: string) {
    return mode === 'plan' ? Object.freeze({ revision: 1,
      allowedActions: Object.freeze({ supervised_ssh: Object.freeze(['list']),
        supervised_db: Object.freeze(['list', 'schema']) }) }) : undefined;
  },
  id: 'codex',
  // Виды сбоя хода объявляет сам адаптер: ядро не знает имён вендора. Общие признаки
  // (статусы, слова) добавляет реестр — здесь только коды CodexErrorInfo.
  turnFailureRules: CODEX_TURN_FAILURE_RULES,
  effortHints: {
    none: 'Без рассуждения: быстрые ответы на простые запросы.',
    minimal: 'Минимальное рассуждение: приоритет скорости.',
    low: 'Короткое рассуждение для простых задач; быстрее и экономнее.',
    medium: 'Баланс глубины, скорости и расхода для повседневной работы.',
    high: 'Глубокое рассуждение для сложного кода, отладки и планирования.',
    xhigh: 'Очень глубокое рассуждение для трудного ревью и исследований.',
    max: 'Максимальная глубина для самых трудных задач; выше расход, дольше ожидание.',
    ultra: 'Максимальное рассуждение с автоматическим делегированием субагентам.',
  },
  nativeSettings: codexNativeSettings,
  name: 'GPT (Codex)',
  vendor: 'OpenAI',
  color: '#10a37f',
  order: 2,
  untrustedInput: CODEX_UNTRUSTED_INPUT,
  runUntrusted: runCodexUntrusted,
  scopedWorkspace(config: CodexConfig) {
    return codexSupportsRestrictedWorkspace(config?.codexBin);
  },
  install: 'npm i -g @openai/codex && codex login',
  login: 'codex login',
  usagePresentation: { freshness: true, spentLabel: true },
  /**
   * Декларация npm-пакета позволяет найти повреждённую копию без запуска её entry.
   * Managed-провайдеры этого opt-in не имеют и в общий lifecycle не попадают.
   */
  externalCli() {
    return {
      packageId: '@openai/codex',
      binName: 'codex',
      configKey: 'codexBin',
      envKey: 'GRIGDESK_CODEX_BIN',
    };
  },
  /**
   * Доступный пользовательский npm устанавливает latest и при обновлении.
   * Без npm сохраняются прежние команды; вход запускается отдельным действием.
   */
  installation(config: CodexConfig, context?: ProviderInstallationContext) {
    const command = 'npm i -g @openai/codex';
    const npm = context?.npm ? npmInstallCommand('@openai/codex', context.npm, {
      binName: 'codex',
      configKey: 'codexBin',
      envKey: 'GRIGDESK_CODEX_BIN',
    }) : null;
    const install = npm || {
      executable: 'npm',
      args: ['i', '-g', '@openai/codex'],
      command,
      fallbackCommand: 'npm i -g @openai/codex && codex login',
    };

    return {
      install,
      update: npm || {
        executable: config.codexBin,
        args: ['update'],
        command: [config.codexBin, ...['update']].join(' '),
        fallbackCommand: [config.codexBin, ...['update']].join(' '),
      },
      loginCommand: 'codex login',
      loginArgs: ['login'],
    };
  },

  statusPage: 'https://status.openai.com',
  // Каждый путь из opts.extraDirs становится writableRoot sandboxPolicy хода.
  workdir: { switch: 'resume', roots: 'multi' },
  // Встроенная генерация картинок сохраняет файл в CODEX_HOME, а не в рабочей папке.
  imageRoots() {
    return [path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images')];
  },
  directSshPolicy: { enforcement: 'command-hook' },
  settings: [directSshSetting()],

  // Ручной компакт пока идёт универсальной выжимкой текстом. Автокомпакт родной:
  // thread config передаёт app-server-у официальный model_auto_compact_token_limit.
  compaction: { kind: 'summary' },
  chatAutoCompact: true,

  bin(config: CodexConfig) { return config.codexBin; },

  async commands(config: CodexConfig) {
    const skills = await readCodexSkillCommands(config?.codexBin, config?.rootDir);
    return [...CODEX_TUI_COMMANDS, ...skills];
  },

  /**
   * App-server отдаёт живое состояние effective MCP, а CLI JSON — транспорт и
   * совместимый fallback. Никакие env/headers из конфигурации наружу не выходят.
   */
  async mcpStatus(config: CodexConfig, deps: {
    request?: typeof codexAppServerRequest;
    inventory?: typeof readCodexMcpInventory;
  } = {}) {
    const request = deps.request || codexAppServerRequest;
    const inventoryReader = deps.inventory || readCodexMcpInventory;
    const [live, inventory] = await Promise.all([
      request(config.codexBin, {
        method: 'mcpServerStatus/list',
        params: { detail: 'toolsAndAuthOnly', limit: 100 },
      }, { timeoutMs: 60_000 }),
      inventoryReader(config.codexBin, config.rootDir),
    ]);

    if (!live?.error) {
      return {
        state: 'ok',
        groups: CODEX_MCP_GROUPS,
        servers: composeCodexMcpServers(live?.result, inventory?.servers),
        ...((live?.result as { nextCursor?: unknown } | null)?.nextCursor
          ? { note: 'Показаны первые 100 MCP-серверов Codex.' }
          : {}),
      };
    }
    if (inventory?.ok) {
      return {
        state: 'ok',
        note: 'Живая проверка Codex недоступна; показана сохранённая конфигурация.',
        groups: CODEX_MCP_GROUPS,
        servers: inventory.servers,
      };
    }
    return {
      state: 'error',
      error: String(live?.error?.message || inventory?.error || 'Codex MCP недоступен').slice(0, 300),
      servers: [] as CodexMcpServer[],
    };
  },

  probe(config: CodexConfig) {
    return new Promise<{ ok: boolean; version: string | null }>((resolve) => {
      execFile(config.codexBin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return resolve({ ok: false, version: null });
        resolve({ ok: true, version: (stdout || '').trim().slice(0, 60) || null });
      });
    });
  },

  /**
   * Авторизация — файл ~/.codex/auth.json (создаётся `codex login`).
   */
  async auth() {
    try {
      await fs.access(path.join(os.homedir(), '.codex', 'auth.json'));
      return { mode: 'cli', label: 'CLI хоста (codex login)', available: true };
    } catch {
      return { mode: 'none', label: 'не авторизован (codex login)', available: false };
    }
  },

  /**
   * Потребление лимитов ChatGPT/Codex через официальный read-only app-server API.
   * Вызов не запускает модель и не читает историю сессий.
   */
  async usage(config: CodexConfig) {
    return classifyCodexUsageResponse(await readCodexRateLimits(config.codexBin));
  },

  usageActions: {
    'consume-rate-limit-reset': ({ config, payload, requestId }: {
      config?: unknown;
      payload?: unknown;
      requestId?: unknown;
    }) => consumeCodexRateLimitReset(
      (config as CodexConfig).codexBin,
      { requestId, creditId: (payload as { creditId?: unknown } | null)?.creditId },
    ),
  },

  /**
   * Модели, доступные именно этому Codex-аккаунту. App-server сам учитывает версию
   * CLI, авторизацию, rollout и скрытые модели; API-ключ Platform не нужен.
   */
  catalog(config: CodexConfig) {
    return readCodexModelCatalog(config.codexBin);
  },
  catalogLive: true,

  /** Стабильное семейство для policy агентов и движка. */
  modelFamily(model: { family?: unknown; id?: unknown } | null | undefined) {
    return String(model?.family || codexModelFamily(model?.id)).trim();
  },

  /**
   * Обновление CLI (кнопка «Обновить» в настройках → «Исполнители»).
   * Само не запускается — только по нажатию пользователя.
   */
  updateCmd: ['update'],

  /**
   * Последняя опубликованная версия — для индикатора «доступно обновление».
   */
  latestVersion() {
    return npmLatest('@openai/codex');
  },

  seedModels() {
    return [
      {
        id: 'gpt-5.6-sol', family: 'sol', name: 'GPT-5.6-Sol', tier: 100, efforts: null,
        ...codexCatalogContext(null),
      },
      {
        id: 'gpt-5.6-terra', family: 'terra', name: 'GPT-5.6-Terra', tier: 90, efforts: null,
        ...codexCatalogContext(null),
      },
      {
        id: 'gpt-5.6-luna', family: 'luna', name: 'GPT-5.6-Luna', tier: 80, efforts: null,
        ...codexCatalogContext(null),
      },
    ];
  },

  run({
    config, env, message, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
    providerSettings, nativeSettings, signal, onProgress, onStep, tokenInfoReader = readCodexThreadTokenInfo,
    workTools, workspaceAccess, onPermission, log, onSessionCreated,
    onInTurnReady, onInTurnAvailability, onInTurnReceipt, onAssistantMessage, onRunMetadata,
    onProviderUsage, permissionMode, modeSelection, preparedRuntime, runtimeProfileFingerprint,
  }: Parameters<typeof runCodexAppServer>[0]) {
    return runCodexAppServer({
      config,
      env,
      message,
      cwd,
      extraDirs,
      model,
      effort,
      sessionId,
      compactWindow,
      providerSettings,
      nativeSettings,
      signal,
      onProgress,
      onProviderUsage,
      onStep,
      tokenInfoReader,
      workTools,
      workspaceAccess,
      permissionMode,
      modeSelection,
      preparedRuntime,
      runtimeProfileFingerprint,
      onPermission,
      log,
      onSessionCreated,
      onInTurnReady,
      onInTurnAvailability,
      onInTurnReceipt,
      onAssistantMessage,
      onRunMetadata,
    });
  },

  /**
   * Живая сессия: `codex app-server` — сам по себе сервер, и держать его между ходами
   * дешевле, чем поднимать заново. Замер: два `turn/start` в одном процессе, pid тот же.
   *
   * `unsolicited: false` — Codex не будит модель сам: фоновых агентов, которые
   * отчитались бы без запроса, у него нет. Живая сессия всё равно нужна: она сохраняет
   * рабочее состояние процесса и позволяет разбудить агента сообщением от GrigDesk.
   */
  // Канал ввода в активный ход: `turn/steer` установленного app-server. Живой сессии
  // для него не требуется — разовый запуск держит тот же turn до своего финала.
  // Картинки уточнения уходят в тот же steer элементами `localImage`.
  inTurnInput: {
    protocol: 1,
    text: true,
    confirmation: 'forwarded',
    images: true,
  },

  session: {
    mode: 'persistent',
    unsolicited: false,
    restartOn: [
      'model',
      'effort',
      'cwd',
      'extraDirs',
      'compactWindow',
      'providerSettings',
      'nativeSettingsFingerprint',
      'workToolScopeKey',
      'workspaceAccess',
      'permissionMode',
      'modeSelection',
      'runtimeProfileFingerprint',
    ],

    open({
      config, env, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
      providerSettings, nativeSettings, log, hooks, workTools, workspaceAccess,
      permissionMode, modeSelection, preparedRuntime, runtimeProfileFingerprint,
    }: Parameters<typeof openCodexSession>[0]) {
      return openCodexSession({
        config,
        env,
        cwd,
        extraDirs,
        model,
        effort,
        sessionId,
        compactWindow,
        providerSettings,
        nativeSettings,
        log,
        hooks,
        workTools,
        workspaceAccess,
        permissionMode,
        modeSelection,
        preparedRuntime,
        runtimeProfileFingerprint,
      });
    },
  },
};
