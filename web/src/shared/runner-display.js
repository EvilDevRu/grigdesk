const PROVIDER_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
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
