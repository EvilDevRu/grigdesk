// Почему вложение не удалось подготовить — человеческой фразой.
//
// Канал отдаёт МАШИННЫЙ код: свободный текст ошибки провайдера содержит и URL с
// токеном, и чужие подробности, поэтому доверять ему нельзя ни в описании
// задачи, ни в браузере. Фразу по коду собирает кокпит, а числа (размер файла,
// лимит) приходят отдельными полями — подделать число нечем.

const CODE_RE = /^[a-z0-9_]{1,80}$/u;
const megabytes = (bytes) => Math.round(bytes / 1024 / 1024);

const TEXT = Object.freeze({
  file_too_large: 'файл больше предела бота — Telegram не отдаёт такие файлы',
  attachments_too_large: 'суммарный размер вложений обращения превышен',
  too_many_attachments: 'вложений в обращении больше, чем разбирается за раз',
  not_connected: 'канал отключён — файл не забрать',
  // Временный отказ обязан отличаться от постоянного не только кодом, но и
  // текстом: у потолка Bot API ждать бессмысленно, а здесь — единственное, что
  // помогает. Повторы транспорта уже израсходованы к этому моменту.
  download_failed: 'файл не удалось скачать — связь с Telegram оборвалась, попробуйте позже',
  attachment_failed: 'вложение не удалось подготовить',
});

/** Код причины или `null`, если канал прислал что-то иное. */
export function skipReasonCode(value) {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

/**
 * Фраза для человека. Незнакомый код не притворяется известным: он остаётся
 * общим «не удалось подготовить», иначе новый канал молча получил бы чужой текст.
 */
export function skipReasonText(value, { sizeBytes = null, limitBytes = null } = {}) {
  const code = skipReasonCode(value);
  const base = (code && TEXT[code]) || TEXT.attachment_failed;
  if (code !== 'file_too_large') return base;
  const size = Number.isSafeInteger(sizeBytes) && sizeBytes > 0 ? `файл ${megabytes(sizeBytes)} МБ` : null;
  const limit = Number.isSafeInteger(limitBytes) && limitBytes > 0
    ? `бот не может скачать больше ${megabytes(limitBytes)} МБ`
    : null;
  if (size && limit) return `${size} — ${limit}`;
  return base;
}
