
import {
  formatExactDecimal,
  formatExactInteger,
  formatExactUsd,
} from './exactNumberFormat.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


// Точный расход попытки: строки, а не числа, — величины превышают 2^53, и `Number`
// молча терял бы точность (см. exactNumberFormat).
interface ExactTokens {
  in: string;
  out: string;
  cacheRead: string;
  cacheWrite: string;
  completeness: 'complete' | 'partial';
  provenance: 'exact' | 'approximate';
  costUsd?: string | null;
}

// Расход попытки в том виде, в каком его отдаёт раннер: точная часть плюс исторические
// числовые поля старых записей.
interface AttemptTokens extends Record<string, unknown> {
  exact?: unknown;
  costUsd?: unknown;
  in?: unknown;
  out?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

// Один запуск этапа.
export interface RunnerAttempt {
  id?: string;
  epoch?: number;
  runner?: string;
  model?: unknown;
  effort?: unknown;
  rc?: number | null;
  failureDetail?: string;
  tokens?: AttemptTokens | null;
}

// Политика модели для одного исполнителя.
interface RunnerModelPolicy {
  exact?: string;
  label?: string;
  family?: string;
  version?: string;
  effort?: unknown;
}

// Состояние раннера узла: цепочка, кто отработал и по какой политике.
export interface RunnerState {
  chain?: string[];
  actual?: string;
  primary?: string;
  switched?: boolean;
  model?: string;
  models?: Record<string, RunnerModelPolicy | undefined>;
  attempts?: RunnerAttempt[];
}

export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  qwen: 'Qwen',
};

/**
 * Подпись исполнителя. Незнакомый id не прячем, а приводим к читаемому виду: новый
 * провайдер должен появляться в интерфейсе сам, без правки этого списка.
 */
export function providerLabel(id: unknown): string {
  const value = String(id || '');

  if (!value) {
    return translateUi('core.runnerDisplayUnassigned');
  }

  if (PROVIDER_LABELS[value]) {
    return PROVIDER_LABELS[value];
  }

  const words = value.replace(/[_-]+/g, ' ');

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Вся цепочка резерва одной строкой: кого пробуют первым и куда переключаются.
 * Показывается в настройках узла, где важен именно порядок.
 */
export function runnerChainLabel(runner: RunnerState | null | undefined): string {
  return (runner?.chain || []).map(providerLabel).join(' → ');
}

/**
 * Кто работает на узле сейчас. Отработавший исполнитель сильнее назначенного, и
 * пометка «резерв» обязательна: переключение — это факт прогона, а не настройка.
 */
export function runnerNodeLabel(runner: RunnerState | null | undefined): string {
  if (!runner) {
    return '';
  }

  if (runner.actual) {
    return `${providerLabel(
      runner.actual,
    )}${runner.switched ? translateUi('core.runnerDisplayFallback') : ''}`;
  }

  return providerLabel(runner.primary);
}

/**
 * Модель узла. У уже стартовавшего исполнителя показывается та, что реально ушла в
 * запуск, а не сегодняшняя политика профиля: конфиг мог измениться после этапа.
 */
export function runnerModelLabel(
  runner: RunnerState | null | undefined,
  provider = runner?.actual || runner?.primary,
): string {
  if (!runner || !provider) {
    return '';
  }

  if (runner.actual === provider && runner.model) {
    return runner.model;
  }

  const policy = runner.models?.[provider];

  if (!policy) {
    return '';
  }

  if (policy.label) {
    return policy.label;
  }

  if (policy.exact) {
    return policy.exact;
  }

  if (!policy.family) {
    return '';
  }

  return policy.version && policy.version !== 'latest'
    ? `${policy.family} ${policy.version}`
    : policy.family;
}

// Для уже стартовавшего provider-а показываем telemetry конкретного запуска, а не
// сегодняшнюю policy профиля: конфиг мог измениться после завершения этапа. Старые
// meta/API могли ещё не отдавать EFFORT — тогда показываем доступную policy как fallback.
export function runnerEffortLabel(
  runner: RunnerState | null | undefined,
  provider = runner?.actual || runner?.primary,
): string {
  if (!runner || !provider) {
    return '';
  }

  const attempts = Array.isArray(runner.attempts) ? runner.attempts : [];
  const latest = attempts.findLast((attempt: RunnerAttempt) => attempt?.runner === provider);

  if (latest?.effort !== null && latest?.effort !== undefined) {
    return String(latest.effort);
  }

  return String(runner.models?.[provider]?.effort || '');
}

/**
 * Модель и усилие одной строкой — так их показывает модалка этапа. Пустые части
 * отбрасываются, чтобы не осталось висящего разделителя.
 */
export function runnerModelEffortLabel(
  runner: RunnerState | null | undefined,
  provider = runner?.actual || runner?.primary,
): string {
  const model = runnerModelLabel(runner, provider);
  const effort = runnerEffortLabel(runner, provider);
  const latest = runner?.attempts?.findLast((attempt) => attempt.runner === provider);
  const effortLabel = latest?.effort === ''
    ? translateUi('core.stageNoEffort') : effort ? `effort ${effort}` : '';

  return [model, effortLabel].filter(Boolean).join(' · ');
}

/**
 * То же самое, но по записи конкретного запуска: здесь нет политики вовсе, только
 * то, что телеметрия зафиксировала на самом деле.
 */
export function runnerAttemptModelLabel(attempt: RunnerAttempt | null | undefined): string {
  const model = String(attempt?.model || '');
  const effort = String(attempt?.effort || '');
  const effortLabel = attempt?.effort === ''
    ? translateUi('core.stageNoEffort') : effort ? `effort ${effort}` : '';

  return [model, effortLabel].filter(Boolean).join(' · ');
}

/**
 * Короткая запись числа токенов для тесной строки. Историческая ветка: работает по
 * `Number`, поэтому применяется только к старым записям без точного расхода.
 */
function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1e6) {
    return translateUi('core.runnerDisplayM', { value: (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) });
  }

  if (value >= 1e3) {
    return translateUi('core.runnerDisplayK', { value: (value / 1e3).toFixed(value >= 1e4 ? 0 : 1) });
  }

  return String(value);
}

