import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../../web/src/', import.meta.url);

async function source(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('factory UI has no engine-generation branch or operational suffix', async () => {
  const files = await Promise.all([
    source('stores/tasks.js'),
    source('views/TaskModal.vue'),
    source('views/PipelineView.vue'),
  ]);
  for (const text of files) {
    assert.doesNotMatch(
      text,
      /\b(?:v1|v2)\b|generation|isV2|v2Result|(?:factory|route)-v[0-9]+/i,
    );
  }
});

test('route launch, resume and goto use the single API contract', async () => {
  const [store, modal, pipeline, chat] = await Promise.all([
    source('stores/tasks.js'),
    source('views/TaskModal.vue'),
    source('views/PipelineView.vue'),
    source('views/chat/ChatSession.vue'),
  ]);

  assert.match(store, /api\.post\(`\/api\/tasks\/\$\{id\}\/launch`, payload\)/);
  assert.match(modal, /profile:\s*launchForm\.value\.profile[\s\S]*route:\s*launchForm\.value\.route[\s\S]*acceptanceCriteria:/);
  assert.match(modal, /instrumentationFiles,[\s\S]*diagnosisKind:/);
  assert.doesNotMatch(modal, /deliveryTargets:\s*launchNeedsDelivery/);
  assert.match(modal, /<details[\s\S]*Дополнительные параметры[\s\S]*launch-instrumentation/);
  assert.doesNotMatch(modal, /\bticket:\s*`/);
  assert.match(chat, /ui\.openTaskLaunch\(s\.taskId\)/);
  assert.doesNotMatch(chat, /tasks\.launch\(/);

  assert.match(pipeline, /api\.post\(`\/api\/tasks\/\$\{task\}\/resume`\)/);
  assert.match(pipeline, /api\.post\(`\/api\/tasks\/\$\{stage\.value\.task\}\/stage\/\$\{stage\.value\.key\}\/\$\{status\}`/);
  assert.match(pipeline, /!t\.readOnly[\s\S]*t\.result/);
  assert.match(pipeline, /t\.workspaceMode !== 'shared'/);
});
