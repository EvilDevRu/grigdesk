import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { TestContext } from 'node:test';

import * as fixtures from '../../engine/fixtures/routes-catalog-definitions.mjs';
import { FactoryStateAdapter } from '../../../server/src/adapters/factoryState.ts';
import { AuthStore } from '../../../server/src/lib/authStore.ts';
import factoryModule from '../../../server/src/modules/factory/index.ts';
import { RoutesStore } from '../../../server/src/modules/routes/store.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import type { RouteConfig } from '../../../server/src/lib/factoryRouteCli.ts';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const systemdRun = String.raw`#!/bin/bash
set -eu
if [[ "$1" == --version ]]; then exit 0; fi
log=
args=()
while [[ "$1" == --* ]]; do
  case "$1" in
    # Подмена поддерживает transient service фабрики. Запуски DSH сами
    # выберут локальный backend, когда проба transient scope вернёт отказ.
    --scope) exit 1 ;;
    --setenv=*) export "${'$'}{1#--setenv=}" ;;
    --property=StandardOutput=append:*) log="${'$'}{1#--property=StandardOutput=append:}" ;;
  esac
  shift
done
exec </dev/null
( rc=0; "$@" >"$log" 2>&1 || rc=$?; printf 'rc=%s\n' "$rc" >>"$log" ) >/dev/null 2>&1 &
`;

/**
 * Публикует маршрут command → gate в собственном каталоге. Профиль задерживает
 * команду до наблюдения API, чтобы быстрый запуск успел подтвердить свой PID.
 */
export async function prepareCommandServer(
  t: TestContext, root: string, factoryBin: string,
  withAgent = false, withBrowser = false, noResultRetries = 0, withSpeedAgent = false,
) {
  const profile = fixtures.PROFILE_ID;
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, profile);
  const engineHome = path.join(root, 'engine');
  const stateDir = path.join(root, 'state');
  const controlDir = path.join(root, 'control');
  const routesDir = path.join(root, 'routes');
  const checkout = path.join(root, 'repo');
  const unitDir = path.join(root, 'unit-bin');

  for (const dir of [checkout, profileDir, stateDir, controlDir, engineHome, unitDir]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const systemPath = '/usr/bin:/bin';

  execFileSync('git', ['-C', checkout, 'init', '-qb', 'shared-main'], {
    env: { HOME: root, PATH: systemPath },
  });

  const profileScript = String.raw`
PROFILE_NAME=demo-profile
PROFILE_SERVICE_HOST=127.0.0.1
profile_workspace_mode() { printf 'shared\n'; }
profile_repositories() { printf 'app\t%s\t%s\n' "${checkout}" "${checkout}"; }
profile_source_branch() { printf 'shared-main\n'; }
profile_container() { printf 'fixture-stand\n'; }
profile_stand_alive() { return 0; }
profile_project_context() { printf '%s\n' '{"stack":["fixture"],"guardrails":[]}'; }
profile_service_ports() { printf '8830\t8830\n'; }
profile_exclusive_resources() { printf '%s\n' 'stand:fixture-stand' "workspace:${checkout}"; }
profile_instrumentation_restored() { return 0; }
profile_route_command() {
  [[ "$1:$2:$3:$4:$5" == '71:command:verify:VERIFY:fixture-verify' && -r "$6" ]] || return 91
  printf '1\n' >>"${root}/command.count"
  for ((i=0; i<200; i++)); do
    [[ -f "${root}/release-command" ]] && break
    sleep .05
  done
  [[ -f "${root}/release-command" ]] || return 79
  printf '%s\n' '{"schema":1,"outcome":"done","comment":"fixture","failureOwner":null,"findings":[]}'
}
`;

  await fs.writeFile(path.join(profileDir, 'profile.sh'), profileScript);
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{"capabilities":["route-v2"]}');
  await fs.writeFile(path.join(profileDir, 'runners.env'), [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    
    `PROJECT_RUNNER_PRIMARY=${withAgent ? 'deepseek' : 'codex'}`, 'PROJECT_RUNNER_FAILOVER=', '',
  ].join('\n'));
  await fs.writeFile(path.join(unitDir, 'systemd-run'), systemdRun, { mode: 0o700 });

  const systemctl = `#!/bin/bash
