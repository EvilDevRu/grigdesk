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
