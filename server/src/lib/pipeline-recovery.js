// Чистое решение для восстановления конвейера после перезапуска Cockpit/машины.
// Здесь нет запуска процессов: функция только различает аварию, живой запуск и
// состояния, через которые автоматике переступать нельзя.
function positiveInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

export function recoveryDecision({
  registry = {},
  daemonAlive = false,
  profileAvailable = false,
  now = Date.now(),
  maxRestarts = 3,
  windowMs = 15 * 60_000,
} = {}) {
  if (registry.RETRO === 'done') return { action: 'skip', reason: 'completed' };
  if (registry.WF_STATUS !== 'running') return { action: 'skip', reason: 'inactive' };
  if (daemonAlive) return { action: 'skip', reason: 'alive' };

  if (Object.entries(registry).some(([key, value]) => key.startsWith('GATE_') && value === 'waiting')) {
    return { action: 'skip', reason: 'human_gate' };
  }
  if (registry.STALLED_HUMAN === '1') {
    return { action: 'attention', reason: 'human_required' };
  }
  if (!registry.PROFILE || !profileAvailable) {
    return { action: 'attention', reason: 'profile_missing' };
  }

  const limit = Math.max(1, positiveInt(maxRestarts, 3));
  const span = Math.max(1, positiveInt(windowMs, 15 * 60_000));
  const savedWindowAt = positiveInt(registry.RECOVERY_WINDOW_AT);
  const insideWindow = savedWindowAt > 0 && now - savedWindowAt < span;
  const count = insideWindow ? positiveInt(registry.RECOVERY_RESTARTS) : 0;
  const windowAt = insideWindow ? savedWindowAt : now;

  if (count >= limit) {
    return { action: 'attention', reason: 'restart_limit', count, windowAt };
  }
  return {
    action: 'resume',
    reason: 'crashed',
    nextCount: count + 1,
    windowAt,
  };
}
