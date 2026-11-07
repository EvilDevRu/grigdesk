import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  composeDeepSeekMcpServers,
  readDeepSeekMcpStatus,
} from '../../server/src/lib/deepseek/mcpStatus.ts';
import { readProjectMcpServers } from '../../server/src/lib/deepseek/projectMcp.ts';

const CLOSED_VALUES = [
  '/fixture/command-canary',
  'args-canary',
  'env-canary',
  'extra-canary',
];

const ROOT = '/fixture/grigdesk-root';
const NOTE = 'Показана конфигурация MCP для папки GrigDesk. '
  + 'В другой папке чата список может отличаться. '
  + 'Соединение не проверялось. Показаны только stdio-серверы, выбранные для запуска.';
const PARTIAL_NOTE = 'Конфигурация MCP для папки GrigDesk прочитана или проверена не полностью. '
  + 'Список может быть неполным; проверьте `.mcp.json` и команды запуска.';
const EMPTY_TEXT = 'Для папки GrigDesk нет MCP-серверов, выбранных для запуска.';
const LIST_ERROR = 'Не удалось получить список MCP для папки GrigDesk. '
  + 'Проверьте `.mcp.json` и команды запуска.';
const READ_ERROR = 'Не удалось прочитать конфигурацию MCP для папки GrigDesk.';
const ROOT_ERROR = 'Для списка MCP не задана абсолютная папка GrigDesk.';
const RAW_ERROR = '/fixture/private-path warning-canary {"secret":"json-canary"}';

/**
 * Синтетические секреты находятся только в закрытых полях источника.
 * Публичное имя остаётся обычным ключом конфигурации.
 */
function parsedServer(name) {
  return {
    name,
    command: CLOSED_VALUES[0],
    args: [CLOSED_VALUES[1]],
    env: [{ name: 'TOKEN', value: CLOSED_VALUES[2] }],
    extra: CLOSED_VALUES[3],
  };
}

test('проекция DeepSeek: пустой источник даёт пустой список', () => {
  assert.deepEqual(composeDeepSeekMcpServers([]), []);
});

test('проекция DeepSeek: сортировка и пять публичных полей без изменения источника', () => {
  const input = [parsedServer('Янтарь'), parsedServer('Альфа')];
  const before = structuredClone(input);

  input.forEach(Object.freeze);
  Object.freeze(input);

  const result = composeDeepSeekMcpServers(input);

  assert.deepEqual(result, ['Альфа', 'Янтарь'].map((name) => ({
    name,
    target: '',
    scope: 'project',
    state: 'configured',
    detail: '',
  })));
  assert.deepEqual(input, before);

  for (const card of result) {
    assert.deepEqual(Object.keys(card).sort(), ['detail', 'name', 'scope', 'state', 'target']);
  }
});

test('проекция DeepSeek: команды, args, env и лишние поля не попадают в JSON', () => {
  const result = composeDeepSeekMcpServers([parsedServer('Документы')]);
  const json = JSON.stringify(result);

  for (const canary of CLOSED_VALUES) {
    assert.equal(json.includes(canary), false);
  }

  assert.equal(result[0].target, '');
});

test('список DeepSeek: ровно одно чтение заданной абсолютной папки', async () => {
  const calls = [];
  const servers = [parsedServer('Документы')];
  const result = await readDeepSeekMcpStatus({ rootDir: ROOT }, {
    readProject: async (cwd) => {
      calls.push(cwd);

      return {
        file: RAW_ERROR,
        servers,
        warnings: [],
      };
    },
  });

  assert.deepEqual(calls, [ROOT]);
  assert.deepEqual(result, {
    state: 'ok',
    note: NOTE,
    emptyText: EMPTY_TEXT,
    servers: composeDeepSeekMcpServers(servers),
  });
  assert.equal(JSON.stringify(result).includes(RAW_ERROR), false);
});

test('список DeepSeek: отсутствие файлов или выбранных записей — успешный пустой список', async () => {
  for (const file of [null, RAW_ERROR]) {
    const result = await readDeepSeekMcpStatus({ rootDir: ROOT }, {
      readProject: async () => ({
        file,
        servers: [],
        warnings: [],
      }),
    });

    assert.deepEqual(result, {
      state: 'ok',
      note: NOTE,
      emptyText: EMPTY_TEXT,
      servers: [],
    });
  }
});

test('список DeepSeek: warnings сохраняют хорошие карточки с нейтральным пояснением', async () => {
  const servers = [parsedServer('Документы')];
  const result = await readDeepSeekMcpStatus({ rootDir: ROOT }, {
    readProject: async () => ({
      file: RAW_ERROR,
      servers,
      warnings: [RAW_ERROR],
    }),
  });

  assert.deepEqual(result, {
    state: 'ok',
    note: `${NOTE} ${PARTIAL_NOTE}`,
    emptyText: EMPTY_TEXT,
    servers: composeDeepSeekMcpServers(servers),
  });
  assert.equal(JSON.stringify(result).includes('canary'), false);
  assert.equal(JSON.stringify(result).includes('/fixture'), false);
});

