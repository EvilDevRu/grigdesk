import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { nativeModeProbe } from '../fixtures/codex-app-server/permission-mode-loopback.mjs';

const directory = process.env.GRIGDESK_CODEX_NATIVE_ARTIFACTS || os.tmpdir();
const nativeOptions = { timeout: 30_000 };
const binary = process.env.CODEX_BIN || 'codex';

try {
  await promisify(execFile)(binary, ['--version'], { timeout: 10_000 });
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }

  nativeOptions.skip = `Codex CLI не установлен (${binary})`;
}

test('native fixture завершает отказ запуска и закрывает loopback без установленного CLI', {
  timeout: 5_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-codex-missing-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(nativeModeProbe({
    directory: root,
    binary: path.join(root, 'missing-codex'),
    policy: 'never',
    sandbox: 'read-only',
    call: () => assert.fail('модель не должна вызываться при отказе запуска'),
  }), { code: 'ENOENT' });
});

/**
 * Реальный code-mode вызывает объявленный shell, а ответчик не подменяет результат команды.
 * Текст результата и наличие approval измеряются независимо от успешного завершения turn.
 */
async function shellProbe(policy, sandbox, cmd, setup) {
  await mkdir(directory, { recursive: true });

  return nativeModeProbe({
    directory,
    policy,
    sandbox,
    setup,
    call: (_request, scope) => ({
      type: 'custom_tool_call',
      id: 'shell',
      call_id: 'probe',
      name: 'exec',
      namespace: 'functions',
      input: `text(await tools.exec_command(${JSON.stringify({
        cmd: typeof cmd === 'function' ? cmd(scope) : cmd,
        max_output_tokens: 300,
      })}));`,
    }),
  });
}

test('native on-request/read-only не обеспечивает подтверждение каждого Bash', nativeOptions, async () => {
  const f = await shellProbe('on-request', 'read-only', 'printf NATIVE_READ_PROBE');
  const output = JSON.stringify(f.requests[1]?.input.filter((item) => item.type.endsWith('call_output')));

  assert.match(output, /NATIVE_READ_PROBE/u, 'команда должна действительно исполниться');
  assert.equal(f.events.some((event) => event.method === 'item/commandExecution/requestApproval'), false);
});

test('native untrusted с внешним allow-rule не гарантирует вопрос для каждого Bash',
  nativeOptions, async () => {
  const f = await shellProbe('untrusted', 'read-only', 'ls', async ({ cwd, home }) => {
    await writeFile(path.join(cwd, 'NATIVE_READ_SENTINEL'), 'fixture');
    await mkdir(path.join(home, 'rules'));
    await writeFile(path.join(home, 'rules/default.rules'),
      'prefix_rule(pattern=["ls"], decision="allow")\n');
  });
  const output = JSON.stringify(f.requests[1]?.input.filter((item) => item.type.endsWith('call_output')));

  assert.match(output, /NATIVE_READ_SENTINEL/u);
  assert.equal(f.events.some((event) => event.method === 'item/commandExecution/requestApproval'), false);
});

test('native dontAsk разрешает workspace effect и запрещает внешний без approval',
  nativeOptions, async () => {
  const f = await shellProbe('never', 'workspace-write', ({ root }) => (
    `printf allowed > allowed.txt; printf forbidden > ${JSON.stringify(path.join(root, 'forbidden'))}`
  ));

  assert.equal(await readFile(path.join(f.cwd, 'allowed.txt'), 'utf8'), 'allowed');
  await assert.rejects(access(path.join(f.root, 'forbidden')));
  assert.equal(f.events.some((event) => event.method === 'item/commandExecution/requestApproval'), false);
  assert.equal(f.ready.approvalPolicy, 'never');
});

test('native bypass разрешает только синтетический sibling в пробе', nativeOptions, async () => {
  const f = await shellProbe('never', 'danger-full-access', ({ root }) => (
    `printf bypass > ${JSON.stringify(path.join(root, 'sibling'))}`
  ));

  assert.equal(await readFile(path.join(f.root, 'sibling'), 'utf8'), 'bypass');
  assert.equal(f.ready.sandbox.type, 'dangerFullAccess');
});

test('native cleanup не отзывает detached effect полного доступа: bypass не получает admission',
  nativeOptions, async () => {
  const f = await nativeModeProbe({
    directory,
    policy: 'never',
    sandbox: 'danger-full-access',
    cleanTerminals: true,
    call: (_request, { root }) => ({
      type: 'custom_tool_call',
      id: 'shell',
      call_id: 'probe',
      name: 'exec',
      namespace: 'functions',
      input: `text(await tools.exec_command(${JSON.stringify({
        cmd: `setsid sh -c 'sleep 3; printf detached > "${root}/detached-marker"' `
          + '>/dev/null 2>&1 </dev/null &',
        max_output_tokens: 300,
      })}));`,
    }),
  });

  assert.deepEqual(f.terminals, { data: [], nextCursor: null });
  await delay(3300);
  assert.equal(await readFile(path.join(f.root, 'detached-marker'), 'utf8'), 'detached');
});

test('native acceptEdits не защищает новый .env при автоматическом patch', nativeOptions, async () => {
  const f = await nativeModeProbe({
    directory,
    policy: 'on-request',
    sandbox: 'workspace-write',
    call: () => ({
      type: 'custom_tool_call',
      id: 'patch',
      call_id: 'probe',
      name: 'exec',
      namespace: 'functions',
      input: `text(await tools.apply_patch(${JSON.stringify(
        '*** Begin Patch\n*** Add File: .env\n+SYNTHETIC_SENTINEL=changed\n*** End Patch',
      )}));`,
    }),
  });

  assert.match(await readFile(path.join(f.cwd, '.env'), 'utf8'), /SYNTHETIC_SENTINEL=changed/u);
  assert.equal(f.events.some((event) => event.method === 'item/fileChange/requestApproval'), false);
});

for (const mode of ['dontAsk']) {
  test(`настоящий CLI через wrapped adapter: ${mode}, reuse и cleanup`, nativeOptions, async () => {
    const f = await nativeModeProbe({
      directory,
      adapterMode: mode,
      call: (_request, { root }) => ({
        type: 'custom_tool_call',
        id: 'shell',
        call_id: 'probe',
        name: 'exec',
        namespace: 'functions',
        input: `text(await tools.exec_command(${JSON.stringify({
          cmd: mode === 'dontAsk' ? 'printf adapter > adapter.txt'
            : `printf adapter > ${JSON.stringify(path.join(root, 'adapter-sibling'))}`,
          max_output_tokens: 300,
        })}));`,
      }),
    });
    const marker = mode === 'dontAsk' ? path.join(f.cwd, 'adapter.txt')
      : path.join(f.root, 'adapter-sibling');

    assert.equal(await readFile(marker, 'utf8'), 'adapter');
    assert.equal(f.result.reply, 'probe completed');
  });
}
