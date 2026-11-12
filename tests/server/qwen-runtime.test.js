import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { acquireCliLease, inspectCliLeases } from '../../server/src/lib/providerInstall/leases.ts';
import { prepareExternalCliRuntime } from '../../server/src/lib/providerInstall/externalCliRuntime.ts';
import {
  QWEN_KEY, qwenAdapter, qwenFixture, rejectedTurn, runInput, selectedModel, successful, until,
} from '../helpers/qwenFixture.mjs';

/**
 * Canary принадлежит только тесту; отсутствие файла доказывает запрет эффекта.
 * Ошибки доступа и другие ошибки чтения не принимаются за отсутствие записи.
 */
async function absent(file) {
  await assert.rejects(access(file), { code: 'ENOENT' });
}

test('qwen-acp-steps-and-final', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const inputFile = path.join(fixture.workspace, 'input.txt');
  const steps = [];
  let saved = false;

  await writeFile(inputFile, 'Содержимое разрешённого файла');
  await fixture.fake({ tool: { name: 'read_file', args: { file_path: inputFile } } });

  const result = await adapter.run(runInput(fixture, model, {
    onSessionCreated: async (id) => {
      assert.ok(id);
      assert.equal((await fixture.records()).some((item) => item.frame?.method === 'session/prompt'), false);
      saved = true;
    },
    onStep: (step) => {
      if (['think', 'text', 'tool', 'res'].includes(step.k)) {
        assert.equal(saved, true, 'Сессия должна быть сохранена до публикации шага');
      }

      steps.push(step);
    },
  }));

  assert.equal(successful(result), true, JSON.stringify(result));
  assert.equal(result.reply, 'Новый ответ');
  assert.ok(result.sessionId);
  assert.ok(['think', 'text', 'tool', 'res'].every((kind) => steps.some((step) => step.k === kind)));

  const tools = steps.filter((step) => step.k === 'tool');
  const results = steps.filter((step) => step.k === 'res');

  assert.equal(tools.length, 1);
  assert.equal(results.length, 1);
  assert.ok(tools[0].id, 'Идентификатор инструмента не должен быть пустым');
  assert.equal(tools[0].id, results[0].id, 'Результат относится к тому же инструменту');
  assert.equal(results[0].ok, true, 'Лента должна показывать успешный инструмент без отметки ошибки');
  assert.equal(results[0].error, false);

  const handshake = (await fixture.records()).find((item) => item.event === 'handshake');

  assert.equal(handshake.matched, true, 'Native private-parent nonce должен совпадать');
  assert.equal(handshake.guard, 'required-v1');
  assert.equal(handshake.provider, 'attached-v1');

  const modes = await adapter.modes(fixture.config);

  assert.deepEqual(modes.map((mode) => mode.id).sort(), ['auto', 'default', 'plan', 'yolo']);

  const modeCases = [['default', 'default'], ['auto', 'default'], ['plan', 'plan'], ['yolo', 'yolo']];

  for (const [mode, expected] of modeCases) {
    await fixture.fake();
    await adapter.run(runInput(fixture, model, { permissionMode: mode }));

    const records = await fixture.records();
    const spawn = records.filter((item) => item.event === 'spawn').at(-1);
    const modeFrame = records.filter((item) => item.instance === spawn.instance
      && item.frame?.method === 'session/set_mode').at(-1);
    const nativeMode = modeFrame?.frame.params.modeId
      ?? spawn.argv[spawn.argv.indexOf('--approval-mode') + 1];

    assert.equal(nativeMode, expected, `Режим GrigDesk ${mode} должен применять native ${expected}`);
  }

  const failures = [
    { options: { brokenJson: true }, reason: /ACP|JSON|EOF|поток|процесс|протокол/i },
    { options: { eof: true }, reason: /ACP|EOF|закрыт|заверш|процесс|exit|closed/i },
    { options: { error: `synthetic upstream failure ${QWEN_KEY}`, stderr: QWEN_KEY },
      reason: /synthetic upstream failure/ },
  ];

  for (const failure of failures) {
    await fixture.fake(failure.options);

    const reason = await rejectedTurn(() => adapter.run(runInput(fixture, model)));

    assert.match(reason, failure.reason);
    assert.equal(reason.includes(QWEN_KEY), false);
  }
});

