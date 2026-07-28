// Геометрия графа конвейера — точный порт node_geom/edge_path из factory/lib/dashboard.py.
// len(label) в питоне считает КОД-ПОЙНТЫ, поэтому [...label].length (эмодзи = 1).

export const START_DOT = [30, 55];

/** Геометрия узла: {cx, cy, hw, hh}. code → ромб (70×27), иначе прямоугольник (ширина от подписи). */
export function nodeGeom(nid, pos, nodes) {
  const def = nodes[nid] || ['agent', nid, ''];
  const kind = def[0];
  const label = def[1] || nid;
  const [cx, cy] = pos[nid];
  if (kind === 'code') return { cx, cy, hw: 70, hh: 27 };
  const hw = Math.max(58, Math.floor(([...label].length + 2) * 3.8) + 14);
  return { cx, cy, hw, hh: 17 };
}

/**
 * Путь ребра по геометрии узлов. Возвращает { d, label: [lx, ly] }.
 * Порт edge_path (dashboard.py:591) — все 12 типов маршрутизации.
 */
export function edgePath(src, dst, routing, pos, nodes) {
  let sx, sy, shw, shh;
  if (src === '_start') {
    sx = START_DOT[0] + 4; sy = START_DOT[1]; shw = 0; shh = 0;
  } else {
    ({ cx: sx, cy: sy, hw: shw, hh: shh } = nodeGeom(src, pos, nodes));
  }
  const { cx: dx, cy: dy, hw: dhw, hh: dhh } = nodeGeom(dst, pos, nodes);
  const mid = (a, b) => Math.floor((a + b) / 2);
  const i = Math.floor;

  switch (routing) {
    case 'h': {
      const [x1, x2] = dx > sx ? [sx + shw, dx - dhw] : [sx - shw, dx + dhw];
      return { d: `M ${x1} ${sy} L ${x2} ${dy}`, label: [mid(x1, x2), sy - 10] };
    }
    case 'v':
      return { d: `M ${sx} ${sy + shh} L ${dx} ${dy - dhh}`, label: [sx + 14, mid(sy, dy)] };
    case 'arc_up': {
      const x1 = sx - i(shw * 0.5); const y1 = sy - shh;
      const x2 = dx + i(dhw * 0.5); const y2 = dy - dhh;
      const c = sy - shh - 46;
      return { d: `M ${x1} ${y1} C ${x1 - 40} ${c}, ${x2 + 40} ${c}, ${x2} ${y2}`, label: [mid(x1, x2), c + 8] };
    }
    case 'arc_up_hi': {
      const x1 = sx; const y1 = sy - shh;
      const x2 = dx + i(dhw * 0.35); const y2 = dy - dhh;
      const c = sy - shh - 72;
      return { d: `M ${x1} ${y1} C ${x1 - 100} ${c}, ${x2 + 120} ${c}, ${x2} ${y2}`, label: [mid(x1, x2), c + 10] };
    }
    case 'arc_down': {
      const x1 = sx + i(shw * 0.5); const y1 = sy + shh;
      const x2 = dx - i(dhw * 0.5); const y2 = dy + dhh;
      const c = sy + shh + 42;
      return { d: `M ${x1} ${y1} C ${x1 + 40} ${c}, ${x2 - 40} ${c}, ${x2} ${y2}`, label: [mid(x1, x2), c] };
    }
    case 'arc_down_hi': {
      const x1 = sx + i(shw * 0.3); const y1 = sy + shh;
      const x2 = dx - i(dhw * 0.3); const y2 = dy + dhh;
      const c = sy + shh + 78;
      return { d: `M ${x1} ${y1} C ${x1 + 120} ${c}, ${x2 - 120} ${c}, ${x2} ${y2}`, label: [mid(x1, x2), c] };
    }
    case 'to_sandbox':
      return { d: `M ${START_DOT[0] + 4} ${START_DOT[1] + 6} C 150 ${dy}, 500 ${dy}, ${dx - dhw} ${dy}`, label: null };
    case 'arc_down_x2': {
      const x1 = sx + i(shw * 0.3); const y1 = sy + shh;
      const x2 = dx - i(dhw * 0.1); const y2 = dy + dhh;
      const c = sy + shh + 104;
      return { d: `M ${x1} ${y1} C ${x1 + 200} ${c}, ${x2 - 260} ${c}, ${x2} ${y2}`, label: [mid(x1, x2), c - 4] };
    }
    case 'arc_down_x3': {
      const x1 = sx + i(shw * 0.3); const y1 = sy + shh;
      const x2 = dx; const y2 = dy + dhh;
      const c = sy + shh + 128;
      return { d: `M ${x1} ${y1} C ${x1 + 300} ${c}, ${x2 - 320} ${c}, ${x2} ${y2 + 4}`, label: [mid(x1, x2), c - 4] };
    }
    case 'arc_reject': {
      const x1 = sx + shw; const y1 = sy + 8;
      const x2 = dx + i(dhw * 0.2); const y2 = dy + dhh;
      const c = sy + 96;
      return { d: `M ${x1} ${y1} C ${x1 + 420} ${c}, ${x2 - 260} ${c - 30}, ${x2} ${y2 + 4}`, label: [mid(x1, x2), c - 16] };
    }
    case 'from_sandbox': {
      const x1 = sx + shw;
      const x2 = dx - i(dhw * 0.55); const y2 = dy - dhh;
      return { d: `M ${x1} ${sy} C ${x1 + 260} ${sy + 4}, ${x2 - 120} ${y2 - 38}, ${x2} ${y2}`, label: [mid(x1, x2), sy + 16] };
    }
    default:
      return { d: `M ${sx} ${sy} L ${dx} ${dy}`, label: null };
  }
}

/**
 * Тесный viewBox по фактическим узлам (порт graph_viewbox) — убирает пустоту,
 * которую давал зашитый в схему vb. Запас: ±24 по X, под подписи рёбер/сноски по Y.
 */
export function computeViewBox(pos, nodes) {
  const xs = []; const ys = [];
  for (const nid of Object.keys(pos)) {
    const { cx, cy, hw, hh } = nodeGeom(nid, pos, nodes);
    xs.push(cx - hw, cx + hw);
    ys.push(cy - hh - 26, cy + hh + 26);
  }
  if (!xs.length) return '0 0 100 100';
  const x0 = Math.min(...xs, START_DOT[0]) - 24;
  const x1 = Math.max(...xs) + 24;
  const y0 = Math.min(...ys) - 10;
  const y1 = Math.max(...ys) + 10;
  return `${Math.round(x0)} ${Math.round(y0)} ${Math.round(x1 - x0)} ${Math.round(y1 - y0)}`;
}

// Метка статуса узла (порт MARKS).
export const MARKS = {
  done: '✓', run: '●', wait: '⏳', stall: '⚠', skipbad: '⚠', premature: '⚠',
  // fail — узел провалился (пока это только ромб песочницы: стенд не поднялся).
  // Без своей метки он рисовался как обычный, и упавшая песочница #7789 выглядела
  // на схеме так же, как непройденная.
  fail: '✗',
  skip: '—', idle: '?', pending: '',
};
