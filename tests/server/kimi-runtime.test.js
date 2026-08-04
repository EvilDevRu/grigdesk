import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  parseStatus,
  permissionPresentation,
  runContainedKimi,
  selectPermissionOutcome,
} from '../../server/src/lib/kimi/runtime.js';

class FakeAcpProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.pendingPrompt = null;
    let input = '';
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        input += String(chunk);
        let newline;
        while ((newline = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (line.trim()) this.receive(JSON.parse(line));
        }
        done();
      },
      final: (done) => {
        setImmediate(() => {
          this.stdout.end();
          this.stderr.end();
          this.exitCode = 0;
          this.emit('close', 0, null);
        });
        done();
      },
    });
    this.exitCode = null;
    this.killed = false;
  }

  send(message) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  receive(message) {
    this.messages.push(message);
    if (!message.method && message.id === 900) {
      this.permissionResponse = message.result;
      const id = this.pendingPrompt;
      this.pendingPrompt = null;
      this.send({ method: 'session/update', params: { sessionId: 'session-1', update: {
        sessionUpdate: 'tool_call', toolCallId: '1:tool', title: 'Read', kind: 'read', status: 'in_progress', rawInput: { path: 'README.md' },
      } } });
      this.send({ method: 'session/update', params: { sessionId: 'session-1', update: {
        sessionUpdate: 'tool_call_update', toolCallId: '1:tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      } } });
      this.send({ method: 'session/update', params: { sessionId: 'session-1', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Готово.' },
      } } });
      this.send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (message.method === 'initialize') {
      this.send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '0.31.1' } } });
      return;
    }
    if (message.method === 'session/new') {
      this.send({ id: message.id, result: { sessionId: 'session-1', configOptions: [] } });
      return;
    }
    if (message.method === 'session/resume' || message.method === 'session/set_config_option') {
      this.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'session/prompt') {
      const text = message.params?.prompt?.[0]?.text || '';
      if (text === '/status') {
        this.send({ method: 'session/update', params: { sessionId: 'session-1', update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Session status:\n- Model: kimi-code/k3\n- Context: 12,345 / 1,048,576 (1.2%)' },
        } } });
        this.send({ id: message.id, result: { stopReason: 'end_turn' } });
      } else {
        this.pendingPrompt = message.id;
        this.send({ id: 900, method: 'session/request_permission', params: {
          sessionId: 'session-1',
          options: [
            { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
          toolCall: {
            toolCallId: '1:tool', title: 'Read',
            content: [{ type: 'content', content: { type: 'text', text: 'Read README.md' } }],
          },
        } });
      }
    }
  }

  kill() {
    this.killed = true;
    if (this.exitCode === null) {
      this.exitCode = null;
      this.stdout.end();
      this.emit('close', null, 'SIGTERM');
    }
  }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-kimi-runtime-test-'));
  const cwd = path.join(root, 'workspace');
  const chatsDir = path.join(root, 'chats');
  await Promise.all([cwd, chatsDir].map((dir) => fs.mkdir(dir, { recursive: true })));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    cwd,
    config: {
      kimiRuntimeHome: path.join(root, 'private-state'),
      kimiBin: path.join(root, 'kimi'),
      kimiHome: path.join(root, 'host-kimi'),
      chatsDir,
      chatBindingsDir: path.join(chatsDir, '.bindings'),
      kimiSystemctlBin: '/usr/bin/systemctl',
    },
  };
}

