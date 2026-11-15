import {
  appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Версия и схема происходят из настоящего CLI, ответы RPC — управляемый двойник.
 * Журнал отделяет probes от рабочих запусков и сохраняет реальные параметры каждого хода.
 */
export function runPermissionModesFixture({ trace, settings }) {
  const effective = () => JSON.parse(readFileSync(settings, 'utf8'));

  if (process.argv.includes('--version')) {
    process.stdout.write(`codex-cli ${effective().version || '0.167.1'}\n`);

    return;
  }

  if (process.argv.includes('generate-ts')) {
    const directory = process.argv[process.argv.indexOf('--out') + 1];
    const source = fileURLToPath(new URL('./mode-schema-0.167.1/v2', import.meta.url));

    mkdirSync(path.join(directory, 'v2'), { recursive: true });

    for (const file of readdirSync(source)) {
      copyFileSync(path.join(source, file), path.join(directory, 'v2', file.replace(/\.txt$/u, '')));
    }

    if (effective().schemaMismatch) {
      appendFileSync(path.join(directory, 'v2', 'SandboxPolicy.ts'), '\n// Изменённая схема.\n');
    }

    return;
  }

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const threadId = 'fixture-thread';
  const rolloutFile = path.join(path.dirname(settings), 'rollout.json');
  let ephemeral = false;
  let turn = 0;
  let timer;

  appendFileSync(trace, `${JSON.stringify({
    argv: process.argv.slice(2),
    pid: process.pid,
  })}\n`);

  /**
   * Завершение удержанного хода задаётся файлом управления, без настоящего ожидания модели.
   * Interrupt завершает только ход; stdin и процесс остаются доступны для следующего send.
   */
  function complete(status = 'completed') {
    clearInterval(timer);

    if (status === 'completed') {
      if (!ephemeral) {
        const rollout = JSON.parse(readFileSync(rolloutFile, 'utf8'));

        rollout.messages.push({
          role: 'assistant',
          text: 'Готово',
        });
        writeFileSync(rolloutFile, JSON.stringify(rollout));
      }

      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId: `turn-${turn}`,
          item: {
            id: `answer-${turn}`,
            type: 'agentMessage',
            text: 'Готово',
            phase: 'final_answer',
          },
        },
      });
    }

    send({
      method: 'turn/completed',
      params: {
        threadId,
        turn: {
          id: `turn-${turn}`,
          status,
        },
      },
    });
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    const state = effective();

    appendFileSync(trace, `${line}\n`);

    if (message.id === undefined) {
      return;
    }

    if (message.method === 'initialize') {
      if (state.initializeError) {
        send({
          id: message.id,
          error: { message: 'Синтетический отказ initialize' },
        });
      } else {
        send({
          id: message.id,
          result: {},
        });
      }
    } else if (message.method === 'configRequirements/read') {
      send({
        id: message.id,
        result: state.requirementsReply ?? { requirements: null },
      });
    } else if (message.method === 'config/read') {
      send({
        id: message.id,
        result: {
          config: {
            model_provider: 'fixture',
            ...state.config,
          }
        },
      });
    } else if (message.method === 'thread/backgroundTerminals/clean') {
      send({
        id: message.id,
        result: {},
      });
    } else if (message.method === 'thread/backgroundTerminals/list') {
      send({
        id: message.id,
        result: {
          data: [],
          nextCursor: null,
        },
      });
    } else if (['thread/start', 'thread/resume'].includes(message.method)) {
      const params = message.params;
      const config = params.config || {};

      if (params.ephemeral && params.sandbox === 'read-only') {
        ephemeral = true;
        send({
          id: message.id,
          result: {
            thread: {
              id: threadId,
              ephemeral: true,
              environments: [],
            },
            model: params.model,
            instructionSources: [],
            runtimeWorkspaceRoots: [],
            approvalPolicy: 'never',
            sandbox: {
              type: 'readOnly',
              networkAccess: false,
            },
          },
        });

        return;
      }

      if (message.method === 'thread/start') {
        writeFileSync(rolloutFile, JSON.stringify({
          id: threadId,
          messages: [],
        }));
      } else {
        const rollout = JSON.parse(readFileSync(rolloutFile, 'utf8'));

        if (params.threadId !== rollout.id) {
          send({
            id: message.id,
            error: { message: 'Не найден rollout этого thread' },
          });

          return;
        }

        appendFileSync(trace, `${JSON.stringify({
          resumedMessages: rollout.messages,
          pid: process.pid,
        })}\n`);
      }

      send({
        id: message.id,
        result: {
          thread: { id: threadId },
          model: params.model,
          approvalPolicy: params.approvalPolicy,
          approvalsReviewer: params.approvalsReviewer,
          sandbox: params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : {
            type: 'workspaceWrite',
            writableRoots: config['sandbox_workspace_write.writable_roots'] || params.runtimeWorkspaceRoots,
            networkAccess: config['sandbox_workspace_write.network_access'] ?? true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          ...state.opened,
        },
      });
    } else if (message.method === 'turn/start') {
      turn += 1;

      if (!ephemeral) {
        const rollout = JSON.parse(readFileSync(rolloutFile, 'utf8'));

        rollout.messages.push({
          role: 'user',
          input: message.params.input,
        });
        writeFileSync(rolloutFile, JSON.stringify(rollout));
      }

      send({
        id: message.id,
        result: { turn: { id: `turn-${turn}` } },
      });

      if (state.hold) {
        timer = setInterval(() => {
          if (!effective().hold) {
            complete();
          }
        }, 10);
      } else {
        complete();
      }
    } else if (message.method === 'turn/interrupt') {
      send({
        id: message.id,
        result: {},
      });
      complete('interrupted');
    } else {
      send({
        id: message.id,
        error: { message: `Неожиданный RPC: ${message.method}` },
      });
    }
  });
}
