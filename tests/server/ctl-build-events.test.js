import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  fixture, expectedBuildCalls, expectedAllPhases, assertInterleavedPhases,
} from './helpers/ctlBuildFixture.js';

const server = ['server.node', 'server.build', 'server.install'];
const web = ['web.dependencies', 'web.build'];
const window = ['window.package', 'window.install'];
const tasks = ['tracker.deps', 'tracker.build', 'pipeline.build', 'routes.deps', 'routes.build'];
const voice = ['voice.deps', 'voice.build'];

/**
 * Общие зависимости и установка окружают четыре независимые цепочки.
 * Внутри каждой start/end строго упорядочены; между цепочками порядок не задан.
 */
function assertAllEvents(actual) {
  const events = (steps) => steps.flatMap((id) => [`start\t${id}`, `end\t${id}\t0`]);
  const before = events(['web.dependencies']);
  const after = events(['window.install']);
  const tracks = [server, ['web.build', 'window.package'], tasks, voice].map(events);

  assert.deepEqual(actual.slice(0, before.length), before);
  assert.deepEqual(actual.slice(-after.length), after);
  assert.deepEqual([...actual].sort(), [...before, ...tracks.flat(), ...after].sort());

  for (const track of tracks) {
    assert.deepEqual(actual.filter((event) => track.includes(event)), track);
  }
}

/**
 * FD 3 отделён от пользовательского вывода и захватывается с момента spawn.
 * Ребёнок запускает прежнюю оболочку только на изолированных командах фикстуры.
 */
function observedBuild(box, target, observed = true) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(box.root, 'bin/grigdesk-ctl'), 'build', target], {
      cwd: '/',
      env: {
        ...box.env,
        ...(observed ? { GRIGDESK_CTL_BUILD_OBSERVED: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const output = {
      stdout: '',
      stderr: '',
      events: '',
    };

    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr'],
      [child.stdio[3], 'events']]) {
      stream.on('data', (chunk) => {
        output[key] += chunk.toString();
      });
    }

    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);

    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ ...output, code });
    });
  });
}

for (const [target, steps] of [
  ['all', [...server, ...web, ...window]],
  ['server', server],
  ['web', web],
  ['window', [...web, ...window]],
  ['apk', ['apk.build']],
]) {
  test(`BE-STEPS: ${target}, реальные границы fd 3 и прежний argv`, async (t) => {
    const box = await fixture(t);
    const result = await observedBuild(box, target);
    const expected = steps.flatMap((id) => [`start\t${id}`, `end\t${id}\t0`]);
    const actual = result.events.trim().split('\n').filter((line) => !line.startsWith('hint\t'));

    assert.equal(result.code, 0, result.stderr);

    if (target === 'all') {
      assertInterleavedPhases(await box.calls(), expectedAllPhases(box));
      assertAllEvents(actual);
    } else {
      assert.deepEqual(await box.calls(), expectedBuildCalls(box, target));
      assert.deepEqual(actual, expected, 'Нет событий фактических шагов сборки на fd 3');
    }

    assert.doesNotMatch(result.stdout + result.stderr, /start\t|end\t|hint\t/u);

    if (steps.includes('server.install')) {
      assert.match(result.events, target === 'all' ? /hint\tqueued-server\n/u : /hint\tselect-server\n/u);
    }
  });
}

test('BE-STEPS: отказ APK завершает свою стадию исходным кодом', async (t) => {
  const box = await fixture(t);

  await box.fail('mobile', 'build', 29);

  const result = await observedBuild(box, 'apk');

  assert.equal(result.code, 29, result.stderr);
  assert.equal(result.events, 'start\tapk.build\nend\tapk.build\t29\n');
  assert.deepEqual(await box.calls(), expectedBuildCalls(box, 'apk'));
});

for (const [stage, command, argument, code, count] of [
  ['server.node', null, null, 1, 1],
  ['server.build', 'npm', 'build:binary', 21, 2],
  ['server.install', 'npm', 'install:binary', 22, 3],
  ['web.dependencies', 'npm', 'install', 26, 1],
  ['web.build', 'npm', 'build', 23, 3],
  ['window.package', 'npm', 'dist', 24, 4],
  ['window.install', 'desktop', 'install', 25, 5],
]) {
  test(`BE-STEPS: отказ ${stage}, end с кодом и без будущих фаз`, async (t) => {
    const box = await fixture(t);

    if (stage === 'server.node') {
      await fs.writeFile(path.join(box.root, 'server/build/node-runtime.json'), '{}');
    } else {
      await box.fail(command, argument, code);
    }

    if (stage === 'web.dependencies') {
      await fs.rm(path.join(box.root, 'server/node_modules'), { recursive: true });
    }

    const target = stage.startsWith('server.') ? 'server' : 'window';
    const result = await observedBuild(box, target);
    const steps = target === 'server' ? server : [...web, ...window];
    const index = steps.indexOf(stage);
    const expected = steps.slice(0, index).flatMap((id) => [`start\t${id}`, `end\t${id}\t0`]);

    expected.push(`start\t${stage}`, `end\t${stage}\t${code}`);
    assert.equal(result.code, code, result.stderr);

    const commands = await box.calls();

    assert.equal(commands.length, count);
    assert.deepEqual(result.events.trim().split('\n').filter((line) => !line.startsWith('hint\t')),
      expected, 'Нет end отказавшей фазы или начались последующие шаги');
  });
}

test('BE-STEPS барьер: открытого fd 3 без observed-маркера недостаточно', async (t) => {
  const box = await fixture(t);
  const result = await observedBuild(box, 'all', false);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.events, '');
  assertInterleavedPhases(await box.calls(), expectedAllPhases(box));
});
