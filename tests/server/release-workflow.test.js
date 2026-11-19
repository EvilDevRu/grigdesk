import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const pipelineEntry = 'tools/releasePipeline.mts tools/releaseRecipe.json';
const repository = path.resolve(import.meta.dirname, '../..');

test('RW-1: workflow релиза запускается вручную, собирает комплект и публикует на сайт', async () => {
  const text = await fs.readFile(
    path.join(repository, '.github/workflows/grigdesk-release.yml'), 'utf8',
  );

  assert.match(text, /^  workflow_dispatch:/m);
  assert.doesNotMatch(text, /^  push:/m);
  assert.match(await fs.readFile(path.join(repository, 'tools/releaseRecipe.json'), 'utf8'),
    /help-guide\.test\.mts/u);
  assert.match(text, /group: grigdesk-release\s*\n/);
  assert.match(text, /server\/build\/node-runtime\.json/u);
  assert.ok(text.includes(pipelineEntry + ' --groups prepare-server,prepare-build,server'));
  assert.ok(text.includes(pipelineEntry + ' --groups prepare-web,prepare-build,web'));
  assert.match(text, /npm --prefix mobile ci/);
  assert.ok(text.indexOf('npm --prefix mobile ci')
    < text.indexOf(pipelineEntry + ' --groups prepare-server'));
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
  const manager = steps.findIndex((step) => step.name === 'Пользовательский менеджер процессов тестов');
  const tests = steps.findIndex((step) => step.id === 'server_tests');
  const lock = JSON.parse(await fs.readFile(
    path.join(repository, 'tests/fixtures/qwen-cli/package-lock.json'), 'utf8'));

  assert.ok(manager >= 0 && tests > manager);
  assert.equal(lock.packages['node_modules/@qwen-code/qwen-code'].version, '0.27.3');
  assert.match(steps[manager].run, /github-hosted/u);
  assert.match(steps[manager].run, /MemoryMax=4G/u);
  assert.match(steps[manager].run, /DBUS_SESSION_BUS_ADDRESS/u);
  assert.ok(steps[tests].run.includes(pipelineEntry + ' --groups prepare-server,prepare-build,server'));

  const recipe = JSON.parse(await fs.readFile(path.join(repository, 'tools/releaseRecipe.json'), 'utf8'));
  const cli = recipe.stages.find((stage) => stage.id === 'qwen-test-cli');
  const native = recipe.stages.find((stage) => stage.id === 'server-tests');
  const launcher = await fs.readFile(path.join(repository, 'tools/ci/run-release-server-tests.sh'), 'utf8');

  assert.equal(cli.group, 'prepare-server');
  assert.match(cli.argv.join(' '), /npm --prefix tests\/fixtures\/qwen-cli ci/u);
  assert.ok(native.needs.includes('prepare-server'));
  assert.equal(native.group, 'server');
  assert.deepEqual(native.argv, ['bash', 'tools/ci/run-release-server-tests.sh']);
  assert.match(launcher, /GRIGDESK_QWEN_BIN="\$PWD\/tests\/fixtures\/qwen-cli\//u);
  assert.match(launcher, /systemd-run --user --scope --collect/u);
  assert.match(launcher, /app-grigdesk-tests-.*\.scope/u);
  assert.match(launcher, /npm --prefix server test/u);
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
    const consumer = job.steps.findIndex((step) => job === server || job === web
      ? /releasePipeline\.mts/u.test(step.run ?? '') : step.name === 'Сборка комплекта');

    assert.ok(install >= 0 && consumer > install);
  }

  for (const job of [server, web, build]) {
    const install = job.steps.findIndex((step) =>
      (step.run ?? '').includes('npm --prefix routes ci --include=dev'));
    const consumer = job.steps.findIndex((step) => job === server || job === web
      ? /releasePipeline\.mts/u.test(step.run ?? '') : step.name === 'Сборка комплекта');

    assert.ok(install >= 0 && consumer > install);
  }

  const serverRun = server.steps.find((step) => step.name === 'Общий прогон серверных проверок');

  assert.match(serverRun.run, /--groups prepare-server,prepare-build,server/u);
  assert.equal(server.steps.some((step) => step['continue-on-error']), false);
  assert.equal(web.steps.find((step) =>
    step.name === 'Общий прогон web-проверок')['continue-on-error'], undefined);

  const desktopPreparation = 'tools/ci/prepare-release-desktop.sh';
  const desktopStep = build.steps.findIndex((step) => (step.run ?? '').includes(desktopPreparation));
  const bundleStep = build.steps.findIndex((step) => step.name === 'Сборка комплекта');
  const localBundle = await fs.readFile(path.join(repository, 'tools/buildDesktopRelease.mts'), 'utf8');

  assert.ok(desktopStep >= 0 && desktopStep < bundleStep);
  assert.ok(localBundle.includes(desktopPreparation));

  const provisioning = await fs.readFile(path.join(repository, 'tools/ci/provision-ubuntu.sh'), 'utf8');

  for (const job of [server, web]) {
    const setup = job.steps.findIndex((step) => step.name === 'Общая подготовка одноразового runner');
    const testIndex = job.steps.findIndex((step) => /releasePipeline\.mts/u.test(step.run ?? ''));

    assert.ok(setup >= 0 && setup < testIndex);
    assert.match(job.steps[setup].run, /--disposable-environment/u);
    assert.match(provisioning, /chromiumSandbox: true/u);
    assert.doesNotMatch(provisioning, /--no-sandbox/u);
  }

  for (const job of [server, build]) {
    const cleanup = job.steps.find((step) => step.name === 'Место для native-сборок');

    assert.match(cleanup.run, /RUNNER_ENVIRONMENT:-.*github-hosted/u);
    assert.match(cleanup.run, /sudo rm -rf -- \/usr\/share\/dotnet \/usr\/local\/\.ghcup/u);
    assert.doesNotMatch(cleanup.run, /android|\/node\b|\/python\b|chromium/u);
  }
});

