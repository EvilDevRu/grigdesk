// Подготовка демо-данных: единственное место раздела, которое пишет в данные стенда.
//
// Здесь проверяются не удобства, а запреты. Каждый тест отвечает на вопрос «может ли
// эта кнопка тронуть то, что трогать нельзя»: прод, общий стенд, стенд конвейера,
// стенд с неизвестным владельцем, чужой рецепт. И отдельно — что оборванный прогон
// не повторяется сам.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSeedDecision,
  readDataRevision,
  runSeed,
  seedAvailability,
} from '../../server/src/lib/showcase/seed.ts';

const SEED_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
echo "готовим данные стенда \${SHOWCASE_TASK}"
echo "SHOWCASE_DATA_REVISION=demo-\${SHOWCASE_TASK}"
`;

async function fixture(t, { script = SEED_SCRIPT } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-seed-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const contractDir = path.join(root, 'showcase');

  await mkdir(contractDir, { recursive: true });

  if (script !== null) {
    const file = path.join(contractDir, 'seed.sh');

    await writeFile(file, script, 'utf8');
    await chmod(file, 0o755);
  }

  return { root, contractDir };
}

function scopeFixture(overrides = {}) {
  return {
    ref: { kind: 'sandbox', id: '990001' },
    profile: 'demo-profile',
    targetLabel: 'стенд 990001',
    environment: 'isolated-demo',
    recordUrl: 'http://127.0.0.1:5192',
    viewUrl: 'http://127.0.0.1:5192',
    allowedOrigins: ['http://127.0.0.1:5192'],
    capabilities: ['record', 'seed'],
    screens: [],
    login: null,
    sandbox: {
      task: '990001',
      slot: 1,
      fePort: 5192,
      apiPort: 8092,
      workspaceMode: 'isolated',
      standOwnership: 'task',
      repos: [],
      pipeline: false,
      updatedAt: null,
    },
    targetFingerprint: 'target-1',
    policyRevision: 'policy-1',
    dataRevision: 'начальные',
    buildRevision: null,
    ...overrides,
  };
}

test('на подготовленной демо-копии хук доступен и объявляет рецепт', async (t) => {
  const { contractDir } = await fixture(t);
  const availability = await seedAvailability(scopeFixture(), contractDir);

  assert.equal(availability.available, true);
  assert.ok(availability.recipeFingerprint, 'у рецепта обязан быть отпечаток');
});

test('на прод-подобной цели «только чтение» подготовка запрещена', async (t) => {
  const { contractDir } = await fixture(t);
  const availability = await seedAvailability(
    scopeFixture({ environment: 'read-only' }),
    contractDir,
  );

  assert.equal(availability.available, false);
  assert.match(availability.reason, /изолированной демо-копии/);
});

test('стенд конвейера разделу не принадлежит', async (t) => {
  const { contractDir } = await fixture(t);
  const scope = scopeFixture();
  const availability = await seedAvailability(
    { ...scope, sandbox: { ...scope.sandbox, pipeline: true } },
    contractDir,
  );

  assert.equal(availability.available, false);
  assert.match(availability.reason, /конвейера/);
});

test('общий рабочий стенд закрыт: подготовка затронула бы чужое', async (t) => {
  const { contractDir } = await fixture(t);
  const scope = scopeFixture();
  const availability = await seedAvailability(
    { ...scope, sandbox: { ...scope.sandbox, workspaceMode: 'shared' } },
    contractDir,
  );

  assert.equal(availability.available, false);
  assert.match(availability.reason, /общем рабочем дереве/);
});

test('неизвестный владелец стенда закрывает подготовку', async (t) => {
  const { contractDir } = await fixture(t);
  const scope = scopeFixture();

  for (const ownership of ['', 'shared', 'external']) {
    const availability = await seedAvailability(
      { ...scope, sandbox: { ...scope.sandbox, standOwnership: ownership } },
      contractDir,
    );

    assert.equal(availability.available, false, ownership || 'пусто');
    assert.match(availability.reason, /Владелец стенда/);
  }
});

test('цель «проект» демо-копией не считается', async (t) => {
  const { contractDir } = await fixture(t);
  const availability = await seedAvailability(
    scopeFixture({ ref: { kind: 'project', id: 'demo-profile' } }),
    contractDir,
  );

  assert.equal(availability.available, false);
  assert.match(availability.reason, /не демо-копия/);
});

test('без объявления возможности профилем хук недоступен', async (t) => {
  const { contractDir } = await fixture(t);
  const availability = await seedAvailability(
    scopeFixture({ capabilities: ['record'] }),
    contractDir,
  );

  assert.equal(availability.available, false);
  assert.match(availability.reason, /не объявил подготовку/);
});

test('без самого скрипта хук недоступен', async (t) => {
  const { contractDir } = await fixture(t, { script: null });
  const availability = await seedAvailability(scopeFixture(), contractDir);

  assert.equal(availability.available, false);
  assert.match(availability.reason, /seed\.sh/);
});

test('правка скрипта делает прежнее решение недействительным', async (t) => {
  const { contractDir } = await fixture(t);
  const scope = scopeFixture();
  const before = await seedAvailability(scope, contractDir);
  const decision = createSeedDecision(before.recipeFingerprint);

  await writeFile(path.join(contractDir, 'seed.sh'), `${SEED_SCRIPT}\necho "и ещё шаг"\n`, 'utf8');

  const after = await seedAvailability(scope, contractDir);

  assert.notEqual(after.recipeFingerprint, before.recipeFingerprint);

  await assert.rejects(
    () => runSeed({
      scope,
      availability: after,
      decision,
      workDir: path.join(contractDir, 'work'),
    }),
    (error) => error.code === 'seed_decision_stale',
  );
});

test('смена стенда тоже отменяет решение', async (t) => {
  const { contractDir } = await fixture(t);
  const scope = scopeFixture();
  const availability = await seedAvailability(scope, contractDir);
  const decision = createSeedDecision(availability.recipeFingerprint);
  const moved = { ...scope, targetFingerprint: 'target-2' };
  const movedAvailability = await seedAvailability(moved, contractDir);

  await assert.rejects(
    () => runSeed({
      scope: moved,
      availability: movedAvailability,
      decision,
      workDir: path.join(contractDir, 'work'),
    }),
    (error) => error.code === 'seed_decision_stale',
  );
});

test('успешный хук объявляет новую ревизию данных', async (t) => {
  const { contractDir } = await fixture(t);
  const scope = scopeFixture();
  const availability = await seedAvailability(scope, contractDir);
  const outcome = await runSeed({
    scope,
    availability,
    decision: createSeedDecision(availability.recipeFingerprint),
    workDir: path.join(contractDir, 'work'),
  });

  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.dataRevision, 'demo-990001');
  assert.match(outcome.log, /готовим данные стенда 990001/);
});

test('хук получает короткое окружение без ключей сервера', async (t) => {
  const { contractDir } = await fixture(t, {
    script: `#!/usr/bin/env bash
