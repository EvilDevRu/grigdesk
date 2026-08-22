/**
 * Общий повтор операции с нарастающей паузой.
 *
 * Заведён после разбора 22.08.2026: одинаковый цикл «попробуй ещё раз» расползался
 * копиями по адаптерам исполнителей, и копии разъезжались — у одного было две попытки
 * подряд БЕЗ паузы (то есть обе улетали в одно моргание сети), у другого повтора не было
 * вовсе. Правило теперь одно на всех, а решение «что вообще повторять» остаётся у
 * вызывающего: только он знает, какой ответ окончателен.
 *
 * Два инварианта, оба оплачены живыми граблями:
 *
 * - **Пауза обязательна.** Моргание туннеля длится секунды. Повтор без задержки
 *   удваивает трафик, не увеличивая шанс на ответ.
 * - **Повторяется только то, что лечится ожиданием.** Отказ аккаунта, неавторизованный
 *   CLI и отсутствие метода у старой версии — самостоятельные ответы: повтор их не
 *   изменит, а человека задержит. Поэтому `retryWhen` по умолчанию не повторяет ничего,
 *   и молчаливого «повторим на всякий случай» тут не бывает.
 *
 * Отдельно про идемпотентность: право на повтор есть только у операции, которая ничего
 * не меняет и не расходует. Читающей ручке лимитов — да, списанию кредита — нет.
 */

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {(attempt: number) => Promise<any>} run операция; получает номер попытки с нуля
 * @param {object} [options]
 * @param {number} [options.attempts=3] сколько всего попыток, включая первую
 * @param {number[]} [options.delaysMs=[400,1200]] паузы между попытками; последняя длится
 *   до конца, если попыток больше
 * @param {(value: any) => boolean} [options.retryWhen] повторить при таком ответе?
 * @param {(error: unknown) => boolean} [options.retryOnError] повторить при исключении?
 *   По умолчанию да: брошенная ошибка почти всегда транспортная.
 * @param {(ms: number) => Promise<void>} [options.sleep] для тестов
 * @returns {Promise<any>} последний ответ; если все попытки бросили — бросает последнюю ошибку
 */
export async function withRetry(run, {
  attempts = 3,
  delaysMs = [400, 1200],
  retryWhen = () => false,
  retryOnError = () => true,
  sleep = defaultSleep,
} = {}) {
  let lastValue;
  let lastError = null;
  let hasValue = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastValue = await run(attempt);
      hasValue = true;
      lastError = null;
      if (!retryWhen(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
      hasValue = false;
      if (!retryOnError(error)) throw error;
    }

    // После последней попытки паузы нет: ждать уже нечего, ответ отдаётся как есть.
    if (attempt < attempts - 1) {
      await sleep(delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0);
    }
  }

  if (!hasValue && lastError) throw lastError;
  return lastValue;
}
