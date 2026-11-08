import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertReleaseCheckResults, decodeReleaseChecks, releaseCheckNotes, resolveReleaseChecks,
} from '../../tools/releaseChecks.mts';
import { resolveReleaseIdentity } from '../../tools/release-identity.mts';

const input = {
  testMode: 'full',
  reason: '',
  validationRun: '',
  version: '0.1.0',
  commit: 'a'.repeat(40),
  ref: 'refs/tags/v0.1.0',
};

test('проверки: full не меняется автоматически по версии', () => {
  for (const version of ['0.1.0', '0.1.1', '1.2.3']) {
    const checks = resolveReleaseChecks({
      ...input,
      version,
      ref: `refs/tags/v${version}`,
    });

    assert.equal(checks.mode, 'full');
    assert.equal(checks.reason, null);
  }
});

test('проверки: владелец явно выбирает skip для любой версии, включая 0.1.1', () => {
  for (const version of ['0.1.0', '0.1.1', '1.2.3']) {
    const checks = resolveReleaseChecks({
      ...input,
      version,
      ref: `refs/tags/v${version}`,
      testMode: 'skip',
      reason: '  Риск принят владельцем  ',
    });

    assert.equal(checks.mode, 'skipped');
    assert.equal(checks.reason, 'Риск принят владельцем');
    assert.deepEqual(decodeReleaseChecks(checks), checks);
  }
});

test('проверки: канал dev также сохраняет явный выбор владельца', () => {
  const checks = resolveReleaseChecks({
    ...input,
    version: '0.1.0-dev.28',
    ref: 'refs/heads/dev',
    testMode: 'skip',
    reason: 'Проверка упаковки',
  });

  assert.equal(checks.mode, 'skipped');
});

test('проверки: отсутствие причины и смешение skip/reuse отвергаются', () => {
  for (const overrides of [
    { testMode: 'skip' },
    { testMode: 'skip', reason: '   ' },
    { testMode: 'skip', reason: 'x'.repeat(1001) },
    {
      testMode: 'skip',
      reason: 'Риск принят',
      validationRun: '42',
    },
    { testMode: 'unknown' },
    { reason: 'Неявный пропуск' },
    { validationRun: '../42' },
    { commit: 'not-a-commit' },
    { ref: 'refs/heads/feature' },
  ]) {
    assert.throws(() => resolveReleaseChecks({ ...input, ...overrides }), /release_checks_/);
  }
});

test('проверки: номер успешного прогона задаёт отдельный режим reuse', () => {
  const checks = resolveReleaseChecks({ ...input, validationRun: '42' });

  assert.equal(checks.mode, 'reused');
  assert.equal(checks.validationRun, '42');
});

test('проверки: full требует реальный успех обоих jobs', () => {
  const checks = resolveReleaseChecks(input);

  assert.doesNotThrow(() => assertReleaseCheckResults(checks, 'success', 'success'));

  for (const result of ['failure', 'skipped', 'cancelled', '']) {
    assert.throws(() => assertReleaseCheckResults(checks, result, 'success'));
    assert.throws(() => assertReleaseCheckResults(checks, 'success', result));
  }
});

test('проверки: явный skip не маскирует провал уже запущенного job', () => {
  const checks = resolveReleaseChecks({
    ...input,
    testMode: 'skip',
    reason: 'Риск принят',
  });

  assert.doesNotThrow(() => assertReleaseCheckResults(checks, 'skipped', 'skipped'));
  assert.throws(() => assertReleaseCheckResults(checks, 'failure', 'skipped'));
  assert.throws(() => assertReleaseCheckResults(checks, 'success', 'success'));
});

test('проверки: повреждённое или дополненное свидетельство не принимается', () => {
  const checks = resolveReleaseChecks(input);

  for (const value of [null, [], {}, { ...checks, extra: true }, { ...checks, mode: 'success' },
    { ...checks, commit: 'other' }, { ...checks, validationRun: 42 }]) {
    assert.throws(() => decodeReleaseChecks(value));
  }
});

