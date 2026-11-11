import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyCli, applyPayload, cliJson, selection, settingsFixture, waitFor,
} from '../../helpers/stageRunnerSettingsFixture.mjs';

// Новый барьер К1/К7: без sidecar реальный launcher сохраняет старые argv/defaults.
test('next-launch-without-override-barrier', async (t) => {
  const fx = await settingsFixture(t);
  const result = await fx.start().finished;

  assert.equal(result.status, 0, result.output);

  const [capture] = await fx.captures();

  assert.equal(capture.provider, 'alpha');
  assert.equal(capture.model, 'alpha-model');
  assert.equal(capture.effort, 'high');
});

test('next-launch-exact-pair', async (t) => {
  const fx = await settingsFixture(t);
  const before = await readFile(fx.config);

  await fx.seed(selection());

  const result = fx.shell('run_agent 81 fixture PLAN');

  assert.equal(result.status, 0, result.stderr);

  const [capture] = await fx.captures();

  assert.equal(capture.model, 'alpha-strong', 'resolver обязан применить exact model локального node');
  assert.equal(capture.effort, 'max');
  assert.deepEqual(await readFile(fx.config), before);

  const meta = await readFile(`${fx.env.STATE_DIR}/logs/runs/t81/PLAN/${capture.id}/meta.env`, 'utf8');

  assert.match(meta, /^MODEL=alpha-strong$/m);
  assert.match(meta, /^EFFORT=max$/m);

  await fx.seed(selection('alpha-strong', ''), 2);

  const noEffort = fx.shell('run_agent 81 fixture PLAN');

  assert.equal(noEffort.status, 0, noEffort.stderr);
  assert.equal((await fx.captures()).at(-1).effort, '', 'явная пустота не становится high');

  await fx.seed(selection(null, null), 3);
  await writeFile(fx.config, before.toString()
    .replace('MODEL_DEFAULT_ALPHA_EXACT=alpha-model', 'MODEL_DEFAULT_ALPHA_EXACT=alpha-strong')
    .replace('MODEL_DEFAULT_ALPHA_EFFORT=high', 'MODEL_DEFAULT_ALPHA_EFFORT=max'));

  const inherited = fx.shell('run_agent 81 fixture PLAN');

  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal((await fx.captures()).at(-1).model, 'alpha-strong');
  assert.equal((await fx.captures()).at(-1).effort, 'max');
});

test('active-save-is-future', async (t) => {
  const fx = await settingsFixture(t);
  const active = fx.start({ FAKE_ALPHA_RESULT: 'wait' });
  const first = await waitFor(async () => (await fx.captures())[0], 'первый provider получил argv');
  const metaPath = `${fx.env.STATE_DIR}/logs/runs/t81/PLAN/${first.id}/meta.env`;

  await waitFor(() => readFile(metaPath, 'utf8').catch(() => null), 'meta первой попытки');

  const oldMeta = await readFile(metaPath);
  const options = cliJson(fx.cli('options', ['--provider', 'alpha']));

  cliJson(applyCli(fx, applyPayload(options)));
  assert.equal(active.child.exitCode, null, 'next не останавливает живой run_agent');
  assert.equal((await fx.captures()).length, 1);
  assert.deepEqual(await readFile(metaPath), oldMeta);
  assert.deepEqual(cliJson(fx.cli('show')).selection, selection());
});

test('node-and-attempt-isolation', async (t) => {
  const fx = await settingsFixture(t);

  await fx.seed(selection());

  const peer = fx.shell('run_agent 81 fixture SHIP', {
    FACTORY_LIFECYCLE_NODE_ID: 'ship', FACTORY_LIFECYCLE_RUN_KEY: 'SHIP',
  });

  assert.equal(peer.status, 0, peer.stderr);
  assert.equal((await fx.captures())[0].model, 'alpha-model', 'соседний trusted node не получает pin');

  const other = fx.shell('pipeline_store_route_init 82 PLAN PROFILE demo-profile\nrun_agent 82 fixture PLAN');

  assert.equal(other.status, 0, other.stderr);
  assert.equal((await fx.captures())[1].model, 'alpha-model', 'другая задача не получает pin');

  const revisit = fx.shell('run_agent 81 fixture PLAN');

  assert.equal(revisit.status, 0, revisit.stderr);
  assert.equal((await fx.captures())[2].model, 'alpha-strong', 'повторный визит своего node получает pin');

  const replaced = fx.shell([
    'source "$FACTORY_HOME/lib/attempt-state.sh"',
    `attempt_state_abandon_v2 81 ${fx.identity.attempt} fixture >/dev/null`,
    'new_attempt=$(attempt_state_begin_v2 81 demo-profile "$TEST_ROOT/routes") || exit $?',
    'attempt_state_select_route_v2 81 "$new_attempt" feature >/dev/null || exit $?',
    'export FACTORY_LIFECYCLE_ATTEMPT_ID="$new_attempt"',
    'pipeline_store_update 81 ATTEMPT_ID "$new_attempt"',
    'run_agent 81 fixture PLAN',
  ].join('\n'));

  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal((await fx.captures())[3].model, 'alpha-model', 'новая attempt не копирует sidecar');
});

