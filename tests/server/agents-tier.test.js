// Класс модели в шаблоне агента: чтение легаси-семейства и запись.
// Сверка «класс шаблона против модельной политики профиля» жила в валидаторе
// legacy-стора маршрутов и ушла вместе с ним: под v2 состав маршрута и его
// исполнителей проверяет сам публикатор профиля (routes/publish.mjs
// --validate) и factory-check — по опубликованному бандлу, а не по схеме,
// которую никто не исполняет.
import assert from 'node:assert/strict';
import test from 'node:test';

import { defaults, parseAgentFile, serializeAgent } from '../../server/src/modules/agents/store.js';

test('Легаси-семейство в шаблоне читается как класс модели', () => {
  const legacy = (model) => parseAgentFile(`---\nkind: agent\nmodel: ${model}\n---\n\nПромпт\n`);
  assert.equal(legacy('opus').tier, 'reasoning');
  assert.equal(legacy('fable').tier, 'reasoning');
  assert.equal(legacy('sonnet').tier, 'balanced');
  assert.equal(legacy('haiku').tier, 'cheap');
  // Незнакомое значение не выдумываем: рекомендации просто нет.
  assert.equal(legacy('gpt-9').tier, '');
  // Явный класс сильнее легаси-поля и семейство обратно не всплывает.
  const explicit = parseAgentFile('---\ntier: cheap\nmodel: opus\n---\n\nПромпт\n');
  assert.equal(explicit.tier, 'cheap');
  assert.equal(explicit.model, undefined);
});

test('Запись шаблона: класс сериализуется, семейство отвергается', () => {
  assert.match(serializeAgent({ ...defaults(), tier: 'reasoning' }), /^tier: reasoning$/m);
  assert.match(serializeAgent({ ...defaults() }), /^tier: $/m);
  assert.throws(
    () => serializeAgent({ ...defaults(), tier: 'opus' }),
    (e) => e.code === 'invalid_agent_metadata',
  );
});
