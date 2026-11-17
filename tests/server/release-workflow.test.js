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

test('RW-QWEN: native CLI закреплён, а Host имеет настоящий ограниченный user scope', async () => {
  const yaml = await import('../../server/node_modules/yaml/dist/index.js');
  const workflow = yaml.parse(await fs.readFile(
    path.join(repository, '.github/workflows/grigdesk-release.yml'), 'utf8'));
  const steps = workflow.jobs.server.steps;
  const cli = steps.findIndex((step) => step.name === 'Настоящий CLI Qwen');
  const manager = steps.findIndex((step) => step.name === 'Пользовательский менеджер процессов тестов');
  const tests = steps.findIndex((step) => step.id === 'server_tests');
  const lock = JSON.parse(await fs.readFile(
    path.join(repository, 'tests/fixtures/qwen-cli/package-lock.json'), 'utf8'));

  assert.ok(cli >= 0 && manager > cli && tests > manager);
  assert.equal(lock.packages['node_modules/@qwen-code/qwen-code'].version, '0.27.3');
  assert.match(steps[cli].run, /npm --prefix tests\/fixtures\/qwen-cli ci/u);
  assert.match(steps[cli].run, /GRIGDESK_QWEN_BIN=\$GITHUB_WORKSPACE\//u);
  assert.match(steps[manager].run, /github-hosted/u);
  assert.match(steps[manager].run, /MemoryMax=4G/u);
  assert.match(steps[manager].run, /DBUS_SESSION_BUS_ADDRESS/u);
  assert.match(steps[tests].run, /systemd-run --user --scope --collect/u);
  assert.match(steps[tests].run, /app-grigdesk-tests-.*\.scope/u);
  assert.match(steps[tests].run, /-- npm --prefix server test/u);
});

test('RW-2: отдельный relay-workflow удалён', async () => {
  await assert.rejects(
    fs.stat(path.join(repository, '.github/workflows/relay-release.yml')),
    (error) => {
      return error.code === 'ENOENT';
    },
  );
});

test('RW-CHANNELS: этапы выпуска связаны строгими воротами и неизменяемыми артефактами', async () => {
  const source = await fs.readFile(path.join(repository, '.github/workflows/grigdesk-release.yml'), 'utf8');
  const yaml = await import('../../server/node_modules/yaml/dist/index.js');
  const workflow = yaml.parse(source);
  const inputs = workflow.on.workflow_dispatch.inputs;
  const { plan, server, web, build, verify, publish } = workflow.jobs;

  assert.deepEqual(inputs.channel.options, ['release', 'dev']);
  assert.deepEqual(inputs.test_mode.options, ['full', 'skip']);
  assert.equal(inputs.test_mode.default, 'full');
  assert.equal(inputs.publish.default, false);
  assert.equal(inputs.skip_reason.type, 'string');
  assert.equal(workflow.permissions.actions, 'read');
  assert.equal(workflow.on.push, undefined);
  assert.deepEqual(build.needs, ['plan', 'server', 'web']);
  assert.deepEqual(verify.needs, ['plan', 'build']);
  assert.deepEqual(publish.needs, ['plan', 'build', 'verify']);
  assert.match(build.if, /!cancelled\(\).*needs.plan.result == 'success'/u);
  assert.match(verify.if, /!cancelled\(\).*needs.build.result == 'success'/u);
  assert.match(publish.if, /!cancelled\(\).*inputs.publish.*needs.verify.result == 'success'/u);
  assert.equal(plan.steps.find((step) => step.name === 'Исходники').with['fetch-depth'], 0);
  assert.match(plan.steps.find((step) => step.name === 'Происхождение выпуска из main').run,
    /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/u);
  assert.equal(plan.outputs.run_tests, '${{ steps.checks.outputs.run_tests }}');

  for (const job of [server, web]) {
    assert.deepEqual(job.needs, ['plan']);
    assert.equal(job.if, "${{ needs.plan.outputs.run_tests == 'true' }}");
    assert.doesNotMatch(yaml.stringify(job), /secrets\.|tools\/bundle|release-publish/u);
  }

  for (const job of [plan, verify]) {
    assert.doesNotMatch(yaml.stringify(job), /secrets\./u);
  }

  const gate = build.steps.findIndex((step) => step.name === 'Подтверждение всех проверок');
  const dependencies = build.steps.findIndex((step) => step.run === 'npm --prefix server ci');
  const key = build.steps.findIndex((step) => step.name === 'Ключ подписи');
  const bundle = build.steps.findIndex((step) => step.name === 'Сборка комплекта');
  const artifact = build.steps.find((step) => step.id === 'artifacts');

  assert.ok(gate >= 0 && gate < dependencies && dependencies < key && key < bundle);
  assert.equal(build.steps[gate].env.SERVER_RESULT, '${{ needs.server.result }}');
  assert.equal(build.steps[gate].env.WEB_RESULT, '${{ needs.web.result }}');
  assert.match(build.steps[gate].run, /releaseChecks\.mts gate/u);
  assert.equal(build.steps[bundle].env.GRIGDESK_RELEASE_NOTES_JSON, undefined);
  assert.ok(build.steps.some((step) => /releaseChecks\.mts notes/u.test(step.run ?? '')));
  assert.ok(build.steps.some((step) => /releaseChecks\.mts attach/u.test(step.run ?? '')));
  assert.equal(build.outputs.artifact_id, '${{ steps.artifacts.outputs.artifact-id }}');
  assert.equal(artifact.with['if-no-files-found'], 'error');
  assert.doesNotMatch(yaml.stringify(build), /secrets\.RELEASE_SITE_KEY|release-publish/u);
  assert.doesNotMatch(yaml.stringify(publish), /RELEASE_SIGNING_KEY|tools\/bundle/u);

  for (const job of [verify, publish]) {
    const download = job.steps.find((step) => step.name === 'Получение артефакта');

    assert.equal(download.with['artifact-ids'], '${{ needs.build.outputs.artifact_id }}');
    assert.equal(download.with.path, 'release-artifacts');
  }

  assert.match(verify.steps.find((step) => step.name === 'Проверка готовых пакетов').run,
    /tests\/run-node-tests-safe\.sh tools\/verifyRelease\.mts/u);
  assert.equal(verify.steps.some((step) => step['continue-on-error']), false);
  assert.equal(publish.steps.find((step) => step.name === 'Публикация на сайт').env.RELEASE_SITE_PORT,
    "${{ secrets.RELEASE_SITE_PORT || '22' }}");

  // Зависимости voice готовятся в каждом job до потребления его тестами или bundle.
  // Outcome обязателен в общем gate, даже при continue-on-error самого шага.
  for (const job of [server, web, build]) {
    const install = job.steps.findIndex((step) =>
      (step.run ?? '').includes('npm --prefix voice ci --include=dev'));
    const consumer = job.steps.findIndex((step) => job === server ? step.id === 'voice_tests'
      : job === web ? /npm --prefix web test/u.test(step.run ?? '') : step.name === 'Сборка комплекта');

    assert.ok(install >= 0 && consumer > install);
  }

  for (const job of [server, web, build]) {
    const install = job.steps.findIndex((step) =>
      (step.run ?? '').includes('npm --prefix routes ci --include=dev'));
    const consumer = job.steps.findIndex((step) => job === server ? step.id === 'routes_tests'
      : job === web ? /npm --prefix web test/u.test(step.run ?? '') : step.name === 'Сборка комплекта');

    assert.ok(install >= 0 && consumer > install);
  }

  const serverGate = server.steps.find((step) => step.name === 'Подтверждение серверных проверок');

  for (const [id, result] of [
    ['server_tests', 'SERVER_RESULT'],
    ['shared_tests', 'SHARED_RESULT'],
    ['guide_tests', 'GUIDE_RESULT'],
    ['voice_tests', 'VOICE_RESULT'],
    ['routes_tests', 'ROUTES_RESULT'],
  ]) {
    const step = server.steps.find((entry) => entry.id === id);

    assert.equal(step['continue-on-error'], true);
    assert.equal(serverGate.env[result], '${{ steps.' + id + '.outcome }}');
    assert.ok(serverGate.run.includes(`test "$${result}" = success`));
  }

  assert.equal(web.steps.find((step) => step.name === 'Тесты web')['continue-on-error'], undefined);

  for (const job of [server, web]) {
    const browser = job.steps.findIndex((step) => step.name === 'Браузер тестов');
    const sandbox = job.steps.findIndex((step) => step.name === 'Песочница Chromium');
    const testIndex = job.steps.findIndex((step) => /npm --prefix (server|web) test/u.test(step.run ?? ''));

    assert.ok(browser >= 0 && browser < sandbox && sandbox < testIndex);
    assert.match(job.steps[sandbox].run, /chromiumSandbox: true/u);
    assert.doesNotMatch(job.steps[sandbox].run, /--no-sandbox/u);
  }

  for (const job of [server, build]) {
    const cleanup = job.steps.find((step) => step.name === 'Место для native-сборок');

    assert.match(cleanup.run, /RUNNER_ENVIRONMENT:-.*github-hosted/u);
    assert.match(cleanup.run, /sudo rm -rf -- \/usr\/share\/dotnet \/usr\/local\/\.ghcup/u);
    assert.doesNotMatch(cleanup.run, /android|\/node\b|\/python\b|chromium/u);
  }
});
