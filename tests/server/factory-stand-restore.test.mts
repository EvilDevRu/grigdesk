// Подъём стенда задачи перед продолжением попытки. Живой случай 20.10.2026: после
// перезагрузки машины процессы стендов пропали, «Продолжить» отвечало успехом, а движок
// через 13 секунд выходил кодом 73 («среда профиля не готова») — и так у трёх задач подряд.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { restoreTaskStand } from '../../server/src/lib/factoryStandRestore.ts';
import type {
  StandRestoreRequest,
  StandRestoreResult,
} from '../../server/src/lib/factoryStandRestore.ts';

type StartBehaviour = 'up' | 'fail' | 'silent' | 'slow';

interface FixtureOptions {
  start?: StartBehaviour;
  alive?: boolean;
  hooks?: boolean;
}

/**
 * Профиль-заглушка: стенд «жив», пока есть файл $STATE_DIR/stand-<задача>.up.
 * Хук подъёма создаёт его (или ведёт себя по `start`) и отмечает каждый свой вызов,
 * чтобы тест видел, звали ли подъём вообще и с каким STATE_DIR.
 */
async function fixture(t: TestContext, { start = 'up', alive = true, hooks = true }: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-stand-restore-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, 'profiles');
  const stateDir = path.join(root, 'state');
  const startBodies: Record<StartBehaviour, string> = {
    up: 'touch "$STATE_DIR/stand-$1.up"',
    fail: 'echo "ОШИБКА: порт 8150 занят" >&2; return 7',
    silent: ':',
    slow: 'sleep 5',
  };

  await mkdir(path.join(profilesDir, 'demo'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(profilesDir, 'demo', 'profile.sh'), hooks ? `
profile_stand_alive() { ${alive ? '[[ -f "$STATE_DIR/stand-$1.up" ]]' : 'return 73'}; }
profile_stand_start() {
  printf '%s\\n' "$STATE_DIR" >> "$STATE_DIR/start.calls"
  ${startBodies[start]}
}
` : 'profile_stand_alive() { return 0; }\n');

  return {
    stateDir,
    config: {
      profilesDir,
      factoryHome: root,
      stateDir,
    },
    startCalls: path.join(stateDir, 'start.calls'),
  };
}

/**
 * Причина отказа подъёма. Успешный итог здесь — ошибка теста; сужение типа даёт
 * проверить текст без приведения.
 */
function failureOf(result: StandRestoreResult): string {
  if (result.ok) {
    throw new assert.AssertionError({ message: `ожидался отказ подъёма, получено ${result.outcome}` });
  }

  return result.message;
}

const TASK_STAND: StandRestoreRequest = {
  profile: 'demo',
  task: '42',
  standOwnership: 'task',
};

test('живой стенд не перезапускается', async (t) => {
  const fx = await fixture(t);

  await writeFile(path.join(fx.stateDir, 'stand-42.up'), '');

  const result = await restoreTaskStand(fx.config, TASK_STAND);

  assert.deepEqual(result, { ok: true, outcome: 'alive' });
  assert.equal(existsSync(fx.startCalls), false, 'хук подъёма не вызывался');
});

test('мёртвый стенд поднимается хуком профиля с STATE_DIR сервера', async (t) => {
  const fx = await fixture(t);

  const result = await restoreTaskStand(fx.config, TASK_STAND);

  assert.deepEqual(result, { ok: true, outcome: 'started' });
  assert.equal((await readFile(fx.startCalls, 'utf8')).trim(), fx.stateDir);
});

test('общий стенд GrigDesk не проверяет и не запускает', async (t) => {
  const fx = await fixture(t);

  const result = await restoreTaskStand(fx.config, { ...TASK_STAND, standOwnership: 'external' });

  assert.deepEqual(result, { ok: true, outcome: 'skipped' });
  assert.equal(existsSync(fx.startCalls), false);
});

test('профиль без хука подъёма — решение остаётся за движком', async (t) => {
  const fx = await fixture(t, { hooks: false });

  assert.deepEqual(await restoreTaskStand(fx.config, TASK_STAND), { ok: true, outcome: 'skipped' });
});

test('нечитаемый профиль — тоже skipped: диагностику даст сам движок', async (t) => {
  const fx = await fixture(t);
  const config = { ...fx.config, profilesDir: path.join(fx.stateDir, 'нет-такого') };

  assert.deepEqual(await restoreTaskStand(config, TASK_STAND), { ok: true, outcome: 'skipped' });
});

test('отказ хука подъёма возвращает причину с выводом профиля', async (t) => {
  const fx = await fixture(t, { start: 'fail' });

  const result = await restoreTaskStand(fx.config, TASK_STAND);

  const message = failureOf(result);

  assert.match(message, /^стенд задачи не поднялся: хук подъёма профиля завершился с ошибкой/);
  assert.match(message, /порт 8150 занят/);
});

test('хук отработал, а стенд молчит — отказ, а не запуск движка вслепую', async (t) => {
  const fx = await fixture(t, { start: 'silent', alive: false });

  const result = await restoreTaskStand(fx.config, TASK_STAND);

  assert.match(failureOf(result), /после подъёма стенд не отвечает/);
});

// Срок обязан гасить и потомков хука: оставшийся `sleep` с открытым stderr держал бы
// ответ «Продолжить» до своего конца, а с ним и допуск мутаций задачи.
test('зависший подъём обрывается по сроку вместе с потомками', async (t) => {
  const fx = await fixture(t, { start: 'slow' });
  const startedAt = Date.now();

  const result = await restoreTaskStand(fx.config, { ...TASK_STAND, timeoutMs: 500 });

  assert.match(failureOf(result), /подъём не уложился в 1 с/);
  assert.ok(Date.now() - startedAt < 4000, 'ответ не ждёт завершения sleep 5');
});

test('неверный профиль или номер задачи не доходят до bash', async (t) => {
  const fx = await fixture(t);

  const badProfile = await restoreTaskStand(fx.config, { ...TASK_STAND, profile: '../demo' });
  const badTask = await restoreTaskStand(fx.config, { ...TASK_STAND, task: '42; rm -rf /' });

  assert.equal(badProfile.ok, false);
  assert.equal(badTask.ok, false);
  assert.equal(existsSync(fx.startCalls), false);
});
