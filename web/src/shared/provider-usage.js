// Представление серверного контракта лимитов. Всплывашка всегда получает текст,
// даже пока данные грузятся или CLI не предоставляет API потребления.
export function providerUsageView(entry, provider = {}) {
  if (!entry || typeof entry !== 'object') {
    return {
      state: 'loading',
      bars: [],
      message: 'Данные о лимитах ещё не получены.',
      note: '',
      tone: 'muted',
      action: null,
    };
  }

  const tone = {
    ok: 'ok',
    auth_required: 'bad',
    blocked: 'bad',
    rate_limited: 'warn',
    unavailable: 'warn',
    unsupported: 'muted',
  }[entry.state] || 'muted';

  const fallback = entry.state === 'ok'
    ? ''
    : `Статус лимитов ${provider.name || 'исполнителя'} недоступен.`;
  return {
    ...entry,
    bars: Array.isArray(entry.bars) ? entry.bars : [],
    message: entry.message || fallback,
    note: entry.stale ? 'Показываем последние успешно полученные значения.' : '',
    tone,
    action: entry.action || null,
  };
}
