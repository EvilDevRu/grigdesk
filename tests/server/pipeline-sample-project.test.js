import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ROOT, ENGINE, TASK, ATTEMPT, RUN, fixture, repository, saveProject,
  run, ok, hook, configure, context, put,
} from '../fixtures/pipelineSample.mjs';

test('SAMPLE-PROJECT-01: only project description supplies project settings', async (t) => {
  const f = await fixture(t);
  const promptsDir = path.join(f.profile, 'routes/prompts');
  const names = await readdir(promptsDir);
  const promptsBefore = await Promise.all(names.map((name) => readFile(path.join(promptsDir, name))));

  ok(configure(f));

  assert.equal(ok(hook(f, 'profile_workspace_mode')), f.project.workspace.mode);
  assert.equal(ok(hook(f, 'profile_stand_mode')), 'none');
  assert.equal(ok(hook(f, 'profile_source_branch', [TASK, 'app'])), `task-${TASK}`);
  assert.ok(ok(hook(f, 'profile_repositories', [TASK])).includes(f.source));

  const project = JSON.parse(ok(hook(f, 'profile_project_context', [TASK])));

  assert.deepEqual(Object.keys(project).sort(), ['guardrails', 'stack']);
  assert.deepEqual(project.stack, f.project.stack);
  assert.ok(project.guardrails.some((rule) => rule.includes('PRODUCT.md')));
  assert.ok(project.guardrails.some((rule) => rule.includes('project.json')));

  const other = await repository(f.root, 'other', 'release');

  await put(other, 'RULES.md', '# Правила другого проекта\nСохранять другой ответ.\n');
  f.project.repositories[0] = {
    name: 'app',
    source: other,
    baseBranch: 'release',
    targetBranch: 'release',
    productRules: 'RULES.md',
  };
  f.project.stack = ['Другой runtime'];
  await saveProject(f);

  assert.ok(ok(hook(f, 'profile_repositories', [TASK])).includes(other));

  const changed = JSON.parse(ok(hook(f, 'profile_project_context', [TASK])));

  assert.deepEqual(changed.stack, f.project.stack);
  assert.ok(changed.guardrails.some((rule) => rule.includes('RULES.md')));
  assert.ok(!changed.guardrails.some((rule) => rule.includes('PRODUCT.md')));
  ok(configure(f));

  const promptsAfter = await Promise.all(names.map((name) => readFile(path.join(promptsDir, name))));

  assert.deepEqual(promptsAfter, promptsBefore, 'смена описания проекта не переписывает инструкции этапов');
});

test('SAMPLE-PROJECT-02: one provider with distinct author/reviewer models', async (t) => {
  const f = await fixture(t);

  ok(configure(f));

  const settings = await readFile(path.join(f.profile, 'runners.env'), 'utf8');

  assert.match(settings, /^RUNNERS_SCHEMA=1$/m);
  assert.match(settings, /^RUNNERS_COVERAGE=required$/m);
  assert.match(settings, /^PROJECT_RUNNER_PRIMARY=alpha$/m);
  assert.match(settings, /^PROJECT_RUNNER_FAILOVER=(?:''|"")?$/m);

  for (const key of ['PLAN', 'BUILD', 'TESTS', 'REPRO', 'DIAGNOSE']) {
    const value = ok(run('bash', ['-c', 'source "$1"; name="MODEL_${2}_ALPHA_EXACT"; printf "%s" "${!name}"',
      'fixture', path.join(f.profile, 'runners.env'), key], { env: f.env }));

    assert.equal(value, f.project.executors.author.model, key);
  }

  for (const key of ['SKEPTIC', 'REVIEW', 'BROWSER', 'AUDIT', 'SHIP']) {
    assert.match(settings, new RegExp(`^MODEL_${key}_ALPHA_EXACT=['"]?alpha-reviewer['"]?$`, 'm'));
  }

  f.project.executors.reviewer.model = f.project.executors.author.model;
  await saveProject(f);
  assert.equal(configure(f).status, 64);
});

