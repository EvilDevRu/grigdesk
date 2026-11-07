// Ошибки отправки и исполнения задач Tripo.
// Публичные причины и подробности формируются без раскрытия тела ответа.

import type { ProviderError, RemoteState } from '../studio3d/provider.ts';

/**
 * Текст исполнителя для второй строки ошибки: без управляющих символов и не
 * длиннее 200 знаков. Показывается как текст, никогда как разметка.
 */
function detailOf(message: string | null): string | null {
  if (!message) {
    return null;
  }

  const clean = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

  return clean ? clean.slice(0, 200) : null;
}

/**
 * Собирает ошибку для человека: вид для веток кода, русское сообщение, код и текст
 * исполнителя. Срок повтора нужен только занятой очереди и ограничению частоты.
 */
function providerError(
  kind: ProviderError['kind'],
  code: number | null,
  message: string,
  detail: string | null,
  retryAfterMs: number | null = null,
): ProviderError {
  return {
    kind,
    code,
    message,
    detail,
    retryAfterMs
  };
}

const REQUEST_ERRORS: readonly [readonly number[], ProviderError['kind'], string][] = [
  [[1002, 4000], 'auth', 'Tripo не принял ключ: проверьте ключ и регион.'],
  [[1005], 'auth', 'Tripo запретил доступ: проверьте права ключа.'],
  [[2010], 'credits', 'Не хватает кредитов Tripo.'],
  [[1003, 1004, 2002], 'params', 'Tripo не принял параметры.'],
  [[2003], 'input', 'Пустой файл или недоступная ссылка.'],
  [[2004], 'input', 'Tripo не принимает этот тип файла.'],
  [
    [2005, 2006, 2007, 2011, 2012],
    'input',
    'Tripo не принял исходную версию: нужен готовый результат подходящего вида.',
  ],
  [[2008], 'moderation', 'Tripo отклонил данные по правилам содержания.'],
  [[2009], 'params', 'В описании недопустимые символы.'],
  [[2015, 2016, 2017], 'params', 'Эта версия модели у Tripo устарела.'],
  [[2018], 'complex', 'Модель слишком сложная — уменьшите число граней.'],
  [[2019], 'expired', 'Файл у Tripo истёк — его нужно загрузить заново.'],
  [[2020, 2021, 2022], 'input', 'Tripo не смог взять файл: ссылка недоступна или файл слишком большой.'],
];

/**
 * Ошибка запроса к API (создание, опрос, загрузка). Сначала HTTP-статусы с особым
 * смыслом, затем коды Tripo; неизвестный ответ не выдаётся за понятный. Коды 1000 и
 * 1001 документация называет ошибкой ключа, а tripo-cli — сбоем сервера: решает статус.
 */
export function tripoRequestError(
  status: number,
  code: number | null,
  message: string | null,
  retryAfterMs: number | null = null,
): ProviderError {
  const detail = detailOf(message);

  if (status === 429 && code === 2000) {
    const message = 'Tripo занят: одновременно можно ограниченное число заказов этого вида.';

    return providerError('busy', code, message, detail, retryAfterMs);
  }

  if (status === 429) {
    return providerError('rate', code, 'Tripo просит повторить позже.', detail, retryAfterMs);
  }

  if (status === 402) {
    return providerError('credits', code, 'Не хватает кредитов Tripo.', detail);
  }

  if (status === 401) {
    return providerError('auth', code, 'Tripo не принял ключ: проверьте ключ и регион.', detail);
  }

  if (status >= 500 || (code !== null && [1000, 1001].includes(code) && status !== 403)) {
    return providerError('server', code, 'У Tripo сбой на сервере. Повторим позже.', detail);
  }

  if (code !== null && [1000, 1001].includes(code)) {
    return providerError('auth', code, 'Tripo не принял ключ: проверьте ключ и регион.', detail);
  }

  if (status === 404 || code === 2001) {
    return providerError('not-found', code, 'Tripo не нашёл заказ или файл: другой ключ или регион?', detail);
  }

  const known = code === null ? undefined : REQUEST_ERRORS.find(([codes]) => codes.includes(code));

  if (known) {
    return providerError(known[1], code, known[2], detail);
  }

  return providerError('unknown', code, `Tripo вернул ошибку ${code ?? status}.`, detail);
}

/**
 * Ошибка завершённой задачи. Удачная задача списывает кредиты, неудачная, отменённая
 * и отклонённая — возвращает: это сказано в каждом сообщении.
 */
export function tripoTaskError(
  state: RemoteState,
  code: number | null,
  message: string | null,
): ProviderError {
  const detail = detailOf(message);

  if (state === 'banned' || code === 2008) {
    const text = 'Tripo отклонил данные по правилам содержания. Кредиты вернулись.';

    return providerError('moderation', code, text, detail);
  }

  if (state === 'expired') {
    return providerError('expired', code, 'Tripo удалил файлы этого заказа.', detail);
  }

  if (state === 'cancelled') {
    return providerError('server', code, 'Заказ отменён у Tripo. Кредиты вернулись.', detail);
  }

  const byCode: Readonly<Record<number, [ProviderError['kind'], string]>> = {
    1004: ['params', 'Tripo не принял входные данные. Кредиты вернулись.'],
    2018: ['complex', 'Обработка не уложилась во время — уменьшите число граней. Кредиты вернулись.'],
    2020: ['input', 'Tripo не смог скачать входной файл. Кредиты вернулись.'],
    2021: ['input', 'Файл слишком большой. Кредиты вернулись.'],
    2022: ['input', 'Картинка слишком большая. Кредиты вернулись.'],
  };
  const known = code === null ? undefined : byCode[code];

  if (known) {
    return providerError(known[0], code, known[1], detail);
  }

  const text = 'Tripo не справился. Кредиты вернулись — попробуйте ещё раз с другим сидом.';

  return providerError('server', code, text, detail);
}