test('RW-PLATFORMS: переключатели задают сборку и ворота выдачи', async (t) => {
  const yaml = await import('../../server/node_modules/yaml/dist/index.js');
  const workflow = await fs.readFile(path.join(repository, '.github/workflows/grigdesk-release.yml'), 'utf8');
  const doc = yaml.parse(workflow);
  const inputs = doc.on.workflow_dispatch.inputs;
  const selection = doc.jobs.plan.steps.find((step) => step.id === 'accepted');
  const {
    linux_candidate_build: linuxBuild,
    linux_candidate_verify: linuxVerify,
    macos_build: macBuild,
    macos_verify: macVerify,
    candidate_artifacts: output,
  } = doc.jobs;

  for (const checkbox of [inputs.linux, inputs.macos]) {
    assert.equal(checkbox.type, 'boolean');
    assert.equal(checkbox.default, true);
  }

  assert.equal(inputs.platforms, undefined);
  assert.equal(inputs.channel.default, 'dev');
  assert.equal(doc.jobs.plan.steps[0], selection);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'release-inputs-'));
  const selectedFile = path.join(temporary, 'selected.txt');

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  for (const [linux, macos, expected] of [
    ['true', 'true', 'linux-and-macos'],
    ['true', 'false', 'linux'],
    ['false', 'true', 'macos'],
    ['false', 'false', null],
  ]) {
    await fs.writeFile(selectedFile, '');

    const observed = spawnSync('/bin/bash', ['-e', '-c', selection.run], {
      env: {
        BUILD_LINUX: linux,
        BUILD_MACOS: macos,
        GITHUB_OUTPUT: selectedFile,
      },
      encoding: 'utf8',
    });

    assert.equal(observed.status, expected ? 0 : 1, observed.stderr);
    assert.equal(await fs.readFile(selectedFile, 'utf8'), expected ? `platforms=${expected}\n` : '');

    if (!expected) {
      assert.match(observed.stdout, /^::error::/u);
    }
  }

  for (const build of [linuxBuild, macBuild]) {
    assert.deepEqual(build.needs, ['plan', 'server', 'web']);
    assert.equal(build.environment, 'platform-candidate');
    assert.equal(build.steps.filter((step) => /secrets\./u.test(JSON.stringify(step))).length, 1);
  }

  for (const linux of [linuxBuild, linuxVerify]) {
    assert.equal(linux.if, "${{ success() && needs.plan.outputs.platforms == 'linux-and-macos' }}");
  }

  for (const mac of [macBuild, macVerify]) {
    assert.match(mac.if, /success\(\).*platforms == 'macos'.*\|\|\s+.*platforms == 'linux-and-macos'/u);
  }

  assert.equal(linuxBuild['runs-on'], 'ubuntu-24.04');
  assert.equal(linuxVerify['runs-on'], 'ubuntu-24.04');
  assert.equal(macBuild['runs-on'], 'macos-15');
  assert.equal(macVerify['runs-on'], 'macos-15');
  assert.deepEqual(linuxVerify.needs, ['plan', 'linux_candidate_build']);
  assert.deepEqual(macVerify.needs, ['plan', 'macos_build']);
  assert.deepEqual(output.needs, ['plan', 'linux_candidate_verify', 'macos_verify']);
  assert.match(output.if, /!cancelled\(\).*needs\.plan\.result == 'success'/u);
  assert.match(output.if, /needs\.macos_verify\.result == 'success'/u);
  assert.match(output.if, /platforms == 'macos' && needs.linux_candidate_verify.result == 'skipped'/u);
  assert.match(output.if,
    /platforms == 'linux-and-macos' && needs.linux_candidate_verify.result == 'success'/u);

  for (const job of [linuxVerify, macVerify, output]) {
    assert.doesNotMatch(JSON.stringify(job), /secrets\./u);
    assert.equal(job['continue-on-error'], undefined);
  }

  for (const platform of ['linux-x64', 'darwin-arm64']) {
    const upload = output.steps.find((step) => step.with?.path === `verified-candidates/${platform}`);
    const selected = "${{ needs.plan.outputs.platforms == 'linux-and-macos' }}";

    assert.match(upload?.uses ?? '', /^actions\/upload-artifact@/u);
    assert.equal(upload.with['if-no-files-found'], 'error');
    assert.equal(upload.if, platform === 'linux-x64' ? selected : undefined);
  }

  for (const name of ['build', 'verify', 'publish']) {
    assert.match(doc.jobs[name].if, /needs\.plan\.outputs\.platforms == 'linux'/u);
  }
});