if [[ "$2" == stop ]]; then exit 1; fi
if [[ -f "${stateDir}/t71.launch.log" ]] &&
  ! tail -n 1 "${stateDir}/t71.launch.log" | grep -q '^rc='; then
  echo active
else
  echo inactive
  exit 3
fi
`;

  await fs.writeFile(path.join(unitDir, 'systemctl'), systemctl, { mode: 0o700 });

  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;

  t.after(() => {
    if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
    if (oldHome === undefined) { delete process.env.HOME; } else { process.env.HOME = oldHome; }
  });
  process.env.PATH = `${unitDir}:${oldPath}`;
  process.env.HOME = root;

  const rootDir = root;
  const config = {
    rootDir,
    dataHome: path.join(root, 'data'),
    factoryHome: engineHome,
    factoryEngineProtocol: 'go-v1' as const,
    factoryBin,
    factoryControlDir: controlDir,
    factoryConfigRoot: path.join(root, 'config'),
    stateDir,
    routesDir,
    profilesDir,
    factoryProfile: profile,
    ticketsDir: path.join(root, 'tickets'),
    sandboxDownCmd: '',
    modelsPath: path.join(root, 'models.json'),
  };
  const adapter = new FactoryStateAdapter({
    stateDir,
    routesDir,
    profilesDir,
    controlDir,
  });
  const catalog = await publishCommandRoute(
    routesDir, withAgent, withBrowser, noResultRetries, 'skip', withSpeedAgent,
  );
  /**
   * Каждый новый Fastify модуль заново читает профиль и попытку.
   * Каталоги установки остаются теми же после закрытия предыдущего экземпляра.
   */
  const open = async (overrides: Partial<RouteConfig> = {}, auth?: { cliToken: string }) => {
    const app = Fastify({ logger: false });

    if (auth) {
      const authStore = new AuthStore({
        sessionsPath: path.join(root, 'sessions.json'),
        legacyAccountPath: path.join(root, 'account.json'),
      });

      await app.register(authPlugin, {
        authStore,
        internalToken: 'internal',
        cliToken: auth.cliToken,
      });
    }

    await app.register(factoryModule, {
      config: { ...config, ...overrides },
      factoryState: adapter,
      tracker: null,
      prefs: { read: () => ({}) },
      analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
    });
    await app.ready();
    t.after(() => app.close());

    return app;
  };

  return {
    adapter,
    open,
    config,
    catalog,
    checkout,
  };
}

/**
 * Изолирует рабочую копию тестового Codex от профиля shared.
 * Хук публикует только descriptor уже готовой временной копии без сервисов.
 */
export async function prepareIsolatedCommandWorkspace(
  fixture: Awaited<ReturnType<typeof prepareCommandServer>>,
) {
  const root = fixture.config.rootDir;
  const source = path.join(root, 'source');
  const profile = path.join(fixture.config.profilesDir, 'demo-profile');

  execFileSync('git', ['init', '-qb', 'shared-main', source], {
    env: { HOME: root, PATH: '/usr/bin:/bin' },
    timeout: 10_000,
  });
  await fs.appendFile(path.join(profile, 'profile.sh'), `
profile_workspace_mode() { printf 'isolated\\n'; }
profile_stand_mode() { printf 'none\\n'; }
profile_repositories() { printf 'app\\t%s\\t%s\\n' "${source}" "${fixture.checkout}"; }
`);
  await fs.writeFile(path.join(profile, 'up.sh'), `#!/bin/bash
