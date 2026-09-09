export function resolveRequestedEffort(value, supportedLevels) {
  const effort = typeof value === 'string' ? value.trim() : '';
  if (!effort) return { ok: true, effort: undefined };

  const levels = Array.isArray(supportedLevels) ? supportedLevels : [];
  if (levels.includes(effort)) return { ok: true, effort };

  return { ok: false, effort: undefined, levels };
}
