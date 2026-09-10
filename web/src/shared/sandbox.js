// Адреса живых стендов (песочниц) задач.
//
// Стенды слушают динамические порты на мозге (сейчас 519x — фронт, 809x — API, плюс слоты
// 517x/808x). Как до них дотянуться — зависит от того, откуда открыт кокпит:
//
// 1. С самого мозга или из локальной сети — напрямую по порту: `http://<хост мозга>:<порт>`.
//    Хост берём у МОЗГА (api.base или текущий origin), а не подставляем localhost: окно
//    открывают с планшета, где localhost — это само устройство-окно.
//
// 2. Снаружи, через шлюз — по ПОДДОМЕНУ: `https://p<порт>.<текущий хост>`. Наружу открыт только
//    443, поэтому порт живёт в имени: шлюз и локальный Caddy разбирают его из Host и проксируют
//    на нужный порт. Поддомен, а НЕ подпуть — принципиально: дев-сервер Vite отдаёт ассеты
//    от корня (`base: '/'`), под подпутём он ломается, а на поддомене работает как дома.
import { api } from './apiClient.ts';

/**
 * Хост машины, на которой живут стенды (= машина мозга).
 */
function brainHostname() {
  const base = api.base || (typeof location !== 'undefined' ? location.origin : '');
  try {
    return new URL(base).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}

/**
 * Имя хоста — литеральный адрес (IPv4/IPv6) или localhost? К такому поддомен не приклеить.
 */
function isBareAddress(host) {
  return host === 'localhost'
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    || host.includes(':')
    || host.startsWith('[');
}

/**
 * Работаем через шлюз: соединение защищённое И хост — настоящее доменное имя.
 * Локальный TLS на localhost сюда не попадает — там прямой доступ по порту короче и надёжнее.
 */
function viaGateway() {
  if (typeof location === 'undefined') return false;
  return location.protocol === 'https:' && !isBareAddress(brainHostname());
}

/**
 * Адрес стенда по номеру порта. Пустой порт → null (стенд не поднят).
 */
export function sandboxUrl(port) {
  if (!port) return null;
  const host = brainHostname();
  // Схему для прямого доступа форсим http: стенды — обычные dev-серверы без TLS. Переход по
  // ссылке в новую вкладку это top-level navigation, под блокировку смешанного контента
  // он не попадает (в отличие от iframe).
  return viaGateway()
    ? `https://p${port}.${host}/`
    : `http://${host}:${port}/`;
}