test('проверки: согласованный риск входит в оба текста подписанного описания', () => {
  const reason = 'Риск принят; $(команда) остаётся текстом';
  const checks = resolveReleaseChecks({
    ...input,
    testMode: 'skip',
    reason,
  });
  const notes = JSON.parse(releaseCheckNotes(checks, JSON.stringify({ ru: 'Выпуск', en: 'Release' })));

  assert.match(notes.ru, /^Выпуск/);
  assert.match(notes.en, /^Release/);
  assert.ok(notes.ru.includes(reason));
  assert.ok(notes.en.includes(reason));
  assert.match(notes.en, /skipped/);
  assert.throws(() => releaseCheckNotes(checks, '{"ru":"only"}'));
  assert.throws(() => releaseCheckNotes(checks, JSON.stringify({ ru: 'x'.repeat(16000), en: '' })));
});

test('проверки CLI: план, ворота и acceptance сохраняют identity и решение', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-checks-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const file = path.join(directory, 'release-checks.json');
  const output = path.join(directory, 'outputs');
  const script = new URL('../../tools/releaseChecks.mts', import.meta.url).pathname;
  const env = {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: output,
    GITHUB_REF: input.ref,
    GRIGDESK_RELEASE_VERSION: input.version,
    GRIGDESK_RELEASE_COMMIT: input.commit,
    TEST_MODE: 'skip',
    TEST_SKIP_REASON: 'Владелец принял риск',
    SERVER_RESULT: 'skipped',
    WEB_RESULT: 'skipped',
  };
  const run = (command, overrides = {}) => execFileSync(process.execPath, [script, command, file], {
    env: { ...env, ...overrides },
    timeout: 10_000,
    stdio: 'pipe',
  });

  run('plan');
  assert.equal(await readFile(output, 'utf8'), 'run_tests=false\nmode=skipped\n');
  run('gate');
  assert.throws(() => run('gate', { SERVER_RESULT: 'failure' }));
  assert.throws(() => run('gate', { GRIGDESK_RELEASE_COMMIT: 'b'.repeat(40) }));
  await writeFile(path.join(directory, 'release-acceptance.json'), JSON.stringify({
    identity: { version: input.version, commit: input.commit },
    runtimeAcceptance: 'not-performed',
  }));
  run('attach');

  const receipt = JSON.parse(await readFile(path.join(directory, 'release-acceptance.json'), 'utf8'));

  assert.equal(receipt.testValidation.mode, 'skipped');
  assert.equal(receipt.runtimeAcceptance, 'not-performed');
});

test('stable: identity берётся прямо из main или соответствующего тега', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-main-'));
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release test',
    GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Release test',
    GIT_COMMITTER_EMAIL: 'release@example.invalid',
  };
  const git = (...args) => execFileSync('git', args, {
    cwd: root,
    env,
    stdio: 'pipe',
  }).toString().trim();

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');
  git('init', '-q', '-b', 'main');
  git('add', 'VERSION');
  git('commit', '-qm', 'release');

  const source = git('rev-parse', 'HEAD');
  const options = {
    root,
    channel: 'release',
    ref: 'refs/heads/main',
    runNumber: '28',
  };
  const identity = await resolveReleaseIdentity(options);

  assert.equal(identity.commit, source);
  assert.equal(identity.version, '0.1.0');
  assert.equal(resolveReleaseChecks({ ...input, ref: options.ref }).mode, 'full');
  await assert.rejects(resolveReleaseIdentity({ ...options, ref: 'refs/heads/dev' }));
  git('tag', 'v0.1.0');
  assert.equal((await resolveReleaseIdentity({ ...options, ref: 'refs/tags/v0.1.0' })).commit, source);

  const output = path.join(root, 'env');

  assert.throws(() => execFileSync(process.execPath,
    [new URL('../../tools/release-identity.mts', import.meta.url).pathname], {
      env: {
        ...env,
        RELEASE_CHANNEL: 'release',
        GITHUB_REF: options.ref,
        GITHUB_SHA: 'b'.repeat(40),
        GITHUB_ENV: output,
      },
      cwd: root,
      stdio: 'pipe',
    }), (error) => error.stderr.toString().includes('release_checkout_commit_mismatch'));
});
