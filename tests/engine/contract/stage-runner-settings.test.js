import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyCli, applyCliAsync, applyPayload, cliJson, selection, settingsFixture,
} from '../../helpers/stageRunnerSettingsFixture.mjs';

// К1/К6: варианты принадлежат конкретной модели и подтверждённому раннеру.
test('options-per-model', async (t) => {
  const fx = await settingsFixture(t);
  const before = await readFile(fx.config);
  const options = cliJson(fx.cli('options', ['--provider', 'alpha']));

  assert.deepEqual(options.identity, fx.identity);
  assert.deepEqual(options.models.find((model) => model.id === 'alpha-model').efforts, ['low', 'high']);
  assert.deepEqual(options.models.find((model) => model.id === 'alpha-strong').efforts, ['high', 'max', '']);
  assert.deepEqual(options.models.find((model) => model.id === 'alpha-model').aliases, ['default']);
  assert.equal(typeof options.catalogRevision, 'string');
  assert.ok(options.catalogRevision.length > 0);
  assert.deepEqual(await readFile(fx.config), before);
  assert.deepEqual(await fx.captures(), []);

  await writeFile(fx.config, before.toString()
    .replace('MODEL_DEFAULT_ALPHA_EXACT=alpha-model', 'MODEL_DEFAULT_ALPHA_EXACT=')
    .replace('MODEL_DEFAULT_ALPHA_FAMILY=fixture', 'MODEL_DEFAULT_ALPHA_FAMILY=default'));

  const alias = cliJson(fx.cli('options', ['--provider', 'alpha']));

  assert.equal(alias.effective.model, 'default', 'наследуемый alias остаётся аргументом запуска');
  assert.deepEqual(alias.models.find((model) => model.aliases?.includes('default')).efforts, ['low', 'high']);
});

test('opaque-model-id', async (t) => {
  const fx = await settingsFixture(t);
  const options = cliJson(fx.cli('options', ['--provider', 'gamma']));
  const opaque = '["route","model"]';

  assert.equal(options.models[0].id, opaque);

  const selected = {
    primary: 'gamma',
    parametersFor: 'gamma',
    model: opaque,
    effort: 'off'
  };
  const saved = cliJson(applyCli(fx, applyPayload(options, selected)));

  assert.deepEqual(saved.selection, selected);
  assert.equal(cliJson(fx.cli('show')).effective.model, opaque);
});

