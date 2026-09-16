import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import claude, {
  buildClaudeUntrustedArgs,
  buildClaudeUntrustedInput,
} from '../../server/src/lib/executors/claude.ts';

test('Claude untrusted argv отключает инструменты, customizations, MCP и persistence', () => {
  const args = buildClaudeUntrustedArgs({
    model: 'opus',
    effort: 'high',
    providerSettings: { fastMode: true },
  });
  const valueAfter = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueAfter('--tools'), '');
  // Режим plan подмешивает инструкции о файле плана, и модель на сложном вопросе
  // отвечала «планом» вместо ответа: model-only ход идёт без подсказок о плане.
  assert.equal(valueAfter('--permission-mode'), 'dontAsk');
  assert.equal(valueAfter('--setting-sources'), '');
  for (const flag of [
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ]) assert.ok(args.includes(flag), flag);
  for (const forbidden of ['--add-dir', '--resume', '--dangerously-skip-permissions']) {
    assert.equal(args.includes(forbidden), false, forbidden);
  }
});

test('Claude untrusted input передаёт изображения байтами, без файлового пути', () => {
  const payload = buildClaudeUntrustedInput('разбери обращение', [{
    mediaType: 'image/png',
    data: 'iVBORw0KGgo=',
  }]);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.type, 'user');
  assert.deepEqual(parsed.message.content, [
    { type: 'text', text: 'разбери обращение' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    },
  ]);
  assert.doesNotMatch(payload, /\/tmp|attachmentPaths|extraDirs/u);
  assert.throws(() => buildClaudeUntrustedInput('x', [{
    mediaType: 'application/octet-stream', data: 'AA==',
  }]), (error) => error.code === 'unsupported_media');
  // Предел строки stream-json CLI называется до запуска, а не после его отказа.
  assert.throws(
    () => buildClaudeUntrustedInput('x', [{ mediaType: 'image/jpeg', data: 'A'.repeat(1_048_576) }]),
    (error) => error.code === 'input_too_large' && /1024 КБ/u.test(error.message),
  );
});

test('Claude untrusted ход запускается в отдельном временном cwd и не сохраняет session', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-claude-untrusted-'));
  const bin = path.join(dir, 'fake-claude');
  const capture = path.join(dir, 'capture');
  await writeFile(bin, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "${CAPTURE_PATH}.args"',
    'pwd > "${CAPTURE_PATH}.cwd"',
    'IFS= read -r payload',
    'printf "%s" "$payload" > "${CAPTURE_PATH}.stdin"',
    "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"{\\\"kind\\\":\\\"none\\\"}\",\"session_id\":\"must-not-leak\"}'",
  ].join('\n'));
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const out = await claude.runUntrusted({
    config: { claudeBin: bin },
    env: { CAPTURE_PATH: capture },
    message: 'недоверенный prompt',
    images: [],
    model: 'opus',
    providerSettings: {},
  });
  assert.equal(out.reply, '{"kind":"none"}');
  assert.equal(out.sessionId, null);

  const cwd = (await readFile(`${capture}.cwd`, 'utf8')).trim();
  assert.match(cwd, /^\/tmp\/cockpit-inbox-model-/u);
  assert.notEqual(cwd, process.cwd());
  await assert.rejects(access(cwd));

  const args = (await readFile(`${capture}.args`, 'utf8')).split('\n');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.doesNotMatch(args.join('\n'), new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.equal(JSON.parse(await readFile(`${capture}.stdin`, 'utf8')).type, 'user');
});

test('Claude untrusted ход сохраняет причину ошибки из result при exit code 1', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-claude-auth-'));
  const bin = path.join(dir, 'fake-claude');
  await writeFile(bin, [
    '#!/bin/sh',
    'IFS= read -r payload',
    "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"error_during_execution\","
      + "\"is_error\":true,\"result\":\"Failed to authenticate: OAuth session expired "
      + "and could not be refreshed\"}'",
    'exit 1',
  ].join('\n'));
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(claude.runUntrusted({
    config: { claudeBin: bin },
    message: 'недоверенный prompt',
    images: [],
    model: 'opus',
    providerSettings: {},
  }), (error) => {
    assert.equal(error.code, 'model_auth_failed');
    assert.match(error.message, /Авторизация Claude истекла/u);
    return true;
  });
});

test('Claude untrusted ход, убитый по сроку, называет срок, а не «без результата»', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-claude-slow-'));
  const bin = path.join(dir, 'fake-claude');
  // Медленная модель: читает prompt и молчит дольше срока; result-события не будет.
  await writeFile(bin, [
    '#!/bin/sh',
    'IFS= read -r payload',
    'sleep 5',
  ].join('\n'));
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(claude.runUntrusted({
    config: { claudeBin: bin },
    message: 'длинный сценарий',
    images: [],
    model: 'opus',
    providerSettings: {},
    timeoutMs: 300,
  }), (error) => {
    assert.equal(error.code, 'model_run_failed');
    assert.match(error.message, /не уложился/u);
    assert.doesNotMatch(error.message, /без результата/u);
    return true;
  });
});

test('Claude untrusted ход, убитый по сроку после повторов запроса, называет транспорт', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-claude-retry-'));
  const bin = path.join(dir, 'fake-claude');
  // Сеть рвётся: CLI успевает объявить два повтора запроса и молчит дольше срока.
  await writeFile(bin, [
    '#!/bin/sh',
    'IFS= read -r payload',
    "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-opus-5\"}'",
    "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"api_retry\",\"attempt\":2,"
      + "\"max_retries\":10,\"retry_delay_ms\":1212,\"error_status\":null,\"error\":\"unknown\"}'",
    "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"api_retry\",\"attempt\":3,"
      + "\"max_retries\":10,\"retry_delay_ms\":2298,\"error_status\":529,\"error\":\"overloaded_error\"}'",
    'sleep 5',
  ].join('\n'));
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(claude.runUntrusted({
    config: { claudeBin: bin },
    message: 'проверка сценария',
    images: [],
    model: 'opus',
    providerSettings: {},
    timeoutMs: 300,
  }), (error) => {
    assert.equal(error.code, 'model_unreachable');
    assert.match(error.message, /не уложился/u);
    assert.match(error.message, /повторил запрос 2 раз/u);
    assert.match(error.message, /HTTP 529 overloaded_error/u);
    return true;
  });
});

test('Claude untrusted ход отличает потерянное соединение с API от ответа модели', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-claude-lost-'));
  const bin = path.join(dir, 'fake-claude');
  await writeFile(bin, [
    '#!/bin/sh',
    'IFS= read -r payload',
    "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"error_during_execution\","
      + "\"is_error\":true,\"result\":\"API Error: Connection to the API was lost (fetch failed). "
      + "This is usually temporary.\"}'",
    'exit 1',
  ].join('\n'));
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(claude.runUntrusted({
    config: { claudeBin: bin },
    message: 'проверка сценария',
    images: [],
    model: 'opus',
    providerSettings: {},
  }), (error) => {
    assert.equal(error.code, 'model_unreachable');
    assert.match(error.message, /не дозвонился до API/u);
    assert.match(error.message, /Connection to the API was lost/u);
    return true;
  });
});
