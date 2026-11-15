import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import codex from '../../../server/src/lib/executors/codex.ts';
import { externalCliAdapter } from '../../../server/src/lib/providerInstall/externalCliAdapter.ts';
import { hostApi } from './host-api.mjs';

const [root, binary, scenario] = process.argv.slice(2);
const home = path.join(root, 'home');
const cwd = path.join(root, 'workspace');
const resources = [];
const requests = [];
const owners = [];
let command = '';
let callPending = false;
let responses = 0;
let heldResponse = null;
let hold = false;
let requireEmpty = [];

/**
 * Отсутствующая cgroup считается пустой; ошибка доступа не является успешным cleanup.
 * Проверяется сохранённый путь собственного scope, без поиска чужих процессов по имени.
 */
async function emptyGroup(group) {
  const events = await readFile(path.join('/sys/fs/cgroup', group, 'cgroup.events'), 'utf8')
    .catch((error) => {
      if (error.code === 'ENOENT') {
        return 'populated 0';
      }

      throw error;
    });

  return /^populated 0$/mu.test(events);
}

/**
 * Ограниченный опрос ждёт реального эффекта ОС, а не текста финального ответа модели.
 * Срок не позволяет ошибке управления процессом удержать native gate навсегда.
 */
async function until(check, description) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await pause(20);
  }

  assert.fail(`Native: не наступило событие ${description}`);
}

/**
 * Loopback подменяет только модель: exec_command исполняет настоящий выбранный CLI.
 * До следующего запроса сверяем пустоту прежнего scope, подтверждая порядок перехода.
 */
async function modelResponse(request, response) {
  let body = '';

  for await (const chunk of request) {
    body += chunk;
  }

  for (const group of requireEmpty) {
    assert.equal(await emptyGroup(group), true, 'Новый ход не начинается до confirmed cleanup');
  }

  requests.push(JSON.parse(body));

  if (hold) {
    heldResponse = response;

    return;
  }

  const item = command && !callPending ? {
    type: 'custom_tool_call',
    id: `shell-${responses}`,
    call_id: `probe-${responses}`,
    name: 'exec',
    namespace: 'functions',
    input: `text(await tools.exec_command(${JSON.stringify({
      cmd: command,
      max_output_tokens: 500,
    })}));`,
  } : {
    type: 'message',
    id: `answer-${responses}`,
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: `NATIVE_HISTORY_${responses}`,
    }],
  };

  callPending = item.type === 'custom_tool_call';

  if (!callPending) {
    command = '';
  }

  responses += 1;

  const output = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item,
    },
    {
      type: 'response.completed',
      response: {
        id: `response-${responses}`,
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      },
    },
  ];

  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(output.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

/**
 * PID берётся из собственного session DTO, cgroup — из /proc этого процесса.
 * PID exit не служит заменой гарантии: после close проверяется captured cgroup.
 */
async function captureOwner(api, chatKey) {
  const session = (await api.sessions()).sessions.find((entry) => entry.chatKey === chatKey);

  assert.ok(session?.pid, 'Native Codex должен иметь учтённый owner');

  const cgroup = await readFile(`/proc/${session.pid}/cgroup`, 'utf8');
  const group = cgroup.split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  const unit = group?.split('/').at(-1);

  assert.match(unit || '', /\.scope$/u, 'Ordinary Codex находится в отдельном scope');
  assert.equal(await emptyGroup(group), false);

  const captured = {
    group,
    unit,
    pid: session.pid,
  };

  owners.push(captured);

  return captured;
}

/**
 * Три вида собственной фоновой работы переживают exit породившей оболочки.
 * Gate и короткий срок делают проверку late marker безопасной даже при дефекте cleanup.
 */
async function launchDetached(api, chatKey, suffix) {
  const directory = path.join(root, suffix);
  const childScript = path.join(directory, 'child.mjs');
  const launcher = path.join(directory, 'launcher.mjs');

  await mkdir(directory);
  await writeFile(childScript, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const [directory, name] = process.argv.slice(2);',
    "fs.writeFileSync(path.join(directory, name + '.ready'), String(process.pid));",
    'const deadline = Date.now() + 25000;',
    'const timer = setInterval(() => {',
    "  if (fs.existsSync(path.join(directory, 'release'))) {",
    "    fs.writeFileSync(path.join(directory, name + '.late'), 'late');",
    '    clearInterval(timer);',
    '  } else if (Date.now() > deadline) {',
    '    clearInterval(timer);',
    '  }',
    '}, 20);',
    '',
  ].join('\n'));
  await writeFile(launcher, [
    "import { spawn } from 'node:child_process';",
    `const script = ${JSON.stringify(childScript)};`,
    `const directory = ${JSON.stringify(directory)};`,
    "spawn(process.execPath, [script, directory, 'normal'], { stdio: 'ignore' }).unref();",
    "spawn(process.execPath, [script, directory, 'setsid'], { detached: true, stdio: 'ignore' }).unref();",
    "const code = 'const {spawn}=require(\"node:child_process\");'",
    '  + `spawn(process.execPath, [${JSON.stringify(script)}, ${JSON.stringify(directory)}, "double"],`',
    '  + \'{detached:true,stdio:"ignore"}).unref();\';',
    "spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();",
    '',
  ].join('\n'));
  command = `${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)}`;

  const result = await api.turn(chatKey);

  assert.equal(result.statusCode, 200, result.body);

  const pids = [];

  for (const name of ['normal', 'setsid', 'double']) {
    const ready = path.join(directory, `${name}.ready`);

    await until(() => readFile(ready, 'utf8').then(() => true, () => false), `${name} ready`);
    pids.push(Number(await readFile(ready, 'utf8')));
  }

  return {
    directory,
    pids,
    owner: await captureOwner(api, chatKey),
  };
}

