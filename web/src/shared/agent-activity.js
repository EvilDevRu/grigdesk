export function agentActivityLabel(activity) {
  if (activity?.journalFresh) return 'агент пишет';
  if (!Number.isFinite(activity?.journalAgeSec)) return 'журнал не подключён';
  const minutes = Math.max(1, Math.floor(activity.journalAgeSec / 60));
  return `нет событий ${minutes} мин`;
}
