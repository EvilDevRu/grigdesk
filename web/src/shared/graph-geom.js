// Геометрия клиентской схемы. Порядок, связи и статусы остаются серверными;
// координаты уплотняются под узлы с внешними подписями без масштабирования мелкого текста.

export const START_DOT = [18, 52];

const HALF_WIDTH = 88;
const LINE_HEIGHT = 16;
const ROW_GAP = 20;
const COLUMN_GAP = 24;

/**
 * Переносит длинное название по словам, сохраняя весь текст.
 * Длинное слово режется по код-пойнтам, чтобы не разрывать суррогатную пару.
 */
export function nodeLabelLines(label) {
  const lines = [];
  let line = '';

  for (const word of String(label).split(/\s+/).filter(Boolean)) {
    const characters = [...word];

    if (line && [...line].length + characters.length + 1 > 18) {
      lines.push(line);
      line = '';
    }

    while (characters.length > 18) {
      lines.push(characters.splice(0, 18).join(''));
    }

    const rest = characters.join('');

    line = line ? `${line} ${rest}` : rest;
  }

  if (line) {
    lines.push(line);
  }

  return lines.length ? lines : [''];
}

/**
 * Круг или ромб стоит на линии маршрута, название и исполнитель находятся под ним.
 * Асимметричные границы учитывают всю подпись, сохраняя общий уровень значков в ряду.
 */
export function nodeGeom(nid, pos, nodes) {
  const label = nodes[nid]?.[1] || nid;
  const lines = nodeLabelLines(label);
  const [cx, cy] = pos[nid];
  const radius = nodes[nid]?.[0] === 'code' ? 26 : 22;
  const labelY = cy + 42;
  const detailY = labelY + (lines.length - 1) * LINE_HEIGHT + 6;
  const top = cy - radius;
  const bottom = detailY + LINE_HEIGHT;

  return {
    cx,
    cy,
    hw: HALF_WIDTH,
    hh: (bottom - top) / 2,
    radius,
    top,
    bottom,
    labelY,
    detailY,
  };
}

/**
 * Сохраняет взаимное расположение серверных узлов, сжимая пустые промежутки.
 * Общий масштаб X оставляет вертикальные стыки змейки на месте. Одиночная параллельная
 * ветка занимает свободный левый край следующего ряда, если там хватает места.
 * @returns {Record<string, import('../../../shared/factoryGraphContracts.ts').GraphPosition>}
 */
export function layoutGraphPositions(pos, nodes, withReturns = false, parallelNodes = []) {
  const rows = new Map();
  /** @type {Record<string, import('../../../shared/factoryGraphContracts.ts').GraphPosition>} */
  const result = {};

  for (const [id, [x, y]] of Object.entries(pos)) {
    const row = rows.get(y) || [];

    row.push({
      id,
      x,
    });
    rows.set(y, row);
  }

  const sortedRows = [...rows.entries()].sort(([left], [right]) => left - right);
  let scale = 0;

  for (const [, row] of sortedRows) {
    row.sort((left, right) => left.x - right.x);

    for (let index = 1; index < row.length; index += 1) {
      const gap = row[index].x - row[index - 1].x;

      if (gap > 0) {
        scale = Math.max(scale, (HALF_WIDTH * 2 + COLUMN_GAP) / gap);
      }
    }
  }

  const minimumX = Math.min(...Object.values(pos).map(([x]) => x));
  const packedRows = [];

  for (const [index, [, row]] of sortedRows.entries()) {
    const nextRow = sortedRows[index + 1]?.[1];
    const branch = row.length === 1 && parallelNodes.includes(row[0].id) ? row[0] : null;
    const space = nextRow ? (nextRow[0].x - minimumX) * (scale || 1) : 0;

    if (branch && nextRow && space >= HALF_WIDTH * 2 + COLUMN_GAP) {
      nextRow.unshift({
        id: branch.id,
        x: minimumX,
      });

      continue;
    }

    packedRows.push(row);
  }

  let previousBelow = 0;
  let cy = START_DOT[1];

  for (const [index, row] of packedRows.entries()) {
    const geometry = row.map(({ id }) => nodeGeom(id, pos, nodes));
    const above = Math.max(...geometry.map((node) => node.radius));
    const below = Math.max(...geometry.map((node) => node.bottom - node.cy));

    if (index > 0) {
      cy += previousBelow + above + ROW_GAP + (withReturns ? 56 : 0);
    }

    for (const { id, x } of row) {
      result[id] = [HALF_WIDTH + 44 + (x - minimumX) * (scale || 1), cy];
    }

    previousBelow = below;
  }

  return result;
}

