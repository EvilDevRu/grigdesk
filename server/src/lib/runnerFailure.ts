// Терминальная ошибка провайдера имеет отдельный смысл от stdout инструмента.
// Общий разбор используется классификатором движка и диагностикой остановок.
import { translate } from '../../../shared/i18n/catalogs.ts';

import { classifyTurnFailure } from './chat/turnFailures.ts';
import type { TurnFailureRule, TurnFailureSignal } from './chat/turnFailures.ts';
import { DSH_TURN_FAILURE_RULES } from './deepseek/turnFailureRules.ts';
import { claudeTurnFailure, CLAUDE_TURN_FAILURE_RULES } from './executors/_claudeTurnFailures.ts';
import { KIMI_FAILURE_RULES } from './kimi/turnFailure.ts';

type Row = Record<string, unknown>;

export interface RunnerFailure {
  code: string;
  message: string;
}

interface CodexFailureEvidence {
  failure: RunnerFailure | null;
  valid: boolean;
  activity: boolean;
}

const object = (value: unknown): Row | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null
);

const SECRET_ASSIGNMENT = new RegExp([
  String.raw`\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|authorization)\b`,
  String.raw`["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)`,
].join(''), 'giu');

/**
 * Сообщение предназначено для карточки и однострочного meta.env. Убираем управляющие
 * последовательности и типичные секреты до ограничения длины, чтобы не оставить их префикс.
 */
