import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { glmGateHash, parseGlmGateProof } from '../../shared/node/glmGateProtocol.ts';
import { buildHelper } from '../../server/scripts/sea/helpers.mts';

const SOURCE = fileURLToPath(new URL('../../', import.meta.url));
const POLICY = {
  workTools: [],
  ssh: true,
  db: true,
  strictDb: true,
};
const LIMIT = 4 * 1024 * 1024;
// Поток выдаёт заданные Buffer целиком: граница внутри UTF-8 не зависит от таймеров ОС.
// Настоящий entry helper получает эти блоки через свой обычный цикл чтения stdin.
const WRAPPER = `
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
const chunks = JSON.parse(readFileSync(0, 'utf8')).map(value => Buffer.from(value, 'base64'));
Object.defineProperty(process, 'stdin', { value: Readable.from(chunks) });
await import(process.argv[1]);
`;

/**
 * Привязка рассчитывается по исходным аргументам до разбиения входа.
 * Успех требует прежнего хэша, а не только синтаксически корректного JSON.
 */
function nativeRequest(input) {
  return {
    binding: {
      format: 1,
      consumer: 'chat',
      launchId: 'fixture-launch',
      policyHash: glmGateHash(POLICY),
      sessionId: 'fixture-session',
      agentId: 'fixture-agent',
      turn: 1,
      callId: 'fixture-call',
      name: 'write',
      sha256: glmGateHash(input),
    },
    arguments: input,
  };
}

/**
 * Запускает source или собранный helper без выполнения файлового инструмента.
 * Дочерний процесс получает только фикстурную политику и данные, без ключей хоста.
 */
async function invokeHook(t, helper, policyFile, chunks, native = true) {
  const args = [
    '--input-type=module', '--eval', WRAPPER, pathToFileURL(helper).href,
    '--policy', policyFile, ...(native ? ['--native-gate'] : []),
  ];
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  });
  const output = { stdout: '', stderr: '' };
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value) => {
    output.stdout += value;
  });
  child.stderr.on('data', (value) => {
    output.stderr += value;
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(chunks.map((chunk) => chunk.toString('base64'))));

  const code = await closed;

  return { ...output, code };
}

test('GLM stdin: UTF-8 и предел байтов в source и собранном helper', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glm-stdin-'));
  const policyFile = path.join(root, 'policy.json');
  const helpersDir = path.join(root, 'server/runtime/helpers');
  const manifestPath = path.join(SOURCE, 'server/build/helpers.json');

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(policyFile, JSON.stringify(POLICY));
  await mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
  await symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));

  const bundled = await buildHelper({
    root: SOURCE,
    manifestPath,
    id: 'glm-tool-policy-hook',
    outDir: helpersDir,
    workDir: path.join(root, 'build'),
  });

  await writeFile(path.join(helpersDir, 'helpers.json'), await readFile(manifestPath));

  const helpers = [path.join(SOURCE, 'server/scripts/glmToolPolicyHook.mts'), bundled.file];

  for (const helper of helpers) {
    await t.test(path.basename(helper), async (t) => {
      await t.test('длинный write сохраняет 2-, 3- и 4-байтовые символы', async (t) => {
        for (const symbol of ['Ж', '€', '😀']) {
          const input = { file_path: '/workspace/note.md', content: `${'текст '.repeat(12000)}${symbol}` };
          const request = nativeRequest(input);
          const json = JSON.stringify(request);
          const bytes = Buffer.from(json);
          const start = Buffer.byteLength(json.slice(0, json.indexOf(symbol)));

          for (let offset = 1; offset < Buffer.byteLength(symbol); offset += 1) {
            const chunks = [bytes.subarray(0, start + offset), bytes.subarray(start + offset)];
            const result = await invokeHook(t, helper, policyFile, chunks);

            assert.equal(result.code, 0, result.stderr);
            assert.equal(parseGlmGateProof(result.stdout, request.binding).decision, 'allow');
          }
        }
      });

      await t.test('legacy hook сохраняет хэш русских аргументов', async (t) => {
        const input = { file_path: '/workspace/note.md', content: 'Журнал' };
        const payload = {
          hook_event_name: 'PreToolUse',
          tool_name: 'write',
          tool_use_id: 'fixture-call',
          tool_input: input,
        };
        const json = JSON.stringify(payload);
        const bytes = Buffer.from(json);
        const split = Buffer.byteLength(json.slice(0, json.indexOf('Ж'))) + 1;
        const result = await invokeHook(t, helper, policyFile,
          [bytes.subarray(0, split), bytes.subarray(split)], false);
        const descriptor = JSON.parse(result.stderr.trim().slice('GLM-POLICY '.length));

        assert.equal(result.code, 0, result.stderr);
        assert.equal(descriptor.sha256, glmGateHash(input));
      });

      await t.test('ровно 4 МиБ допускаются, лишний байт запрещён', async (t) => {
        const empty = nativeRequest({ file_path: '/workspace/note.md', content: '' });
        const contentBytes = LIMIT - Buffer.byteLength(JSON.stringify(empty));

        for (const extra of [0, 1]) {
          const content = 'Я'.repeat(Math.floor(contentBytes / 2))
            + 'x'.repeat(contentBytes % 2 + extra);
          const request = nativeRequest({ file_path: '/workspace/note.md', content });
          const bytes = Buffer.from(JSON.stringify(request));
          const result = await invokeHook(t, helper, policyFile, [bytes]);

          assert.equal(bytes.length, LIMIT + extra);
          assert.equal(result.code, extra ? 2 : 0, result.stderr);

          if (extra) {
            assert.match(result.stderr, /вход hook слишком велик/u);
          } else {
            assert.equal(parseGlmGateProof(result.stdout, request.binding).decision, 'allow');
          }
        }
      });

      await t.test('несовпадающий хэш по-прежнему запрещён', async (t) => {
        const request = nativeRequest({ content: 'Исходный текст' });

        request.arguments.content = 'Другой текст';

        const result = await invokeHook(t, helper, policyFile, [Buffer.from(JSON.stringify(request))]);

        assert.equal(result.code, 2);
        assert.match(result.stderr, /аргументы native gate не совпали/u);
      });
    });
  }
});
