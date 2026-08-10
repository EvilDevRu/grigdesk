export const PROVIDER_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
};

export function providerLabel(id) {
  const value = String(id || '');
  if (!value) return 'не назначен';
  if (PROVIDER_LABELS[value]) return PROVIDER_LABELS[value];
  const words = value.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function runnerChainLabel(runner) {
  return (runner?.chain || []).map(providerLabel).join(' → ');
}

export function runnerNodeLabel(runner) {
  if (!runner) return '';
  if (runner.actual) {
    return `${providerLabel(runner.actual)}${runner.switched ? ' · резерв' : ''}`;
  }
  return providerLabel(runner.primary);
}

export function runnerModelLabel(runner, provider = runner?.actual || runner?.primary) {
  if (!runner || !provider) return '';
  if (runner.actual === provider && runner.model) return runner.model;
  const policy = runner.models?.[provider];
  if (!policy) return '';
  if (policy.exact) return policy.exact;
  if (!policy.family) return '';
  return policy.version && policy.version !== 'latest'
    ? `${policy.family} ${policy.version}`
    : policy.family;
}

// Для уже стартовавшего provider-а показываем telemetry конкретного запуска, а не
// сегодняшнюю policy профиля: конфиг мог измениться после завершения этапа. Старые
// meta/API могли ещё не отдавать EFFORT — тогда показываем доступную policy как fallback.
export function runnerEffortLabel(runner, provider = runner?.actual || runner?.primary) {
  if (!runner || !provider) return '';
  const attempts = Array.isArray(runner.attempts) ? runner.attempts : [];
  const latest = attempts.findLast((attempt) => attempt?.runner === provider);
  if (latest?.effort) return String(latest.effort);
  return String(runner.models?.[provider]?.effort || '');
}

export function runnerModelEffortLabel(runner, provider = runner?.actual || runner?.primary) {
  const model = runnerModelLabel(runner, provider);
  const effort = runnerEffortLabel(runner, provider);
  return [model, effort ? `effort ${effort}` : ''].filter(Boolean).join(' · ');
}

export function runnerAttemptModelLabel(attempt) {
  const model = String(attempt?.model || '');
  const effort = String(attempt?.effort || '');
  return [model, effort ? `effort ${effort}` : ''].filter(Boolean).join(' · ');
}

function compactTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}М`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}к`;
  return String(value);
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
export function attemptCostLabel(attempt) {
  const tokens = attempt?.tokens;
  if (!tokens) return '';
  if (Number.isFinite(tokens.costUsd) && tokens.costUsd > 0) {
    return `$${tokens.costUsd < 0.01 ? tokens.costUsd.toFixed(4) : tokens.costUsd.toFixed(2)}`;
  }
  const total = ['in', 'out', 'cacheRead', 'cacheWrite']
    .map((key) => (Number.isFinite(tokens[key]) ? tokens[key] : 0))
    .reduce((sum, value) => sum + value, 0);
  return total > 0 ? `${compactTokens(total)} ток.` : '';
}

export function attemptCostTitle(attempt) {
  const tokens = attempt?.tokens;
  if (!tokens) return '';
  const parts = [
    ['вход', tokens.in],
    ['выход', tokens.out],
    ['из кэша', tokens.cacheRead],
    ['в кэш', tokens.cacheWrite],
  ]
    .filter(([, value]) => Number.isFinite(value))
    .map(([label, value]) => `${label} ${value.toLocaleString('ru-RU')}`);
  if (Number.isFinite(tokens.costUsd) && tokens.costUsd > 0) {
    parts.push(`стоимость $${tokens.costUsd.toFixed(4)}`);
  }
  return parts.join(' · ');
}

const REASONS = {
  primary: 'основной исполнитель',
  fallback_limit: 'закончился лимит',
  unavailable: 'исполнитель недоступен',
  unavailable_preflight: 'исполнитель недоступен до запуска',
  route_unavailable: 'нет совместимого маршрута',
  manual_switch: 'переключено вручную',
  coverage_unavailable: 'не пройдена проверка окружения',
  invalid_config: 'ошибка конфигурации',
  context_overflow: 'переполнен контекст',
  denied: 'действие запрещено политикой',
  manual_switch_conflict: 'конфликт ручного переключения',
};

export function runnerReasonLabel(reason) {
  return REASONS[reason] || String(reason || '').replace(/_/g, ' ') || 'причина не записана';
}

export function attemptResultLabel(result) {
  const labels = {
    ok: 'успешно',
    limited: 'лимит',
    unavailable_preflight: 'недоступен',
    provider_unavailable: 'провайдер недоступен',
    route_unavailable: 'несовместим',
    manual_switch: 'переключён вручную',
    denied: 'запрещено',
    timeout: 'таймаут',
    transient: 'временный сбой',
    invalid_config: 'ошибка настройки',
    context_overflow: 'контекст переполнен',
    crashed: 'процесс упал',
    unknown: 'неизвестная ошибка',
  };
  return labels[result] || result || 'идёт';
}
