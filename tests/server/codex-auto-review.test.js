// Поведение native approvals проверяется JSON-RPC trace и эффектами fixture-процесса.
// Эти тесты не запускают модель и не объявляют проверенными настоящие права Git.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { openCodexSession } from '../../server/src/lib/executors/codex.ts';
import { createCodexStepNormalizer } from '../../server/src/lib/executors/_codexSteps.ts';
import { reviewEvent } from '../fixtures/codex-app-server/auto-review-0.164.0.mjs';

const FIXTURE = new URL('../fixtures/codex-app-server/auto-review-0.164.0.mjs', import.meta.url).href;

/**
 * Локальный alive не доказывает смерть native процесса; проверяем собственный PID.
 * Исчезновение процесса делает отсутствие marker окончательным без гонки таймеров.
 */
async function waitForFixtureExit(pid) {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        return;
      }

      throw error;
    }

    await delay(20);
  }

  assert.fail('собственный fixture app-server продолжил работать после отказа');
}

/**
 * Каждый тест получает отдельный trace и собственный закрываемый app-server.
 * Внешний reviewer в конфиге намеренно конфликтует с ограниченной workspaceAccess.
 */
async function fixture(t, scenario = 'reviews', overrides = {}, effectiveSettings = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-auto-review-'));
  const bin = path.join(dir, 'codex-fixture.mjs');
  const trace = path.join(dir, 'trace.jsonl');
  const marker = path.join(dir, 'late-effect');

  await writeFile(bin, [
    `#!${process.execPath}`,
    `import { runAutoReviewFixture } from ${JSON.stringify(FIXTURE)};`,
    'runAutoReviewFixture();',
    '',
  ].join('\n'));
  await chmod(bin, 0o755);

  const session = openCodexSession({
    config: { codexBin: bin },
    cwd: dir,
    extraDirs: [path.join(dir, 'shared')],
    tokenInfoReader: async () => null,
    env: {
      ...process.env,
      GRIGDESK_CODEX_FIXTURE_TRACE: trace,
      GRIGDESK_CODEX_FIXTURE_CLI_VERSION: '0.164.0',
      GRIGDESK_CODEX_FIXTURE_SCENARIO: scenario,
      GRIGDESK_CODEX_EFFECTIVE_SETTINGS: JSON.stringify(effectiveSettings),
      GRIGDESK_CODEX_EFFECT_MARKER: marker,
    },
    ...overrides,
  });

  t.after(async () => {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    dir,
    marker,
    session,
    async messages() {
      const entries = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

      return entries.filter((entry) => entry.direction === 'client').map((entry) => entry.message);
    },
  };
}

test('обычный start/resume и два send явно задают native Auto-review при прежних roots', async (t) => {
  for (const sessionId of [null, '00000000-0000-7000-8000-000000000049']) {
    const f = await fixture(t, 'reviews', { sessionId });

    await f.session.send({ message: 'Первый ход' });
    await f.session.send({ message: 'Второй ход' });

    const messages = await f.messages();
    const opened = messages.find((message) => (
      message.method === (sessionId ? 'thread/resume' : 'thread/start')
    ));
    const turns = messages.filter((message) => message.method === 'turn/start');

    assert.equal(turns.length, 2);

    for (const message of [opened, ...turns]) {
      assert.equal(message.params.approvalPolicy, 'on-request');
      assert.equal(message.params.approvalsReviewer, 'auto_review');
    }

    assert.equal(opened.params.sandbox, 'workspace-write');
    assert.deepEqual(opened.params.runtimeWorkspaceRoots, [f.dir, path.join(f.dir, 'shared')]);

    for (const turn of turns) {
      assert.deepEqual(turn.params.sandboxPolicy, {
        type: 'workspaceWrite',
        writableRoots: [f.dir, path.join(f.dir, 'shared')],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      });
    }
  }
});

test('workspaceAccess сохраняет never/user и точные границы вопреки внешнему auto_review', async (t) => {
  const workspaceAccess = {
    readableRoots: ['/fixture/read'],
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
  const f = await fixture(t, 'reviews', {
    workspaceAccess,
    nativeSettings: {
      accepted: [],
      payload: { approval_policy: 'on-request', approvals_reviewer: 'auto_review' },
    },
  });

  await f.session.send({ message: 'Служебный ход' });

  const messages = await f.messages();

  for (const message of messages.filter((entry) => ['thread/start', 'turn/start'].includes(entry.method))) {
    assert.equal(message.params.approvalPolicy, 'never');
    assert.equal(message.params.approvalsReviewer, 'user');
  }

  assert.deepEqual(messages.find((entry) => entry.method === 'turn/start').params.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: [],
    readOnlyAccess: {
      type: 'restricted',
      includePlatformDefaults: true,
      readableRoots: [f.dir, '/fixture/read'],
    },
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
});

test('mismatch effective settings закрывает процесс до turn без потери thread', async (t) => {
  for (const effective of [
    { approvalPolicy: 'never' },
    { approvalsReviewer: 'user' },
    { approvalsReviewer: null },
    { omitReviewer: true },
    { sandbox: { type: 'dangerFullAccess' } },
    { sandbox: { type: 'readOnly' } },
  ]) {
    for (const sessionId of [null, '00000000-0000-7000-8000-000000000049']) {
      const f = await fixture(t, 'reviews', { sessionId }, effective);

      await assert.rejects(f.session.send({ message: 'Не запускать' }),
        /Codex.*не принял.*(политик|reviewer|sandbox)/);
      assert.equal(f.session.alive, false);
      assert.equal(f.session.sessionId, '00000000-0000-7000-8000-000000000049');
      assert.equal((await f.messages()).some((message) => message.method === 'turn/start'), false);
    }
  }
});

test('native review виден в live/saved steps, дедуп по reviewId только внутри хода', async (t) => {
  const f = await fixture(t);

  for (let index = 0; index < 2; index += 1) {
    const live = [];
    const result = await f.session.send({ message: 'Продолжай', onStep: (step) => live.push(step) });

    assert.deepEqual(result.steps, live);
    assert.equal(result.reply, 'Ход завершён');

    const notes = result.steps.filter((step) => step.k === 'note' && step.text.includes('Auto-review:'));

    assert.equal(notes.length, 4, 'approved, denied, timedOut, aborted: чужие/старые события отсеяны');
    assert.equal(notes.filter((step) => step.text.includes('denied')).length, 1);
    assert.match(notes.find((step) => step.text.includes('denied')).text,
      /git add -- allowed.txt.*\nТестовый отказ/s);
    assert.ok(notes.some((step) => step.text.includes('timedOut')));
    assert.ok(notes.some((step) => step.text.includes('aborted')));
    assert.equal(result.steps.find((step) => step.k === 'res' && step.id === 'command-reviewed').ok, true);
    assert.equal((await f.messages()).filter((message) => message.id === 91640).length, 0);
  }
});

test('нормализатор ограничивает native данные и не сливает разные review одного item', () => {
  const normalize = createCodexStepNormalizer();
  const first = reviewEvent('thread', 'turn', {
    review: { status: 'denied', rationale: 'x'.repeat(20_000) },
  });
  const note = normalize(first).find((step) => step.k === 'note');

  assert.ok(note);
  assert.ok(note.text.length <= 4_000);
  assert.deepEqual(normalize(first), []);
  assert.equal(normalize(reviewEvent('thread', 'turn', { reviewId: 'second' })).length, 1);
});

test('собственный manual request физически закрывает app-server', { timeout: 15_000 }, async (t) => {
  for (const kind of ['command', 'file', 'permissions']) {
    for (const owner of ['own', 'missing']) {
      const f = await fixture(t, `manual-${kind}-${owner}`);

      await assert.rejects(f.session.send({ message: 'Проверка отказа' }), /неподдерживаемое действие/);
      assert.equal(f.session.alive, false);
      await assert.rejects(f.session.send({ message: 'Нельзя продолжать этот процесс' }));
      await waitForFixtureExit(f.session.pid);
      await assert.rejects(readFile(f.marker), { code: 'ENOENT' });

      const response = (await f.messages()).find((message) => message.id === 91640);
      // Процесс может погибнуть до чтения отказа из stdin. Безопасный исход —
      // закрытый transport; получение RPC error отдельно доказано чужими запросами.
      if (response) {
        assert.equal(response.error.code, -32601);
        assert.equal(response.result, undefined);
      }
    }
  }
});

test('manual request чужого thread/turn получает ошибку без остановки родителя', async (t) => {
  for (const kind of ['command', 'file', 'permissions']) {
    for (const owner of ['thread', 'turn']) {
      const f = await fixture(t, `manual-${kind}-${owner}`);
      const result = await f.session.send({ message: 'Свой ход продолжается' });

      assert.equal(result.reply, 'Ход завершён');
      assert.equal(f.session.alive, true);

      const response = (await f.messages()).find((message) => message.id === 91640);

      assert.equal(response.error.code, -32601);
      assert.equal(response.result, undefined);
    }
  }
});

test('request своего thread до turn/start response закрывается fail-closed', async (t) => {
  const f = await fixture(t, 'early-manual');

  await assert.rejects(f.session.send({ message: 'Не продолжать до определения владельца' }),
    /неподдерживаемое действие/);
  assert.equal(f.session.alive, false);
  await waitForFixtureExit(f.session.pid);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});
