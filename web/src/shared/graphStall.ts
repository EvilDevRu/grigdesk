import { isRecord } from '../../../shared/lib/objects.ts';
import type { FactoryGraphData } from '../../../shared/pipeline/factoryGraphContracts.ts';
import {

  normalizeStallText,
  readStallPresentation,
} from '../../../shared/pipeline/stallPresentation.ts';
import { runnerModelLabel, runnerNodeLabel } from './runnerDisplay.ts';
import type { RunnerState } from './runnerDisplay.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);


type StallGraph = Partial<Pick<FactoryGraphData, 'nodes' | 'stall' | 'nodeOrigins'>> & {
  keys?: Record<string, string>;
  runnerKeys?: Record<string, string>;
  nodeMeta?: Record<string, { runner?: RunnerState }>;
};

function cleanNodeLabel(label: unknown): string {
  return String(label || '').replace(/^[^\p{L}\p{N}<]+/u, '').trim();
}

/**
 * Сводочная остановка может не иметь node: граф уже знает точный узел стенда.
 * Неизвестный этап не становится сырой подписью узла в интерфейсе.
 */
function stallNode(graph: StallGraph | null | undefined, stall: Record<string, unknown>): string | null {
  if (stall.phase === 'bootstrap') {
    return Object.entries(graph?.nodeOrigins || {}).find(([, origin]) => (
      origin.scope === 'bootstrap' && origin.originId === 'scout'
    ))?.[0] || null;
  }

  if (typeof stall.node === 'string' && graph?.nodes?.[stall.node]) {
    return stall.node;
  }

  const graphStop = isRecord(graph?.stall) ? graph.stall : null;

  if (stall.stage && graphStop?.stage === stall.stage && typeof graphStop.node === 'string') {
    return graphStop.node;
  }

  return Object.keys(graph?.nodes || {}).find((id) => stall.stage && (
    graph?.keys?.[id] === stall.stage || graph?.runnerKeys?.[id] === stall.stage
    || id.toUpperCase() === stall.stage
  )) || (typeof stall.node === 'string' ? stall.node : null);
}

/**
 * Сохраняет полные title/hint для подсказки узла и добавляет отдельный краткий вид.
 * Кривое необязательное расширение и старый сервер используют полную прозу без разрезания.
 */
export function graphStallView(graph: StallGraph | null | undefined, input: unknown = graph?.stall) {
  if (!isRecord(input)) {
    return null;
  }

  const node = stallNode(graph, input);
  const stage = typeof input.stage === 'string' ? input.stage : null;
  const title = typeof input.title === 'string' && input.title
    ? input.title
    : t('core.pipelineKonveyerOstanovlen');
  const hint = typeof input.hint === 'string' ? input.hint : '';
  const presentation = readStallPresentation(input.presentation);
  const reason = normalizeStallText(stage && title.startsWith(`${stage}: `)
    ? title.slice(stage.length + 2) : title);
  const runner = node ? graph?.nodeMeta?.[node]?.runner : undefined;
  const actualModel = runner?.actual && runner.model ? runnerModelLabel(runner) : '';
  const model = actualModel || presentation?.model || runnerModelLabel(runner);

  return {
    node,
    stage,
    nodeLabel: cleanNodeLabel(node ? graph?.nodes?.[node]?.[1] : '') || t('core.pipeline'),
    title,
    hint,
    fails: typeof input.fails === 'number' && Number.isFinite(input.fails) ? input.fails : null,
    reason: presentation?.reason || reason,
    summary: presentation?.summary || normalizeStallText(hint),
    details: presentation?.details || {
      what: normalizeStallText(title),
      ...(hint ? { action: normalizeStallText(hint) } : {}),
    },
    attempts: presentation?.attempts,
    returns: presentation?.returns,
    lastFailure: presentation?.lastFailure || '',
    model,
    runner: runner ? runnerNodeLabel(runner) : '',
  };
}

export type GraphStallView = NonNullable<ReturnType<typeof graphStallView>>;