export function cleanRunnerFailureMessage(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[адрес скрыт]')
    .replace(/\bBearer\s+[^\s,;"']+/giu, 'Bearer [скрыто]')
    .replace(/\b(?:sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gu, '[скрыто]')
    .replace(SECRET_ASSIGNMENT, '$1=[скрыто]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Сигнатуры применяются только к полям ошибки событийного протокола. Текст команды,
 * результата теста или сообщения агента сюда не попадает и не открывает breaker.
 */
function failureFromError(value: unknown): RunnerFailure | null {
  const error = object(value);
  const message = typeof value === 'string' ? value : error?.message;
  const fields = [error?.type, error?.code, error?.status, message]
    .filter((field) => typeof field === 'string' || typeof field === 'number');
  const signature = fields.join(' ');

  if (!signature.trim()) {
    return null;
  }

  let code = 'unknown';

  if (/Selected model is at capacity(?:\.|$)/iu.test(signature)) {
    code = 'capacity';
  } else if (/sandbox[_ ]denied|permission denied/iu.test(signature)) {
    code = 'permission_denied';
  } else if (/(?:\b413\b|request too large|context[_ -]length[_ -]exceeded|context window.*exceed)/iu
    .test(signature)) {
    code = 'context_overflow';
  } else if (/usage_limit_reached|hit your (?:usage|weekly|monthly|rate) limit|purchase more credits/iu
    .test(signature) || /(?:weekly|subscription|usage).*limit.*(?:reached|reset)/iu.test(signature)) {
    code = 'usage_limit';
  } else if (/\b429\b|rate_limit_error|too many requests/iu.test(signature)) {
    code = 'rate_limit';
  } else if (/\b(?:401|403)\b|unauthorized|authentication.*(?:expired|required|error)/iu.test(signature)
    || /request not allowed|run codex login/iu.test(signature)) {
    code = 'authentication';
  }

  return {
    code,
    message: cleanRunnerFailureMessage(typeof message === 'string' ? message : signature),
  };
}

/**
 * Берём последний невосстановленный отказ. Повреждение и неизвестные события закрывают
 * доказательство отсутствия работы; завершение/продолжение хода снимает прежнюю ошибку.
 */
export function inspectCodexFailure(raw: string): CodexFailureEvidence {
  let failure: RunnerFailure | null = null;
  let valid = true;
  let activity = false;

  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    let event: Row | null;

    try {
      event = object(JSON.parse(line));
    } catch {
      valid = false;
      continue;
    }

    if (!event || typeof event.type !== 'string') {
      valid = false;
      continue;
    }

    if (event.type === 'turn.failed') {
      failure = failureFromError(event.error);
    } else if (event.type === 'error') {
      failure = failureFromError(event.error ?? event);
    } else if (event.type === 'usage_limit_reached') {
      failure = failureFromError(event);
    } else if (event.type === 'turn.started' || event.type === 'thread.started') {
      failure = null;
    } else {
      activity = true;
      failure = null;
    }
  }

  return {
    failure,
    valid,
    activity,
  };
}

/**
 * Общий реестр описывает причину человеку, не управляющий класс раннера.
 * Коды адаптера и признаки HTTP сохраняют различие квоты, частоты запросов и авторизации.
 */
function failureFromSignal(signal: TurnFailureSignal, rules: readonly TurnFailureRule[]): RunnerFailure {
  const kind = classifyTurnFailure(signal, rules).kind;
  const codes: Record<string, string> = {
    auth: 'authentication',
    usage_limit: 'usage_limit',
    context_overflow: 'context_overflow',
    rate_limited: 'rate_limit',
    overloaded: 'capacity',
    network: 'network',
    server_error: 'server_error',
    bad_request: 'bad_request',
    policy: 'policy',
  };

  return { code: codes[kind] || 'unknown', message: cleanRunnerFailureMessage(signal.message) };
}

/**
 * Ошибочный result Claude содержит текст, массив ошибок или только subtype.
 * Общий HTTP 429 итога не отменяет более точный отказ окна подписки из предыдущего события.
 */
function claudeResultFailure(event: Row, previous: RunnerFailure | null): RunnerFailure {
  const errors = Array.isArray(event.errors)
    ? event.errors.filter((error) => typeof error === 'string') : [];
  const text = errors.join('\n') || (typeof event.result === 'string' ? event.result : '')
    || String(event.subtype || 'result error');
  const signal = claudeTurnFailure(text, event.error);

  if (Number.isInteger(event.api_error_status)) {
    signal.status = Number(event.api_error_status);
  }

  const failure = failureFromSignal(signal, CLAUDE_TURN_FAILURE_RULES);

  return previous?.code === 'usage_limit' && ['rate_limit', 'unknown'].includes(failure.code)
    ? { ...previous, message: failure.message } : failure;
}

/**
 * Claude объявляет сбой synthetic-репликой, ошибочным result или отказом окна подписки.
 * Обычные сообщения и результаты инструментов не классифицируются по содержащимся в них словам.
 */
export function inspectClaudeFailure(raw: string): RunnerFailure | null {
  let failure: RunnerFailure | null = null;

  for (const line of raw.split('\n')) {
    let event: Row | null;

    try {
      event = object(JSON.parse(line));
    } catch {
      continue;
    }

    if (!event) {
      continue;
    }

    const message = object(event.message);
    const info = object(event.rate_limit_info);

    if (event.type === 'subscription_limit_reached'
      || (event.type === 'rate_limit_event' && info?.status === 'rejected')) {
      failure = { code: 'usage_limit', message: `${String(event.type)}: rejected` };
    } else if (event.type === 'assistant' && message?.model === '<synthetic>') {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content.map(object).filter((part) => part?.type === 'text')
        .map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');

      failure = failureFromSignal(claudeTurnFailure(text, event.error), CLAUDE_TURN_FAILURE_RULES);
    } else if (event.type === 'error') {
      failure = failureFromError(event.error ?? event);
    } else if (event.is_error === true || (event.type === 'result'
      && typeof event.subtype === 'string' && event.subtype.startsWith('error_'))) {
      failure = claudeResultFailure(event, failure);
    } else if (event.type === 'assistant' || (event.type === 'system' && event.subtype === 'init')
      || (event.type === 'rate_limit_event'
        && ['allowed', 'allowed_warning'].includes(String(info?.status)))) {
      failure = null;
    }
  }

  return failure;
}

/**
 * Host-wrapper DSH публикует окончательный wrapper_error без private payload модели.
 * Старт нового хода и успешный result снимают старый отказ; неизвестный код сохраняет текст.
 */
function inspectFactoryWrapperFailure(raw: string): RunnerFailure | null {
  let failure: RunnerFailure | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    let event: Row | null;

    try {
      event = object(JSON.parse(line));
    } catch {
      continue;
    }

    if (['deepseek_start', 'glm_start'].includes(String(event?.event))
      || (event?.event === 'result' && event.stopReason !== 'error')) {
      failure = null;
    }

    if (event?.event !== 'wrapper_error') {
      continue;
    }

    const code = typeof event.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(event.code)
      ? event.code : 'unknown';
    const message = typeof event.message === 'string' ? event.message : '';

    const classified = failureFromSignal({
      code: String(event.code || ''),
      message,
      ...(Number.isInteger(event.status) ? { status: Number(event.status) } : {}),
    }, DSH_TURN_FAILURE_RULES);

    if (classified.code === 'unknown'
      && /Authentication Fails, Your api key: .* is invalid/iu.test(message)) {
      classified.code = 'authentication';
    }

    failure = classified.code === 'unknown'
      ? { code, message: cleanRunnerFailureMessage(message || code) } : classified;
  }

  return failure;
}

/**
 * GLM использует общий retained-протокол DSH, включая его структурированные коды модели.
 * Собственные glm_* причины сохраняются для существующего представления и diagnostic mirror.
 */
export function inspectGlmFactoryFailure(raw: string): RunnerFailure | null {
  return inspectFactoryWrapperFailure(raw);
}

/**
 * DeepSeek сообщает ошибку тем же host-wrapper протоколом, что и GLM.
 * Этот разбор нужен только диагностике и не расширяет разрешения автоматического failover.
 */
export function inspectDeepSeekFactoryFailure(raw: string): RunnerFailure | null {
  return inspectFactoryWrapperFailure(raw);
}

/**
 * Batch CLI Kimi сообщает окончательный отказ отдельной строкой stderr, а не событием stdout.
 * Читаем только этот префикс: строки инструментов и служебный путь к журналу причиной не являются.
 */
export function inspectKimiFailure(raw: string): RunnerFailure | null {
  const message = raw.split('\n').findLast((line) => (
    /^error: failed to run prompt: /u.test(line)
  ))?.slice('error: failed to run prompt: '.length).trim();

  if (!message) {
    return null;
  }

  let { code } = failureFromSignal({ message }, KIMI_FAILURE_RULES);

  if (code === 'unknown' && /No model configured.*\/login|^provider\.auth_error: (?:401|403)\b/u
    .test(message)) {
    code = 'authentication';
  } else if (code === 'unknown' && /^config\.invalid:/u.test(message)) {
    code = 'bad_request';
  }

  return { code, message: cleanRunnerFailureMessage(message) };
}

/**
 * Незнакомый stderr остаётся диагностическим сообщением, а не доказанным типом отказа.
 * Берём последнюю содержательную строку без указателя на private журнал и кадров стека.
 */
export function inspectRunnerStderr(raw: string): RunnerFailure | null {
  const lines = raw.split('\n').filter((value) => (
    value.trim() && !/^\s*(?:See log:|at\s|Node\.js v|[\^{}\[\],]+\s*$)/u.test(value)
  ));
  const line = lines.findLast((value) => /^\s*(?:\w*Error:|error\b|fatal\b|panic\b)/iu.test(value))
    || lines.at(-1);
  const message = line ? cleanRunnerFailureMessage(line) : '';

  return message ? { code: 'stderr', message } : null;
}

// Источник диагностики принадлежит адаптеру формата. Журнал попыток и карточка остановки
// выбирают одинаковый файл и разбор, сохраняя класс автомата и историю запуска.
export const RUNNER_FAILURE_READERS: Readonly<Record<string, {
  file: string;
  inspect: (raw: string) => RunnerFailure | null;
}>> = {
  claude: { file: 'events.jsonl', inspect: inspectClaudeFailure },
  codex: { file: 'events.jsonl', inspect: (raw) => inspectCodexFailure(raw).failure },
  deepseek: { file: 'events.jsonl', inspect: inspectDeepSeekFactoryFailure },
  glm: { file: 'events.jsonl', inspect: inspectGlmFactoryFailure },
  kimi: { file: 'stderr.log', inspect: inspectKimiFailure },
};

/**
 * Номер CLI остаётся диагностикой. Разрешение сменить провайдера определяется
 * подтверждённой ошибкой и отсутствием активности, а не сходством номера версии.
 */
export function classifyCodexFailure(raw: string, rc: number, verified: boolean): string {
  if (rc === 0) {
    return 'ok';
  }
  if (rc === 124) {
    return 'timeout';
  }

  const evidence = inspectCodexFailure(raw);

  if (!verified || !evidence.valid) {
    return 'unknown';
  }

  switch (evidence.failure?.code) {
    case 'capacity':
    case 'rate_limit':
      return 'transient';
    case 'usage_limit':
      return 'limited';
    case 'permission_denied':
      return 'denied';
    case 'context_overflow':
      return 'context_overflow';
    case 'authentication':
      return evidence.activity ? 'unknown' : 'provider_unavailable';
    default:
      return 'unknown';
  }
}

/**
 * Подпись не участвует в политике повтора и переключения. Даже неизвестный класс
 * сохраняет сообщение человеку, тогда как подтверждённые причины переводятся на русский.
 */
export function runnerFailureDetail(failure: RunnerFailure, model = ''): string {
  if (failure.code === 'diagnostic_missing') {
    return cleanRunnerFailureMessage(failure.message);
  }

  if (failure.code === 'stderr') {
    return translate('core.runnerLastDiagnostic', { message: cleanRunnerFailureMessage(failure.message) });
  }

  if (/^glm_[a-z0-9_]{1,60}$/u.test(failure.code)) {
    return translate('core.runnerFailureWithCode', {
      message: cleanRunnerFailureMessage(failure.message),
      code: failure.code,
    });
  }

  const name = cleanRunnerFailureMessage(model).slice(0, 80);
  const modelLabel = name ? `модель «${name}»` : 'модель';
  const labels: Record<string, string> = {
    capacity: `${modelLabel} перегружена`,
    rate_limit: 'провайдер ограничил частоту запросов',
    usage_limit: translate('core.runnerQuotaExhausted'),
    permission_denied: 'исполнитель получил отказ в разрешении',
    context_overflow: 'запрос превысил доступный размер контекста',
    authentication: 'провайдер отклонил авторизацию',
    network: translate('core.runnerConnectionFailed'),
    server_error: translate('core.runnerServerFailed'),
    bad_request: translate('core.runnerRequestRejected'),
    policy: translate('core.runnerPolicyRejected'),
  };

  return labels[failure.code] || `ошибка провайдера: ${cleanRunnerFailureMessage(failure.message)}`;
}
