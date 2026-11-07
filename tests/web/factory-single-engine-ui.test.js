import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { migrationUrl } from './helpers/compile-vue.js';

async function source(path) {
  return readFile(migrationUrl(`src/${path}`), 'utf8');
}

test('factory UI has no engine-generation branch or operational suffix', async () => {
  const files = await Promise.all([
    source('stores/tasks.ts'),
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
    source('stores/tasks.ts'),
    source('views/TaskModal.vue'),
    source('views/PipelineView.vue'),
    source('views/chat/ChatSession.vue'),
  ]);

  assert.match(store, /api\.post\(`\/api\/tasks\/\$\{id\}\/launch`, payload\)/);

  const launchFields = [
    /profile:\s*launchForm\.value!?\.profile/,
    /route:\s*launchForm\.value!?\.route/,
    /acceptanceCriteria:/,
  ];

  assert.match(modal, new RegExp(launchFields.map((field) => field.source).join('[\\s\\S]*')));
  assert.match(modal, /instrumentationFiles,[\s\S]*diagnosisKind:/);
  assert.doesNotMatch(modal, /deliveryTargets:\s*launchNeedsDelivery/);
  assert.match(modal, /<details[\s\S]*Дополнительные параметры[\s\S]*launch-instrumentation/);
  assert.doesNotMatch(modal, /\bticket:\s*`/);
  assert.doesNotMatch(chat, /openTaskLaunch/);
  assert.doesNotMatch(chat, /tasks\.launch\(/);

  assert.match(pipeline, /api\.post\(`\/api\/tasks\/\$\{task\}\/resume`\)/);

  const stageEndpoint = [
    /api\.post\(\s*`\/api\/tasks\/\$\{opened\.task\}/,
    /\/stage\/\$\{opened\.key\}\/\$\{status\}`/,
  ];

  assert.match(pipeline, new RegExp(stageEndpoint.map((part) => part.source).join('')));
  assert.match(pipeline, /!t\.readOnly[\s\S]*t\.result/);
  assert.match(pipeline, /t\.workspaceMode !== 'shared'/);
});