test('список DeepSeek: warnings без серверов дают безопасную ошибку вместо пустого успеха', async () => {
  const result = await readDeepSeekMcpStatus({ rootDir: ROOT }, {
    readProject: async () => ({
      file: RAW_ERROR,
      servers: [],
      warnings: [RAW_ERROR],
    }),
  });

  assert.deepEqual(result, {
    state: 'error',
    error: LIST_ERROR,
    servers: [],
  });
});

test('список DeepSeek: исключение reader не раскрывает исходное сообщение', async () => {
  const result = await readDeepSeekMcpStatus({ rootDir: ROOT }, {
    readProject: async () => {
      throw new Error(RAW_ERROR);
    },
  });

  assert.deepEqual(result, {
    state: 'error',
    error: READ_ERROR,
    servers: [],
  });
});

test('список DeepSeek: ошибка проекции перехватывается той же безопасной границей', async () => {
  const server = {
    get name() {
      throw new Error(RAW_ERROR);
    },
  };
  const result = await readDeepSeekMcpStatus({ rootDir: ROOT }, {
    readProject: async () => ({
      file: null,
      servers: [server],
      warnings: [],
    }),
  });

  assert.deepEqual(result, {
    state: 'error',
    error: READ_ERROR,
    servers: [],
  });
});

test('список DeepSeek: незаданная или относительная папка отвергается до reader', async () => {
  for (const config of [{}, { rootDir: '' }, { rootDir: 'project' }, { rootDir: '   ' }]) {
    let reads = 0;
    const result = await readDeepSeekMcpStatus(config, {
      readProject: async () => {
        reads += 1;

        return {
          file: null,
          servers: [],
          warnings: [],
        };
      },
    });

    assert.deepEqual(result, {
      state: 'error',
      error: ROOT_ERROR,
      servers: [],
    });
    assert.equal(reads, 0);
  }
});

/**
 * Собственный executable при запуске оставил бы marker.
 * Каждый тест проверяет отсутствие запуска перед удалением временного проекта.
 */