/**
 * Точный расход, если он есть и цел. Проверка строгая по построению: одна кривая
 * строка здесь превратилась бы в неверную сумму на экране, а «нет данных» и «ноль» —
 * разные утверждения, и второе врать не имеет права.
 */
function exactTokens(tokens: AttemptTokens | null | undefined): ExactTokens | null {
  const exact = tokens?.exact as ExactTokens | undefined;
  const fields = ['in', 'out', 'cacheRead', 'cacheWrite'] as const;

  if (!exact || fields.some((key) => typeof exact[key] !== 'string'
      || exact[key].length > 64 || !/^(?:0|[1-9][0-9]*)$/u.test(exact[key]))
      || !['complete', 'partial'].includes(exact.completeness)
      || !['exact', 'approximate'].includes(exact.provenance)
      || (exact.costUsd !== null && exact.costUsd !== undefined
        && (typeof exact.costUsd !== 'string'
          || exact.costUsd.length > 64
          || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u.test(exact.costUsd)))) {
    return null;
  }

  return exact;
}

/**
 * Деление на степень десяти без потери точности: целая часть и остаток считаются
 * в BigInt, а дробь собирается строкой. `Number` здесь запрещён — значения крупные.
 */
function decimalRatio(value: string, divisor: bigint): string {
  const amount = BigInt(value);
  const whole = amount / divisor;
  const remainder = amount % divisor;

  if (remainder === 0n) {
    return whole.toString();
  }

  const scale = divisor.toString().length - 1;
  const fraction = remainder.toString().padStart(scale, '0').replace(/0+$/u, '');

  return `${whole}.${fraction}`;
}

/**
 * Короткая запись точного числа токенов: «1.2М», «340к». Порог знака после запятой
 * зависит от величины — на десятках миллионов дробь уже ничего не сообщает.
 */
