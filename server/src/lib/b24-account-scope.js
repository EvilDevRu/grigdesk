// Область пользовательских B24-данных кокпита. Браузер её не передаёт: она выводится
// из портала и номера пользователя, а наружу уходит только непрозрачным хешем — иначе
// клиент мог бы попросить чужой набор. Общая для избранного и просмотренного, чтобы
// одна и та же учётка не получила два разных ключа.
import { createHash } from 'node:crypto';

function normalizedPortal(baseUrl) {
  const url = new URL(String(baseUrl));
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

/** @throws если identity неполна — вызывающий переводит это в свою ошибку контракта. */
export function b24AccountScope(identity) {
  const userId = String(identity?.userId ?? '').trim();
  if (!/^[1-9]\d*$/.test(userId)) throw new Error('invalid user id');
  const portal = normalizedPortal(identity?.baseUrl);
  return createHash('sha256').update(`${portal}\0${userId}`).digest('hex');
}