async function projectFixture(t, { git = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-mcp-status-'));
  const marker = path.join(root, 'process-started');

  t.after(async () => {
    try {
      const entries = await fs.readdir(root);

      assert.equal(entries.includes('process-started'), false, 'список не запускает MCP');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  if (git) {
    await fs.mkdir(path.join(root, '.git'));
  }

  const bin = path.join(root, 'bin');
  const command = path.join(bin, 'fixture-mcp');

  await fs.mkdir(bin);
  await fs.writeFile(command, `#!/bin/sh\nprintf started > '${marker}'\nexit 0\n`, { mode: 0o755 });

  const entry = {
    command,
    args: [CLOSED_VALUES[1]],
    env: { TOKEN: CLOSED_VALUES[2] },
  };

  return {
    root,
    bin,
    command,
    entry,
  };
}

async function writeProject(cwd, servers) {
  await fs.writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

/**
 * Снимок собственных файлов обнаруживает записи и создание runtime/session.
 * Содержимое сравнивается побайтно, включая executable и конфигурацию.
 */
async function projectSnapshot(root) {
  const entries = (await fs.readdir(root, { recursive: true })).sort();
  const contents = [];

  for (const entry of entries) {
    const file = path.join(root, entry);

    if ((await fs.stat(file)).isFile()) {
      contents.push([entry, (await fs.readFile(file)).toString('base64')]);
    }
  }

  return { entries, contents };
}

/**
 * Все интеграционные чтения проходят проверку отсутствия файловых эффектов.
 * Читается только собственный временный проект с заданным абсолютным cwd.
 */
async function unchangedStatus(fixture, cwd = fixture.root, deps = {}) {
  const before = await projectSnapshot(fixture.root);
  const result = await readDeepSeekMcpStatus({ rootDir: cwd }, deps);

  assert.deepEqual(await projectSnapshot(fixture.root), before);

  return result;
}

test('файлы DeepSeek: stdio у корня Git, без запуска и раскрытия закрытых полей', async (t) => {
  const fixture = await projectFixture(t, { git: true });

  await writeProject(fixture.root, { Документы: fixture.entry });

  const result = await unchangedStatus(fixture);

  assert.equal(result.state, 'ok');
  assert.deepEqual(result.servers.map((server) => server.name), ['Документы']);
  assert.equal(result.servers[0].state, 'configured');

  for (const value of [fixture.root, ...CLOSED_VALUES]) {
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test('файлы DeepSeek: слои и выключенный дубликат совпадают с существующим reader', async (t) => {
  const fixture = await projectFixture(t, { git: true });
  const nested = path.join(fixture.root, 'workspace');

  await fs.mkdir(nested);
  await writeProject(fixture.root, { общий: fixture.entry, корневой: fixture.entry });
  await writeProject(nested, {
    общий: { ...fixture.entry, disabled: true },
    локальный: fixture.entry,
    выключенный: { ...fixture.entry, enabled: false },
  });

  const read = await readProjectMcpServers(nested);
  const result = await unchangedStatus(fixture, nested);

  assert.deepEqual(result.servers, composeDeepSeekMcpServers(read.servers));
  assert.deepEqual(result.servers.map((server) => server.name), ['корневой', 'локальный', 'общий']);

  await writeProject(fixture.root, { корневой: fixture.entry });

  const withoutRoot = await unchangedStatus(fixture, nested);

  assert.deepEqual(withoutRoot.servers.map((server) => server.name), ['корневой', 'локальный']);
});

test('файлы DeepSeek: папка без Git и PATH собственного fixture', async (t) => {
  const fixture = await projectFixture(t);

  await writeProject(fixture.root, { Документы: { ...fixture.entry, command: 'fixture-mcp' } });

  const result = await unchangedStatus(fixture, fixture.root, {
    readProject: (cwd) => readProjectMcpServers(cwd, { searchPath: fixture.bin }),
  });

  assert.equal(result.state, 'ok');
  assert.deepEqual(result.servers.map((server) => server.name), ['Документы']);
});

test('файлы DeepSeek: нет файла, пустой состав и только выключенные записи — пустой успех', async (t) => {
  const fixture = await projectFixture(t);
  const expected = {
    state: 'ok',
    note: NOTE,
    emptyText: EMPTY_TEXT,
    servers: [],
  };

  assert.deepEqual(await unchangedStatus(fixture), expected);

  await writeProject(fixture.root, {});
  assert.deepEqual(await unchangedStatus(fixture), expected);

  await writeProject(fixture.root, { выключенный: { ...fixture.entry, disabled: true } });
  assert.deepEqual(await unchangedStatus(fixture), expected);
});

test('файлы DeepSeek: хорошие записи сохраняются рядом с неподдерживаемыми и повреждёнными', async (t) => {
  const fixture = await projectFixture(t);

  await writeProject(fixture.root, {
    Документы: fixture.entry,
    http: { type: 'http', url: `https://fixture.invalid/${CLOSED_VALUES[2]}` },
    missing: { command: path.join(fixture.root, 'missing-canary') },
    badArgs: { ...fixture.entry, args: [12] },
    badEnv: { ...fixture.entry, env: { 'secret-canary=bad': 'token-canary' } },
    'grigdesk-work': fixture.entry,
    'grigdesk-perm': fixture.entry,
  });

  const result = await unchangedStatus(fixture);

  assert.equal(result.state, 'ok');
  assert.deepEqual(result.servers.map((server) => server.name), ['Документы']);
  assert.equal(result.note, `${NOTE} ${PARTIAL_NOTE}`);
  assert.equal(JSON.stringify(result).includes('canary'), false);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
  assert.equal(JSON.stringify(result).includes('grigdesk-'), false);
});

test('файлы DeepSeek: повреждённый JSON и только HTTP дают безопасную ошибку', async (t) => {
  const fixture = await projectFixture(t);
  const expected = {
    state: 'error',
    error: LIST_ERROR,
    servers: [],
  };

  await fs.writeFile(path.join(fixture.root, '.mcp.json'), `{"secret":"json-canary" ${RAW_ERROR}`);
  assert.deepEqual(await unchangedStatus(fixture), expected);

  await writeProject(fixture.root, { http: { url: 'https://fixture.invalid/secret-canary' } });
  assert.deepEqual(await unchangedStatus(fixture), expected);

  await writeProject(fixture.root, { 'grigdesk-work': fixture.entry, 'grigdesk-perm': fixture.entry });
  assert.deepEqual(await unchangedStatus(fixture), expected);
});

test('файлы DeepSeek: I/O-ошибка без серверов и частичное чтение двух слоёв', async (t) => {
  const fixture = await projectFixture(t, { git: true });
  const nested = path.join(fixture.root, 'workspace');

  await fs.mkdir(path.join(fixture.root, '.mcp.json'));

  assert.deepEqual(await unchangedStatus(fixture), {
    state: 'error',
    error: LIST_ERROR,
    servers: [],
  });

  await fs.mkdir(nested);
  await writeProject(nested, { Документы: fixture.entry });

  const result = await unchangedStatus(fixture, nested);

  assert.equal(result.state, 'ok');
  assert.equal(result.note, `${NOTE} ${PARTIAL_NOTE}`);
  assert.deepEqual(result.servers.map((server) => server.name), ['Документы']);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
});