test('contained runtime соблюдает lifecycle, permission и session durability без реального model call', async (t) => {
  const f = await fixture(t);
  const process = new FakeAcpProcess();
  const order = [];
  let launchConfig;
  let launchOptions;
  const out = await runContainedKimi({
    config: f.config,
    chatKey: 'chat-private-a',
    cwd: f.cwd,
    message: 'offline fake prompt',
    model: 'kimi-code/k3',
    effort: 'high',
    permissionMode: 'default',
    onSessionCreated: async (id) => { order.push(`bound:${id}`); },
    onPermission: async (presentation) => {
      order.push(`permission:${presentation.tool}`);
      return { allow: true };
    },
    deps: {
      assertVersion: async () => '0.31.1',
      createProxy: () => ({ async start() {}, async close() {} }),
      preflight: async () => ({ decision: 'GO_CONTAINED_MVP', checks: {} }),
      buildLaunch: async (options) => {
        launchOptions = options;
        launchConfig = options.config;
        return { command: 'fake', args: [], cwdReal: f.cwd, unit: 'cockpit-kimi-fake.service' };
      },
      spawn: () => process,
      stopUnit: async () => {},
    },
  });
  assert.equal(out.reply, 'Готово.');
  assert.equal(out.sessionId, 'session-1');
  assert.equal(out.contextTokens, 12_345);
  assert.equal(out.contextWindow, 1_048_576);
  assert.equal(out.contextIsEstimate, false);
  assert.equal(out.retryState, 'post_prompt');
  assert.deepEqual(order, ['bound:session-1', 'permission:Read']);
  assert.deepEqual(process.permissionResponse, { outcome: { outcome: 'selected', optionId: 'approve_once' } });
  const methods = process.messages.filter((message) => message.method).map((message) => message.method);
  assert.ok(methods.indexOf('session/new') < methods.indexOf('session/prompt'));
  assert.equal(methods.filter((method) => method === 'session/prompt').length, 2); // prompt + локальный /status
  assert.match(launchConfig.kimiRuntimeHome, /private-state\/chats\/[a-f0-9]{64}$/);
  assert.equal(launchConfig.kimiRuntimeBroker, path.join(f.root, 'private-state', 'broker'));
  assert.equal(launchConfig.kimiRuntimeHome.includes('chat-private-a'), false);
  assert.ok(Buffer.byteLength(launchOptions.egressSocketPath) <= 107);
  assert.match(launchOptions.egressSocketPath, /\/broker\/r\/[a-f0-9]{20}\/e\.sock$/);
});

