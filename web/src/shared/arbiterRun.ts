import type { ArbiterRun } from '../../../shared/pipeline/factoryGraphContracts.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


// Идущий разбор арбитра — общая формулировка для всех поверхностей.
//
// Разбор виден в трёх местах: плашка свёрнутой карточки, узел схемы и модалка этого узла.
// Копия форматирования в каждом из них разошлась бы на первой же правке — ровно та беда,
// ради которой заведены общие `shared/pipeline/pipelineWait.ts` и `shared/pipeline/agentActivity.ts`.

/**
 * Короткая подпись «кто и сколько»: `сам · 3 мин`.
 *
 * `actor` отвечает на вопрос «почему задача едет без меня»: нажатую кнопку человек
 * помнит, а обход вотчера выглядит самодвижением конвейера.
 */
export function arbiterRunLabel(run: ArbiterRun | null | undefined): string {
  if (!run) {
    return '';
  }

  const who = run.actor === 'auto'
    ? translateUi('core.arbiterRunAutomatically')
    : translateUi('core.arbiterRunOnRequest');
  const sec = Math.max(0, Number(run.elapsedSec) || 0);
  const time = sec < 60
    ? translateUi('core.arbiterRunS', { sec: sec })
    : translateUi('core.arbiterRunMin', { value: Math.floor(sec / 60) });

  return `${who} · ${time}`;
}

// Остановка принадлежит узлу, и подсвечивается именно он. Набор невелик и закрыт: это
// те статусы, которые ставит остановка маршрута, а не любая краснота на схеме.
const ARBITRATED_STATUSES = new Set(['stall', 'premature']);

/**
 * Показывать ли узел разбираемым.
 *
 * Пока идёт разбор, задача снаружи неотличима от вставшей: тот же красный узел, та же
 * плашка. Человек читает это как «работа стоит на мне» и берётся за неё руками —
 * параллельно с арбитром, который её в этот момент и делает.
 */
export function nodeIsArbitrated(status: string, run: ArbiterRun | null | undefined): boolean {
  return Boolean(run) && ARBITRATED_STATUSES.has(status);
}
