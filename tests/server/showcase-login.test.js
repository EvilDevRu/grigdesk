// Вход на стенд: откуда берётся учётка и как она доезжает до исполнителя записи.
//
// Секрет живёт в файле профиля и читается как KEY=value — без исполнения shell.
// Проверяется, что ссылка не выходит за каталог профиля, что объявленный, но не
// найденный вход останавливает запись до старта, и что пароль не задерживается в
// файле задания дольше, чем исполнителю нужно его прочитать.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseCredentialsRef,
  readEnvValue,
  readLoginCredentials,
} from '../../server/src/lib/showcase/loginCredentials.ts';
import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';

const LOGIN_CONTRACT = {
  version: 1,
  url: '/login',
  userSelector: '#email',
  passwordSelector: '#password',
  submitSelector: 'button[type="submit"]',
  readySelector: 'a[href="/logout"]',
  credentialsRef: 'lib.sh:SB_LOGIN_EMAIL:SB_LOGIN_PASSWORD',
};

test('ссылка на учётку разбирается только внутри каталога профиля', () => {
  assert.deepEqual(parseCredentialsRef('lib.sh:SB_LOGIN_EMAIL:SB_LOGIN_PASSWORD'), {
    file: 'lib.sh',
    userKey: 'SB_LOGIN_EMAIL',
    passwordKey: 'SB_LOGIN_PASSWORD',
  });
  assert.equal(parseCredentialsRef('../../.state/b24-creds.json:USER:PASS'), null);
  assert.equal(parseCredentialsRef('/etc/passwd:USER:PASS'), null);
  assert.equal(parseCredentialsRef('lib.sh:USER'), null);
  assert.equal(parseCredentialsRef('lib.sh:$(id):PASS'), null);
});

test('значение читается из строки KEY=value в любой из форм кавычек', () => {
  const text = [
    '# комментарий',
    'export SB_LOGIN_EMAIL="demo@example.test"',
    "SB_LOGIN_PASSWORD='p#ss word'",
    'SB_LOGIN_HASH=abc123 # хвост',
  ].join('\n');

  assert.equal(readEnvValue(text, 'SB_LOGIN_EMAIL'), 'demo@example.test');
  assert.equal(readEnvValue(text, 'SB_LOGIN_PASSWORD'), 'p#ss word');
  assert.equal(readEnvValue(text, 'SB_LOGIN_HASH'), 'abc123');
  assert.equal(readEnvValue(text, 'MISSING'), '');
});

test('учётка приходит из файла профиля, а без неё — null', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-login-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'lib.sh'),
    'SB_LOGIN_EMAIL="demo@example.test"\nSB_LOGIN_PASSWORD=\'secret\'\n',
    'utf8',
  );

  assert.deepEqual(
    await readLoginCredentials(root, 'lib.sh:SB_LOGIN_EMAIL:SB_LOGIN_PASSWORD'),
    { user: 'demo@example.test', password: 'secret' },
  );
  assert.equal(await readLoginCredentials(root, 'lib.sh:SB_LOGIN_EMAIL:NO_SUCH'), null);
  assert.equal(await readLoginCredentials(root, 'missing.sh:A:B'), null);
});

/**
 * Служба на профиле со входом. Браузером назначен существующий файл: запись до
 * его запуска не доходит, а проверяется то, что служба кладёт в задание.
 */
async function fixture(t, { credentials = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-login-service-'));
  let service = null;

  t.after(async () => {
    await service?.disable().catch(() => null);
    await rm(root, { recursive: true, force: true });
  });

  const profileDir = path.join(root, 'profiles', 'demo-profile');
  const contractDir = path.join(profileDir, 'showcase');

  await mkdir(contractDir, { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(contractDir, 'target.json'), JSON.stringify({
    version: 1,
    environment: 'read-only',
    project: { record: 'http://127.0.0.1:5173', view: 'http://127.0.0.1:5173' },
    sandbox: null,
    allowedOrigins: [],
    capabilities: ['record', 'login'],
  }), 'utf8');
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify({
    version: 1,
    screens: [{ id: 'overview', title: 'Обзор', path: '/', readySelector: 'body', elements: [] }],
  }), 'utf8');
  await writeFile(path.join(contractDir, 'login.json'), JSON.stringify(LOGIN_CONTRACT), 'utf8');
  await writeFile(
    path.join(profileDir, 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
    'utf8',
  );

  if (credentials) {
    await writeFile(
      path.join(profileDir, 'lib.sh'),
      'SB_LOGIN_EMAIL="demo@example.test"\nSB_LOGIN_PASSWORD="secret"\n',
      'utf8',
    );
  }

  service = createShowcaseService({
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath: process.execPath,
    listProjects: async () => ['demo-profile'],
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });

  await service.recover();

  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  const withScene = await service.addScene(project.id, project.revision, {
    title: 'Обзор',
    screenId: 'overview',
    narration: 'Открываем обзор.',
    caption: '',
    subtitleText: '',
    startState: null,
    readyCondition: null,
    actions: [],
  });

  return { service, root, project: withScene };
}

test('объявленный вход без учётки останавливает запись до её начала', async (t) => {
  const { service, project } = await fixture(t, { credentials: false });

  assert.ok(project.target.scope.capabilities.includes('login'));
  await assert.rejects(
    () => service.startRecording(project.id),
    (error) => error.code === 'login_credentials_missing' && error.status === 409,
  );
});

test('исполнитель получает вход с учёткой, а пароль стирается из задания после чтения', async (t) => {
  const { service, root, project } = await fixture(t);
  const job = await service.startRecording(project.id);
  const taskFile = path.join(root, 'showcase', 'jobs', job.id, 'work');

  t.after(() => service.cancelJob(job.id).catch(() => null));

  const attempt = await waitFor(async () => {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(taskFile).catch(() => []);

    return entries[0] ?? null;
  });
  const task = await waitFor(async () => {
    const text = await readFile(path.join(taskFile, attempt, 'task.json'), 'utf8').catch(() => '');
    const parsed = text ? JSON.parse(text) : null;

    // Исполнитель стирает пароль сразу после чтения: ждём именно это состояние,
    // иначе проверка зависела бы от того, кто успел первым.
    return parsed?.login && parsed.login.password === '' ? parsed : null;
  });

  assert.equal(task.login.user, 'demo@example.test');
  assert.equal(task.login.userSelector, '#email');
  assert.equal(task.login.readySelector, 'a[href="/logout"]');
  assert.equal(task.login.password, '');
});

async function waitFor(probe, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await probe();

    if (value) {
      return value;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error('ожидаемое состояние не наступило');
}
