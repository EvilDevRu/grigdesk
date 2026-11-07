import type { FactoryGraphData } from '../../../shared/pipeline/factoryGraphContracts.ts';

/**
 * Петлю определяет закреплённый маршрут, а движение — живость демона и текущий узел.
 * Возвраты обычного маршрута и старый статус run после остановки не изображают работу пары.
 */
export function factoryLoopView(graph: FactoryGraphData, reference = false) {
  const loop = graph.loop;

  if (!loop || !graph.pos[loop.lead] || !graph.pos[loop.worker]) {
    return null;
  }

  const statuses = graph.statuses ?? {};
  const activeNode = !reference && graph.daemonAlive === true && !graph.stall
    ? [loop.worker, loop.lead].find((id) => statuses[id] === 'run') ?? null
    : null;
  const round = reference ? null : graph.loopProgress?.round ?? null;
  const maxRounds = reference ? null : graph.loopProgress?.maxRounds ?? null;
  const stage = reference ? null : graph.loopProgress?.stage ?? null;
  const roundLabel = round === null
    ? 'Круг неизвестен'
    : round === 0 ? 'До первого круга' : `Круг ${round}${maxRounds ? ` из ${maxRounds}` : ''}`;
  let activity = 'Петля на паузе';

  if (activeNode) {
    const action = activeNode === loop.worker ? 'Выполняет' : round === 0 ? 'Ставит задачу' : 'Проверяет';

    activity = `${action}: ${graph.nodes[activeNode]?.[1] || activeNode}`;
  } else if (['done', 'skip'].includes(statuses[loop.lead] ?? '')) {
    activity = 'Проверка пройдена · выход из петли';
  } else if (graph.stall) {
    activity = 'Петля остановлена';
  }

  return {
    ...loop,
    activeNode,
    round,
    roundLabel,
    stage,
    activity,
  };
}