test('RELEASE-WORKFLOW-PIPELINE: тестовые и сборочные job-ы идут общим рецептом', async () => {
  const yaml = await import('../../server/node_modules/yaml/dist/index.js');
  const workflow = await fs.readFile(
    path.join(repository, '.github/workflows/grigdesk-release.yml'), 'utf8');
  const doc = yaml.parse(workflow);
  const runnings = workflow.match(/tools\/releasePipeline\.mts tools\/releaseRecipe\.json[^\n]*/gu) ?? [];

  assert.ok(runnings.length >= 3, 'job-ы не вызывают общий runner');
  assert.ok(runnings.some((line) => line.includes('--groups prepare-server,prepare-build,server')));
  assert.ok(runnings.some((line) => line.includes('--groups prepare-web,prepare-build,web')));
  assert.ok(runnings.some((line) => line.includes('--groups build')));

  for (const jobName of ['server', 'web']) {
    const steps = doc.jobs[jobName].steps.map((step) => step.run ?? '');

    assert.ok(!steps.some((run) => run.includes('npm --prefix server test')
      || run.includes('npm --prefix web test')),
    `${jobName} содержит собственный список тестов`);
  }

  assert.ok(doc.jobs.build.needs.includes('server'));
  assert.ok(doc.jobs.build.needs.includes('web'));
  assert.ok(doc.jobs.verify.needs.includes('build'));

  // Сборка комплекта и свидетельство проверок остаются шагами build-job.
  const buildRuns = doc.jobs.build.steps.map((step) => step.run ?? '').join('\n');

  assert.ok(buildRuns.includes('tools/bundle.mts'));
  assert.ok(buildRuns.includes('release-plan/*.json'));
});

test('PROMOTE-WORKFLOW: продвижение не собирает и не подписывает заново', async () => {
  const yaml = await import('../../server/node_modules/yaml/dist/index.js');
  const workflow = await fs.readFile(
    path.join(repository, '.github/workflows/grigdesk-promote.yml'), 'utf8');
  const doc = yaml.parse(workflow);
  const steps = doc.jobs.promote.steps.map((step) => step.name ?? step.uses ?? '');

  assert.ok(!workflow.includes('RELEASE_SIGNING_KEY'));
  assert.ok(!workflow.includes('tools/bundle.mts'));
  assert.ok(steps.indexOf('Скачивание точного артефакта')
    < steps.indexOf('Проверка кандидата без пересборки'));
  assert.ok(steps.indexOf('Проверка кандидата без пересборки')
    < steps.indexOf('Публикация'));

  const publish = doc.jobs.promote.steps.find((step) => step.name === 'Публикация');

  assert.equal(publish.if, '${{ inputs.publish }}');
  assert.ok(workflow.includes('repos/${GITHUB_REPOSITORY}/actions/runs/'));
  assert.ok(workflow.includes('--artifact-id'));
});
