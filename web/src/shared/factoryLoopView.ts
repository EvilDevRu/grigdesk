import type { FactoryGraphData } from '../../../shared/pipeline/factoryGraphContracts.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


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
    ? translateUi('core.factoryLoopViewRoundUnknown')
    : round === 0 ? translateUi('core.factoryLoopViewBeforeTheFirstRound')
      : maxRounds ? translateUi('core.factoryLoopRoundOf', { round, maxRounds })
        : translateUi('core.factoryLoopViewRound', { round, value: '' });
  let activity = translateUi('core.factoryLoopViewLoopPaused');

  if (activeNode) {
    const action = activeNode === loop.worker
      ? translateUi('core.factoryLoopViewExecuting')
      : round === 0
        ? translateUi('core.factoryLoopViewCreatingATask')
        : translateUi('core.factoryLoopViewVerifying');

    activity = `${action}: ${graph.nodes[activeNode]?.[1] || activeNode}`;
  } else if (['done', 'skip'].includes(statuses[loop.lead] ?? '')) {
    activity = translateUi('core.factoryLoopViewVerificationPassedLeavingTheLoop');
  } else if (graph.stall) {
    activity = translateUi('core.factoryLoopViewLoopStopped');
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
