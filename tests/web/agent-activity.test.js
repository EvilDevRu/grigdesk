import assert from 'node:assert/strict';
import test from 'node:test';

import { agentActivityLabel } from '../../web/src/shared/agent-activity.js';

test('agent activity label distinguishes a live journal, silence duration and missing telemetry', () => {
  assert.equal(agentActivityLabel({ journalFresh: true, journalAgeSec: 4 }), 'агент пишет');
  assert.equal(agentActivityLabel({ journalFresh: false, journalAgeSec: 92 }), 'нет событий 1 мин');
  assert.equal(agentActivityLabel({ journalFresh: false, journalAgeSec: 605 }), 'нет событий 10 мин');
  assert.equal(agentActivityLabel({ journalFresh: false, journalAgeSec: null }), 'журнал не подключён');
});