test('qwen-resume-exact-session', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const first = await adapter.run(runInput(fixture, model));
  const steps = [];

  assert.equal(successful(first), true);
  assert.ok(first.sessionId);

  const second = await adapter.run(runInput(fixture, model, {
    sessionId: first.sessionId,
    message: 'Продолжи.',
    onStep: (step) => steps.push(step),
  }));
  const records = await fixture.records();
  const loads = records.filter((item) => item.frame?.method === 'session/load');
  const prompts = records.filter((item) => item.frame?.method === 'session/prompt');

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.reply, 'Новый ответ');
  assert.equal(loads.length, 1);
  assert.equal(loads[0].frame.params.sessionId, first.sessionId);
  assert.equal(prompts.length, 2);

  const processIds = prompts.map((item) => item.instance);

  assert.ok(new Set(processIds).size >= 2);
  assert.equal(JSON.stringify(steps).includes('OLD_REPLAY'), false, 'Replay не является новым ответом');
  assert.equal(typeof adapter.sessionBinding?.authProfileId, 'function');

  const binding = await adapter.sessionBinding.authProfileId(fixture.config);

  process.env.QWEN_TEST_KEY = 'synthetic-rotated-key';

  const changed = await adapter.sessionBinding.authProfileId(fixture.config);

  assert.notEqual(changed, binding, 'Смена ключа должна отделять native память');
  assert.equal(changed.includes('synthetic-rotated-key'), false);

  const before = prompts.length;

  await rejectedTurn(() => adapter.run(runInput(fixture, model, {
    sessionId: '../foreign-session', chatKey: 'foreign-chat',
  })));

  const afterForeign = (await fixture.records()).filter((item) => item.frame?.method === 'session/prompt');

  assert.equal(afterForeign.length, before);
});

test('qwen-abort-no-late-effect', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const preAborted = new AbortController();

  preAborted.abort();

  const before = (await fixture.records()).filter((item) => item.event === 'spawn').length;

  await rejectedTurn(() => adapter.run(runInput(fixture, model, { signal: preAborted.signal })));
  assert.equal((await fixture.records()).filter((item) => item.event === 'spawn').length, before);
  await fixture.fake({ hold: true });

  const controller = new AbortController();
  let notifyText;
  const textReady = new Promise((resolve) => {
    notifyText = resolve;
  });

  t.after(() => controller.abort());

  const outcome = adapter.run(runInput(fixture, model, {
    signal: controller.signal,
    onStep: (step) => {
      if (step.k === 'text') {
        notifyText('text');
      }
    },
  }));
  const finished = outcome.then(() => 'finished', () => 'failed');

  assert.equal(await Promise.race([textReady, finished]), 'text');

  const holders = await inspectCliLeases({
    directory: path.join(fixture.dataHome, 'provider-cli-leases'), providerId: 'qwen',
  });
  const processIds = holders.flatMap((holder) => [holder.childPid, holder.sessionId]).filter(Boolean);

  assert.ok(processIds.length, 'Остановка проверяется по host PID, а не PID внутри bwrap');
  controller.abort();
  await rejectedTurn(() => outcome);

  await until(() => {
    return processIds.every((pid) => {
      try {
        process.kill(pid, 0);

        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    });
  }, 'завершение своего ACP child');

  const effect = path.join(fixture.workspace, 'late-effect');
  const approvalAbort = new AbortController();
  let lateAllow;

  t.after(() => approvalAbort.abort());

  await fixture.fake({
    ask: true,
    effect,
    tool: { name: 'run_shell_command', args: { command: 'printf allowed' } },
  });

  const pending = adapter.run(runInput(fixture, model, {
    signal: approvalAbort.signal,
    onPermission: () => new Promise((resolve) => {
      lateAllow = resolve;
      approvalAbort.abort();
    }),
  }));

  await rejectedTurn(() => pending);
  assert.equal(typeof lateAllow, 'function', 'Сценарий должен дойти до ожидания разрешения');
  lateAllow({ allow: true });
  await absent(effect);
});

test('qwen-final-guard-before-effect', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const effect = path.join(fixture.workspace, 'forbidden-effect');

  for (const options of [
    { tool: { name: 'run_shell_command', args: { command: 'ssh example.invalid true' } } },
    { tool: { name: 'unknown_native_tool', args: {} } },
    { foreignSession: true, tool: { name: 'run_shell_command', args: { command: 'printf allowed' } } },
  ]) {
    await fixture.fake({ effect, ...options });

    const before = (await fixture.records()).filter((item) => item.event === 'guard').length;

    await adapter.run(runInput(fixture, model, {
      permissionMode: 'yolo',
      providerSettings: { blockDirectSsh: true },
      onPermission: async () => ({ allow: true }),
    })).catch(() => null);

    const decisions = (await fixture.records()).filter((item) => item.event === 'guard');

    assert.equal(decisions.length, before + 1, 'Проверяется отказ guard, а не сбой до запуска CLI');
    assert.equal(decisions.at(-1).allowed, false);
    await absent(effect);
  }

  await fixture.fake({ noAck: true });

  const before = (await fixture.records()).filter((item) => item.frame?.method === 'session/prompt').length;
  const reason = await rejectedTurn(() => adapter.run(runInput(fixture, model)));

  assert.match(reason, /guard|совмест|протокол|защит/i);

  const afterNoAck = (await fixture.records()).filter((item) => item.frame?.method === 'session/prompt');

  assert.equal(afterNoAck.length, before);
  assert.equal(reason.includes(QWEN_KEY), false);
});

