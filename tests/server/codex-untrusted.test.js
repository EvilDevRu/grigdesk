import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import codex from '../../server/src/lib/executors/codex.ts';
import {
  assertCodexUntrustedThread,
  buildCodexUntrustedInput,
  runCodexUntrusted,
} from '../../server/src/lib/executors/_codexUntrusted.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BA'
  + 'EiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=';
const READY = {
  thread: { id: 'isolated', ephemeral: true, environments: [] },
  instructionSources: [],
  runtimeWorkspaceRoots: [],
  approvalPolicy: 'never',
  sandbox: { type: 'readOnly', networkAccess: false },
  model: 'test-model',
};

test('Codex объявляет поддержку текста и кадров для общего выбора модели', () => {
  assert.equal(codex.untrustedInput.text, true);
  assert.equal(codex.untrustedInput.images, true);
  assert.equal(codex.untrustedInput.maxImages, 20);
  assert.equal(codex.runUntrusted, runCodexUntrusted);
});

test('Codex принимает только изображения байтами и соблюдает лимит кадров', () => {
  assert.deepEqual(buildCodexUntrustedInput('кадр', [{ mediaType: 'image/png', data: PNG }]), [
    { type: 'text', text: 'кадр', text_elements: [] },
    { type: 'image', url: `data:image/png;base64,${PNG}` },
  ]);
  assert.throws(() => buildCodexUntrustedInput('', Array(21).fill({})),
    { code: 'attachment_media_limit' });
  for (const image of [
    { mediaType: 'text/plain', data: PNG },
    { mediaType: 'image/png', data: '/tmp/photo.png' },
    { mediaType: 'image/png', data: 'https://example.test/image' },
  ]) {
    assert.throws(() => buildCodexUntrustedInput('', [image]), { code: 'unsupported_media' });
  }
});

test('Codex не передаёт ввод CLI, который не подтвердил изоляцию', () => {
  assert.doesNotThrow(() => assertCodexUntrustedThread(READY));
  for (const changed of [
    {},
    { ...READY, thread: { ...READY.thread, environments: null } },
    { ...READY, thread: { ...READY.thread, environments: [{}] } },
    { ...READY, thread: { ...READY.thread, ephemeral: false } },
    { ...READY, instructionSources: ['/project/AGENTS.md'] },
    { ...READY, approvalPolicy: 'on-request' },
    { ...READY, sandbox: { type: 'dangerFullAccess' } },
    { ...READY, sandbox: { type: 'readOnly', networkAccess: true } },
    { ...READY, runtimeWorkspaceRoots: ['/project'] },
  ]) {
    assert.throws(() => assertCodexUntrustedThread(changed), { code: 'unsafe_model_provider' });
  }
});

/**
 * Поддельный процесс сохраняет протокол, чтобы проверить границу и очистку при отказах.
 */