function compactExactTokens(value: string): string {
  const amount = BigInt(value);

  if (amount >= 1_000_000n) {
    return translateUi('core.runnerDisplayM', { value: formatExactDecimal(decimalRatio(value, 1_000_000n), {
      maximumFractionDigits: amount >= 10_000_000n ? 0 : 1,
    }) });
  }
  if (amount >= 1_000n) {
    return translateUi('core.runnerDisplayK', { value: formatExactDecimal(decimalRatio(value, 1_000n), {
      maximumFractionDigits: amount >= 10_000n ? 0 : 1,
    }) });
  }

  return value;
}

function exactTotal(exact: ExactTokens): string {
  return (['in', 'out', 'cacheRead', 'cacheWrite'] as const)
    .reduce((sum, key) => sum + BigInt(exact[key]), 0n).toString();
}

/**
 * Цена одного запуска этапа. Расход публикует раннер (метод `usage`), и знает
 * его не каждый CLI: у kimi ACP-мост молчит. Поэтому отсутствие данных даёт
 * пустую метку, а не ноль — «бесплатно» и «неизвестно» разные утверждения.
 *
 * В строке показывается ОДНО число, иначе ряд попыток разъезжается. Доллары
 * сильнее токенов: этапы сравнивают по цене, а не по объёму. Кэш-чтение при
 * этом остаётся в подсказке — миллион прочитанных из кэша токенов и миллион
 * записанных стоят по-разному в десять раз.
 */