test('SAMPLE-PROJECT-03: invalid description never executes or configures another profile', async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.project);
  const mutations = [
    (p) => {
      p.schema = 2;
    },
    (p) => {
      p.id = 'another-profile';
    },
    (p) => {
      p.repositories[0].source = '/missing/synthetic-repository';
    },
    (p) => {
      p.workspace.root = `${f.root}/bad:path`;
    },
    (p) => {
      p.checks.tests[0].argv = 'echo unsafe';
    },
    (p) => {
      p.volatilePaths = [{ repo: 'app', path: '../outside' }];
    },
  ];

  for (const mutate of mutations) {
    f.project = structuredClone(original);
    mutate(f.project);
    await saveProject(f);

    const result = configure(f);

    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /project\.json/);
    await assert.rejects(readFile(path.join(f.profile, 'runners.env')), { code: 'ENOENT' });
  }

  f.project = structuredClone(original);
  await saveProject(f);
  ok(configure(f));

  const graphFile = path.join(f.profile, 'graph.json');
  const graph = JSON.parse(await readFile(graphFile, 'utf8'));

  graph.capabilities = ['route-v2'];
  await writeFile(graphFile, JSON.stringify(graph));
  f.project.schema = 99;
  await saveProject(f);

  const invalidSource = run('bash', ['-c', 'source "$1"', 'fixture', path.join(f.profile, 'profile.sh')],
    { env: f.env, timeout: 10000 });

  assert.notEqual(invalidSource.status, 0);
  assert.match(invalidSource.stderr, /project\.json/);

  const checked = run(path.join(ENGINE, 'bin/factory-check'), [f.project.id, '--quick'],
    { env: f.env, timeout: 10000 });

  assert.notEqual(checked.status, 0);
  assert.match(checked.stdout + checked.stderr, /project\.json/);

  f.project = original;
  f.project.workspace.prepare = [{
    repo: 'app',
    argv: [process.execPath,
    path.join(f.root, 'adapter.mjs'), '; touch OWNED $(touch OWNED)'],
    timeoutSeconds: 5,
  }];
  f.project.permissions.allow = ['fixture-allowed'];
  f.project.permissions.deny = ['fixture-denied'];
  await saveProject(f);
  ok(hook(f, 'profile_workspace_mode'));
  await assert.rejects(readFile(path.join(f.root, 'calls.jsonl')), { code: 'ENOENT' });
  assert.ok(!ok(hook(f, 'profile_stage_agent_allow', ['BUILD'])).includes('deliver.py'));
  assert.ok(ok(hook(f, 'profile_stage_agent_allow', ['SHIP'])).includes('deliver.py'));

  const permissions = ok(run('bash', ['-c',
    'source "$1" || exit; printf "%s\\n" "${PROFILE_AGENT_ALLOW[@]}" "${PROFILE_AGENT_DENY[@]}"',
    'fixture', path.join(f.profile, 'profile.sh')], { env: f.env }));

  assert.ok(permissions.includes('fixture-allowed'));
  assert.ok(permissions.includes('fixture-denied'));
  ok(run('bash', [path.join(f.profile, 'up.sh'), TASK], { env: f.env }));

  const calls = (await readFile(path.join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

  assert.deepEqual(calls, [['; touch OWNED $(touch OWNED)']]);
  assert.ok(!(await readdir(f.root)).includes('OWNED'));
});

test('SAMPLE-PROJECT-04: ui without stand warns', async (t) => {
  const f = await fixture(t);

  f.project.stand.hasInterface = true;
  await saveProject(f);

  const configured = configure(f);
  const docs = await readFile(path.join(ROOT, 'docs/grigdesk/pipeline/profile-sample.md'), 'utf8');

  ok(configured);
  assert.match(configured.stderr, /при[её]мк[\s\S]*человек|человек[\s\S]*при[её]мк/iu);
  assert.match(docs, /isolated/);
  assert.match(docs, /интерфейс[\s\S]*человек/iu);
});

