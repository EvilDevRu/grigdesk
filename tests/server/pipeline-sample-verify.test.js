import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  TASK, ATTEMPT, RUN, fixture, saveProject, context, published, command, hook, put, run, ok,
} from '../fixtures/pipelineSample.mjs';

/**
 * Поднимает только Git-копию образца; baseline записывает реальный workspace helper.
 * VERIFY получает тот же typed context и commandId, что настоящий dispatcher.
 */
async function verification(t, route = 'small') {
  const f = await fixture(t);

  await put(f.source, 'app.mjs', 'export const answer = 42; // OLD_STYLE\n');
  ok(run('git', ['-C', f.source, 'add', 'app.mjs']));
  ok(run('git', ['-C', f.source, 'commit', '-qm', 'Прежний долг фикстуры']));
  await put(f.root, 'style.mjs', [
    'import { readFileSync, readdirSync } from "node:fs";',
    'let failed = false;',
    'for (const file of ["app.mjs", ...readdirSync("tests").map(name => "tests/" + name)]) {',
    '  for (const [index, line] of readFileSync(file, "utf8").split("\\n").entries()) {',
    '    if (line.includes("STYLE")) {',
    '      failed = true;',
    '      console.log(JSON.stringify({path:file,line:index+1,rule:"fixture-style",message:"Стиль"}));',
    '    }',
    '  }',
    '}',
    'process.exit(failed ? 1 : 0);',
  ].join('\n'));
  f.project.checks.style = [{
    repo: 'app',
    argv: [process.execPath, path.join(f.root, 'style.mjs')],
    timeoutSeconds: 5,
    format: 'jsonl',
  }];
  await saveProject(f);
  ok(run('bash', [path.join(f.profile, 'up.sh'), TASK], { env: f.env }));

  const rows = ok(hook(f, 'profile_repositories', [TASK])).split('\n');
  const workspace = rows.find((row) => row.startsWith('app\t')).split('\t')[2];
  const value = await context(f, route, workspace);
  const p = await published(f);
  const machine = p.describe(route);
  const attemptDir = path.join(f.control, 'protocol-v2/tasks', `t${TASK}`, 'attempts', ATTEMPT);

  await mkdir(path.join(attemptDir, 'artifacts'), { recursive: true });
  f.env.ROUTE_V2_ATTEMPT_DIR = attemptDir;

  const check = (id = 'verify') => command(f, value, machine.nodes.find((node) => node.id === id));

  return {
    f,
    workspace,
    value,
    check,
  };
}

/**
 * Снимок TESTS закрепляет реальные bytes непосредственно исполняемых тестов.
 * Этот hook — источник доверенного snapshot, provider-writable manifest им не подменяется.
 */
async function snapshot(f, value, workspace, files) {
  const entries = [];

  for (const file of files) {
    const bytes = await readFile(path.join(workspace, file));

    entries.push(`${createHash('sha256').update(bytes).digest('hex')}  app:${file}`);
  }

  await writeFile(value.artifacts.testsDigest, entries.join('\n') + '\n');

  const testsContext = { ...value, stage: { id: 'tests', runKey: 'TESTS' } };
  const contextFile = await put(f.root, 'tests-context.json', JSON.stringify(testsContext));

  return hook(f, 'profile_route_node_evidence_check',
    [TASK, 'feature', 'tests', 'TESTS', 'done', RUN, contextFile]);
}