test('qwen-filesystem-mcp-workdir', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const capability = typeof adapter.workdir === 'function'
    ? adapter.workdir(fixture.config) : adapter.workdir;

  assert.deepEqual(capability, { switch: 'reseed', roots: 'single' });
  assert.equal(typeof adapter.validateWorkdir, 'function');

  const sibling = path.join(fixture.root, 'sibling');
  const canary = path.join(sibling, 'canary');

  await mkdir(sibling);
  await writeFile(canary, 'original');
  await symlink(sibling, path.join(fixture.workspace, 'escape'));

  const validation = await adapter.validateWorkdir({
    config: fixture.config,
    cwd: fixture.workspace,
    extraDirs: [sibling],
  });

  assert.ok(validation.error || validation.rejected?.length,
    'Дополнительный writable root не поддерживается');
  assert.equal(validation.extraDirs?.includes(sibling), false);

  const model = await selectedModel(adapter, fixture);

  for (const file of [canary, path.join(fixture.workspace, 'escape', 'canary')]) {
    await fixture.fake({
      effect: file,
      tool: { name: 'write_file', args: { file_path: file, content: 'bad' } },
    });
    await adapter.run(runInput(fixture, model, { permissionMode: 'yolo' })).catch(() => null);
    assert.equal(await readFile(canary, 'utf8'), 'original');
  }

  const own = path.join(fixture.workspace, 'own');

  await fixture.fake({
    effect: own,
    tool: { name: 'write_file', args: { file_path: own, content: 'effect' } },
  });
  await adapter.run(runInput(fixture, model, { permissionMode: 'yolo' }));
  assert.equal(await readFile(own, 'utf8'), 'effect', 'Полный запрет tools не заменяет правильную политику');

  const malicious = path.join(fixture.workspace, 'ambient-mcp-started');

  await mkdir(path.join(fixture.workspace, '.qwen'));
  await writeFile(path.join(fixture.workspace, '.qwen/settings.json'), JSON.stringify({
    mcpServers: { hostile: { command: '/bin/sh', args: ['-c', `touch '${malicious}'`] } },
  }));
  await fixture.fake();
  await adapter.run(runInput(fixture, model, { mcpServers: [] }));
  await absent(malicious);

  const status = await adapter.mcpStatus(fixture.config);

  assert.equal(JSON.stringify(status).includes(QWEN_KEY), false);
  assert.equal(JSON.stringify(status).includes('"connected":true'), false);
});

test('qwen-cli-lease', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);

  await fixture.fake({ hold: true });

  const runtime = await prepareExternalCliRuntime(adapter, fixture.config, fixture.env);
  const leaseInput = {
    directory: runtime.process.leaseDirectory,
    providerId: 'qwen',
    resourceKey: runtime.process.resourceKey,
  };
  const controller = new AbortController();
  let notifyReady;
  const ready = new Promise((resolve) => {
    notifyReady = resolve;
  });

  t.after(() => controller.abort());

  const running = adapter.run(runInput(fixture, model, {
    signal: controller.signal,
    onStep: (step) => {
      if (step.k === 'text') {
        notifyReady('ready');
      }
    },
  }));
  const outcome = running.then(() => 'ended', () => 'failed');

  assert.equal(await Promise.race([ready, outcome]), 'ready');

  const observed = await inspectCliLeases(leaseInput);

  assert.ok(observed.some((holder) => holder.childPid || holder.sessionId), 'bwrap не должен терять reader');
  await assert.rejects(acquireCliLease({ ...leaseInput, mode: 'exclusive' }), { code: 'provider_in_use' });
  controller.abort();
  await rejectedTurn(() => running);
  assert.deepEqual(await inspectCliLeases(leaseInput), []);

  const exclusive = await acquireCliLease({
    ...leaseInput,
    mode: 'exclusive',
  });

  try {
    await fixture.fake();
    await rejectedTurn(() => adapter.run(runInput(fixture, model)));
  } finally {
    await exclusive.release();
  }
});