export function attemptCostLabel(attempt: RunnerAttempt | null | undefined): string {
  const tokens = attempt?.tokens;

  if (!tokens) {
    return '';
  }

  const exact = exactTokens(tokens);

  if (exact) {
    const partial = exact.completeness === 'partial';

    if (exact.costUsd !== null && exact.costUsd !== undefined) {
      const fractionDigits = /^0\.00/u.test(exact.costUsd) && exact.costUsd !== '0' ? 4 : 2;
      const amount = formatExactUsd(exact.costUsd, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });

      return partial ? `≥${amount}` : amount;
    }

    const total = exactTotal(exact);

    if (total !== '0' || exact.completeness === 'complete') {
      return translateUi(
        'core.runnerDisplayTokens',
        { value: partial ? '≥' : '', value2: compactExactTokens(total) },
      );
    }

    return '';
  }

  const costUsd = tokens.costUsd as number;

  if (Number.isFinite(costUsd) && costUsd > 0) {
    return `$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
  }

  const total = (['in', 'out', 'cacheRead', 'cacheWrite'] as const)
    .map((key) => (Number.isFinite(tokens[key]) ? Number(tokens[key]) : 0))
    .reduce((sum, value) => sum + value, 0);

  return total > 0 ? translateUi('core.runnerDisplayTokensc4c9f1', { value: compactTokens(total) }) : '';
}

/**
 * Подсказка к цене: разбивка по видам токенов и оговорки о полноте. Кэш-чтение
 * остаётся здесь, а не в строке: миллион прочитанных и миллион записанных стоят
 * по-разному в десять раз, и сворачивать их в одно число нельзя.
 */
export function attemptCostTitle(attempt: RunnerAttempt | null | undefined): string {
  const tokens = attempt?.tokens;

  if (!tokens) {
    return '';
  }

  const exact = exactTokens(tokens);

  if (exact) {
    const parts = [
      [translateUi('core.runnerDisplayInput'), exact.in],
      [translateUi('core.runnerDisplayOutput'), exact.out],
      [translateUi('core.runnerDisplayCacheRead'), exact.cacheRead],
      [translateUi('core.runnerDisplayCacheWrite'), exact.cacheWrite],
    ].map(([label, value]) => `${label} ${formatExactInteger(value, {
      groupSeparator: '\u00a0',
    })}`);

    if (exact.costUsd !== null && exact.costUsd !== undefined) {
      parts.push(translateUi('core.runnerDisplayCost', { value: formatExactUsd(exact.costUsd, {
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
      }) }));
    }

    if (exact.completeness === 'partial') {
      parts.push(translateUi('core.runnerDisplayRecordedPortion'));
    }

    if (exact.provenance === 'approximate') {
      parts.push(translateUi('core.runnerDisplayHistoricalEstimate'));
    }

    return parts.join(' · ');
  }

  const legacyCost = tokens.costUsd as number;
  const parts = ([
    [translateUi('core.runnerDisplayInput'), tokens.in],
    [translateUi('core.runnerDisplayOutput'), tokens.out],
    [translateUi('core.runnerDisplayCacheRead'), tokens.cacheRead],
    [translateUi('core.runnerDisplayCacheWrite'), tokens.cacheWrite],
  ] as Array<[string, unknown]>)
    .filter(([, value]) => Number.isFinite(value))
    .map(([label, value]) => `${label} ${Number(value).toLocaleString(uiLocalePort.value)}`);

  if (Number.isFinite(legacyCost) && legacyCost > 0) {
    parts.push(translateUi('core.runnerDisplayCosta46729', { value: legacyCost.toFixed(4) }));
  }

  return parts.join(' · ');
}

const REASONS: Record<string, string> = {
  get primary() {
    return translateUi('core.pipelineOsnovnoyIspolnitel');
  },
  get fallback_limit() {
    return translateUi('core.runnerDisplayQuotaExhausted');
  },
  get unavailable() {
    return translateUi('core.runnerDisplayExecutorUnavailable');
  },
  get unavailable_preflight() {
    return translateUi('core.runnerDisplayExecutorUnavailableBeforeLaunch');
  },
  get route_unavailable() {
    return translateUi('core.runnerDisplayNoCompatibleRoute');
  },
  get manual_switch() {
    return translateUi('core.runnerDisplaySwitchedManually');
  },
  get coverage_unavailable() {
    return translateUi('core.runnerDisplayEnvironmentCheckFailed');
  },
  get invalid_config() {
    return translateUi('core.runnerDisplayConfigurationError');
  },
  get context_overflow() {
    return translateUi('core.runnerDisplayContextOverflow');
  },
  get denied() {
    return translateUi('core.runnerDisplayActionDeniedByPolicy');
  },
  get manual_switch_conflict() {
    return translateUi('core.runnerDisplayManualSwitchConflict');
  },
};

/**
 * Почему узел работает этим исполнителем. Незнакомую причину показываем как есть,
 * заменив подчёркивания: молчание было бы хуже неудобного, но правдивого текста.
 */
export function runnerReasonLabel(reason: unknown): string {
  const key = String(reason || '');

  return REASONS[key] || key.replace(/_/g, ' ') || translateUi('core.runnerDisplayReasonNotRecorded');
}

/**
 * Чем закончился запуск. Пустое значение означает «идёт»: у незавершённой попытки
 * результата ещё нет. Завершённый отказ без диагностики явно сообщает отсутствие причины.
 */
export function attemptResultLabel(result: unknown, rc?: number | null): string {
  const fallback = Number.isInteger(rc)
    ? translateUi('core.runnerExitReasonMissing', { code: rc! })
    : translateUi('core.runnerFailureReasonMissing');
  const labels: Record<string, string> = {
    ok: translateUi('core.dbUspeshno'),
    limited: translateUi('core.runnerQuotaExhausted'),
    unavailable_preflight: translateUi('core.unavailable'),
    provider_unavailable: translateUi('core.runnerDisplayProviderUnavailable'),
    route_unavailable: translateUi('core.runnerDisplayIncompatible'),
    manual_switch: translateUi('core.runnerDisplayManuallySwitched'),
    denied: translateUi('core.runnerDisplayDenied'),
    timeout: translateUi('core.runnerDisplayTimeout'),
    transient: translateUi('core.runnerDisplayTemporaryFailure'),
    invalid_config: translateUi('core.runnerDisplaySetupError'),
    context_overflow: translateUi('core.runnerDisplayContextIsFull'),
    crashed: translateUi('core.runnerDisplayProcessCrashed'),
    unknown: fallback,
  };
  const key = String(result || '');

  return labels[key] || (key ? fallback : translateUi('core.showcaseIdet'));
}
