// Терминальная ошибка провайдера имеет отдельный смысл от stdout инструмента.
// Общий разбор используется классификатором движка и диагностикой остановок.
import { translate } from '../../../shared/i18n/catalogs.ts';

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
 * Отказ host-wrapper-а GLM этапа — последнее событие wrapper_error retained-потока.
 * Код попадает в однострочный meta.env, поэтому непредсказуемая форма становится unknown.
 */
export function inspectGlmFactoryFailure(raw: string): RunnerFailure | null {
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

    if (event?.event !== 'wrapper_error') {
      continue;
    }

    const code = typeof event.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(event.code)
      ? event.code : 'unknown';
    const message = typeof event.message === 'string' ? event.message : '';

    failure = { code, message: cleanRunnerFailureMessage(message || code) };
  }

  return failure;
}

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
    usage_limit: 'исчерпан лимит использования провайдера',
    permission_denied: 'исполнитель получил отказ в разрешении',
    context_overflow: 'запрос превысил доступный размер контекста',
    authentication: 'провайдер отклонил авторизацию',
  };

  return labels[failure.code] || `ошибка провайдера: ${cleanRunnerFailureMessage(failure.message)}`;
}
