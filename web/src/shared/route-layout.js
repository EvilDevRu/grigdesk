// Автораскладка схемы маршрута из цепочки агентов + возвратов.
// На входе — суть маршрута (routes/<id>.json) и база агентов; на выходе — граф
// в формате FactoryGraph ({nodes, pos, edges}). Никаких ручных координат:
// блоки раскладываются змейкой (ряд слева направо, следующий — справа налево),
// перенос ряда — вертикальным ребром, возвраты — дугами.

const KIND_PREFIX = { agent: '🤖 ', human: '👤 ', code: '</> ' };
const ROW_Y0 = 50;      // y первого ряда
const ROW_STEP = 150;   // шаг рядов (запас под дуги возвратов)
const GAP = 72;         // зазор между блоками в ряду
const MAX_X = 1980;     // правая граница ряда
const X0 = 110;         // левый отступ первого блока

/** Полуширина блока — та же формула, что в geometrии графа (graph-geom.nodeGeom). */
function halfWidth(kind, label) {
  if (kind === 'code') return 70;
  return Math.max(58, Math.floor(([...label].length + 2) * 3.8) + 14);
}

/**
 * Строит граф для FactoryGraph из маршрута.
 * @param {string[]} stages — цепочка id агентов
 * @param {Array<{from: string, to: string, label: string}>} returns — возвраты
 * @param {Map<string, object>|object} agentsById — база агентов (id → агент)
 */
export function layoutRoute(stages, returns, agentsById) {
  const agentOf = (id) => (agentsById instanceof Map ? agentsById.get(id) : agentsById[id]) || null;

  // Узлы: форма и подпись из базы агентов (иконка — по виду, как в схемах фабрики).
  const nodes = {};
  for (const id of stages) {
    const a = agentOf(id);
    const kind = a?.kind || 'agent';
    nodes[id] = [kind, (KIND_PREFIX[kind] || '') + (a?.label || id), a?.sub || ''];
  }

  // Раскладка змейкой. rowOf/idxOf нужны для выбора типа дуг возвратов.
  const pos = {};
  const rowOf = {}; const idxOf = {};
  let row = 0; let dir = 1; // 1 — вправо, -1 — влево
  let cursor = X0;          // x ближнего края следующего блока (по направлению)
  stages.forEach((id, i) => {
    const [kind, label] = nodes[id];
    const hw = halfWidth(kind, label);
    let cx = dir === 1 ? cursor + hw : cursor - hw;
    const overflow = dir === 1 ? cx + hw > MAX_X : cx - hw < X0 - 40;
    if (overflow && i > 0) {
      // Перенос: новый ряд идёт в обратную сторону, а первый блок ряда встаёт
      // ПОД предыдущим (тот же x) — переход рисуется вертикальным ребром.
      row++; dir = -dir;
      cx = pos[stages[i - 1]][0];
    }
    pos[id] = [cx, ROW_Y0 + row * ROW_STEP];
    rowOf[id] = row; idxOf[id] = i;
    cursor = cx + dir * (hw + GAP);
  });

  // Рёбра основной цепочки: старт → первый, дальше h в ряду / v на переносе.
  const edges = [];
  if (stages.length) edges.push(['_start', stages[0], '', 'plain', 'h']);
  for (let i = 1; i < stages.length; i++) {
    const a = stages[i - 1]; const b = stages[i];
    edges.push([a, b, '', 'plain', rowOf[a] === rowOf[b] ? 'h' : 'v']);
  }

  // Возвраты: дугой над первым рядом, под остальными; длинные — «высокой» дугой.
  for (const r of returns) {
    if (!(r.from in pos) || !(r.to in pos)) continue;
    const span = Math.abs(idxOf[r.from] - idxOf[r.to]);
    let routing;
    if (rowOf[r.from] === rowOf[r.to]) {
      routing = rowOf[r.from] === 0
        ? (span > 3 ? 'arc_up_hi' : 'arc_up')
        : (span > 3 ? 'arc_down_hi' : 'arc_down');
    } else {
      routing = 'arc_down_hi';
    }
    edges.push([r.from, r.to, r.label || '', 'fail', routing]);
  }

  return { nodes, pos, edges, vb: '' };
}