async function fakeCli(t, behavior) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-codex-untrusted-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'codex');
  const capture = path.join(directory, 'capture.jsonl');
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const launch = { cwd: process.cwd(), args: process.argv.slice(2) };
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(launch)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const event = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(capture)},line+'\\n');
 if (event.id === 1) send({id:1,result:{}});
 if (event.id === 2) send({id:2,result:${JSON.stringify(READY)}});
 if (event.id === 3) { ${behavior} }
});
`);
  await chmod(bin, 0o755);

  return { bin, capture };
}

test('Codex возвращает финальный ответ, выбранное усилие и удаляет временные данные', async (t) => {
  const { bin, capture } = await fakeCli(t, `
    send({method:'item/completed',params:{threadId:'foreign',
      item:{id:'wrong',type:'agentMessage',text:'wrong'}}});
    send({method:'item/completed',params:{threadId:'isolated',
      item:{id:'reply',type:'agentMessage',text:'{"ok":true}'}}});
    send({method:'turn/completed',params:{threadId:'isolated',turn:{status:'completed'}}});
  `);
  const result = await runCodexUntrusted({
    config: { codexBin: bin }, message: 'вход', model: 'test-model', effort: 'high',
    images: [{ mediaType: 'image/png', data: PNG }],
  });
  assert.deepEqual(result, {
    reply: '{"ok":true}', sessionId: null, actualModel: 'test-model', cost: null,
  });
  const records = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  await assert.rejects(access(records[0].cwd));
  const turn = records.find((entry) => entry.method === 'turn/start').params;
  assert.equal(turn.effort, 'high');
  assert.deepEqual(turn.environments, []);
  assert.equal(turn.input[1].url, `data:image/png;base64,${PNG}`);
  assert.equal(records.some((entry) => entry.method === 'thread/resume'), false);
});

for (const [name, behavior, code] of [
  ['отказ модели', `send({method:'turn/completed',params:{threadId:'isolated',
    turn:{status:'failed',error:{message:'bad request'}}}});`, 'model_run_failed'],
  ['лимит модели', `send({method:'turn/completed',params:{threadId:'isolated',
    turn:{status:'failed',error:{codexErrorInfo:'usageLimitExceeded',message:'limit reached'}}}});`,
  'model_rate_limited'],
  ['пустой результат', `send({method:'turn/completed',params:{threadId:'isolated',
    turn:{status:'completed'}}});`, 'model_run_failed'],
  ['запрос инструмента', "send({id:100,method:'item/tool/call',params:{}});", 'unsafe_model_provider'],
  ['переполнение', "process.stdout.write('x'.repeat(3*1024*1024));", 'model_run_failed'],
  ['сломанный поток', "process.stdout.write('not json\\n');", 'model_run_failed'],
]) {
  test(`Codex завершает изолированный процесс: ${name}`, async (t) => {
    const { bin, capture } = await fakeCli(t, behavior);
    await assert.rejects(runCodexUntrusted({ config: { codexBin: bin }, message: 'x' }), { code });
    const first = JSON.parse((await readFile(capture, 'utf8')).split('\n')[0]);
    await assert.rejects(access(first.cwd));
  });
}

test('Codex прерывает зависший запрос по сроку и по отмене', async (t) => {
  const { bin } = await fakeCli(t, '');
  await assert.rejects(runCodexUntrusted({ config: { codexBin: bin }, timeoutMs: 100 }),
    /не уложился/u);
  await assert.rejects(runCodexUntrusted({ config: { codexBin: bin }, signal: AbortSignal.timeout(100) }),
    { code: 'model_run_aborted' });
});

/**
 * Настоящий установленный CLI отправляет запрос локальному приёмнику вместо модели.
 * Проверяем фактическую границу: ни исходных правил, ни подключённого MCP, ни
 * инструментов файлов/команд; изображения находятся прямо в user content.
 */
test('установленный Codex изолирует сценарий и кадры от рабочего окружения', {
  timeout: 30_000,
}, async (t) => {
  try {
    await promisify(execFile)(process.env.CODEX_BIN || 'codex', ['--version'], { timeout: 10_000 });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return t.skip('Codex CLI не установлен.');
    }
    throw error;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'cockpit-codex-untrusted-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, 'state');
  await mkdir(state);
  const marker = path.join(directory, 'external-action');
  const poison = 'UNTRUSTED_TEST_PRIVATE_RULES_MUST_NOT_APPEAR';
  await writeFile(path.join(state, 'AGENTS.md'), poison);
  const captures = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    captures.push(JSON.parse(body));
    const item = captures.length === 1
      ? { type: 'custom_tool_call', id: 'tool-call', call_id: 'probe', name: 'exec', namespace: 'functions',
        input: 'text({emptyTools:ALL_TOOLS.length===0,'
          + 'shell:typeof tools.exec_command,fs:typeof tools.apply_patch});' }
      : { type: 'message', id: 'answer', role: 'assistant',
        content: [{ type: 'output_text', text: '{"verified":true}' }] };
    const events = [
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'response', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(path.join(state, 'config.toml'), `
model_provider = "contract"
developer_instructions = "${poison}"
notify = ["touch", ${JSON.stringify(marker)}]
[model_providers.contract]
name = "contract"
base_url = "http://127.0.0.1:${server.address().port}"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.poison]
command = "touch"
args = [${JSON.stringify(marker)}]
[features]
apps = true
plugins = true
shell_tool = true
hooks = true
`);
  const bin = path.join(directory, 'codex-test');
  // Подмена только адреса модели на границе тестового CLI; пользовательский config
  // специально содержит другие настройки и не должен попасть в изолированный ход.
  const args = [
    '-c', 'model_provider="contract"',
    '-c', 'model_providers.contract={name="contract",'
      + `base_url="http://127.0.0.1:${server.address().port}",wire_api="responses",`
      + 'requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}',
  ];
  await writeFile(bin, `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(process.env.CODEX_BIN || 'codex')},
  [...${JSON.stringify(args)}, ...process.argv.slice(2)], {stdio:'inherit'});
process.on('SIGTERM', () => child.kill());
child.on('close', code => process.exit(code ?? 1));
`);
  await chmod(bin, 0o755);
  const result = await runCodexUntrusted({
    config: { codexBin: bin },
    env: { CODEX_HOME: state },
    message: 'Проверь приложенный кадр.',
    images: [{ mediaType: 'image/png', data: PNG }],
    model: 'gpt-6-astra', effort: 'low', timeoutMs: 20_000,
  });
  assert.equal(result.reply, '{"verified":true}');
  assert.equal(captures.length, 2);
  const toolResults = captures[1].input.filter((item) => item.type === 'custom_tool_call_output');
  assert.equal(toolResults[0]?.output, 'code-mode host is disabled');
  const request = captures[0];
  assert.doesNotMatch(JSON.stringify(request), new RegExp(poison));
  const tools = [
    ...(request.tools || []),
    ...request.input.filter((item) => item.type === 'additional_tools').flatMap((item) => item.tools),
  ];
  const exposed = tools.flatMap((tool) => tool.type === 'namespace' ? tool.tools : [tool]);
  assert.deepEqual(exposed.map((tool) => tool.name).sort(), ['exec', 'request_user_input_async', 'wait']);
  // В описании оболочки есть примеры tools.exec_command; это не объявления.
  // У изолированной оболочки нет ни одного вложенного инструмента.
  assert.doesNotMatch(exposed.find((tool) => tool.name === 'exec').description, /declare const tools:/u);
  const content = request.input.filter((item) => item.role === 'user').flatMap((item) => item.content);
  assert.ok(content.some((part) => (
    part.type === 'input_image' && part.image_url.startsWith('data:image/png;')
  )));
  assert.doesNotMatch(JSON.stringify(content), /\/tmp|environment_context|AGENTS.md/u);
  await assert.rejects(access(marker));
  await assert.rejects(access(path.join(state, 'sessions')));
});