cat >"$STATE_DIR/t$1.env" <<EOF
TASK=$1
WORKSPACE_MODE=isolated
STAND_OWNERSHIP=task
SB_K=0
API_PORT=
FE_PORT=
SOURCE_BRANCH=shared-main
REPO_COUNT=1
REPO_0_NAME=app
REPO_0_SOURCE=${source}
REPO_0_WT=${fixture.checkout}
REPO_0_BRANCH=shared-main
EOF
`, { mode: 0o700 });
}

/**
 * Использует штатного писателя каталога для маршрута с командой и воротами.
 * Воспроизводимость нужна для сравнения с отдельной установкой.
 */
export async function publishCommandRoute(
  routesDir: string, withAgent: boolean, withBrowser = false, noResultRetries = 0,
  bootstrapMode: 'skip' | 'required' = 'skip', withSpeedAgent = false,
) {
  const profile = fixtures.PROFILE_ID;
  const base = fixtures.ROUTE_DEFINITIONS.command.route;
  const verify = structuredClone(base.nodes.find((node) => node.id === 'verify')!);
  const stop = { stop: 'human' };

  verify.on = {
    done: { next: 'gate_accept' },
    skipped: stop,
    failed: stop,
    exhausted: stop,
  };
  Reflect.deleteProperty(verify, 'onFailure');

  const agent = {
    id: 'build',
    runKey: 'BUILD',
    executor: 'agent',
    phase: 'main',
    emits: [],
    policy: {
      filesystem: 'state-only',
      timeoutClass: 'standard',
      budgetClass: 'standard',
      ...(withBrowser ? { browser: 'allow' } : {}),
    },
    prompt: { blocks: [{ file: 'prompts/model.base.md' }], requiredContext: ['task'] },
    retry: { ...verify.retry, noResult: noResultRetries },
    fanout: verify.fanout,
    on: {
      done: { stop: 'done' },
      skipped: stop,
      failed: stop,
      exhausted: stop,
    },
  };
  const gate = {
    id: 'gate_accept',
    executor: 'gate',
    phase: 'main',
    runKey: 'GATE_ACCEPT',
    emits: [],
    on: { approved: withAgent ? { next: 'build' } : { stop: 'done' }, rejected: stop },
  };
  const nodes = withAgent ? [verify, gate, agent] : [verify, gate];

  if (withSpeedAgent) {
    const second = {
      ...agent,
      id: 'validate_speed',
      runKey: 'VALIDATE_SPEED',
    };
    const build = {
      ...agent,
      on: {
        ...agent.on,
        done: { next: second.id },
      },
    };

    nodes.splice(2, 1, build, second);
  }

  const route = {
    ...base,
    bootstrap: bootstrapMode,
    entry: 'verify',
    nodes,
    sequence: { main: nodes.map((node) => node.id), tail: [] },
  };
  const store = new RoutesStore({ baseDir: routesDir });
  const prompts = withAgent ? { 'prompts/model.base.md': 'Подтвердите проверку один раз.' } : {};
  const published = await store.publishRoute(profile, 'command', { route, prompts });
  const scout = structuredClone(fixtures.bootstrap);

  scout.nodes[0]!.on.done.escalate.routes = ['command'];
  scout.escalation[0]!.allowedRoutes = ['command'];

  return store.publishCatalog(profile, {
    catalog: {
      schema: 2,
      profile,
      routes: { command: published.routeHash },
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: scout,
    prompts: fixtures.bootstrapPrompts,
  }, { expectedCatalogHash: null });
}

type Attempt = Awaited<ReturnType<FactoryStateAdapter['readTrustedAttempt']>>;

/**
 * Ждёт подтверждения из доверенного reader-а с коротким пределом пробы.
 * Последний прочитанный курсор указывает, где прервался переход.
 */
export async function expectAttempt(
  adapter: FactoryStateAdapter, ready: (a: Attempt) => boolean, timeoutMs = 4000,
) {
  let last: unknown;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const attempt = await adapter.readTrustedAttempt('71');

      if (ready(attempt)) {
        return attempt;
      }

      last = attempt.cursor;
    } catch (error) {
      last = error;
    }

    await setTimeout(50);
  }

  assert.fail(`Доверенная попытка не дошла до ожидаемого состояния: ${JSON.stringify(last)}`);
}
