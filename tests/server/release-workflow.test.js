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

test('RW-CHANNELS: проверки параллельны, упаковка требует оба успешных набора или доказанный reuse',
  async () => {
  const source = await fs.readFile(
    path.join(repository, '.github/workflows/grigdesk-release.yml'), 'utf8',
  );
  const yaml = await import('../../server/node_modules/yaml/dist/index.js');
  const workflow = yaml.parse(source);
  const inputs = workflow.on.workflow_dispatch?.inputs;
  const { server, web, release } = workflow.jobs;
  const steps = release.steps;
  const gate = steps.find((step) => step.name === 'Подтверждение всех проверок');
  const production = steps.findIndex((step) => step.run === 'npm --prefix web run build');

  assert.deepEqual(inputs.channel.options, ['release', 'dev']);
  assert.equal(inputs.channel.default, 'release');
  assert.equal(inputs.publish.type, 'boolean');
  assert.equal(inputs.publish.default, false);
  assert.equal(inputs.validation_run.type, 'string');
  assert.equal(inputs.validation_run.default, '');
  assert.equal(workflow.permissions.actions, 'read');
  assert.equal(workflow.on.push, undefined);
  assert.deepEqual(release.needs, ['server', 'web']);
  assert.equal(release.if, '${{ !cancelled() }}');
  assert.equal(server.needs, undefined);
  assert.equal(web.needs, undefined);
  assert.equal(server.if, "${{ inputs.validation_run == '' }}");
  assert.equal(web.if, "${{ inputs.validation_run == '' }}");
  assert.equal(server['timeout-minutes'], 240);
  assert.equal(web['timeout-minutes'], 90);
  assert.equal(release['timeout-minutes'], 120);
  assert.ok(steps.indexOf(gate) < production);
  assert.equal(gate.if, '${{ !cancelled() }}');
  assert.equal(gate.env.SERVER_RESULT, '${{ needs.server.result }}');
  assert.equal(gate.env.WEB_RESULT, '${{ needs.web.result }}');
  assert.match(gate.run, /test "\$SERVER_RESULT" = success/u);
  assert.match(gate.run, /test "\$WEB_RESULT" = success/u);
  assert.match(gate.run, /if \[ "\$REUSED_VALIDATION" = true \]/u);
  assert.match(gate.run, /test -s "\$VALIDATION_RECEIPT"/u);

  const serverGate = server.steps.find((step) => step.name === 'Подтверждение серверных проверок');

  assert.equal(serverGate.if, '${{ !cancelled() }}');

  for (const [id, result] of [
    ['server_tests', 'SERVER_RESULT'],
    ['shared_tests', 'SHARED_RESULT'],
    ['guide_tests', 'GUIDE_RESULT'],
  ]) {
    const step = server.steps.find((entry) => entry.id === id);

    assert.equal(step?.['continue-on-error'], true);
    assert.equal(step.if, undefined);
    assert.ok(server.steps.indexOf(step) < server.steps.indexOf(serverGate));
    assert.equal(serverGate.env[result], '${{ steps.' + id + '.outcome }}');
    assert.ok(serverGate.run.includes(`test "$${result}" = success`));
  }

  const webTest = web.steps.find((step) => step.name === 'Тесты web');
  const serverTest = server.steps.find((step) => step.id === 'server_tests');

  assert.equal(webTest.run, 'npm --prefix web test');
  assert.equal(webTest['continue-on-error'], undefined);
  assert.equal(webTest.env.NODE_OPTIONS, '--test-reporter=tap');
  assert.equal(serverTest.env.NODE_OPTIONS, '--test-reporter=tap');
  assert.match(serverTest.run, /df -h/u);
  assert.match(serverTest.run, /free -m/u);
  assert.doesNotMatch(yaml.stringify(server), /secrets\.|tools\/bundle|release-publish/u);
  assert.doesNotMatch(yaml.stringify(web), /secrets\.|tools\/bundle|release-publish/u);

  for (const [job, testStep] of [[server, serverTest], [web, webTest]]) {
    const browser = job.steps.findIndex((step) => step.name === 'Браузер тестов');
    const dependencies = job.steps.findIndex((step) => step.run === 'npm --prefix server ci');
    const chromiumSandbox = job.steps.findIndex((step) => step.name === 'Песочница Chromium');
    const media = job.steps.findIndex((step) => step.name === 'Системные средства тестов');
    const sandbox = job.steps.findIndex((step) => step.name === 'Песочница native-проверок');
    const testIndex = job.steps.indexOf(testStep);

    assert.ok(dependencies < browser && browser < chromiumSandbox && chromiumSandbox < testIndex);
    assert.match(job.steps[browser].run, /playwright-core\/cli\.js install --with-deps chromium/u);
    assert.match(job.steps[chromiumSandbox].run, /chromiumSandbox: true/u);
    assert.doesNotMatch(job.steps[chromiumSandbox].run, /--no-sandbox/u);
    assert.ok(media >= 0 && media < testIndex);
    assert.match(job.steps[media].run, /ffmpeg -version\s+ffprobe -version/u);
    assert.match(job.steps[media].run, /ffmpeg ripgrep python3-pil\s/u);
    assert.match(job.steps[media].run, /rg --version/u);
    assert.match(job.steps[media].run, /from PIL import Image/u);
    assert.ok(sandbox >= 0 && sandbox < testIndex);
    assert.match(job.steps[sandbox].run, /bwrap --ro-bind \/ \/ --dev \/dev/u);
    assert.match(job.steps[sandbox].run, /apparmor_parser -r \/etc\/apparmor.d\/grigdesk-ci-bwrap/u);
    assert.match(job.steps[sandbox].run, /unshare -Urnm \/usr\/bin\/true/u);
  }

  const snapshot = server.steps.findIndex((step) => step.name === 'Исходники тестового исполнителя');
  const variants = server.steps.findIndex((step) => step.name === 'Прогрев вариантов тестового ELF');
  const legacy = server.steps.findIndex((step) => step.name === 'Прогрев среды миграции');
  const binary = server.steps.findIndex((step) => step.name === 'Проверка тестового ELF');

  assert.ok(snapshot >= 0 && snapshot < variants && variants < legacy && legacy < binary);
  assert.ok(binary < server.steps.indexOf(serverTest));
  assert.equal(web.steps.some((step) => step.name === 'Прогрев вариантов тестового ELF'), false);

  const validation = steps.find((step) => step.id === 'validation');
  const mechanism = steps.find((step) => step.name === 'Проверка механизма подтверждения CI');
  const bundle = steps.find((step) => step.name === 'Сборка комплекта');
  const key = steps.find((step) => step.name === 'Ключ подписи');
  const publish = steps.find((step) => step.name === 'Публикация на сайт');
  const cleanup = steps.find((step) => step.name === 'Освобождение тестовых артефактов');

  assert.equal(validation.run, 'node tools/releaseValidation.mts');
  assert.equal(validation.env.VALIDATION_RUN, '${{ inputs.validation_run }}');
  assert.ok(steps.indexOf(validation) < steps.indexOf(gate));
  assert.ok(steps.indexOf(mechanism) < steps.indexOf(key));
  assert.ok(production < steps.indexOf(key) && steps.indexOf(key) < steps.indexOf(bundle));
  assert.match(mechanism.run, /release-validation\.test\.js/u);
  assert.equal(mechanism.if, undefined);
  assert.equal(bundle.env.GRIGDESK_RELEASE_ORIGIN,
    "${{ secrets.RELEASE_SITE_PUBLIC_ORIGIN || 'https://grigdesk.com' }}");
  assert.ok(steps.indexOf(cleanup) > production && steps.indexOf(cleanup) < steps.indexOf(bundle));
  assert.match(cleanup.run, /test "\$GRIGDESK_TEST_DEEPSEEK_ROOT" = "\$RUNNER_TEMP\/deepseek-tests"/u);
  assert.match(cleanup.run, /rm -rf -- "\$GRIGDESK_TEST_DEEPSEEK_ROOT"/u);
  assert.match(publish.if ?? '', /inputs\.publish/u);
  assert.equal(publish.env.RELEASE_SITE_PORT, "${{ secrets.RELEASE_SITE_PORT || '22' }}");
  assert.equal(publish.env.RELEASE_SITE_MIRROR_PORT, "${{ secrets.RELEASE_SITE_MIRROR_PORT || '22' }}");
});
