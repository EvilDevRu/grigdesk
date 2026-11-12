import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import factoryModule from '../../../server/src/modules/factory/index.ts';
import { factoryTicketHash } from '../../../server/src/lib/factoryTaskSources.ts';
import { parsePipeline } from '../../../server/src/lib/pipelineParse.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
export const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
export const ROUTE_HASH = 'a'.repeat(64);

/**
 * HTTP-запуск пользуется изолированными тикетами, профилем и подменным движком.
 * Необязательный портал меняет только источник контекста, прежние defaults сохранены.
 */
export async function factoryLaunchFixture(t, {
  tracker = null,
  sourceFixture = null,
  app: suppliedApp = null,
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
  check)
    echo "OK profile=demo catalog=${'b'.repeat(64)} route=feature" \
      "delivery=disabled instrumentation=disabled"
    exit 0 ;;
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
  marker="[FACTORY_ERROR=runner_preflight_unavailable RUNNERS=codex]"
  printf '%s\\n' "runner preflight не пройден: недоступны codex $marker" \\
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

  if (preflightFlag) {
    await writeFile(path.join(root, 'preflight-fails'), '1\n');
  }

  const oldPath = process.env.PATH;

  process.env.PATH = `${binDir}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });

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
    ...(sourceFixture ? {
      analysisDir: sourceFixture.config.analysisDir,
      factoryTaskSourcesPath: sourceFixture.config.factoryTaskSourcesPath
        || path.join(stateDir, 'factory-task-sources.json'),
    } : {}),
  };
  const app = suppliedApp || Fastify({ logger: false });
  const auth = { internalToken: 'runner-internal-secret', cliToken: 'runner-cli-secret' };

  if (withAuth) {
    await app.register(authPlugin, {
      authStore: { isConfigured: () => true, isValidSession: () => false },
      ...auth,
    });
  }

  const factoryState = {
      discoverProfiles() {
        return ['demo'];
      },
      async primaryProfile() {
        return 'demo';
      },
      async readRegistry(id) {
        return { registry: parsePipeline(await readFile(path.join(stateDir, `t${id}.pipeline`), 'utf8')) };
      },
      /**
       * Проверяет только дочерний процесс локального тестового движка.
       * Чужой PID не считается подтверждением запуска нужного номера.
       */
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
                deliveryMode: 'disabled',
                instrumentationMode: 'disabled',
                instrumentationRequired: false,
              },
            },
          }
          : null;
      },
  };

  if (sourceFixture) {
    factoryState.readTrustedAttempt = async (id) => {
      const { registry } = await factoryState.readRegistry(id);

      return {
        profile: registry.PROFILE,
        route: registry.ROUTE,
        catalogHash: registry.CATALOG_HASH,
        attempt: registry.ATTEMPT_ID,
        queueDispatchId: registry.QUEUE_DISPATCH_ID,
      };
    };
    factoryState.readTrustedTicketProof = async (id) => {
      const { registry } = await factoryState.readRegistry(id);
      const ticket = JSON.parse(await readFile(path.join(config.ticketsDir, `t${id}.ticket.json`), 'utf8'));

      return {
        attempt: registry.ATTEMPT_ID,
        queueDispatchId: registry.QUEUE_DISPATCH_ID,
        ticketHash: factoryTicketHash(ticket),
      };
    };
  }

  await app.register(factoryModule, {
    factoryState,
    config,
    prefs: { read: () => ({}) },
    tracker: sourceFixture?.tracker || tracker,
    analyzer: sourceFixture?.analyzer || {
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
    factoryState,
  };
}
