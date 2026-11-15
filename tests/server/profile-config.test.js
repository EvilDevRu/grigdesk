import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { shellQuote } from '../../shared/lib/shellQuote.ts';
import profileConfigModule from '../../server/src/modules/profileConfig/index.ts';
import {
  ProfileConfigError,
  applyProfileVariableChanges,
  applyRunnerOperations,
  readProfileVariables,
} from '../../server/src/lib/profileConfig.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ENGINE_HOME = fileURLToPath(new URL('../../engine/', import.meta.url));

process.env.NODE_ENV = 'test';

/**
 * Каждый тест владеет своим профилем и всеми путями движка.
 * Очистка действует и при падении подготовки или проверки.
 */
async function fixture(t, text = '# metadata\nPROFILE_CTX="Стек: Node"\nPROFILE_LOOP_MAX_ROUNDS=20\n') {
  const parent = process.env.GRIGDESK_ARTIFACTS_DIR
    || path.join(os.homedir(), '.grigdesk', 'artifacts');

  await fs.mkdir(parent, { recursive: true });

  const root = await fs.mkdtemp(path.join(parent, 'profile-config-'));

  const closeBeforeCleanup = [];

  t.after(async () => {
    try {
      for (const close of closeBeforeCleanup.reverse()) {
        await close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const profilesDir = path.join(root, 'profiles');
  const directory = path.join(profilesDir, 'demo');
  const file = path.join(directory, 'profile.sh');

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(file, text, { mode: 0o755 });
  await fs.writeFile(path.join(directory, 'graph.json'), '{"capabilities":["route-v2"]}');

  const config = {
    profilesDir,
    factoryBin: path.join(ENGINE_HOME, 'bin', 'factory'),
    factoryHome: ENGINE_HOME,
    stateDir: path.join(root, 'state'),
    factoryControlDir: path.join(root, 'control'),
    factoryConfigRoot: path.join(root, 'config'),
    dataHome: root,
  };

  return {
    root,
    directory,
    file,
    config,
    closeBeforeCleanup
  };
}

/**
 * Монтирует реальный HTTP-модуль на изолированный профиль.
 * Приложение закрывается раньше удаления его файлов.
 */
async function httpFixture(t, fixtureOptions = {}) {
  const fx = await fixture(t, fixtureOptions.text);
  const app = Fastify({ logger: false });

  fx.closeBeforeCleanup.push(() => app.close());
  await app.register(profileConfigModule, { config: fx.config });
  await app.ready();

  return { ...fx, app };
}

test('RE-B1-01: prefix metadata читается, отсутствующий ключ доступен для создания', async (t) => {
  const fx = await fixture(t);
  const values = await readProfileVariables(fx.config.profilesDir, 'demo', 'profile.sh');
  const byName = Object.fromEntries(values.map((item) => [item.name, item]));

  assert.deepEqual(byName.PROFILE_CTX, {
    name: 'PROFILE_CTX',
    value: 'Стек: Node',
    literal: true,
    editable: true,
    present: true,
    reason: null,
  });
  assert.deepEqual(byName.PROFILE_TRIAGE_MARKERS, {
    name: 'PROFILE_TRIAGE_MARKERS',
    value: null,
    literal: false,
    editable: true,
    present: false,
    reason: 'not_declared',
  });
});

test('RE-B1-02: сложные присваивания readonly и не раскрывают текст', async (t) => {
  const cases = [
    'PROFILE_CTX="Первая строка\nВторая строка"\n',
    'PROFILE_CTX=first\nPROFILE_CTX=second\n',
    'show() {\n  PROFILE_CTX=nested\n}\n',
    'cat <<\'END\'\nPROFILE_CTX=heredoc\nEND\n',
    'PROFILE_CTX="unterminated\n',
    'PROFILE_CTX=first\neval "$SOME_CODE"\n',
  ];

  for (const text of cases) {
    const fx = await fixture(t, text);
    const values = await readProfileVariables(fx.config.profilesDir, 'demo', 'profile.sh');
    const value = values.find((item) => item.name === 'PROFILE_CTX');

    assert.ok(value, text);
    assert.equal(value.editable, false, text);
    assert.equal(value.literal, false, text);
    assert.equal(value.value, null, text);
    assert.equal(await fs.readFile(fx.file, 'utf8'), text);
  }
});

test('RE-B1-03: GET возвращает DTO, валидирует профиль и отсутствие файла', async (t) => {
  const { app } = await httpFixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/profiles/demo/config' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().variables.profileSh.find((v) => v.name === 'PROFILE_CTX')?.value,
    'Стек: Node');
  assert.deepEqual(response.json().capabilities, ['route-v2']);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json().variables.dashboard.every((v) => !v.editable), true);
  assert.equal((await app.inject('/api/profiles/ghost/config')).statusCode, 404);
  assert.equal((await app.inject('/api/profiles/..%2Fx/config')).statusCode, 400);
});

test('RE-B1-04: чтение не исполняет подстановку и не выдаёт чужие literal-секреты', async (t) => {
  const fx = await fixture(t);
  const marker = path.join(fx.root, 'executed');
  const source = `API_TOKEN="private-fixture-token"\nPROFILE_CTX="$(touch ${shellQuote(marker)})"\n`;

  await fs.writeFile(fx.file, source);

  const values = await readProfileVariables(fx.config.profilesDir, 'demo', 'profile.sh');

  assert.equal(values.find((v) => v.name === 'API_TOKEN')?.value, null);
  assert.equal(values.find((v) => v.name === 'PROFILE_CTX')?.value, null);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  assert.equal(await fs.readFile(fx.file, 'utf8'), source);
});

test('RE-B2-01: изменяются только свои строки, CRLF и права сохранены', async (t) => {
  const original = '# metadata\r\nPROFILE_CTX="Стек: Node"\r\nPROFILE_LOOP_MAX_ROUNDS=20\r\n';
  const fx = await fixture(t, original);

  await applyProfileVariableChanges(fx.config.profilesDir, 'demo', 'profile.sh', [
    {
      name: 'PROFILE_CTX',
      from: 'Стек: Node',
      to: 'Стек: Vue'
    },
    {
      name: 'PROFILE_LOOP_MAX_ROUNDS',
      from: '20',
      to: '40'
    },
  ]);

  assert.equal(await fs.readFile(fx.file, 'utf8'),
    '# metadata\r\nPROFILE_CTX="Стек: Vue"\r\nPROFILE_LOOP_MAX_ROUNDS="40"\r\n');
  assert.equal((await fs.stat(fx.file)).mode & 0o777, 0o755);
});

test('RE-B2-02: все malformed changes отклоняются до записи первой валидной', async (t) => {
  const { app, file } = await httpFixture(t);
  const before = await fs.readFile(file);
  const valid = {
    name: 'PROFILE_CTX',
    from: 'Стек: Node',
    to: 'Стек: Vue'
  };
  const invalid = [null, [], {}, { ...valid, to: 7 }, { ...valid, extra: true },
    { ...valid, name: '../bad' }, { ...valid, to: 'x; command' }];

  for (const bad of invalid) {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/profiles/demo/variables',
      payload: { file: 'profile.sh', changes: [valid, bad] },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(await fs.readFile(file), before);
  }
});

test('RE-B2-03: конфликт второго значения не применяет первое', async (t) => {
  const fx = await fixture(t);
  const before = await fs.readFile(fx.file);

  await assert.rejects(applyProfileVariableChanges(fx.config.profilesDir, 'demo', 'profile.sh', [
    {
      name: 'PROFILE_CTX',
      from: 'Стек: Node',
      to: 'Стек: Vue'
    },
    {
      name: 'PROFILE_LOOP_MAX_ROUNDS',
      from: '5',
      to: '40'
    },
  ]), (error) => error instanceof ProfileConfigError && error.status === 409);

  assert.deepEqual(await fs.readFile(fx.file), before);
});

test('RE-B2-04: multiline/дубликат/heredoc/function не повреждаются PATCH', async (t) => {
  const cases = [
    'PROFILE_CTX="Первая\nВторая"\n',
    'PROFILE_CTX=first\nPROFILE_CTX=second\n',
    'cat <<\'END\'\nPROFILE_CTX=inside\nEND\n',
    'helper() {\n  PROFILE_CTX=inside\n}\n',
  ];

  for (const source of cases) {
    const fx = await fixture(t, source);

    await assert.rejects(applyProfileVariableChanges(fx.config.profilesDir, 'demo', 'profile.sh', [
      {
        name: 'PROFILE_CTX',
        from: null,
        to: 'Замена'
      },
    ]), (error) => error.code === 'variable_not_literal' && error.status === 409);
    assert.equal(await fs.readFile(fx.file, 'utf8'), source);
    await exec('bash', ['-n', fx.file]);
  }
});

test('RE-B2-05: создание — перед shell-хвостом, удаление отсутствующего запрещено', async (t) => {
  const tail = 'helper() {\n  printf ok\n}\nexit 0\n';
  const fx = await fixture(t, '# metadata\nPROFILE_CTX=old\n' + tail);

  await applyProfileVariableChanges(fx.config.profilesDir, 'demo', 'profile.sh', [
    {
      name: 'PROFILE_TRIAGE_MARKERS',
      from: null,
      to: 'миграции, API'
    },
  ]);

  assert.equal(await fs.readFile(fx.file, 'utf8'),
    '# metadata\nPROFILE_CTX=old\nPROFILE_TRIAGE_MARKERS="миграции, API"\n' + tail);
  await exec('bash', ['-n', fx.file]);

  const before = await fs.readFile(fx.file);

  await assert.rejects(applyProfileVariableChanges(fx.config.profilesDir, 'demo', 'profile.sh', [
    {
      name: 'PROFILE_TRIAGE_RULES',
      from: null,
      to: null
    },
  ]), (error) => error.code === 'variable_absent' && error.status === 400);
  assert.deepEqual(await fs.readFile(fx.file), before);
});

test('RE-B2-06: recheck видит внешний drift целого файла и убирает temp', async (t) => {
  const fx = await fixture(t);
  const external = '# external edit\nPROFILE_CTX="Стек: Node"\nPROFILE_LOOP_MAX_ROUNDS=20\n';

  await assert.rejects(applyProfileVariableChanges(fx.config.profilesDir, 'demo', 'profile.sh', [
    {
      name: 'PROFILE_CTX',
      from: 'Стек: Node',
      to: 'Стек: Vue'
    },
  ], { beforeRecheck: () => fs.writeFile(fx.file, external) }),
  (error) => error.status === 409 && error.code === 'profile_file_conflict');

  assert.equal(await fs.readFile(fx.file, 'utf8'), external);
  assert.equal((await fs.readdir(fx.directory)).some((name) => name.endsWith('.tmp')), false);
});

test('RE-B2-07: две серверные CAS-записи одного from не теряют конфликт', async (t) => {
  const fx = await fixture(t);
  const results = await Promise.allSettled(['first', 'second'].map((to) => (
    applyProfileVariableChanges(fx.config.profilesDir, 'demo', 'profile.sh', [
      {
        name: 'PROFILE_CTX',
        from: 'Стек: Node',
        to
      },
    ])
  )));

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);


  const rejected = results.find((result) => result.status === 'rejected');

  assert.equal(rejected.reason.code, 'variable_conflict');


  const values = await readProfileVariables(fx.config.profilesDir, 'demo', 'profile.sh');

  const winningValue = ['first', 'second'][results.findIndex((result) => result.status === 'fulfilled')];

  assert.equal(values.find((value) => value.name === 'PROFILE_CTX').value, winningValue);
});

/**
 * Canonical engine config создаётся как данные: real CLI меняет только этот файл.
 * Model prompt, workspace и пользовательское состояние не участвуют в проверке.
 */
async function runnerFixture(t) {
  const fx = await fixture(t);
  const runnersFile = path.join(fx.directory, 'runners.env');

  await fs.writeFile(runnersFile, [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=4', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=codex', 'PROJECT_RUNNER_FAILOVER=claude',
    'STAGE_REVIEW_PRIMARY=codex', 'STAGE_REVIEW_FAILOVER=deepseek',
    'MODEL_REVIEW_CODEX_EFFORT=high', '',
  ].join('\n'));

  return { ...fx, runnersFile };
}

test('RE-B2-08: реальный engine сохраняет пропущенный failover и очищает явный', async (t) => {
  const fx = await runnerFixture(t);
  const first = await applyRunnerOperations(fx.config, 'demo', [
    { kind: 'runner', primary: 'kimi' },
    {
      kind: 'runner',
      role: 'REVIEW',
      primary: 'glm'
    },
  ]);

  assert.equal(first.PROJECT_RUNNER_PRIMARY, 'kimi');
  assert.equal(first.PROJECT_RUNNER_FAILOVER, 'claude');
  assert.equal(first.STAGE_REVIEW_PRIMARY, 'glm');
  assert.equal(first.STAGE_REVIEW_FAILOVER, 'deepseek');

  const cleared = await applyRunnerOperations(fx.config, 'demo', [
    {
      kind: 'runner',
      primary: 'kimi',
      failover: ''
    },
    {
      kind: 'model',
      role: 'REVIEW',
      provider: 'codex',
      effort: 'low',
      familyFailover: 'backup'
    },
  ]);

  assert.equal(cleared.PROJECT_RUNNER_FAILOVER, '');
  assert.equal(cleared.STAGE_REVIEW_FAILOVER, 'deepseek');
  assert.equal(cleared.MODEL_REVIEW_CODEX_EFFORT, 'low');
  assert.equal(cleared.MODEL_REVIEW_CODEX_FAMILY_FAILOVER, 'backup');
  assert.equal(cleared.CONFIG_REVISION, '8');
});

test('RE-B2-09: valid+malformed runner batch даёт 400, реальный файл не меняется', async (t) => {
  const fx = await runnerFixture(t);
  const app = Fastify({ logger: false });

  fx.closeBeforeCleanup.push(() => app.close());
  await app.register(profileConfigModule, { config: fx.config });
  await app.ready();

  const before = await fs.readFile(fx.runnersFile);
  const invalid = [null, [], {}, { kind: 'wrong' }, { kind: 'runner', primary: 7 },
    {
      kind: 'model',
      role: 'REVIEW',
      provider: 'codex'
    },
    {
      kind: 'model',
      role: 'REVIEW',
      provider: 'codex',
      effort: null
    },
    {
      kind: 'runner',
      primary: 'kimi',
      extra: true
    },
    { kind: 'runner', primary: 'glm' }];

  for (const bad of invalid) {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/profiles/demo/runners',
      payload: { operations: [{ kind: 'runner', primary: 'kimi' }, bad] },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(await fs.readFile(fx.runnersFile), before);
  }
});

test('RE-B2-10: PATCH variables happy path и обе path-traversal границы', async (t) => {
  const { app, file } = await httpFixture(t);
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/profiles/demo/variables',
    payload: { file: 'profile.sh', changes: [{
      name: 'PROFILE_CTX',
      from: 'Стек: Node',
      to: 'Vue'
    }] },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().variables.find((v) => v.name === 'PROFILE_CTX').value, 'Vue');


  const saved = await fs.readFile(file);

  for (const suffix of ['variables', 'runners']) {
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/..%2Fx/${suffix}`,
      payload: {},
    });

    assert.equal(denied.statusCode, 400);
    assert.deepEqual(await fs.readFile(file), saved);
  }
});

test('RE-B2-11: выбранный factoryBin применяет первую операцию, отказ второй честен', async (t) => {
  const fx = await runnerFixture(t);
  const wrapper = path.join(fx.root, 'selected-factory.sh');
  const body = [
    '#!/usr/bin/env bash',
    'if [[ "$3" == model ]]; then exit 7; fi',
    'exec "$FACTORY_HOME/bin/factory" "$@"',
    '',
  ].join('\n');

  await fs.writeFile(wrapper, body, { mode: 0o755 });

  await assert.rejects(applyRunnerOperations({ ...fx.config, factoryBin: wrapper }, 'demo', [
    { kind: 'runner', primary: 'kimi' },
    {
      kind: 'model',
      role: 'REVIEW',
      provider: 'codex',
      effort: 'low'
    },
  ]), (error) => error.code === 'profile_config_cli' && error.status === 502
    && error.applied === 1 && error.currentOperationUnknown === true);

  const text = await fs.readFile(fx.runnersFile, 'utf8');

  assert.match(text, /PROJECT_RUNNER_PRIMARY=kimi/);
  assert.match(text, /PROJECT_RUNNER_FAILOVER=claude/);
  assert.match(text, /MODEL_REVIEW_CODEX_EFFORT=high/);
  assert.match(text, /CONFIG_REVISION=5/);
});
