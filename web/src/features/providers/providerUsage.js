/**
 * Полосы одного ведра лимитов идут в ответе подряд, и различить их можно только по
 * подписи — «Неделя (7д)» и «Неделя · gpt-reserve» выглядят одним плоским списком.
 * Разделитель ставится там, где сменилось поле `group`. Считаем его здесь, а не в
 * шаблоне: `v-for` не должен знать про соседа, а правило одно на всех исполнителей.
 *
 * Полоса без `group` линии НЕ порождает: черта — это утверждение «дальше другое ведро»,
 * а исполнитель, который вёдра не назвал, такого не сообщал. У Ollama полосы вовсе не
 * лимиты (видеопамять и ОЗУ машины), и разделять там нечего. Поэтому сравниваем с
 * последним НАЗВАННЫМ ведром: неназванная полоса не рвёт группу и не начинает свою.
 */
function withGroupBreaks(bars) {
  let previous = null;

  return bars.map((bar) => {
    const group = bar.group || '';
    const separated = Boolean(group) && Boolean(previous) && group !== previous;

    previous = group || previous;

    return { ...bar, separated };
  });
}

// Представление серверного контракта лимитов. Всплывашка всегда получает текст,
// даже пока данные грузятся или CLI не предоставляет API потребления.
export function providerUsageView(entry, provider = {}) {
  if (!entry || typeof entry !== 'object') {
    return {
      state: 'loading',
      bars: [],
      resources: [],
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
    bars: withGroupBreaks(Array.isArray(entry.bars) ? entry.bars : []),
    resources: Array.isArray(entry.resources) ? entry.resources : [],
    message: entry.message || fallback,
    note: entry.stale ? 'Показываем последние успешно полученные значения.' : '',
    tone,
    action: entry.action || null,
  };
}