/**
 * Скругляет ортогональный маршрут без ручных коэффициентов Безье.
 * Опорные точки одновременно задают безопасные границы пути для viewBox.
 */
function roundedPath(points, label = null) {
  const clean = points.filter((point, index) => (
    index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]
  ));
  let d = `M ${clean[0][0]} ${clean[0][1]}`;

  for (let index = 1; index < clean.length - 1; index += 1) {
    const previous = clean[index - 1];
    const corner = clean[index];
    const next = clean[index + 1];
    const before = Math.hypot(corner[0] - previous[0], corner[1] - previous[1]);
    const after = Math.hypot(next[0] - corner[0], next[1] - corner[1]);
    const radius = Math.min(10, before / 2, after / 2);
    const entry = corner.map((value, axis) => value + (previous[axis] - value) * radius / before);
    const leave = corner.map((value, axis) => value + (next[axis] - value) * radius / after);

    d += ` L ${entry[0]} ${entry[1]} Q ${corner[0]} ${corner[1]} ${leave[0]} ${leave[1]}`;
  }

  const last = clean[clean.length - 1];

  d += ` L ${last[0]} ${last[1]}`;

  return {
    d,
    label,
    bounds: clean,
  };
}

/**
 * Линии входят в круг или ромб; вертикальные выходы обходят подписи по межколоночному зазору.
 * Возвраты сохраняют ортогональные полосы над рядами, под подписями и вокруг правого края.
 */
