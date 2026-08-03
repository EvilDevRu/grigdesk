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

import factoryModule from '../../server/src/modules/factory/index.js';
import { parsePipeline } from '../../server/src/lib/pipeline-parse.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);

const missing = (file) => access(file).then(() => false, () => true);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-launch-runner-'));
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
  check) echo "OK profile=demo catalog=${'b'.repeat(64)} route=feature delivery=disabled"; exit 0 ;;
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
seen=""; task=""
for a in "$@"; do
  if [ -n "$seen" ]; then task="$a"; break; fi
  if [ "$a" = "${factoryBin}" ]; then seen=1; fi
done
[ -n "$task" ] || exit 1
# «Живой» оркестратор: '; :' после sleep запрещает bash exec-оптимизацию последней
# команды — иначе cmdline потеряет маркеры bin/factory и номер задачи. Потоки
# отвязаны, чтобы execFile не ждал закрытия pipe до конца sleep.
bash -c 'sleep 30; :' "${factoryBin}" "$task" </dev/null >/dev/null 2>&1 &
pid=$!
echo "$pid" >> "${path.join(root, 'daemon.pids')}"
cat > "${stateDir}/t$task.pipeline" <<EOF
PROFILE=demo
ROUTE=feature
RUN_PROTOCOL=2
CATALOG_PROTOCOL=route-v2
ATTEMPT_ID=${ATTEMPT}
ROUTE_HASH=${ROUTE_HASH}
DELIVERY_MODE=disabled
ORCH_PID=$pid
STALLED_HUMAN=0
WF_STATUS=running
EOF
exit 0
`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemctl'), '#!/usr/bin/env bash\necho active\nexit 0\n', { mode: 0o755 });

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
    stateDir,
    profilesDir,
    factoryProfile: 'demo',
  };
  const app = Fastify({ logger: false });
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
            routeOptions: { feature: { deliveryMode: 'disabled' } },
          }
          : null;
      },
    },
    config,
    prefs: { read: () => ({}) },
    b24: null,
    analyzer: { readClarifications: async () => null, async get() { return null; } },
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
  return { app, root, factoryCalls, systemdCalls };
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
  assert.match(calls, /--ticket-json \S*t42\.ticket\.json --runner-primary claude --routes-dir/);
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
