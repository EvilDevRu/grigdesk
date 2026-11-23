import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

// Общий предел второй попытки happy-eyeballs. На битых маршрутах (VPN с мёртвым
// IPv6) отказ параллельной IPv6-попытки обрывает ещё не установившееся IPv4-соединение:
// 2000 мс дают здоровому семейству выиграть гонку до старта отказывающей попытки.
// Прецедент того же предела для npm — providerInstall/npmEnvironment.ts.
export const NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS = 2000;

/**
 * Применяет общий предел попыток выбора семейства к текущему Node-процессу.
 * Вызывается до первых сетевых запросов сервера; сетевые дети применяют его в своём bootstrap.
 */
export function applyNetworkFamilyAttemptTimeout(): void {
  setDefaultAutoSelectFamilyAttemptTimeout(NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS);
}