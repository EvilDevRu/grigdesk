import assert from 'node:assert/strict';
import {
  execFile
} from 'node:child_process';
import {
  createServer
} from 'node:http';
import {
  promises as fs
} from 'node:fs';
import path from 'node:path';
import {
  fileURLToPath
} from 'node:url';
import {
  promisify
} from 'node:util';

import {
  makeGigaCodeFixture
} from './fixture.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LAUNCH = path.join(ROOT, 'tests/helpers/gigacode/launch.sh');

/**
 * Guard снимается только в отдельном очищенном child env после проверки fake realpath.
 * Реальные runner, bridge, launcher и status consumer работают без подмены factory_exec.
 */
export async function launch(t, scenario, extraEnv = {}, { onObserve } = {}) {
  await fs.access(path.join(ROOT, 'engine/lib/runners/gigacode.sh'));
  await fs.access(path.join(ROOT, 'server/scripts/gigacodeRunner.mts'));

  const fixture = await makeGigaCodeFixture(t, scenario);
  const fake = await fs.realpath(fixture.config.gigacodeBin);

  assert.equal(fake, path.join(fixture.root, 'cli', 'gigacode'));
  assert.equal(await fs.realpath(LAUNCH), LAUNCH);

  const state = path.join(scenario.nestedState ? fixture.workspace : fixture.root, 'state');
  const captureFile = path.join(state, 'reports/t42/requests.jsonl');
  const original = JSON.parse(await fs.readFile(fixture.scenarioFile, 'utf8'));

  await fs.writeFile(fixture.scenarioFile, JSON.stringify({
    ...original,
    captureFile,
    captureCwd: fixture.workspace,
  }));

  const marker = `giga-stubborn-${path.basename(fixture.root)}`;

  if (scenario.stubbornChild) {
    const data = JSON.parse(await fs.readFile(fixture.scenarioFile, 'utf8'));

    await fs.writeFile(fixture.scenarioFile, JSON.stringify({
      ...data,
      spawnSleepMarker: marker,
      leaveChildOnCancel: true,
    }));
  }
  if (scenario.filesystemProbe) {
    const source = path.join(fixture.workspace, 'canary.txt');
    const data = JSON.parse(await fs.readFile(fixture.scenarioFile, 'utf8'));

    await fs.writeFile(source, 'unchanged');
    await fs.writeFile(fixture.scenarioFile, JSON.stringify({
      ...data,
      filesystemOperations: [{
          path: source,
          content: 'overwritten'
        },
        {
          path: path.join(state, 'reports/t42/allowed.txt'),
          content: 'report'
        },
      ],
    }));
  }

  const observed = [];
  const observer = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) {
      body += chunk;
    }

    const entry = JSON.parse(body);

    observed.push(entry);
    onObserve?.(entry);
    response.end('ok');
  });

  await new Promise((resolve) => observer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => observer.close(resolve)));
  await fs.writeFile(fixture.scenarioFile, JSON.stringify({
    ...JSON.parse(await fs.readFile(fixture.scenarioFile, 'utf8')),
    observeUrl: `http://127.0.0.1:${observer.address().port}`,
  }));

  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: fixture.root,
    LANG: 'C.UTF-8',
    NODE_BIN: process.execPath,
    GRIGDESK_GIGACODE_NODE_BIN: process.execPath,
    FACTORY_HOME: path.join(ROOT, 'engine'),
    FACTORY_STATE: state,
    STATE_DIR: state,
    FACTORY_CONTROL_ROOT: path.join(fixture.root, 'control'),
    FACTORY_CONFIG_ROOT: path.join(fixture.root, 'config'),
    FACTORY_PROFILES_DIR: path.join(fixture.root, 'profiles'),
    FACTORY_RUNNERS_DIR: path.join(fixture.root, 'runners'),
    GIGA_TEST_PEER_COUNT: path.join(fixture.root, 'peer-count'),
    GRIGDESK_GIGACODE_BIN: fake,
    GRIGDESK_GIGACODE_HOME: fixture.config.gigacodeHome,
    GRIGDESK_GIGACODE_RUNTIME_HOME: fixture.config.gigacodeRuntimeHome,
    GRIGDESK_GIGACODE_BWRAP_BIN: '/usr/bin/bwrap',
    FACTORY_ROUTE_FILESYSTEM_POLICY: 'state-only',
    FACTORY_RUNNER_VERSION: scenario.cliVersion || '26.7.33',
    FACTORY_FORBID_LIVE: '0',
    ...extraEnv,
  };

  await fs.mkdir(state);

  let result;

  try {
    const driver = extraEnv.GIGA_TEST_DISPATCH === '1' ?
      path.join(ROOT, 'tests/helpers/gigacode/dispatch.sh') : LAUNCH;

    result = await exec('/bin/bash', [driver], {
      cwd: fixture.workspace,
      env,
      timeout: 20000
    });
  } catch (error) {
    result = error;
  }

  const runDir = /^RUN_DIR=(.+)$/mu.exec(result.stdout || '')?.[1] ||
    path.join(state, 'logs/runs/t42/CHECK/synthetic-run');
  const events = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8').catch(() => '');
  const meta = await fs.readFile(path.join(runDir, 'meta.env'), 'utf8').catch(() => '');
  const last = await fs.readFile(path.join(runDir, 'last.md'), 'utf8').catch(() => '');
  const requests = (await fs.readFile(captureFile, 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  const encoded = /^VERDICT_B64=(.*)$/mu.exec(result.stdout || '')?.[1];
  const verdict = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : null;
  const peerCalls = (await fs.readFile(env.GIGA_TEST_PEER_COUNT, 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).length;

  const remainingDescendants = scenario.stubbornChild ?
    await exec('/usr/bin/pgrep', ['-f', `^${marker}( |$)`])
    .then((value) => value.stdout.trim().split('\n').map(Number), () => []) :
    [];

  t.after(() => {
    for (const pid of remainingDescendants) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Только собственные marker-PID. */ }
    }
  });

  if (scenario.stubbornChild) {
    assert.equal(observed.filter((entry) => entry.kind === 'spawned').length, 1);
    assert.deepEqual(remainingDescendants, []);
  }

  return {
    ...fixture,
    result,
    runDir,
    events,
    meta,
    last,
    requests,
    observed,
    verdict,
    peerCalls,
    remainingDescendants
  };
}
