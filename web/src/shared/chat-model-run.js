/**
 * Последний завершённый ответ, для которого известно хотя бы то, какую модель
 * запросили. Не пропускаем GPT-ходы без `actualModel`: иначе шапка откатывается
 * к старому Claude-ответу и выдаёт его за текущий факт.
 */
export function lastModelRun(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'assistant' && (message.actualModel || message.model)) return message;
  }
  return null;
}

/**
 * `actualModel` — модель, которую явно сообщил поток CLI.
 * `model` — модель, переданная исполнителю. Если факта нет, показываем запрос
 * с честной подписью, а не подставляем его в поле «факт».
 */
export function modelRunView(run) {
  const actual = String(run?.actualModel || '').trim();
  const requested = String(run?.model || '').trim();
  const model = actual || requested;
  const comparableRequested = requested.replace(/\[1m\]$/, '');
  const mismatch = !!actual && !!requested
    && actual !== requested
    && !actual.startsWith(comparableRequested);

  return {
    model,
    requested,
    source: actual ? 'факт' : (requested ? 'запрошено' : ''),
    actual: !!actual,
    mismatch,
  };
}
