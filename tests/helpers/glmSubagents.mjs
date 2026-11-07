import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { ensureGlmTestRuntime } from './glmTestRuntime.mts';
import { createGlmBinaryFixtureRoot } from './glmBinary.mts';
import { startGlmLoopback } from './glmLoopback.mts';
import { GLM_SERVICE_KEY, glmTextReply, glmToolCall, writeGlmEgressGuard } from './glmProductionFixture.mts';
/**
 * Фикстура использует production ELF, native gate и настоящие инструменты.
 * Подменяется только Z.ai на loopback с синтетическим ключом и запретом внешнего fetch.
 */
export async function glmSubagentFixture(t, mode, options = {}) {
  const runtime = await ensureGlmTestRuntime();
  const root = await createGlmBinaryFixtureRoot('subagents-');
  const cwd = path.join(root, 'project');
  const children = [];
  const permissions = [];
  const controller = new AbortController();
  const marker = path.join(cwd, 'child.txt');

  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), '# Инструкция\nGLM_CHILD_PROJECT_RULE\n');

  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    respond: (payload, index) => {
      if (options.respond) {
        return options.respond(payload, index, { marker, controller });
      }

      const child = payload.messages.some((message) => message.role === 'user'
        && JSON.stringify(message.content).includes('GLM_CHILD_TASK'));
      const result = payload.messages.some((message) => message.role === 'tool');

      if (child) {
        children.push(payload);

        if (mode === 'stop') {
          controller.abort();

          return new Promise(() => { });
        }
        if (result) {
          return glmTextReply('Ответ критика');
        }
        if (mode === 'child-question') {
          return glmToolCall('ask_user_question', {
            questions: [{ id: 'child-q', question: 'Нужен ответ?' }],
          }, 'same-child-call');
        }
        if (mode === 'escalation') {
          return glmToolCall('bash', {
            command: `touch '${marker}'`,
            sandbox_permissions: 'danger-full-access',
            justification: 'Проверка отказа ребёнку',
          }, 'same-child-call');
        }

        return glmToolCall('write', { file_path: marker, content: 'child-effect' }, 'same-child-call');
      }
      if (result) {
        return glmTextReply('Ответ корня');
      }
      if (mode === 'root-write') {
        return glmToolCall('write', { file_path: marker, content: 'child-effect' }, 'root-write-call');
      }
      if (mode === 'root-question') {
        return glmToolCall('ask_user_question', {
          questions: [{ id: 'root-q', question: 'Продолжить?' }],
        }, 'root-question-call');
      }

      const call = glmToolCall(mode === 'fork' ? 'subagent_fork' : 'subagent', {
        description: 'Одинаковая подпись',
        prompt: 'GLM_CHILD_TASK',
        ...(mode === 'background' ? { run_in_background: true } : {}),
        ...options.delegationArgs,
      }, 'root-delegation');

      if (mode === 'parallel') {
        const second = glmToolCall('subagent', {
          description: 'Одинаковая подпись', prompt: 'GLM_CHILD_TASK',
        }, 'root-delegation-second');

        call.deltas = call.deltas.map((delta, index) => ({
          ...delta,
          tool_calls: [...delta.tool_calls, ...second.deltas[index].tool_calls.map((item) => ({
            ...item, index: 1,
          }))],
        }));
      }

      return call;
    },
  });

  t.after(async () => {
    controller.abort();
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY
    },
    admission: [{ mode: 'api', compatibility: runtime.identity }],
    modelEndpoint: mock.endpoint,
    egressGuard: await writeGlmEgressGuard(root),
    catalog: [{ id: '["zai","glm-5.3"]', efforts: ['high'] }],
    spawn: (...args) => {
      options.beforeSpawn?.(path.dirname(args[1][args[1].indexOf('--patch') + 1]), { root, cwd });

      return spawn(...args);
    },
  });

  return {
    root,
    cwd,
    controller,
    marker,
    children,
    permissions,
    mock,
    run: (overrides = {}) => adapter.run({
      config: { ...runtime.config, glmRuntimeHome: path.join(root, 'home') },
      cwd,
      chatKey: 'subagents-fixture',
      message: 'Проверь план критиком',
      model: '["zai","glm-5.3"]',
      effort: 'high',
      providerSettings: {
        blockDirectSsh: true,
        blockDirectDb: true,
      },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
      onSessionCreated: async () => { },
      onPermission: async (presentation) => {
        permissions.push(presentation);

        return { allow: false, rawAnswers: [{ selected: [], text: 'Продолжить' }] };
      },
      ...overrides,
    }),
  };
}

