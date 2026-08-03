// Откуда берётся пара для https-сокета: явный env-override, выпущенное из «Настроек» — или ничего.
// Вынесено из app.js отдельным модулем ровно затем, чтобы решение можно было проверить тестом:
// app.js при импорте поднимает сервер, и внутрь него тест не заглянет.
import { readFileSync } from 'node:fs';
import tlsLib from 'node:tls';
import { X509Certificate } from 'node:crypto';

/**
 * @param {object} opts
 * @param {string} opts.keyPath   COCKPIT_TLS_KEY (пусто — не задан)
 * @param {string} opts.certPath  COCKPIT_TLS_CERT
 * @param {boolean} opts.modeEnabled  тумблер «Доступ → Локальный HTTPS» (prefs.accessLocalHttps)
 * @param {{load: () => object}} opts.localTls
 * @returns {{source: 'env'|'state'|'none', key?: Buffer, cert?: Buffer, fingerprint?: string, error?: string}}
 *
 * Разница в поведении при ошибке намеренная. Пути в env — явное намерение оператора (шлюз,
 * ручной сертификат), тихо проигнорировать его нельзя: падаем сразу с понятной ошибкой.
 * Сертификат из `.state` выпущен кнопкой в браузере — и если он битый, сервер обязан подняться
 * по http, иначе кнопка в браузере устраивает вечный крэш-луп под `Restart=always`, а чинить
 * его можно только с консоли мозга — это отдельный сценарий восстановления после сбоя.
 */
export function loadTlsSource({ keyPath, certPath, modeEnabled, localTls }) {
  if (!!keyPath !== !!certPath) {
    throw new Error('COCKPIT_TLS_KEY и COCKPIT_TLS_CERT должны быть заданы вместе');
  }
  if (keyPath && certPath) {
    let key; let cert;
    try {
      key = readFileSync(keyPath);
      cert = readFileSync(certPath);
      tlsLib.createSecureContext({ key, cert });
    } catch (err) {
      throw new Error(`Не годится TLS-сертификат (COCKPIT_TLS_KEY / COCKPIT_TLS_CERT): ${err.message}`);
    }
    return {
      source: 'env', key, cert, fingerprint: new X509Certificate(cert).fingerprint256,
    };
  }
  // Тумблер режима проверяем ПОСЛЕ env: заданный руками сертификат им не гасится — это
  // настройка машины, а не режим в UI, и человек за консолью не ждёт, что галка в браузере
  // отменит его переменные окружения.
  //
  // Выключенный тумблер не трогает файлы на диске: он лишь не поднимает сокет. Обратное
  // включение — тумблер плюс перезапуск, без повторной установки корня на устройства.
  if (!modeEnabled) return { source: 'none', error: '' };

  const local = localTls.load();
  if (!local.ok) {
    return { source: 'none', error: local.reason === 'disabled' ? '' : local.reason };
  }
  return { source: 'state', ...local };
}
