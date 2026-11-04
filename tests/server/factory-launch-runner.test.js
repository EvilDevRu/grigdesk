// Выбор исполнителя при запуске: launch-options отдаёт каталог и дефолт профиля,
// launch валидирует runnerPrimary ДО любых побочных эффектов и прокидывает его
// движку аргументом --runner-primary сразу после --ticket-json.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  access, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { ownTask, seedTasks } from './helpers/grigdesk-tasks.js';

import factoryModule from '../../server/src/modules/factory/index.ts';
import { parsePipeline } from '../../server/src/lib/pipelineParse.ts';
import authPlugin from '../../server/src/plugins/auth.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);

const missing = (file) => access(file).then(() => false, () => true);

/**
 * HTTP-запуск пользуется изолированными тикетами, профилем и подменным движком.
 * Необязательный портал меняет только источник контекста, прежние defaults сохранены.
 */
async function fixture(t, {
  tracker = null,
  clarifications = null,
  openQuestions = null,
  publishRegistry = true,
  withAuth = false,
  unitActive = true,
  // Файл-флаг вместо второго набора заглушек: пока он есть, «движок» изображает
  // отказ runner preflight — пишет типизированный маркер в launch.log и НЕ создаёт
  // ни реестра, ни демона. Тест снимает флаг между двумя запусками одной задачи.
  preflightFlag = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-launch-runner-'));
  const stateDir = path.join(root, 'state');
  const profilesDir = path.join(root, 'profiles');
  const binDir = path.join(root, 'bin');
  const runnersDir = path.join(root, 'engine', 'lib', 'runners');
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(path.join(profilesDir, 'demo'), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(runnersDir, { recursive: true }),
  ]);
  // Установлены два исполнителя; служебные модули движка — не исполнители.
  for (const name of ['claude.sh', 'codex.sh', 'index.sh', 'policy.sh', 'catalog.sh']) {
    await writeFile(path.join(runnersDir, name), '# адаптер\n');
  }
  await writeFile(path.join(profilesDir, 'demo', 'runners.env'), [
    'RUNNERS_SCHEMA=1',
    'CONFIG_REVISION=1',
    'PROJECT_RUNNER_PRIMARY=codex',
    'PROJECT_RUNNER_FAILOVER=claude',
    '',
  ].join('\n'));
  await writeFile(path.join(profilesDir, 'demo', 'profile.sh'), `
PROFILE_TRIAGE_REPOS=""
profile_repositories() { printf 'demo\\t${root}/src\\t${root}/work\\n'; }
`);

  const factoryCalls = path.join(root, 'factory.calls');
  const systemdCalls = path.join(root, 'systemd.calls');
  const factoryBin = path.join(binDir, 'factory');
  await writeFile(factoryBin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${factoryCalls}"
case "$1" in
  check) echo "OK profile=demo catalog=${'b'.repeat(64)} route=feature delivery=disabled instrumentation=disabled"; exit 0 ;;
  slots) echo '{"supported":false,"reason":"тест без слотов"}'; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

  // systemd-run-заглушка: журналирует argv, поднимает «живого» оркестратора
  // (cmdline содержит bin/factory и номер задачи) и пишет реестр прогона —
  // ровно то, что ждёт подтверждение запуска в startRoutePipeline.
  await writeFile(path.join(binDir, 'systemd-run'), `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "systemd 252 (test)"; exit 0; fi
printf '%s\\n' "$*" >> "${systemdCalls}"
seen=""; task=""; previous=""; runner=""; expected=""; dispatch=""
for a in "$@"; do
  case "$previous" in
    --runner-primary) runner="$a" ;;
    --expected-catalog-hash) expected="$a" ;;
    --queue-dispatch-id) dispatch="$a" ;;
  esac
  if [ -n "$seen" ] && [ -z "$task" ]; then task="$a"; fi
  if [ "$a" = "${factoryBin}" ]; then seen=1; fi
  previous="$a"
done
[ -n "$task" ] || exit 1
# Отказ runner preflight: движок печатает типизированный маркер и уходит ДО создания
# попытки — на диске остаётся только launch.log. Регистрация transient-юнита при этом
# успешна, поэтому здесь exit 0: провал виден GrigDesk не по коду, а по состоянию.
if [ -f "${path.join(root, 'preflight-fails')}" ]; then
  printf '%s\\n' "runner preflight не пройден: недоступны codex [FACTORY_ERROR=runner_preflight_unavailable RUNNERS=codex]" \\
    >> "${stateDir}/t$task.launch.log"
  exit 0
fi
# «Живой» оркестратор: '; :' после sleep запрещает bash exec-оптимизацию последней
# команды — иначе cmdline потеряет маркеры bin/factory и номер задачи. Потоки
# отвязаны, чтобы execFile не ждал закрытия pipe до конца sleep.
bash -c 'sleep 30; :' "${factoryBin}" "$task" </dev/null >/dev/null 2>&1 &
pid=$!
echo "$pid" >> "${path.join(root, 'daemon.pids')}"
${publishRegistry ? `
cat > "${stateDir}/t$task.pipeline" <<EOF
PROFILE=demo
ROUTE=feature
RUN_PROTOCOL=2
CATALOG_PROTOCOL=route-v2
CATALOG_HASH=$expected
ATTEMPT_ID=${ATTEMPT}
ROUTE_HASH=${ROUTE_HASH}
QUEUE_DISPATCH_ID=$dispatch
RUNNER_OVERRIDE_PRIMARY=$runner
DELIVERY_MODE=disabled
ORCH_PID=$pid
STALLED_HUMAN=0
WF_STATUS=running
EOF
` : ''}
exit 0
`, { mode: 0o755 });
  // При отказе preflight юнит не живёт, но после снятия флага тот же запуск обязан
  // подтверждаться как обычно — иначе тест повторного старта проверял бы заглушку,
  // а не снятие pending-marker.
  await writeFile(path.join(binDir, 'systemctl'), preflightFlag
    ? `#!/usr/bin/env bash
if [ -f "${path.join(root, 'preflight-fails')}" ]; then echo inactive; exit 3; fi
echo active
exit 0
`
    : (unitActive
      ? '#!/usr/bin/env bash\necho active\nexit 0\n'
      : '#!/usr/bin/env bash\necho inactive\nexit 3\n'), { mode: 0o755 });

  if (preflightFlag) await writeFile(path.join(root, 'preflight-fails'), '1\n');

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const config = {
    factoryHome: path.join(root, 'engine'),
    factoryBin,
    factoryConfigRoot: path.join(root, 'config'),
    factoryControlDir: path.join(root, 'control'),
    routesDir: path.join(root, 'routes'),
    ticketsDir: path.join(root, 'tickets'),
    grigdeskTasksPath: path.join(root, 'tasks.json'),
    stateDir,
    profilesDir,
    factoryProfile: 'demo',
  };
  const app = Fastify({ logger: false });
  const auth = { internalToken: 'runner-internal-secret', cliToken: 'runner-cli-secret' };

  if (withAuth) {
    await app.register(authPlugin, {
      authStore: { isConfigured: () => true, isValidSession: () => false },
      ...auth,
    });
  }
  await app.register(factoryModule, {
    factoryState: {
      discoverProfiles() { return ['demo']; },
      async primaryProfile() { return 'demo'; },
      async readRegistry(id) {
        return { registry: parsePipeline(await readFile(path.join(stateDir, `t${id}.pipeline`), 'utf8')) };
      },
      isDaemonAlive(orchPid, task) {
        try {
          const argv = readFileSync(`/proc/${Number(orchPid)}/cmdline`, 'utf8').split('\0').filter(Boolean);
          return argv.some((a) => a.endsWith('/bin/factory')) && argv.includes(String(task));
        } catch { return false; }
      },
      async catalog(profile) {
        return profile === 'demo'
          ? {
            routes: ['feature'],
            catalogHash: 'b'.repeat(64),
            routeOptions: {
              feature: {
                deliveryMode: 'disabled', instrumentationMode: 'disabled', instrumentationRequired: false,
              },
            },
          }
          : null;
      },
    },
    config,
    prefs: { read: () => ({}) },
    tracker,
    analyzer: {
      readClarifications: async () => clarifications,
      readOpenQuestions: async () => openQuestions,
      async get() {
        return null;
      },
    },
    internalToken: withAuth ? auth.internalToken : '',
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    const pids = await readFile(path.join(root, 'daemon.pids'), 'utf8').catch(() => '');
    for (const pid of pids.split('\n').filter(Boolean)) {
      try { process.kill(Number(pid)); } catch { /* уже ушёл */ }
    }
    await rm(root, { recursive: true, force: true });
  });

  return {
    app,
    root,
    config,
    factoryCalls,
    systemdCalls,
    auth,
  };
}

