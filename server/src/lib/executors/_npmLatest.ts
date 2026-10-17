// Последняя опубликованная версия CLI-исполнителя и сравнение с установленной.
// Оба наших CLI (claude-code, codex) публикуются в npm-реестре — это самый дешёвый
// и одинаковый для них источник «а не вышло ли новее»: один HTTP-запрос, без подпроцессов.
// Обновление НИКОГДА не запускается само — это только индикатор для пользователя.

import { setTimeout as pause } from 'node:timers/promises';

/**
 * Версия пакета с тегом latest. null — сеть недоступна/пакет не найден
 * (тогда индикатор просто не показывается, ошибок в UI нет).
 */
export async function npmLatest(pkg: string): Promise<string | null> {
  // Сеть на стенде флапает (VPN): один и тот же запрос то падает, то отвечает за 0.5 с.
  // Три попытки с паузой — иначе индикатор обновления гас бы на ровном месте.
  for (let i = 0; i < 3; i++) {
    try {
      // Без abbreviated-заголовка (`application/vnd.npm.install-v1+json`): на эндпоинте
      // `/latest` реестр отвечает на него 406 — тот формат только для полного документа пакета.
      const r = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const d = await r.json();
        if (typeof d?.version === 'string') return d.version;
      }
    } catch { /* сетевой сбой — пробуем ещё раз */ }

    if (i < 2) {
      await pause(800);
    }
  }
  return null;
}

/**
 * Числа версии из произвольной строки CLI: «2.1.85 (Claude Code)» → [2,1,85],
 * «codex-cli 0.145.0» → [0,145,0]. Нет чисел — null.
 */
export function parseVersion(s: unknown): [number, number, number] | null {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Установленная версия старше опубликованной? Неполные данные → false:
 * лучше не показать индикатор, чем звать обновляться без повода.
 */
export function isOutdated(current: unknown, latest: unknown): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (Number(b[i]) > Number(a[i])) return true;
    if (Number(b[i]) < Number(a[i])) return false;
  }
  return false;
}