set -euo pipefail
env | sort
`,
  });
  const scope = scopeFixture();
  const availability = await seedAvailability(scope, contractDir);

  process.env.SHOWCASE_TEST_SECRET = 'секрет-который-не-должен-уехать';

  t.after(() => {
    delete process.env.SHOWCASE_TEST_SECRET;
  });

  const outcome = await runSeed({
    scope,
    availability,
    decision: createSeedDecision(availability.recipeFingerprint),
    workDir: path.join(contractDir, 'work'),
  });

  assert.equal(outcome.state, 'succeeded');
  assert.ok(
    !outcome.log.includes('SHOWCASE_TEST_SECRET'),
    'окружение сервера хуку не наследуется',
  );
  assert.match(outcome.log, /SHOWCASE_TASK=990001/);
});

test('оборванный по сроку хук даёт неизвестный исход и не повторяется сам', async (t) => {
  const { contractDir } = await fixture(t, {
    script: `#!/usr/bin/env bash
set -euo pipefail
echo "начали"
sleep 30
`,
  });
  const scope = scopeFixture();
  const availability = await seedAvailability(scope, contractDir);
  const outcome = await runSeed({
    scope,
    availability,
    decision: createSeedDecision(availability.recipeFingerprint),
    workDir: path.join(contractDir, 'work'),
    deadlineMs: 800,
  });

  assert.equal(outcome.state, 'outcome_unknown');
  assert.match(outcome.reason, /повтор остаётся за человеком/);
  assert.equal(outcome.dataRevision, null, 'неизвестный исход не объявляет данные готовыми');
});

test('упавший хук — отказ, а не неизвестный исход', async (t) => {
  const { contractDir } = await fixture(t, {
    script: `#!/usr/bin/env bash
echo "ломаемся" >&2
exit 3
`,
  });
  const scope = scopeFixture();
  const availability = await seedAvailability(scope, contractDir);
  const outcome = await runSeed({
    scope,
    availability,
    decision: createSeedDecision(availability.recipeFingerprint),
    workDir: path.join(contractDir, 'work'),
  });

  assert.equal(outcome.state, 'failed');
  assert.match(outcome.log, /ломаемся/);
});

test('журнал прогона сохраняется рядом с попыткой', async (t) => {
  const { contractDir } = await fixture(t);
  const scope = scopeFixture();
  const availability = await seedAvailability(scope, contractDir);
  const workDir = path.join(contractDir, 'work');

  await runSeed({
    scope,
    availability,
    decision: createSeedDecision(availability.recipeFingerprint),
    workDir,
  });

  const log = await readFile(path.join(workDir, 'seed.log'), 'utf8');

  assert.match(log, /готовим данные стенда/);
});

test('ревизия данных читается только из объявленной строки', () => {
  assert.equal(readDataRevision('SHOWCASE_DATA_REVISION=demo-1\n'), 'demo-1');
  assert.equal(readDataRevision('что-то ещё\nSHOWCASE_DATA_REVISION=demo-2\nконец\n'), 'demo-2');
  assert.equal(readDataRevision('данные обновлены'), null);
});
