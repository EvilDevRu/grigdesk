import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeStageRunnerSelection } from '../../shared/pipeline/stageRunnerSettings.ts';

test('отсутствие, сброс и выбор скорости различаются в DTO узла', () => {
  const legacy = {
    primary: null,
    parametersFor: 'codex',
    model: null,
    effort: null,
  };

  assert.deepEqual(decodeStageRunnerSelection(legacy), legacy);
  assert.deepEqual(decodeStageRunnerSelection({ ...legacy, speed: null }), { ...legacy, speed: null });
  assert.equal(decodeStageRunnerSelection({ ...legacy, speed: 'ultrafast' }).speed, 'ultrafast');
  assert.throws(() => decodeStageRunnerSelection({ ...legacy, speed: '' }));
  assert.throws(() => decodeStageRunnerSelection({ ...legacy, serviceTier: 'priority' }));
});