test('SAMPLE-PROJECT-05: stand addresses match engine transport', async (t) => {
  const f = await fixture(t);

  f.project.workspace.mode = 'shared';
  f.project.stand.frontendUrl = 'http://127.0.0.1:5173';
  f.project.stand.apiUrl = 'http://127.0.0.1:8000';
  await saveProject(f);
  ok(configure(f));
  assert.equal(ok(hook(f, 'profile_service_ports', [TASK])), '5173\t8000');
  assert.equal(ok(run('bash', ['-c', 'source "$1" || exit; printf "%s" "$PROFILE_SERVICE_HOST"',
    'fixture', path.join(f.profile, 'profile.sh')], { env: f.env })), '127.0.0.1');

  const canonical = structuredClone(f.project);

  for (const [field, value] of [
    ['frontendUrl', 'https://127.0.0.1:5173'],
    ['frontendUrl', 'http://127.0.0.1:5173/path'],
    ['frontendUrl', 'http://127.0.0.1'],
    ['frontendUrl', null],
    ['apiUrl', null],
  ]) {
    f.project = structuredClone(canonical);
    f.project.stand[field] = value;
    await saveProject(f);

    const before = await readFile(path.join(f.profile, 'runners.env'));
    const result = configure(f);

    assert.equal(result.status, 64, `${field}=${value}: ${result.stderr}`);
    assert.match(result.stderr, /project\.json|URL|адрес/);
    assert.deepEqual(await readFile(path.join(f.profile, 'runners.env')), before);
  }
});

test('SAMPLE-ACCEPT-01: task-wide acceptance follows interface mode', async (t) => {
  const f = await fixture(t);
  const value = await context(f);

  value.stage = { id: 'browser', runKey: 'BROWSER' };

  const file = await put(f.root, 'context.json', JSON.stringify(value));
  const report = path.join(f.state, `t${TASK}.acceptance.json`);
  const evidence = await put(f.root, 'evidence.txt', 'Ответ проверен командами');
  const accepted = {
    schema: 1,
    taskId: TASK,
    attemptId: ATTEMPT,
    runId: RUN,
    mode: 'commands',
    criteria: value.task.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: 'passed',
      evidence,
    })),
  };
  const check = () => hook(f, 'profile_route_node_evidence_check',
    [TASK, 'small', 'browser', 'BROWSER', 'done', RUN, file]);

  value.services = { frontendUrl: 'unavailable', apiUrl: 'unavailable' };
  await writeFile(file, JSON.stringify(value));
  await writeFile(report, JSON.stringify(accepted));
  ok(check());

  for (const broken of [
    { ...accepted, criteria: accepted.criteria.slice(1) },
    { ...accepted, taskId: '43' },
    { ...accepted, attemptId: 'a_00000000000000000000000000000002' },
    { ...accepted, runId: '00000000-0000-4000-8000-000000000002' },
    { ...accepted, criteria: accepted.criteria.map((item) => ({ ...item, status: 'skipped' })) },
  ]) {
    await writeFile(report, JSON.stringify(broken));
    assert.notEqual(check().status, 0);
  }

  f.project.stand.hasInterface = true;
  await saveProject(f);
  await writeFile(report, JSON.stringify(accepted));
  assert.notEqual(check().status, 0, 'UI без стенда нельзя принять командами');

  f.project.workspace.mode = 'shared';
  f.project.stand.frontendUrl = 'http://127.0.0.1:5173';
  f.project.stand.apiUrl = 'http://127.0.0.1:8000';
  await saveProject(f);
  value.workspace.mode = 'shared';
  value.services = { frontendUrl: f.project.stand.frontendUrl,
    apiUrl: f.project.stand.apiUrl };
  await writeFile(file, JSON.stringify(value));
  await writeFile(report, JSON.stringify({
    ...accepted,
    mode: 'browser',
    url: f.project.stand.frontendUrl,
    browserEvidence: evidence,
  }));
  ok(check());

  await writeFile(report, JSON.stringify({
    ...accepted,
    mode: 'browser',
    url: f.project.stand.frontendUrl,
  }));
  assert.notEqual(check().status, 0, 'браузерная приёмка требует сохранённое evidence');

  await writeFile(report, JSON.stringify({
    ...accepted,
    mode: 'browser',
    url: f.project.stand.frontendUrl,
    browserEvidence: evidence,
  }));

  value.services.frontendUrl = 'unavailable';
  await writeFile(file, JSON.stringify(value));
  assert.notEqual(check().status, 0, 'недоступный обязательный стенд блокирует done');
  assert.ok((await readdir(f.root)).every((name) => name !== 'OWNED'));
});