/**
 * Смерть своих PID и пустота scope измеряются независимо; внешняя запись уже совершена.
 * Открытие gate после закрытия не должно производить поздний эффект.
 */
async function assertDetachedClosed(detached) {
  await until(() => emptyGroup(detached.owner.group), 'пустая captured cgroup');

  for (const pid of detached.pids) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }

  await writeFile(path.join(detached.directory, 'release'), '1');
  await pause(100);

  for (const name of ['normal', 'setsid', 'double']) {
    await assert.rejects(readFile(path.join(detached.directory, `${name}.late`)), { code: 'ENOENT' });
  }
}

/**
 * Вся последовательность исполняется внутри отдельного synthetic app service.
 * Убийство этого владельца в родительском тесте никогда не затрагивает сервер задачи.
 */
async function run() {
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const server = createServer((request, response) => {
    modelResponse(request, response).catch((error) => {
      response.destroy(error);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  resources.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await writeFile(path.join(home, 'config.toml'), [
    'model_provider="contract"',
    '[model_providers.contract]',
    'name="contract"',
    `base_url="http://127.0.0.1:${server.address().port}"`,
    'wire_api="responses"',
    'requires_openai_auth=false',
    'request_max_retries=0',
    'stream_max_retries=0',
    '',
  ].join('\n'));

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: home,
    SHELL: '/bin/bash',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    GRIGDESK_HOME: path.join(root, 'data'),
    GRIGDESK_ARTIFACTS_DIR: path.join(root, 'artifacts'),
  };
  const fixture = {
    root,
    cwd,
    config: {
      codexBin: binary,
      rootDir: cwd,
      dataHome: env.GRIGDESK_HOME,
    },
    cleanup: (close) => resources.push(close),
    update: async () => { },
  };
  const t = { after: (close) => resources.push(close) };
  const api = await hostApi(t, {
    fixture,
    executor: externalCliAdapter(codex, env),
    processManager: { heal: async () => { } },
    seed: true,
    modelId: 'gpt-6-astra',
  });
  const chatKey = await api.chat('native-chat');
  const sibling = path.join(root, 'sibling');

  command = `printf allowed > allowed.txt; printf forbidden > ${JSON.stringify(sibling)}`;

  const sandbox = await api.turn(chatKey, { mode: 'dontAsk' });

  if (scenario === 'missing-bus') {
    assert.equal(sandbox.statusCode, 503, sandbox.body);
    assert.equal(requests.length, 0, 'Отказ user bus предшествует рабочему turn');
    assert.equal((await api.sessions()).sessions.length, 0);
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ unavailableBus: true }));

    for (const close of resources.reverse()) {
      await close();
    }

    return;
  }

  assert.equal(sandbox.statusCode, 200, sandbox.body);
  assert.equal(await readFile(path.join(cwd, 'allowed.txt'), 'utf8'), 'allowed');
  await assert.rejects(readFile(sibling), { code: 'ENOENT' });

  const offOwner = await captureOwner(api, chatKey);

  assert.equal((await api.toggle(true)).statusCode, 200);
  requireEmpty = [offOwner.group];
  command = `printf host > ${JSON.stringify(sibling)}`;
  assert.equal((await api.turn(chatKey)).statusCode, 200);
  assert.equal(await readFile(sibling, 'utf8'), 'host');

  const hostOwner = await captureOwner(api, chatKey);
  const profile = (await api.sessions()).sessions[0].permissionProfile;

  assert.deepEqual(profile, {
    id: 'host',
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    confirmed: true,
  });
  assert.equal((await api.turn(chatKey)).statusCode, 200);
  assert.equal((await captureOwner(api, chatKey)).unit, hostOwner.unit, 'Два send используют один scope');

  const detached = await launchDetached(api, chatKey, 'detached');

  if (scenario !== 'sequence') {
    await writeFile(path.join(root, 'ready.json'), JSON.stringify({
      detached,
      sibling,
      profile,
    }));
    process.once('SIGTERM', async () => {
      for (const close of resources.reverse()) {
        await close();
      }

      process.exit(0);
    });

    return;
  }

  hold = true;

  const active = api.turn(chatKey);

  await until(() => Boolean(heldResponse), 'удержанный native model request');
  assert.equal((await api.app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: { chatKey },
  })).statusCode, 200);
  await active;
  heldResponse.destroy();
  heldResponse = null;
  hold = false;
  assert.equal(await emptyGroup(hostOwner.group), false, 'Stop не закрывает scope');
  assert.equal((await api.turn(chatKey)).statusCode, 200);
  assert.equal((await api.toggle(false)).statusCode, 200);
  requireEmpty.push(hostOwner.group);
  assert.equal((await api.turn(chatKey)).statusCode, 200);
  await assertDetachedClosed(detached);

  const off = (await api.sessions()).sessions[0].permissionProfile;

  assert.equal(off.sandbox, 'workspace-write');
  assert.equal(off.approvalPolicy, 'on-request');
  assert.equal(off.approvalsReviewer, 'auto_review');
  assert.equal(await readFile(sibling, 'utf8'), 'host', 'Закрытие не отменяет выполненное действие');
  assert.ok(JSON.stringify(requests.at(-1).input).includes('NATIVE_HISTORY_'),
    'Resume содержит прежний ответ');

  for (const action of ['close', 'reset', 'delete', 'force', 'shutdown']) {
    assert.equal((await api.toggle(true)).statusCode, 200);

    const id = await api.chat(`native-${action}`);
    const owned = await launchDetached(api, id, action);

    if (action === 'shutdown') {
      await api.app.close();
    } else if (action === 'reset') {
      assert.equal((await api.app.inject({
        method: 'POST',
        url: '/api/chat/session/reset',
        payload: { chatKey: id },
      })).statusCode, 200);
    } else if (action === 'delete') {
      assert.equal((await api.app.inject({
        method: 'DELETE',
        url: `/api/chat/store/chat/${id}`,
      })).statusCode,
        200);
    } else {
      if (action === 'force') {
        hold = true;
      }

      const running = action === 'force' ? api.turn(id) : null;

      if (running) {
        await until(() => Boolean(heldResponse), 'native force-close занятого хода');
      }

      assert.equal((await api.app.inject({
        method: 'DELETE',
        url: `/api/chat/sessions/${id}${action === 'force' ? '?force=1' : ''}`,
      })).statusCode, 200);
      await running;
      heldResponse?.destroy();
      heldResponse = null;
      hold = false;
    }

    await assertDetachedClosed(owned);
  }

  await writeFile(path.join(root, 'result.json'), JSON.stringify({
    owners,
    profile,
    off,
    requests: requests.length,
    sibling: await readFile(sibling, 'utf8'),
  }));

  for (const close of resources.reverse()) {
    await close();
  }
}

run().catch(async (error) => {
  await writeFile(path.join(root, 'failure.txt'), error.stack || String(error));

  for (const close of resources.reverse()) {
    await close().catch(() => { });
  }

  process.exitCode = 1;
});