test('options-unavailable', async (t) => {
  const fx = await settingsFixture(t);

  fx.env.SETTINGS_METADATA_UNAVAILABLE = '1';

  const result = fx.cli('options', ['--provider', 'alpha']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout} ${result.stderr}`, /unavailable|недоступ/i);
  assert.deepEqual(await fx.captures(), []);
});

// К1/К5: сохранение остановленного/pending этапа атомарно и не запускает процесс.
test('save-atomic-and-scoped', async (t) => {
  const fx = await settingsFixture(t);
  const profile = await readFile(fx.config);
  const options = cliJson(fx.cli('options', ['--provider', 'alpha']));
  const payload = applyPayload(options);
  const saved = cliJson(applyCli(fx, payload));
  const reopened = cliJson(fx.cli('show'));

  assert.deepEqual(saved.selection, payload.selection);
  assert.deepEqual(reopened.selection, payload.selection);
  assert.equal(reopened.revision, options.revision + 1);
  assert.deepEqual(await readFile(fx.config), profile);
  assert.deepEqual(await fx.captures(), []);
  assert.equal((await stat(fx.record)).mode & 0o777, 0o600);
  assert.equal((await stat(`${fx.attemptDir}/runner-settings`)).mode & 0o777, 0o700);

  const neighbor = cliJson(fx.cli('show', [], {
    ...fx.identity,
    node: 'ship',
    stage: 'SHIP'
  }));

  assert.equal(neighbor.selection.model, null);
  assert.equal(neighbor.selection.effort, null);

  const bytes = await readFile(fx.record);

  cliJson(applyCli(fx, payload), 'идемпотентный повтор requestId');
  assert.deepEqual(await readFile(fx.record), bytes);

  const reused = applyCli(fx, { ...payload, selection: selection('alpha-model', 'low') });

  assert.equal(reused.status, 75);
  assert.deepEqual(await readFile(fx.record), bytes);

  const current = cliJson(fx.cli('options', ['--provider', 'alpha']));

  cliJson(applyCli(fx, applyPayload(current, selection('alpha-model', 'high'), 'next', 'newer-save')));

  const newer = await readFile(fx.record);

  assert.equal(applyCli(fx, payload).status, 75, 'старый receipt не переигрывается после новой revision');
  assert.deepEqual(await readFile(fx.record), newer);
});

// К3: второе поле не теряется, а сброшенное читает изменённый временный runners.env.
test('reset-model-and-effort-independently', async (t) => {
  const fx = await settingsFixture(t);

  for (const selected of [selection(null, 'high'), selection('alpha-strong', null), selection(null, null)]) {
    const options = cliJson(fx.cli('options', ['--provider', 'alpha']));

    cliJson(applyCli(fx, applyPayload(options, selected, 'next', `reset-${options.revision}`)));
    assert.deepEqual(cliJson(fx.cli('show')).selection, selected);
  }

  const config = await readFile(fx.config, 'utf8');

  await writeFile(fx.config, config.replace('MODEL_DEFAULT_ALPHA_EFFORT=high',
    'MODEL_DEFAULT_ALPHA_EFFORT=low'));
  assert.equal(cliJson(fx.cli('show')).effective.effort, 'low');
});

// К6: неверная identity и CAS-конфликт не меняют ни байта и не оставляют intent.
test('stale-identity-and-revision', async (t) => {
  const fx = await settingsFixture(t);
  const options = cliJson(fx.cli('options', ['--provider', 'alpha']));

  cliJson(applyCli(fx, applyPayload(options)));

  const current = cliJson(fx.cli('options', ['--provider', 'alpha']));
  const payload = applyPayload(current, selection('alpha-model', 'high'), 'next', 'conflict');
  const bytes = await readFile(fx.record);
  const variants = [
    { identity: { ...fx.identity, task: '82' } },
    { identity: { ...fx.identity, profile: 'other' } },
    { identity: { ...fx.identity, attempt: `a_${'f'.repeat(32)}` } },
    { identity: { ...fx.identity, node: 'ship' } },
    { identity: { ...fx.identity, stage: 'SHIP' } },
    { expectedRevision: current.revision - 1 },
    { expectedRun: { id: 'foreign-run', epoch: 19 } },
    { catalogRevision: 'obsolete-catalog' },
  ];

  for (const variant of variants) {
    const result = applyCli(fx, { ...payload, ...variant });

    assert.equal(result.status, 75, `${JSON.stringify(variant)}: ${result.stderr}`);
    assert.deepEqual(await readFile(fx.record), bytes);
  }

  const writers = await Promise.all([
    applyCliAsync(fx, payload),
    applyCliAsync(fx, { ...payload, requestId: 'second-writer' }),
  ]);

  assert.deepEqual(writers.map((writer) => writer.status).sort((a, b) => a - b), [0, 75]);
});

test('bad-pair-no-write', async (t) => {
  const fx = await settingsFixture(t);
  const options = cliJson(fx.cli('options', ['--provider', 'alpha']));

  cliJson(applyCli(fx, applyPayload(options)));

  const bytes = await readFile(fx.record);
  const current = cliJson(fx.cli('options', ['--provider', 'alpha']));

  for (const selected of [
    selection('missing', 'high'), selection('alpha-model', 'max'),
    { ...selection(), parametersFor: 'beta' },
    {
      ...selection(),
      primary: 'missing',
      parametersFor: 'missing'
    },
  ]) {
    const result = applyCli(fx, applyPayload(current, selected, 'next', 'bad-pair'));

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(`${result.stdout} ${result.stderr}`,
      /model|effort|provider|parametersFor|модел|уров|исполн/i);
    assert.deepEqual(await readFile(fx.record), bytes);
    assert.deepEqual(await fx.captures(), []);
  }
});
