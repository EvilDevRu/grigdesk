// Единый ответ на вопрос «чего конвейер ждёт от человека».
// Спрашивают четверо: карточка на странице конвейера, вотчер оповещений, чип в
// навигации и телеграм-пульт — и считать они обязаны одинаково, иначе цифра на чипе
// разойдётся с тем, что видно на странице, и чипу перестанут верить. Копий этой
// логики было уже две.
//
// Модуль общий для сервера и браузера: на входе только граф задачи, на выходе — текст.

// Граф задачи в той части, которую читает это правило. Он приходит ответом сети,
// поэтому подписи узлов объявлены настолько же мягко, насколько их отдаёт сервер.
export interface PipelineGraph {
  route?: string;
  statuses?: Record<string, string | undefined>;
  pos?: Record<string, unknown>;
  nodes?: Record<string, readonly unknown[] | undefined>;
}

export interface PipelineWaitReason {
  node: string;
  text: string;
  premature: boolean;
}

// Человеческая расшифровка ворот: подпись узла на схеме короткая («Приёмка»),
// а в оповещении и подсказке чипа нужно ДЕЙСТВИЕ, которое от меня ждут.
export const GATE_REASON: Record<string, string> = {
  'hunt/gate_accept': 'принять находки и покрытие',
  'perf/gate_plan': 'утвердить замер, цель и guardrails',
  gate_accept: 'принять работу — проверить в браузере',
  gate_plan: 'утвердить план работ',
  gate_cause: 'подтвердить причину',
};

/** Подпись узла без ведущей эмодзи-иконки. */
export function stripEmoji(value: string | null | undefined): string {
  return (value || '').replace(/^[^\wА-Яа-яЁё]+/, '').trim();
}

/**
 * Ворота, на которых конвейер стоит и ждёт решения человека.
 * `node` — id узла ворот: телеграм-пульту он нужен, чтобы собрать кнопку решения
 * (ключ ворот для `/api/tasks/:id/gate/:key/:decision` берётся из `g.keys[node]`).
 */
export function waitingReason(graph: PipelineGraph | null | undefined): PipelineWaitReason | null {
  const statuses = graph?.statuses || {};

  // Идём по порядку узлов маршрута (pos), а не по карте статусов: если ждут двое,
  // назвать надо ближайшие ворота, а не случайные.
  for (const nid of Object.keys(graph?.pos || statuses)) {
    const status = statuses[nid];

    if ((status === 'wait' || status === 'premature') && nid.startsWith('gate_')) {
      const label = graph?.nodes?.[nid]?.[1];

      return {
        node: nid,
        text: GATE_REASON[`${graph?.route}/${nid}`]
          || GATE_REASON[nid]
          || stripEmoji(typeof label === 'string' ? label : '')
          || nid,
        premature: status === 'premature',
      };
    }
  }

  return null;
}
