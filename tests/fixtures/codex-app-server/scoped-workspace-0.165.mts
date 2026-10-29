import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const requireServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const { parse } = requireServer('smol-toml');

/**
 * Минимальный app-server нового протокола проверяет профиль на thread и каждом turn.
 * Конфигурация берётся из настоящих TOML argv адаптера, без обращения к модели.
 */
export function runScopedWorkspaceFixture(
  { missingPermissions = false }: { missingPermissions?: boolean } = {},
) {
  const argv = process.argv.slice(2);

  if (argv.includes('generate-ts')) {
    const output = argv[argv.indexOf('--out') + 1];

    if (!output) {
      throw new Error('Фикстура схемы требует --out.');
    }

    const directory = path.join(output, 'v2');

    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'SandboxPolicy.ts'),
      'export type SandboxPolicy = { type: "workspaceWrite" };\n');

    for (const name of ['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams']) {
      writeFileSync(path.join(directory, `${name}.ts`),
        `export type ${name} = { ${missingPermissions ? '' : 'permissions?: string | null'} };\n`);
    }

    writeFileSync(path.join(directory, 'ThreadStartResponse.ts'),
      'export type ThreadStartResponse = { activePermissionProfile: unknown };\n');

    return;
  }

  const config = {} as {
    default_permissions: string;
    permissions: Record<string, { filesystem: Record<string, string> }>;
    mcp_servers: Record<string, { enabled?: boolean }>;
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '-c') {
      Object.assign(config, parse(argv[++index]));
    }
  }

  config.mcp_servers = { 'fixture.host/with.dots': { enabled: true } };

  const failure = process.env.GRIGDESK_CODEX_PROFILE_FAILURE;
  const trace = process.env.GRIGDESK_CODEX_PROFILE_TRACE;
  const lines = createInterface({ input: process.stdin });
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

  if (trace) {
    appendFileSync(trace, `${JSON.stringify({ argv })}\n`);
  }

  lines.on('line', (line) => {
    const message = JSON.parse(line);

    if (trace) {
      appendFileSync(trace, `${JSON.stringify(message)}\n`);
    }
    if (message.id === undefined) {
      return;
    }

    const params = message.params;

    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
    } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      const profile = config.permissions?.[params.permissions];

      if (!profile || params.sandbox !== undefined) {
        send({ id: message.id, error: { message: 'Нужен permissions вместо sandbox.' } });

        return;
      }

      if (params.config?.mcp_servers?.['fixture.host/with.dots']?.enabled !== false) {
        send({ id: message.id, error: { message: 'Унаследованный MCP не выключен до thread.' } });

        return;
      }

      send({ id: message.id, result: {
        thread: { id: 'scoped-thread' },
        model: params.model,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: failure === 'network',
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        activePermissionProfile: failure === 'profile' ? null : { id: params.permissions, extends: null },
      } });
    } else if (message.method === 'config/read') {
      if (failure === 'grant') {
        const profile = config.permissions[config.default_permissions];

        if (!profile) {
          throw new Error('Фикстура не получила профиль триажа.');
        }

        profile.filesystem[':root'] = 'read';
      }

      send({ id: message.id, result: { config } });
    } else if (message.method === 'mcpServerStatus/list') {
      send({ id: message.id, result: {
        data: [{
          name: 'fixture.host/with.dots',
          runtimeStatus: failure === 'mcp' ? 'connected' : 'disabled',
          tools: {},
          resources: [],
          resourceTemplates: [],
        }],
        nextCursor: null,
      } });
    } else if (message.method === 'turn/start') {
      if (params.permissions !== config.default_permissions || params.sandboxPolicy !== undefined) {
        send({ id: message.id, error: { message: 'Ход потерял именованный профиль.' } });

        return;
      }

      send({ id: message.id, result: { turn: { id: 'scoped-turn' } } });
      send({ method: 'item/completed', params: {
        threadId: 'scoped-thread',
        turnId: 'scoped-turn',
        item: {
          id: 'answer',
          type: 'agentMessage',
          text: 'Оценка готова.',
          phase: 'final_answer',
        },
      } });
      send({ method: 'turn/completed', params: {
        threadId: 'scoped-thread',
        turn: {
          id: 'scoped-turn',
          status: 'completed',
          error: null,
        },
      } });
    } else {
      send({ id: message.id, error: { message: `Неожиданный метод: ${message.method}` } });
    }
  });
}