test('reserve-keeps-own-policy', async (t) => {
  for (const effort of ['max', null]) {
    await t.test(`основной effort ${effort ?? 'из профиля'}`, async (sub) => {
      const fx = await settingsFixture(sub);

      await fx.seed(selection('alpha-strong', effort));

      const result = fx.shell('run_agent 81 fixture PLAN', { FAKE_ALPHA_RESULT: 'limited' });

      assert.equal(result.status, 0, result.stderr);

      const captures = await fx.captures();

      assert.deepEqual(captures.map(({ provider, model, effort }) => ({
        provider,
        model,
        effort,
      })), [
        {
          provider: 'alpha',
          model: 'alpha-strong',
          effort: effort ?? 'high'
        },
        {
          provider: 'beta',
          model: 'beta-model',
          effort: 'high'
        },
      ]);
    });
  }
});

test('local-primary-keeps-human-breaker-bypass', async (t) => {
  const variants = [
    {
      primary: 'alpha',
      result: 'done',
      expected: ['alpha'],
    },
    {
      primary: 'alpha',
      result: 'limited',
      expected: ['alpha', 'beta'],
    },
    {
      primary: null,
      result: 'done',
      expected: ['beta'],
    },
  ];

  for (const variant of variants) {
    await t.test(`${variant.primary ?? 'policy'} / ${variant.result}`, async (sub) => {
      const fx = await settingsFixture(sub);
      const options = cliJson(fx.cli('options', ['--provider', 'alpha']));
      const selected = selection('alpha-model', 'high', variant.primary);

      cliJson(applyCli(fx, applyPayload(options, selected)));

      const result = fx.shell([
        'fingerprint=$(printf "alpha|default" | sha256sum | cut -c1-24)',
        'breaker_record alpha "$fingerprint" provider "" "" "$(date +%s)" "" fixture',
        'run_agent 81 fixture PLAN',
      ].join('\n'), { FAKE_ALPHA_RESULT: variant.result });

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual((await fx.captures()).map((capture) => capture.provider), variant.expected);
    });
  }
});

test('invalid-on-launch', async (t) => {
  const fx = await settingsFixture(t);

  for (const invalid of [selection('missing', 'high'), selection('alpha-model', 'max')]) {
    await fx.seed(invalid);

    const before = await fx.captures();
    const result = fx.shell('run_agent 81 fixture PLAN');

    assert.notEqual(result.status, 0, 'неподдерживаемая сохранённая пара должна быть отклонена');
    assert.deepEqual(await fx.captures(), before, 'ни основной, ни резервный provider не вызван');
    assert.match(`${result.stdout} ${result.stderr}`, /invalid_config|модел|effort|model/i);
  }
});

// К6: подмена входа ровно между resolver и admission выявляется CAS, без старого argv.
test('admission-race', async (t) => {
  const fx = await settingsFixture(t);

  for (const selected of [selection(), selection('alpha-model', 'low'), {
    primary: 'beta',
    parametersFor: 'beta',
    model: 'beta-model',
    effort: 'high',
  }]) {
    await fx.seed(selection('alpha-model', 'high'), 1);
    await writeFile(`${fx.root}/replacement.json`, JSON.stringify({
      schema: 1,
      identity: fx.identity,
      revision: 2,
      selection: selected,
      failover: selected.primary === null ? null : [],
      receipt: null,
    }));

    const result = fx.shell([
      'eval "$(declare -f _multi_invoke | sed \'1s/_multi_invoke/fixture_original_invoke/\')"',
      'fixture_replaced=0',
      '_multi_invoke() {',
      '  if [[ "$fixture_replaced" == 0 ]]; then',
      '    cp "$TEST_ROOT/replacement.json" "$SETTINGS_RECORD"',
      '    chmod 600 "$SETTINGS_RECORD"',
      '    fixture_replaced=1',
      '  fi',
      '  fixture_original_invoke "$@"',
      '}',
      'run_agent 81 fixture PLAN',
    ].join('\n'), { SETTINGS_RECORD: fx.record });

    assert.equal(result.status, 0, result.stderr);

    const capture = (await fx.captures()).at(-1);

    assert.equal(capture.provider, selected.parametersFor);
    assert.equal(capture.model, selected.model);
    assert.equal(capture.effort, selected.effort);
  }
});
