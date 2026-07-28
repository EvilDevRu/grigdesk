// Единый ответ на вопрос «чего конвейер ждёт от человека».
// Спрашивают трое: карточка на странице конвейера, вотчер оповещений и чип в навигации —
// и считать они обязаны одинаково, иначе цифра на чипе разойдётся с тем, что видно
// на странице, и чипу перестанут верить. Копий этой логики было уже две.

// Человеческая расшифровка ворот: подпись узла на схеме короткая («Приёмка»),
// а в оповещении и подсказке чипа нужно ДЕЙСТВИЕ, которое от меня ждут.
export const GATE_REASON = {
  gate_accept: 'принять работу — проверить в браузере',
  gate_plan: 'утвердить план работ',
  gate_cause: 'подтвердить причину',
};

/** Подпись узла без ведущей эмодзи-иконки. */
export function stripEmoji(s) { return (s || '').replace(/^[^\wА-Яа-яЁё]+/, '').trim(); }

/**
 * Ворота, на которых конвейер стоит и ждёт решения человека.
 * @param {object} g граф задачи (ответ /api/tasks/:id/graph)
 * @returns {{text: string, premature: boolean}|null}
 */
export function waitingReason(g) {
  const statuses = g?.statuses || {};
  // Идём по порядку узлов маршрута (pos), а не по карте статусов: если ждут двое,
  // назвать надо ближайшие ворота, а не случайные.
  for (const nid of Object.keys(g?.pos || statuses)) {
    const s = statuses[nid];
    if ((s === 'wait' || s === 'premature') && nid.startsWith('gate_')) {
      return {
        text: GATE_REASON[nid] || stripEmoji(g.nodes?.[nid]?.[1]) || nid,
        premature: s === 'premature',
      };
    }
  }
  return null;
}