test('SAMPLE-VERIFY-01: changed tests only including untracked/renames/deletions', async (t) => {
  const { f, workspace, check } = await verification(t);

  await rename(path.join(workspace, 'tests/old.test.mjs'), path.join(workspace, 'tests/renamed.test.mjs'));
  await put(workspace, 'tests/untracked.test.mjs', 'export const added = true;\n');
  await put(workspace, 'tests/committed.test.mjs', 'export const committed = true;\n');
  ok(run('git', ['-C', workspace, 'add', 'tests/old.test.mjs', 'tests/renamed.test.mjs',
    'tests/committed.test.mjs']));
  ok(run('git', ['-C', workspace, 'commit', '-qm', 'Тест задачи']));

  const verdict = await check();
  const calls = (await readFile(path.join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const actual = calls.flat().map((file) => path.relative(workspace,
    path.resolve(workspace, file))).sort();

  assert.equal(verdict.outcome, 'done');
  assert.deepEqual(actual,
    ['tests/committed.test.mjs', 'tests/renamed.test.mjs', 'tests/untracked.test.mjs']);

  await rm(path.join(workspace, 'tests/untracked.test.mjs'));
  await rm(path.join(workspace, 'tests/renamed.test.mjs'));
  await rm(path.join(workspace, 'tests/committed.test.mjs'));
  await writeFile(path.join(f.root, 'calls.jsonl'), '');
  await check();
  assert.equal(await readFile(path.join(f.root, 'calls.jsonl'), 'utf8'), '',
    'пустой охват не запускает suite');
});

test('SAMPLE-VERIFY-02: trusted TESTS snapshot and earliest owner', async (t) => {
  const { f, workspace, value, check } = await verification(t, 'feature');
  const relative = 'tests/added.test.mjs';

  await put(workspace, relative, 'export const added = true;\n');
  ok(await snapshot(f, value, workspace, [relative]));

  assert.equal((await check()).outcome, 'done');
  await put(workspace, relative, 'export const added = false;\n');

  const changed = await check();

  assert.equal(changed.outcome, 'failed');
  assert.equal(changed.failureOwner, 'build');

  await writeFile(value.artifacts.testsDigest, 'broken manifest\n');

  const changedAgain = await check();

  assert.equal(changedAgain.failureOwner, 'build', 'после snapshot подмена manifest не меняет виновника');
});

test('SAMPLE-VERIFY-02: absent or invalid TESTS manifest belongs to tests', async (t) => {
  const { f, value, check } = await verification(t, 'feature');

  assert.equal((await check()).failureOwner, 'tests');
  await writeFile(value.artifacts.testsDigest, `${'a'.repeat(64)}  app:../outside.test.mjs\n`);

  const testsContext = { ...value, stage: { id: 'tests', runKey: 'TESTS' } };
  const contextFile = await put(f.root, 'tests-context.json', JSON.stringify(testsContext));
  const captured = hook(f, 'profile_route_node_evidence_check',
    [TASK, 'feature', 'tests', 'TESTS', 'done', RUN, contextFile]);

  assert.notEqual(captured.status, 0);
  assert.equal((await check()).failureOwner, 'tests');
});

test('SAMPLE-VERIFY-03: style claims only changed lines and earliest owner', async (t) => {
  const { f, workspace, value, check } = await verification(t, 'feature');

  await put(workspace, 'tests/new.test.mjs', 'export const added = true; // TESTS_STYLE\n');
  ok(await snapshot(f, value, workspace, ['tests/new.test.mjs']));
  await put(workspace, 'app.mjs', 'export const answer = 42; // OLD_STYLE\n// BUILD_STYLE\n');

  const verdict = await check();

  assert.equal(verdict.outcome, 'failed');
  assert.equal(verdict.failureOwner, 'tests');
  assert.ok(verdict.findings.length >= 2, 'оба новых дефекта не теряются при выборе раннего владельца');
  assert.ok(verdict.findings.every((finding) => !finding.summary.includes('OLD_STYLE')));
});

test('SAMPLE-VERIFY-04: recheck sees review delta and rejects stale attempt snapshot', async (t) => {
  const { f, workspace, value, check } = await verification(t);

  await put(workspace, 'tests/build.test.mjs', 'export const added = true;\n');
  assert.equal((await check()).outcome, 'done');
  assert.equal((await check('recheck')).outcome, 'done');
  await writeFile(path.join(f.root, 'calls.jsonl'), '');
  assert.equal((await check('recheck')).outcome, 'done');
  assert.equal(await readFile(path.join(f.root, 'calls.jsonl'), 'utf8'), '');
  await writeFile(path.join(f.root, 'calls.jsonl'), '');
  await put(workspace, 'tests/review.test.mjs', 'export const reviewed = true;\n');
  await put(workspace, 'app.mjs', 'export const answer = 42; // OLD_STYLE\n// REVIEW_STYLE\n');

  const rechecked = await check('recheck');
  const calls = await readFile(path.join(f.root, 'calls.jsonl'), 'utf8');

  assert.equal(rechecked.outcome, 'failed');
  assert.equal(rechecked.failureOwner, 'build');
  assert.ok(calls.includes('review.test.mjs'));

  value.attempt.id = 'a_00000000000000000000000000000002';
  await writeFile(path.join(f.root, 'calls.jsonl'), '');

  const stale = await check('recheck');
  const repeated = await readFile(path.join(f.root, 'calls.jsonl'), 'utf8');

  assert.ok(repeated.includes('review.test.mjs') || stale.failureOwner === 'environment');
});

test('SAMPLE-VERIFY-05: command stdout passes engine parser and invalid diagnostics stop as environment',
  async (t) => {
    const { f, value, check } = await verification(t);

    assert.equal((await check()).outcome, 'done');
    await put(f.root, 'style.mjs', 'console.log("invalid diagnostics"); process.exit(1);\n');

    const verdict = await check();

    assert.equal(verdict.outcome, 'failed');
    assert.equal(verdict.failureOwner, 'environment');

    const file = await put(f.root, 'context.json', JSON.stringify(value));
    const unknown = hook(f, 'profile_route_command', [TASK, 'small', 'verify', 'VERIFY', 'unknown', file]);

    assert.equal(unknown.status, 64);

    for (const broken of ['{}', '{"schema":1', JSON.stringify({
      schema: 1,
      outcome: 'failed',
      comment: 'Ошибка',
      failureOwner: 'tests',
      findings: [],
    })]) {
      const invalid = await put(f.root, 'invalid.json', broken);
      const parsed = run('bash', ['-c',
        'source "$FACTORY_HOME/lib/route-runtime.sh"; _route_v2_command_result "$1"',
        'fixture', invalid], { env: f.env });

      assert.notEqual(parsed.status, 0);
    }
  });
