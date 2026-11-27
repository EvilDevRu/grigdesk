import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('RL-45: посредник выпускается через общий workflow комплекта', async () => {
  const text = await readFile(
    new URL('../../.github/workflows/grigdesk-release.yml', import.meta.url), 'utf8',
  );
  const uses = [...text.matchAll(/^\s+uses:\s+(\S+)/gm)].map((match) => {
    return match[1];
  });

  assert.match(text, /^  workflow_dispatch:/m);
  assert.doesNotMatch(text, /^  push:/m);
  assert.match(text, /^permissions:\n  contents: read$/m);
  assert.match(text, /persist-credentials: false/);
  assert.ok(text.includes(`go-version: '1.27.4'`));

  for (const action of uses) {
    assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  }

  const yaml = await import('../../server/node_modules/yaml/dist/index.js');
  const workflow = yaml.parse(text);

  assert.deepEqual(workflow.jobs.build.needs, ['plan', 'server', 'web']);
  assert.deepEqual(workflow.jobs.publish.needs, ['plan', 'build', 'verify']);

  for (const job of [workflow.jobs.server, workflow.jobs.web, workflow.jobs.build]) {
    let previous = -1;
    const jobSource = yaml.stringify(job);

    for (const command of [
      'npm --prefix server ci', 'npm --prefix web ci',
      'npm --prefix deepseek ci',
      'npm --prefix desktop ci',
    ]) {
      const index = jobSource.indexOf(command);

      assert.ok(index > previous, command);
      previous = index;
    }
  }

  assert.doesNotMatch(text, /gh release create|contents: write/);
  await assert.rejects(
    readFile(new URL('../../.github/workflows/relay-release.yml', import.meta.url)),
    { code: 'ENOENT' },
  );
});
