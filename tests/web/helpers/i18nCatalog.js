import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Ожидание и descriptor берутся из тех же JSON, которые читает проверяемый переводчик.
 * Имена ключей не привязывают тесты к способу разбиения каталога на группы.
 */
export async function catalogMessage(area, text) {
  const directory = new URL('../../../shared/i18n/assets/locales/', import.meta.url);
  const ru = JSON.parse(await readFile(new URL(`ru/${area}.json`, directory), 'utf8'));
  const en = JSON.parse(await readFile(new URL(`en/${area}.json`, directory), 'utf8'));

  /**
   * Обход сохраняет реальный путь в каталоге, включая вложенные группы.
   * Числовые plural-ветви здесь не нужны: ищется простая подпись UI.
   */
  function find(value, parts = []) {
    for (const [key, child] of Object.entries(value)) {
      if (child === text) {
        return [...parts, key];
      }

      if (child && typeof child === 'object') {
        const found = find(child, [...parts, key]);

        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  const parts = find(ru);

  assert.ok(parts, `${area}: в русском каталоге есть «${text}»`);

  const english = parts.reduce((value, key) => value?.[key], en);

  assert.equal(typeof english, 'string', `${area}: тот же ключ переведён в EN`);
  assert.ok(english.trim());

  return { 
    key: [area, ...parts].join('.'), 
    ru: text, 
    en: english 
  };
}
