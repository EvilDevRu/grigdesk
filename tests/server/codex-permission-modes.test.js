import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import codex from '../../server/src/lib/executors/codex.ts';
import { createWorkTools } from '../../server/src/lib/executors/index.ts';
import { translator } from '../../shared/i18n/catalogs.ts';
import { codexModeProfile, codexPermissionModes, validateCodexRequirements }
  from '../../server/src/lib/executors/_codexPermissionModes.ts';

const source = new URL('../fixtures/codex-app-server/permission-modes-0.164.0.mjs', import.meta.url).href;

/**
 * Все probes и рабочий spawn используют один синтетический CLI и собственный trace.
 * Перезапись settings воспроизводит managed drift без изменения бинаря или истории.
 */
async function fixture(t, mode = 'dontAsk') {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-mode-'));
  const bin = path.join(cwd, 'codex');
  const trace = path.join(cwd, 'trace.jsonl');
  const settings = path.join(cwd, 'settings.json');
  const config = { codexBin: bin };
  const selection = {
    provider: 'codex',
    id: mode,
    revision: 1,
    chatId: 'chat'
  };

  await writeFile(settings, '{}');
  await writeFile(bin, `#!${process.execPath}\nimport { runPermissionModesFixture } from ${
    JSON.stringify(source)};\nrunPermissionModesFixture(${JSON.stringify({ trace, settings })});\n`);
  await chmod(bin, 0o755);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const prepare = async () => {
    const preparedRuntime = await codex.prepareRuntime(config, { signal: AbortSignal.timeout(5000),
      permissionModeContext: {
        mode,
        provider: 'codex',
        chatId: 'chat',
        cwd,
        extraDirs: [],
        modeSelection: selection
      } });

    return {
      config,
      cwd,
      extraDirs: [],
      permissionMode: mode,
      modeSelection: selection,
      preparedRuntime,
      runtimeProfileFingerprint: codex.runtimeProfileFingerprint(preparedRuntime),
      providerSettings: { blockDirectSsh: false },
      tokenInfoReader: async () => null
    };
  };

  return {
    prepare,
    config,
    settings,
    messages: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
  };
}

test('Codex объявляет auto default и синхронно проверяет все известные ID', () => {
  assert.equal(codex.defaultPermissionMode, 'auto');
  assert.equal(typeof codex.normalizePermissionMode, 'function');
  assert.deepEqual(codex.normalizePermissionMode(''), { ok: true, mode: 'auto' });

  for (const mode of ['plan', 'manual', 'auto', 'acceptEdits', 'dontAsk', 'bypassPermissions']) {
    assert.deepEqual(codex.normalizePermissionMode(mode), { ok: true, mode });
  }

  for (const value of ['invalid', 1, {}, false]) {
    assert.equal(codex.normalizePermissionMode(value).ok, false);
  }

  for (const mode of codexPermissionModes()) {
    assert.ok(translator.t('ru', mode.labelKey));
    assert.ok(translator.t('en', mode.labelKey));
    assert.ok(translator.t('en', mode.hintKey));
  }
});

test('недоказанные manual, acceptEdits и plan отклоняются, не подменяясь auto', () => {
  for (const mode of ['manual', 'acceptEdits', 'plan', 'bypassPermissions']) {
    assert.throws(() => codexModeProfile(mode), { code: 'mode_unavailable' });
    assert.equal(codexPermissionModes().some((entry) => entry.id === mode), false);
  }

  assert.equal(Object.isFrozen(codexModeProfile('dontAsk')), true);
});

test('null требований и nullable списки допустимы; пустые/malformed списки закрывают режим', () => {
  assert.doesNotThrow(() => validateCodexRequirements({ requirements: null }, 'dontAsk'));
  assert.doesNotThrow(() => validateCodexRequirements({ requirements: {
    allowedApprovalPolicies: null,
    allowedApprovalsReviewers: null,
    allowedSandboxModes: null,
  } }, 'dontAsk'));

  for (const requirements of [undefined, {}, { requirements: false }, { requirements: {} },
    { requirements: { allowedApprovalPolicies: [] } },
    { requirements: { allowedApprovalPolicies: 'never' } }]) {
    assert.throws(() => validateCodexRequirements(requirements, 'dontAsk'), { code: 'mode_unavailable' });
  }
});

