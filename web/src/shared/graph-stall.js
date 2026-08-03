// Человекочитаемое представление остановки внутри визуальной схемы.
// Сервер уже привязывает движковый STAGE к node; клиент только готовит подписи.

function cleanNodeLabel(label) {
  return String(label || '').replace(/^[^\p{L}\p{N}<]+/u, '').trim();
}

export function graphStallView(graph) {
  const stall = graph?.stall;
  if (!stall) return null;
  const node = stall.node || null;
  const rawNodeLabel = node ? graph.nodes?.[node]?.[1] : null;
  return {
    node,
    stage: stall.stage || null,
    nodeLabel: cleanNodeLabel(rawNodeLabel) || stall.stage || 'Конвейер',
    title: stall.title || 'Конвейер остановлен',
    hint: stall.hint || '',
    fails: Number.isFinite(stall.fails) ? stall.fails : null,
  };
}
