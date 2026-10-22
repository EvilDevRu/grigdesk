import type { FactoryGraphData } from '../../../shared/pipeline/factoryGraphContracts.ts';

interface Stall {
  node?: string;
  stage?: string;
  title?: string;
  hint?: string;
  fails?: number;
}

// Человекочитаемое представление остановки внутри визуальной схемы.
// Сервер уже привязывает движковый STAGE к node; клиент только готовит подписи.

function cleanNodeLabel(label: unknown): string {
  return String(label || '').replace(/^[^\p{L}\p{N}<]+/u, '').trim();
}

/**
 * Готовит подписи уже привязанной к узлу остановки без изменения серверного графа.
 * Отсутствующая остановка не создаёт тревожную плашку на здоровом маршруте.
 */
export function graphStallView(graph: Pick<FactoryGraphData, 'nodes' | 'stall'> | null | undefined) {
  const stall = graph?.stall as Stall | null | undefined;

  if (!stall) {
    return null;
  }

  const node = stall.node || null;
  const rawNodeLabel = node ? graph!.nodes?.[node]?.[1] : null;

  return {
    node,
    stage: stall.stage || null,
    nodeLabel: cleanNodeLabel(rawNodeLabel) || stall.stage || 'Конвейер',
    title: stall.title || 'Конвейер остановлен',
    hint: stall.hint || '',
    fails: Number.isFinite(stall.fails) ? stall.fails : null,
  };
}