test('permission mapper выбирает только allow_once/reject и ACP question option', () => {
  const approval = {
    options: [
      { optionId: 'once', name: 'Approve once', kind: 'allow_once' },
      { optionId: 'always', name: 'Approve always', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
    toolCall: { title: 'Bash', content: [{ type: 'content', content: { type: 'text', text: 'run' } }] },
  };
  assert.deepEqual(selectPermissionOutcome(approval, { allow: true }), { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.deepEqual(selectPermissionOutcome(approval, { allow: false }), { outcome: { outcome: 'selected', optionId: 'no' } });

  const question = {
    options: [
      { optionId: 'q0_opt_0', name: 'A', kind: 'allow_once' },
      { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
    ],
    toolCall: { title: 'AskUserQuestion', content: [{ type: 'content', content: { type: 'text', text: 'Choose' } }] },
  };
  assert.equal(permissionPresentation(question).isQuestion, true);
  assert.deepEqual(selectPermissionOutcome(question, { selected: ['A'] }), { outcome: { outcome: 'selected', optionId: 'q0_opt_0' } });
  assert.deepEqual(selectPermissionOutcome(question, { selected: [] }), { outcome: { outcome: 'selected', optionId: 'q0_skip' } });
});

test('status parser не подменяет точное измерение оценкой', () => {
  assert.deepEqual(parseStatus('Session status:\n- Model: k3\n- Context: 1,234 / 262,144 (0.5%)', 10), {
    contextTokens: 1234,
    contextWindow: 262144,
    contextMetric: 'kimi-session-status',
    contextIsEstimate: false,
    actualModel: 'k3',
  });
  assert.equal(parseStatus('broken', 262144).contextIsEstimate, true);
});

test('host runtime: прямой spawn без proxy/preflight/systemd, ACP-ход и permissions без изменений', async (t) => {
  const f = await fixture(t);
  const process = new FakeAcpProcess();
  const calls = { preflight: 0, proxy: 0, buildLaunch: 0, buildHost: 0, stopUnit: 0 };
  const out = await runContainedKimi({
    config: { ...f.config, kimiLaunchMode: 'host' },
    // chatKey в host-режиме не нужен для состояния; передаём для parity с contained.
    chatKey: 'chat-host-a',
    cwd: f.cwd,
    env: { PATH: '/usr/bin', CUSTOM_FLAG: '1' },
    message: 'offline fake prompt',
    model: 'kimi-code/k3',
    effort: 'high',
    permissionMode: 'default',
    onPermission: async () => ({ allow: true }),
    deps: {
      // Host-режим: расхождение pinned версии — предупреждение, а не падение хода.
      assertVersion: async () => { throw new Error('version mismatch'); },
      createProxy: () => { calls.proxy += 1; throw new Error('host: proxy не должен создаваться'); },
      preflight: async () => { calls.preflight += 1; throw new Error('host: preflight не должен вызываться'); },
      buildLaunch: async () => { calls.buildLaunch += 1; throw new Error('host: contained builder не должен вызываться'); },
      buildHostLaunch: async (options) => {
        calls.buildHost += 1;
        assert.equal(options.cwd, f.cwd);
        assert.equal(options.env.CUSTOM_FLAG, '1');
        return {
          command: 'fake-host',
          args: ['acp'],
          env: { ...options.env, KIMI_CODE_HOME: f.config.kimiHome },
          cwdReal: f.cwd,
          unit: null,
        };
      },
      spawn: (command, args, options) => {
        assert.equal(command, 'fake-host');
        assert.deepEqual(args, ['acp']);
        assert.equal(options.cwd, f.cwd);
        assert.equal(options.env.KIMI_CODE_HOME, f.config.kimiHome);
        assert.equal(options.env.HTTPS_PROXY, undefined);
        return process;
      },
      stopUnit: async () => { calls.stopUnit += 1; },
    },
  });
  assert.equal(out.reply, 'Готово.');
  assert.equal(out.sessionId, 'session-1');
  assert.equal(out.contextTokens, 12_345);
  assert.deepEqual(calls, { preflight: 0, proxy: 0, buildLaunch: 0, buildHost: 1, stopUnit: 0 });
});

test('host runtime: вложения идут по исходным путям, чужой корень отклоняется', async (t) => {
  const f = await fixture(t);
  const attachments = [path.join(f.config.chatsDir, 'attachments', 'note.txt')];
  const process = new FakeAcpProcess();
  const out = await runContainedKimi({
    config: { ...f.config, kimiLaunchMode: 'host' },
    chatKey: 'chat-host-b',
    cwd: f.cwd,
    env: {},
    message: `прочти ${attachments[0]}`,
    attachmentPaths: attachments,
    model: 'kimi-code/k3',
    permissionMode: 'default',
    onPermission: async () => ({ allow: true }),
    deps: {
      assertVersion: async () => '0.31.1',
      buildHostLaunch: async () => ({ command: 'fake-host', args: ['acp'], env: {}, cwdReal: f.cwd, unit: null }),
      spawn: () => process,
      stopUnit: async () => {},
    },
  });
  assert.equal(out.reply, 'Готово.');
  // Staging не выполнялся: текст сообщения с исходным путём дошёл до агента как есть.
  const prompt = process.messages.find((message) => message.method === 'session/prompt');
  assert.ok(prompt.params.prompt[0].text.includes(attachments[0]));

  await assert.rejects(
    runContainedKimi({
      config: { ...f.config, kimiLaunchMode: 'host' },
      chatKey: 'chat-host-c',
      cwd: f.cwd,
      env: {},
      message: 'x',
      attachmentPaths: ['/etc/passwd'],
      model: 'kimi-code/k3',
      deps: {
        assertVersion: async () => '0.31.1',
        buildHostLaunch: async () => { throw new Error('до launch недоходим'); },
        spawn: () => { throw new Error('до spawn недоходим'); },
      },
    }),
    /kimi_attachment_outside_root/,
  );
});
