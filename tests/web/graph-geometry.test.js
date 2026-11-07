import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeViewBox,
  edgePath,
  layoutGraphPositions,
  nodeGeom,
  nodeLabelLines,
} from '../../web/src/shared/graphGeom.ts';

const nodes = {
  build: ['agent', 'Исправление', ''],
  proof: ['code', 'Детерминированная проверка', ''],
  review: ['agent', 'Ревью', ''],
  browser: ['agent', 'Браузер', ''],
  sandbox: ['code', 'Песочница', 'Стенд готов'],
};
const positions = {
  build: [140, 50],
  proof: [480, 50],
  review: [820, 50],
  browser: [820, 210],
  sandbox: [480, 130],
};

test('уплотнение сохраняет ряды и вертикальные связи, не меняя серверный граф', () => {
  const before = structuredClone(positions);
  const result = layoutGraphPositions(positions, nodes);

  assert.deepEqual(positions, before);
  assert.equal(result.build[1], result.proof[1]);
  assert.equal(result.proof[1], result.review[1]);
  assert.equal(result.review[0], result.browser[0]);
  assert.equal(result.sandbox[1] > result.build[1], true);
  assert.equal(result.sandbox[1] < result.browser[1], true);
  assert.equal(result.review[0] - result.build[0] < positions.review[0] - positions.build[0], true);

  for (const [index, id] of Object.keys(result).entries()) {
    const first = nodeGeom(id, result, nodes);

    for (const other of Object.keys(result).slice(index + 1)) {
      const second = nodeGeom(other, result, nodes);
      const separated = Math.abs(first.cx - second.cx) > first.hw + second.hw
        || first.bottom < second.top || second.bottom < first.top;

      assert.equal(separated, true, `${id} и ${other} не перекрываются`);
    }
  }
});

test('длинное название сохраняется целиком и расширяет место под подпись, не увеличивая значок', () => {
  const label = 'Детерминированная проверка очень длинного названия этапа';
  const lines = nodeLabelLines(label);
  const short = nodeGeom('proof', positions, nodes);
  const tall = nodeGeom('proof', positions, { ...nodes, proof: ['code', label] });

  assert.equal(lines.join(' '), label);
  assert.equal(lines.length > 2, true);
  assert.equal(tall.hh > short.hh, true);
  assert.equal(tall.radius, short.radius);
  assert.equal(nodeLabelLines('🛠'.repeat(30)).join(''), '🛠'.repeat(30));
});

test('параллельный стенд занимает свободный край следующего ряда, сохраняя основную змейку', () => {
  const before = structuredClone(positions);
  const result = layoutGraphPositions(positions, nodes, false, ['sandbox']);
  const sandbox = nodeGeom('sandbox', result, nodes);
  const browser = nodeGeom('browser', result, nodes);

  assert.deepEqual(positions, before);
  assert.equal(result.sandbox[1], result.browser[1]);
  assert.equal(result.sandbox[0], result.build[0]);
  assert.equal(result.review[0], result.browser[0]);
  assert.equal(browser.cx - sandbox.cx > browser.hw + sandbox.hw, true);

  const occupied = { ...positions, browser: [140, 210] };
  const unpacked = layoutGraphPositions(occupied, nodes, false, ['sandbox']);

  assert.equal(unpacked.sandbox[1] < unpacked.browser[1], true, 'занятое место не используется');
});

test('холст вмещает верхние и межрядные возвраты вместе с подписями', () => {
  const pos = layoutGraphPositions(positions, nodes, true);
  const paths = [
    edgePath('review', 'build', 'arc_up_hi', pos, nodes, 2),
    edgePath('browser', 'build', 'arc_reject', pos, nodes, 1),
    edgePath('_start', 'sandbox', 'to_sandbox', pos, nodes),
    edgePath('sandbox', 'build', 'from_sandbox', pos, nodes),
  ];
  const [x, y, width, height] = computeViewBox(pos, nodes, paths).split(' ').map(Number);

  for (const path of paths) {
    assert.doesNotMatch(path.d, /NaN|Infinity|undefined/);

    for (const [px, py] of [...path.bounds, ...(path.label ? [path.label] : [])]) {
      assert.equal(px > x && px < x + width, true, 'линия остаётся внутри холста по X');
      assert.equal(py > y && py < y + height, true, 'линия остаётся внутри холста по Y');
    }
  }
});

test('пустая схема и одиночный узел имеют конечный размер', () => {
  for (const graph of [{ pos: {}, nodes: {} }, { pos: { build: [0, 0] }, nodes }]) {
    const pos = layoutGraphPositions(graph.pos, graph.nodes);
    const bounds = computeViewBox(pos, graph.nodes).split(' ').map(Number);

    assert.equal(bounds.every(Number.isFinite), true);
    assert.equal(bounds[2] > 0 && bounds[3] > 0, true);
  }
});

test('возврат проходит выше значков, а повтор узла остаётся видимой петлёй', () => {
  const tallNodes = {
    ...nodes,
    proof: ['code', 'Детерминированная проверка очень длинного многострочного названия этапа'],
  };
  const pos = layoutGraphPositions(positions, tallNodes, true);
  const tall = nodeGeom('proof', pos, tallNodes);
  const rewind = edgePath('review', 'build', 'arc_up', pos, tallNodes);
  const repeat = edgePath('build', 'build', 'arc_up', pos, tallNodes);

  assert.equal(rewind.bounds[1][1] < tall.top, true);
  assert.equal(repeat.bounds[0][0] < repeat.bounds.at(-1)[0], true);
  assert.doesNotMatch(repeat.d, /NaN|Infinity|undefined/);
});

test('связи примыкают к значкам и обходят внешние подписи, включая длинные названия', () => {
  const definitions = {
    ...nodes,
    proof: ['code', 'Детерминированная проверка очень длинного многострочного названия этапа'],
  };
  const pos = layoutGraphPositions(positions, definitions, true, ['sandbox']);
  const routes = [
    ['build', 'proof', 'h'],
    ['review', 'browser', 'v'],
    ['sandbox', 'build', 'from_sandbox'],
    ['review', 'build', 'arc_up'],
    ['browser', 'build', 'arc_down_hi'],
    ['proof', 'build', 'arc_down'],
    ['build', 'build', 'arc_up'],
    ['build', 'build', 'arc_down'],
  ];

  for (const [source, destination, routing] of routes) {
    const path = edgePath(source, destination, routing, pos, definitions);

    for (const [id, point] of [[source, path.bounds[0]], [destination, path.bounds.at(-1)]]) {
      const node = nodeGeom(id, pos, definitions);
      const dx = Math.abs(point[0] - node.cx);
      const dy = Math.abs(point[1] - node.cy);
      const distance = definitions[id][0] === 'code' ? dx + dy : Math.hypot(dx, dy);

      assert.equal(distance, node.radius, `${routing}: связь касается значка ${id}`);
    }

    for (const id of Object.keys(pos)) {
      const node = nodeGeom(id, pos, definitions);
      const left = node.cx - node.hw;
      const right = node.cx + node.hw;
      const top = node.labelY - 14;

      for (let index = 1; index < path.bounds.length; index += 1) {
        const [ax, ay] = path.bounds[index - 1];
        const [bx, by] = path.bounds[index];
        const crosses = ax === bx
          ? ax > left && ax < right && Math.max(ay, by) > top && Math.min(ay, by) < node.bottom
          : ay > top && ay < node.bottom && Math.max(ax, bx) > left && Math.min(ax, bx) < right;

        assert.equal(crosses, false, `${source} → ${destination} (${routing}) обходит подпись ${id}`);
      }
    }
  }
});
