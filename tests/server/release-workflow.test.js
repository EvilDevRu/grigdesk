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
  assert.equal(inputs.validation_run.type, 'string');
  assert.equal(inputs.validation_run.default, '');
  assert.equal(workflow.permissions.actions, 'read');
  assert.equal(workflow.on.push, undefined);

  const steps = workflow.jobs.release.steps;
  const gate = steps.find((step) => step.name === 'Подтверждение всех проверок');
  const production = steps.findIndex((step) => step.run === 'npm --prefix web run build');

  assert.equal(workflow.jobs.release['timeout-minutes'], 240);
  assert.ok(steps.indexOf(gate) < production);
  assert.equal(gate.if, '${{ !cancelled() }}');

  for (const [id, result] of [
    ['server_tests', 'SERVER_RESULT'],
    ['web_tests', 'WEB_RESULT'],
    ['shared_tests', 'SHARED_RESULT'],
    ['guide_tests', 'GUIDE_RESULT'],
  ]) {
    const step = steps.find((entry) => entry.id === id);

    assert.equal(step?.['continue-on-error'], true);
    assert.equal(step.if, "${{ steps.validation.outputs.reused != 'true' }}");
    assert.ok(steps.indexOf(step) < steps.indexOf(gate));
    assert.equal(gate.env[result], '${{ steps.' + id + '.outcome }}');
    assert.ok(gate.run.includes(`test "$${result}" = success`));
  }

  const serverTests = workflow.jobs.release.steps.find((step) =>
    step.run?.includes('npm --prefix server test'));

  assert.equal(serverTests.env.NODE_OPTIONS, '--test-reporter=tap');
  assert.match(serverTests.run, /df -h/u);
  assert.match(serverTests.run, /free -m/u);

  const validation = steps.find((step) => step.id === 'validation');
  const mechanism = steps.find((step) => step.name === 'Проверка механизма подтверждения CI');

  assert.equal(validation.run, 'node tools/releaseValidation.mts');
  assert.equal(validation.env.VALIDATION_RUN, '${{ inputs.validation_run }}');
  assert.ok(steps.indexOf(validation) < steps.indexOf(serverTests));
  assert.ok(steps.indexOf(mechanism) < steps.indexOf(gate));
  assert.match(mechanism.run, /release-validation\.test\.js/u);
  assert.equal(mechanism.if, undefined);
  assert.match(gate.run, /if \[ "\$REUSED_VALIDATION" = true \]/u);
  assert.match(gate.run, /test -s "\$VALIDATION_RECEIPT"/u);

  for (const name of ['Браузер тестов', 'Песочница Chromium', 'Прогрев вариантов тестового ELF',
    'Прогрев среды миграции', 'Проверка тестового ELF']) {
    assert.equal(steps.find((step) => step.name === name).if,
      "${{ steps.validation.outputs.reused != 'true' }}");
  }

  const browser = workflow.jobs.release.steps.findIndex((step) =>
    step.run?.includes('node server/node_modules/playwright-core/cli.js install --with-deps chromium'));
  const serverDependencies = workflow.jobs.release.steps.findIndex((step) =>
    step.run === 'npm --prefix server ci');

  assert.ok(browser > serverDependencies && browser < workflow.jobs.release.steps.indexOf(serverTests));

  const media = workflow.jobs.release.steps.findIndex((step) =>
    step.run?.includes('apt-get install -y --no-install-recommends ffmpeg'));

  assert.ok(media >= 0 && media < workflow.jobs.release.steps.indexOf(serverTests));
  assert.match(workflow.jobs.release.steps[media].run, /ffmpeg -version\s+ffprobe -version/u);
  assert.match(workflow.jobs.release.steps[media].run, /ffmpeg ripgrep python3-pil\s/u);
  assert.match(workflow.jobs.release.steps[media].run, /rg --version/u);
  assert.match(workflow.jobs.release.steps[media].run, /from PIL import Image/u);

  const sandbox = workflow.jobs.release.steps.findIndex((step) =>
    step.run?.includes('apt-get install -y --no-install-recommends bubblewrap'));

  assert.ok(sandbox >= 0 && sandbox < workflow.jobs.release.steps.indexOf(serverTests));
  assert.match(workflow.jobs.release.steps[sandbox].run, /bwrap --ro-bind \/ \/ --dev \/dev/u);
  assert.match(workflow.jobs.release.steps[sandbox].run,
    /profile grigdesk-ci-bwrap \/usr\/bin\/bwrap flags=\(unconfined\)/u);
  assert.match(workflow.jobs.release.steps[sandbox].run,
    /apparmor_parser -r \/etc\/apparmor.d\/grigdesk-ci-bwrap/u);
  assert.match(workflow.jobs.release.steps[sandbox].run, /unshare -Urnm \/usr\/bin\/true/u);

  const chromiumSandbox = steps.findIndex((step) => step.name === 'Песочница Chromium');

  assert.ok(chromiumSandbox > browser && chromiumSandbox < steps.indexOf(serverTests));
  assert.match(steps[chromiumSandbox].run, /chromiumSandbox: true/u);
  assert.doesNotMatch(steps[chromiumSandbox].run, /--no-sandbox/u);

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

  assert.ok(steps.indexOf(cleanup) > steps.findIndex((step) =>
    step.run?.includes('npm --prefix web run build')));
  assert.ok(steps.indexOf(cleanup) < steps.indexOf(bundle));
  assert.match(cleanup.run, /test "\$GRIGDESK_TEST_DEEPSEEK_ROOT" = "\$RUNNER_TEMP\/deepseek-tests"/u);
  assert.match(cleanup.run, /rm -rf -- "\$GRIGDESK_TEST_DEEPSEEK_ROOT"/u);
  assert.match(publish.if ?? '', /inputs\.publish/u);
  assert.equal(publish.env.RELEASE_SITE_PORT, "${{ secrets.RELEASE_SITE_PORT || '22' }}");
  assert.equal(publish.env.RELEASE_SITE_MIRROR_PORT, "${{ secrets.RELEASE_SITE_MIRROR_PORT || '22' }}");
});