test('каталог исключает managed-запрещённые профили и не заменяет отсутствующий default', async (t) => {
  const f = await fixture(t);

  assert.deepEqual((await codex.modes(f.config)).map((entry) => entry.id),
    ['auto', 'dontAsk']);
  await writeFile(f.settings, JSON.stringify({ requirementsReply: { requirements: {
    allowedApprovalPolicies: ['never'],
    allowedApprovalsReviewers: ['user'],
    allowedSandboxModes: ['workspace-write'],
  } } }));
  assert.deepEqual((await codex.modes(f.config)).map((entry) => entry.id), ['dontAsk']);
  assert.equal(codex.defaultPermissionMode, 'auto');
  assert.equal((await f.messages()).some((entry) => entry.method === 'thread/start'), false);
});

test('bypass без явного выбора отклоняется до metadata probe', async () => {
  await assert.rejects(codex.prepareRuntime({ codexBin: '/does-not-exist' }, {
    signal: AbortSignal.timeout(1000), permissionModeContext: {
      mode: 'bypassPermissions',
      provider: 'codex',
      chatId: 'chat',
      cwd: '/fixture',
      extraDirs: []
    },
  }), { code: 'invalid_permission_mode' });
});

for (const mode of ['dontAsk']) {
  test(`start/resume и каждый send получают профиль ${mode}; handle нельзя подделать`, async (t) => {
    const f = await fixture(t, mode);
    const initial = await f.prepare();
    const session = codex.session.open(initial);

    t.after(() => session.close());

    await session.send({ ...initial, message: 'Первый' });

    const next = await f.prepare();

    await session.send({ ...next, message: 'Второй' });
    assert.equal(initial.runtimeProfileFingerprint, next.runtimeProfileFingerprint);

    const messages = await f.messages();
    const turns = messages.filter((entry) => entry.method === 'turn/start');

    assert.equal(turns.length, 2);

    for (const entry of turns) {
      assert.equal(entry.params.approvalPolicy, 'never');
      assert.equal(entry.params.approvalsReviewer, 'user');
      assert.equal(entry.params.sandboxPolicy.type,
        mode === 'dontAsk' ? 'workspaceWrite' : 'dangerFullAccess');
    }

    assert.throws(() => codex.session.open({ ...initial, preparedRuntime: {} }),
      { code: 'mode_unavailable' });
    await assert.rejects(session.send({ message: 'Без свежего handle' }), { code: 'mode_unavailable' });
  });
}

test('drift требований после acquire не допускает второй turn', async (t) => {
  const f = await fixture(t);
  const initial = await f.prepare();
  const session = codex.session.open(initial);

  t.after(() => session.close());
  await session.send({ ...initial, message: 'Первый' });
  await writeFile(f.settings, JSON.stringify({ requirementsReply: { requirements: {
    allowedApprovalPolicies: [],
    allowedApprovalsReviewers: null,
    allowedSandboxModes: null,
  } } }));
  await assert.rejects(session.send({ ...initial, message: 'Второй' }), { code: 'mode_unavailable' });
  assert.equal((await f.messages()).filter((entry) => entry.method === 'turn/start').length, 1);
});

test('plan whitelist проверяет действие до broker, включая SELECT и неизвестный tool', async () => {
  const calls = [];
  const tools = createWorkTools({
    projectId: 'fixture',
    chatKey: 'chat',
    workToolPolicy: codex.workToolPolicy('plan'),
    pluginEnabled: () => true,
    invoke: async (_scope, input) => {
      calls.push(['ssh', input.action]);

      return [];
    },
    dbInvoke: async (_scope, input) => {
      calls.push(['db', input.action]);

      return [];
    },
  });

  for (const [name, input] of [
    ['supervised_ssh', { action: 'exec', command: 'ls' }],
    ['supervised_db', { action: 'query', text: 'SELECT 1' }],
    ['supervised_db', { action: 'unknown' }], ['unknown', { action: 'list' }],
  ]) {
    assert.deepEqual(await tools.invoke(name, input), { ok: false, error: 'action_not_allowed' });
  }

  assert.deepEqual(calls, []);
  await tools.invoke('supervised_ssh', { action: 'list' });
  await tools.invoke('supervised_db', { action: 'list' });
  await tools.invoke('supervised_db', { action: 'schema' });
  assert.deepEqual(calls, [['ssh', 'list'], ['db', 'list'], ['db', 'schema']]);
});
