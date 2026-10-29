import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Протокольная fixture хранит точную схему допущенного codec отдельно от исполнения tools.
 * Она проверяет подготовку и lifecycle; файловые эффекты проверяет installed loopback suite.
 */
export function runPermissionModesFixture(options) {
  const trace = options.trace;

  if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.164.0\n');

    return;
  }
  if (process.argv.includes('generate-ts')) {
    const directory = process.argv[process.argv.indexOf('--out') + 1];
    const source = fileURLToPath(new URL('./mode-schema-0.164.0/v2', import.meta.url));

    mkdirSync(path.join(directory, 'v2'), { recursive: true });

    for (const file of readdirSync(source)) {
      copyFileSync(path.join(source, file), path.join(directory, 'v2', file.replace(/\.txt$/u, '')));
    }

    return;
  }

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const settings = () => options.settings ? JSON.parse(readFileSync(options.settings, 'utf8')) : {};

  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);

    appendFileSync(trace, `${line}\n`);

    const effective = settings();

    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
    } else if (message.method === 'configRequirements/read') {
      send({ id: message.id, result: effective.requirementsReply || { requirements: null } });
    } else if (message.method === 'config/read') {
      send({ id: message.id, result: { config: { model_provider: 'fixture', ...effective.config } } });
    } else if (message.method === 'thread/backgroundTerminals/clean') {
      send({ id: message.id, result: {} });
    } else if (message.method === 'thread/backgroundTerminals/list') {
      send({ id: message.id, result: { data: [], nextCursor: null } });
    } else if (['thread/start', 'thread/resume'].includes(message.method)) {
      const params = message.params;
      const config = params.config || {};

      send({ id: message.id, result: {
        thread: { id: 'fixture-thread' },
        model: params.model,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandbox: params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
          : {
            type: 'workspaceWrite',
            writableRoots: config['sandbox_workspace_write.writable_roots'] || params.runtimeWorkspaceRoots,
            networkAccess: config['sandbox_workspace_write.network_access'] ?? true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
          },
        ...effective.opened,
      } });
    } else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'fixture-turn' } } });
      send({ method: 'item/completed', params: {
        threadId: 'fixture-thread',
        turnId: 'fixture-turn',
        item: {
          id: 'answer',
          type: 'agentMessage',
          text: 'Готово'
        }
      } });
      send({ method: 'turn/completed', params: { threadId: 'fixture-thread',
        turn: { id: 'fixture-turn', status: 'completed' } } });
    }
  });
}