export function edgePath(src, dst, routing, pos, nodes, lane = 0) {
  const source = src === '_start'
    ? {
      cx: START_DOT[0] + 4,
      cy: START_DOT[1],
      hw: 0,
      hh: 0,
      radius: 0,
    }
    : nodeGeom(src, pos, nodes);
  const destination = nodeGeom(dst, pos, nodes);
  const { cx: sx, cy: sy, radius: sr } = source;
  const { cx: dx, cy: dy, radius: dr } = destination;
  const rowNodes = (y) => Object.keys(pos)
    .filter((id) => pos[id][1] === y)
    .map((id) => nodeGeom(id, pos, nodes));
  const rowTop = (y) => Math.min(...rowNodes(y).map((node) => node.top));
  const rowBottom = (y) => Math.max(...rowNodes(y).map((node) => node.bottom));
  const sourceSideX = sx + source.hw + COLUMN_GAP / 2;
  const destinationSideX = dx + destination.hw + COLUMN_GAP / 2;

  if (routing?.startsWith('arc_')) {
    const slot = lane % 3;

    if (sy === dy && routing.startsWith('arc_up')) {
      const railY = rowTop(sy) - 28 - slot * 16;

      if (src === dst) {
        return roundedPath([
          [sx - sr, sy],
          [sx - sr - 20, sy],
          [sx - sr - 20, railY],
          [sx + sr + 20, railY],
          [sx + sr + 20, sy],
          [sx + sr, sy],
        ], [sx, railY - 8]);
      }

      return roundedPath([
        [sx, sy - sr],
        [sx, railY],
        [dx, railY],
        [dx, dy - dr],
      ], [(sx + dx) / 2, railY - 8]);
    }

    if (sy === dy) {
      const railY = rowBottom(sy) + 28 + slot * 16;
      const entrySide = src === dst ? -1 : 1;
      const entryX = dx + entrySide * (destination.hw + COLUMN_GAP / 2);

      return roundedPath([
        [sx + sr, sy],
        [sourceSideX, sy],
        [sourceSideX, railY],
        [entryX, railY],
        [entryX, dy],
        [dx + entrySide * dr, dy],
      ], [(sourceSideX + entryX) / 2, railY - 8]);
    }

    const right = Math.max(...Object.values(pos).map(([x]) => x)) + HALF_WIDTH;
    const railX = right + 28 + slot * 16;
    const sourceY = rowBottom(sy) + 26 + slot * 16;
    const destinationY = rowBottom(dy) + 26 + slot * 16;

    return roundedPath([
      [sx + sr, sy],
      [sourceSideX, sy],
      [sourceSideX, sourceY],
      [railX, sourceY],
      [railX, destinationY],
      [destinationSideX, destinationY],
      [destinationSideX, dy],
      [dx + dr, dy],
    ], [(sx + railX) / 2, sourceY - 8]);
  }

  if (routing === 'to_sandbox') {
    return roundedPath([[sx, sy], [sx, dy], [dx - dr, dy]]);
  }

  if ((routing === 'from_sandbox' || routing === 'v') && sy !== dy) {
    if (dy > sy) {
      const middleY = (rowBottom(sy) + rowTop(dy)) / 2;

      return roundedPath([
        [sx + sr, sy],
        [sourceSideX, sy],
        [sourceSideX, middleY],
        [dx, middleY],
        [dx, dy - dr],
      ], [Math.max(sx, dx) + 40, middleY + 4]);
    }

    const middleY = (rowTop(sy) + rowBottom(dy)) / 2;

    return roundedPath([
      [sx, sy - sr],
      [sx, middleY],
      [destinationSideX, middleY],
      [destinationSideX, dy],
      [dx + dr, dy],
    ], [Math.max(sx, dx) + 40, middleY + 4]);
  }

  const direction = dx >= sx ? 1 : -1;
  const sourceX = sx + direction * sr;
  const destinationX = dx - direction * dr;
  const middleX = (sourceX + destinationX) / 2;

  return roundedPath([
    [sourceX, sy],
    [middleX, sy],
    [middleX, dy],
    [destinationX, dy],
  ], [middleX, sy - 10]);
}

/**
 * Холст включает значки, внешние подписи, метки арбитра и все видимые линии.
 * Запас вокруг опорных точек не даёт обрезать возвраты у края SVG.
 */
export function computeViewBox(pos, nodes, paths = []) {
  const xs = [START_DOT[0]];
  const ys = [START_DOT[1]];

  for (const nid of Object.keys(pos)) {
    const { cx, hw, top, bottom } = nodeGeom(nid, pos, nodes);

    xs.push(cx - hw, cx + hw);
    ys.push(top - 20, bottom);
  }

  for (const path of paths) {
    for (const [x, y] of path.bounds || []) {
      xs.push(x);
      ys.push(y);
    }

    if (path.label) {
      const halfLabel = Math.max(28, [...(path.labelText || '')].length * 3);

      xs.push(path.label[0] - halfLabel, path.label[0] + halfLabel);
      ys.push(path.label[1] - 14, path.label[1]);
    }
  }

  const x0 = Math.floor(Math.min(...xs) - 16);
  const y0 = Math.floor(Math.min(...ys) - 16);
  const x1 = Math.ceil(Math.max(...xs) + 16);
  const y1 = Math.ceil(Math.max(...ys) + 16);

  return `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
}

export const MARKS = {
  done: '✓',
  run: '●',
  wait: '⏳',
  stall: '⚠',
  skipbad: '⚠',
  premature: '⚠',
  fail: '✗',
  arb: '⚖',
  skip: '—',
  idle: '?',
  pending: '',
};
