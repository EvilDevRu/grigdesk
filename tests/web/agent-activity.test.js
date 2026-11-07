import assert from 'node:assert/strict';
import test from 'node:test';

import { agentActivityLabel, silenceReason } from '../../shared/pipeline/agentActivity.ts';

test('agent activity label distinguishes a live journal, silence duration and missing telemetry', () => {
  assert.equal(agentActivityLabel({ journalFresh: true, journalAgeSec: 4 }), 'агент пишет');
  assert.equal(agentActivityLabel({ journalFresh: false, journalAgeSec: 92 }), 'нет событий 1 мин');
  assert.equal(agentActivityLabel({ journalFresh: false, journalAgeSec: 605 }), 'нет событий 10 мин');
  assert.equal(agentActivityLabel({ journalFresh: false, journalAgeSec: null }), 'журнал не подключён');
  // Имя висящего вызова важнее цифры: полчаса playwright и полчаса сборки — разные беды.
  assert.equal(
    agentActivityLabel({ journalFresh: false, journalAgeSec: 1680, silentTool: 'mcp__playwright__browser_click' }),
    'нет событий 28 мин (mcp__playwright__browser_click)',
  );
});

test('silence is called out only past the threshold, and never without it', () => {
  const hung = { silence: { stage: 'BROWSER', sec: 1680, tool: 'mcp__playwright__browser_click' } };
  assert.deepEqual(silenceReason(hung, 900), {
    stage: 'BROWSER',
    sec: 1680,
    tool: 'mcp__playwright__browser_click',
    text: 'browser: молчит 28 мин, висит mcp__playwright__browser_click',
  });
  // Десятиминутный Bash в сборке — законное молчание, звонить не за что.
  assert.equal(silenceReason({ silence: { stage: 'BUILD', sec: 600, tool: 'Bash' } }, 900), null);
  // Порог 0 — «не оповещать»: выключенная проверка молчит даже над висяком.
  assert.equal(silenceReason(hung, 0), null);
  // Хода нет — молчать некому.
  assert.equal(silenceReason({ silence: null }, 900), null);
  assert.equal(silenceReason(undefined, 900), null);
});
