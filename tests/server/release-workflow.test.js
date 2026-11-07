import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '../..');

test('RW-1: workflow релиза запускается вручную, собирает комплект и публикует на сайт', async () => {
  const text = await fs.readFile(
    path.join(repository, '.github/workflows/grigdesk-release.yml'), 'utf8',
  );

  assert.match(text, /^  workflow_dispatch:/m);
  assert.doesNotMatch(text, /^  push:/m);
  assert.match(text, /tests\/docs\/help-guide\.test\.mts/);
  assert.match(text, /group: grigdesk-release\s*\n/);
  assert.match(text, /node-version:\s*24\.21\.0/);
  assert.match(text, /npm --prefix server test/);
  assert.match(text, /npm --prefix web test/);
  assert.match(text, /npm --prefix mobile ci/);
  assert.ok(text.indexOf('npm --prefix mobile ci') < text.indexOf('npm --prefix server test'));
  assert.match(text, /npm --prefix tracker ci/);
  assert.match(text, /npm --prefix relay ci/);
  assert.match(text, /npm --prefix deepseek ci/);
  assert.match(text, /npm --prefix desktop ci/);
  assert.match(text, /tools\/bundle\.mts/);
  assert.match(text, /tools\/buildDeb\.mts/);
  assert.match(text, /tools\/release-publish\.mts "\$PWD"/);
  assert.match(text, /secrets\.RELEASE_SIGNING_KEY/);
  assert.match(text, /secrets\.RELEASE_SITE_KEY/);
  assert.doesNotMatch(text, /GLM|glm-smoke|API_KEY/i);
});

test('RW-2: отдельный relay-workflow удалён', async () => {
  await assert.rejects(
    fs.stat(path.join(repository, '.github/workflows/relay-release.yml')),
    (error) => {
      return error.code === 'ENOENT';
    },
  );
});

test('RW-CHANNELS: ручной выпуск выбирает release/dev и по умолчанию только проверяет', async () => {
  const source = await fs.readFile(
    path.join(repository, '.github/workflows/grigdesk-release.yml'), 'utf8',
  );
  const yaml = await import('../../server/node_modules/yaml/dist/index.js');
  const workflow = yaml.parse(source);
  const inputs = workflow.on.workflow_dispatch?.inputs;

  assert.ok(inputs?.channel, 'ручной workflow должен объявлять выбор канала');
  assert.deepEqual(inputs.channel.options, ['release', 'dev']);
  assert.equal(inputs.channel.default, 'release');
  assert.equal(inputs.publish.type, 'boolean');
  assert.equal(inputs.publish.default, false);
  assert.equal(workflow.on.push, undefined);

  const serverTests = workflow.jobs.release.steps.find((step) =>
    step.run?.includes('npm --prefix server test'));

  assert.equal(serverTests.env.NODE_OPTIONS, '--test-reporter=tap');
  assert.match(serverTests.run, /df -h/u);
  assert.match(serverTests.run, /free -m/u);

  const snapshot = workflow.jobs.release.steps.findIndex((step) =>
    step.run?.includes('materializeDeepSeekSnapshot'));
  const binary = workflow.jobs.release.steps.findIndex((step) =>
    step.run?.includes('tests/server/deepseek-binary-cache-root.test.js'));
  const variants = workflow.jobs.release.steps.findIndex((step) =>
    step.run?.includes('tests/helpers/deepseekBinary.mts --prepare-suite'));
  const legacy = workflow.jobs.release.steps.findIndex((step) =>
    step.run?.includes('tests/helpers/deepseekRuntimeArtifact.mts'));
  const suite = workflow.jobs.release.steps.indexOf(serverTests);

  assert.ok(snapshot >= 0 && snapshot < variants && variants < legacy && legacy < binary && binary < suite,
    'snapshot, варианты ELF и среда миграции готовятся последовательно до большого набора');

  const publish = workflow.jobs.release.steps.find((step) =>
    step.run?.includes('tools/release-publish.mts'));
  const bundle = workflow.jobs.release.steps.find((step) =>
    step.run?.includes('node tools/bundle.mts'));

  assert.ok(publish, 'publisher остаётся отдельным шагом');
  assert.equal(bundle.env.GRIGDESK_RELEASE_ORIGIN,
    "${{ secrets.RELEASE_SITE_PUBLIC_ORIGIN || 'https://grigdesk.com' }}");

  const cleanup = workflow.jobs.release.steps.find((step) =>
    step.name === 'Освобождение тестовых артефактов');
  const steps = workflow.jobs.release.steps;

  assert.ok(steps.indexOf(cleanup) > steps.findIndex((step) =>
    step.run?.includes('npm --prefix web run build')));
  assert.ok(steps.indexOf(cleanup) < steps.indexOf(bundle));
  assert.match(cleanup.run, /test "\$GRIGDESK_TEST_DEEPSEEK_ROOT" = "\$RUNNER_TEMP\/deepseek-tests"/u);
  assert.match(cleanup.run, /rm -rf -- "\$GRIGDESK_TEST_DEEPSEEK_ROOT"/u);
  assert.match(publish.if ?? '', /inputs\.publish/u);
  assert.equal(publish.env.RELEASE_SITE_PORT, "${{ secrets.RELEASE_SITE_PORT || '22' }}");
  assert.equal(publish.env.RELEASE_SITE_MIRROR_PORT, "${{ secrets.RELEASE_SITE_MIRROR_PORT || '22' }}");
});