const LAUNCH_PAYLOAD = {
  profile: 'demo',
  route: 'feature',
  title: 'Проверка выбора исполнителя',
  description: 'Запуск с явным runnerPrimary.',
  sourceUrl: 'https://example.test/tasks/42',
  acceptanceCriteria: [],
};

test('launch-options отдаёт каталог исполнителей и дефолт профиля', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/tasks/42/launch-options' });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().runners, ['claude', 'codex']);
  assert.equal(response.json().defaultRunner, 'codex');
});

test('GET /api/factory/runners отдаёт установленных исполнителей', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/factory/runners' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { runners: ['claude', 'codex'] });
});

test('launch с runnerPrimary прокидывает --runner-primary движку после --ticket-json', async (t) => {
  const { app, systemdCalls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'claude' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');
  const calls = await readFile(systemdCalls, 'utf8');
  assert.match(calls, new RegExp(
    `--ticket-json \\S*t42\\.ticket\\.json --runner-primary claude `
      + `--expected-catalog-hash ${'b'.repeat(64)} --routes-dir`,
  ));
});

test('launch без runnerPrimary запускается по профилю, без --runner-primary', async (t) => {
  const { app, systemdCalls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/43/launch',
    payload: LAUNCH_PAYLOAD,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');
  const calls = await readFile(systemdCalls, 'utf8');
  assert.equal(calls.includes('--runner-primary'), false);
});

test('два start одной задачи сериализованы даже пока registry остаётся bootstrap', async (t) => {
  const { app, auth, systemdCalls } = await fixture(t, {
    publishRegistry: false,
    withAuth: true,
  });
  const first = app.inject({
    method: 'POST',
    url: '/api/tasks/46/launch',
    headers: { 'x-grigdesk-internal': auth.internalToken },
    payload: { ...LAUNCH_PAYLOAD, expectedCatalogHash: 'b'.repeat(64) },
  });
  const second = app.inject({
    method: 'POST',
    url: '/api/tasks/46/launch',
    headers: { 'x-grigdesk-token': auth.cliToken },
    payload: LAUNCH_PAYLOAD,
  });

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  assert.equal(firstResponse.json().outcome, 'started');
  assert.equal(secondResponse.statusCode, 409, secondResponse.body);
  assert.equal(secondResponse.json().error, 'run_exists');
  assert.match(secondResponse.json().message, /trusted identity/);
  const starts = (await readFile(systemdCalls, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(starts.length, 1, 'после uncertain bootstrap второй engine start запрещён');
  assert.match(starts[0], new RegExp('--expected-catalog-hash b{64}'));
});

test('launch с неустановленным runnerPrimary отказан до вызова движка', async (t) => {
  const { app, factoryCalls, systemdCalls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/44/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'bogus' },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'bad_runner');
  assert.equal(await missing(factoryCalls), true, 'движок не вызывался');
  assert.equal(await missing(systemdCalls), true, 'прогон не запускался');
});

test('launch с битым форматом runnerPrimary отказан до вызова движка', async (t) => {
  const { app, factoryCalls, systemdCalls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/45/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'Claude!' },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'bad_runner');
  assert.equal(await missing(factoryCalls), true, 'движок не вызывался');
  assert.equal(await missing(systemdCalls), true, 'прогон не запускался');
});

test('отказ runner preflight не запирает задачу: следующий запуск проходит', async (t) => {
  // Отказ относится к выбранной цепочке: task override требует только codex,
  // хотя профиль также называет claude. Движок встал fail-closed ДО создания попытки —
  // ни реестра, ни control-записи, только launch.log с типизированным маркером.
  // Раньше pending-marker после такого отказа не снимался, и задача отвечала
  // `run_exists` до перезапуска сервера, хотя запускать её было совершенно нечем.
  const { app, root } = await fixture(t, { preflightFlag: true });

  const refused = await app.inject({
    method: 'POST',
    url: '/api/tasks/47/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'codex' },
  });
  assert.equal(refused.statusCode, 500, refused.body);
  assert.equal(refused.json().error, 'runner_preflight_unavailable');
  assert.deepEqual(refused.json().runners, ['codex']);
  assert.equal(refused.json().runners.includes('claude'), false);
  assert.equal(
    await missing(path.join(root, 'state', 't47.pipeline')),
    true,
    'реестр не создан — граница side effect не пересечена',
  );

  // Человек починил профиль (или вернул CLI) и запускает снова.
  await rm(path.join(root, 'preflight-fails'), { force: true });
  await rm(path.join(root, 'state', 't47.launch.log'), { force: true });

  const retried = await app.inject({
    method: 'POST',
    url: '/api/tasks/47/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'codex' },
  });
  assert.notEqual(
    retried.json().error,
    'run_exists',
    'pending-marker обязан сняться: доказано, что попытки не было',
  );
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().outcome, 'launched');
});

test('runner_preflight_failed marker остаётся fail-closed', async (t) => {
  // Соседний маркер означает, что сломалась САМА проверка. Доказательства «попытки
  // не было» за ним нет, поэтому marker снимать нельзя — иначе ослабление одного
  // случая тихо распространится на другой.
  const source = await readFile(
    new URL('../../server/src/modules/factory/index.ts', import.meta.url),
    'utf8',
  );
  const guard = source.slice(source.indexOf('const provenPreSideEffect'));
  const clause = guard.slice(0, guard.indexOf(';'));
  assert.match(clause, /runner_preflight_unavailable/);
  assert.doesNotMatch(clause, /runner_preflight_failed/);
});

test('B24-SOURCE-01: запуск сохраняет портальную ссылку, комментарии и уточнения', async (t) => {
  const { app, config } = await fixture(t, {
    tracker: {
      sourceUrl: (id) => `https://portal.test/company/personal/user/17/tasks/task/view/${id}/`,
      async accountIdentity() {
        return { baseUrl: 'https://portal.test/', userId: 17 };
      },
      async taskPageData() {
        return { comments: [
          {
            text: 'Комментарий человека',
            author: 'Автор',
            isSystem: false
          },
          {
            text: 'Служебный комментарий',
            author: 'Система',
            isSystem: true
          },
        ] };
      },
    },
    clarifications: 'Уточнение человека',
  });
  const { sourceUrl, ...payload } = LAUNCH_PAYLOAD;
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/48/launch',
    payload
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');

  const ticket = JSON.parse(await readFile(path.join(config.ticketsDir, 't48.ticket.json'), 'utf8'));

  assert.equal(ticket.title, payload.title);
  assert.match(ticket.description, /Запуск с явным runnerPrimary/);
  assert.equal(ticket.sourceUrl, 'https://portal.test/company/personal/user/17/tasks/task/view/48/');
  assert.match(ticket.description, /Комментарий человека/);
  assert.match(ticket.description, /Уточнение человека/);
  assert.doesNotMatch(ticket.description, /Служебный комментарий/);
});

test('LOCAL-LAUNCH-01: собственная постановка сильнее body, без обращений к Б24', async (t) => {
  const portalCalls = [];
  const { app, config } = await fixture(t, {
    tracker: {
      async accountIdentity() {
        portalCalls.push('identity');

        return { baseUrl: 'https://portal.test', userId: 17 };
      },
      async taskPageData() {
        portalCalls.push('comments');

        return { comments: [{ text: 'Чужой комментарий портала', author: 'Портал' }] };
      },
    },
    clarifications: 'Ответ человека на вопрос',
    openQuestions: { questions: ['Открытый вопрос'], unknowns: ['Проверить контракт'] },
  });
  const task = ownTask();

  await seedTasks(config, [task]);

  const response = await app.inject({
    method: 'POST',
    url: `/api/tasks/${task.id}/launch`,
    payload: {
      ...LAUNCH_PAYLOAD,
      title: 'Поддельное название',
      description: 'Поддельный текст'
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');

  const ticket = JSON.parse(await readFile(path.join(config.ticketsDir, `t${task.id}.ticket.json`), 'utf8'));

  assert.equal(ticket.title, task.title);
  assert.equal(ticket.sourceUrl, task.sourceUrl);
  assert.ok(ticket.description.includes(task.description));
  assert.match(ticket.description, /Ответ человека на вопрос/);
  assert.match(ticket.description, /Открытый вопрос/);
  assert.doesNotMatch(ticket.description, /Поддельный|Чужой комментарий портала/);
  assert.deepEqual(portalCalls, []);
});
