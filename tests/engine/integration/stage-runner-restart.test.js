import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  applyCli, applyPayload, cliJson, selection, settingsFixture, waitFor,
} from '../../helpers/stageRunnerSettingsFixture.mjs';

/**
 * Удерживает реальный первый процесс на штатном fake adapter после launch barrier.
 * Новая команда должна завершить именно эту identity, не PID из диагностического meta.env.
 */
async function liveFixture(t, fault = null, prepare = null) {
  const fx = await settingsFixture(t);

  if (fault) {
    await injectIoFault(fx, fault);
  }
  if (prepare) {
    await prepare(fx);
  }

  const active = fx.start({ FAKE_ALPHA_RESULT: 'wait' });
  const first = await waitFor(async () => (await fx.captures())[0], 'живой первый запуск');
  const options = cliJson(fx.cli('options', ['--provider', 'alpha']));

  assert.equal(options.actual.run.id, first.id);
  assert.equal(options.actual.run.epoch, first.epoch);

  return {
    ...fx,
    active,
    first,
    options
  };
}

/**
 * Сверяет фактический новый запуск с выбранной парой и историей старого.
 * Повтор команды не может превратить новую identity в повторный запуск прежней.
 */
async function assertRestart(fx, selected, requestId) {
  const options = cliJson(fx.cli('options', ['--provider', selected.parametersFor]));
  const payload = applyPayload(options, selected, 'restart', requestId);
  const result = cliJson(applyCli(fx, payload));

  assert.deepEqual(result.selection, selected);

  const captures = await waitFor(async () => {
    const rows = await fx.captures();

    return rows.length >= 2 ? rows : null;
  }, 'новый процесс после явного restart');
  const last = captures.at(-1);

  assert.notEqual(last.id, fx.first.id);
  assert.ok(last.epoch > fx.first.epoch);
  assert.equal(last.provider, selected.parametersFor);
  assert.equal(last.model, selected.model);
  assert.equal(last.effort, selected.effort);

  const meta = await readFile(`${fx.env.STATE_DIR}/logs/runs/t81/PLAN/${fx.first.id}/meta.env`, 'utf8');

  assert.match(meta, /^MODEL=alpha-model$/m);
  assert.match(meta, /^EFFORT=high$/m);
  assert.match(meta, /^RESULT_CLASS=manual_switch$/m);

  return { payload, last };
}

test('restart-same-provider-model', async (t) => {
  const fx = await liveFixture(t);

  await assertRestart(fx, selection(), 'restart-model');

  const firstHistory = await readFile(`${fx.env.STATE_DIR}/logs/runs/t81/PLAN/${fx.first.id}/meta.env`);
  const options = cliJson(fx.cli('options', ['--provider', 'alpha']));

  cliJson(applyCli(fx, applyPayload(options, selection('alpha-model', 'low'), 'restart', 'restart-again')));

  const captures = await waitFor(async () => {
    const rows = await fx.captures();

    return rows.length === 3 ? rows : null;
  }, 'второй последовательный restart');

  assert.equal(new Set(captures.map((row) => row.id)).size, 3);
  assert.ok(captures[2].epoch > captures[1].epoch);
  assert.equal(captures[2].effort, 'low');

  const unchangedHistory = await readFile(`${fx.env.STATE_DIR}/logs/runs/t81/PLAN/${fx.first.id}/meta.env`);

  assert.deepEqual(unchangedHistory, firstHistory);
});

test('restart-effort-only', async (t) => {
  const fx = await liveFixture(t);

  await assertRestart(fx, selection('alpha-model', 'low'), 'restart-effort');
});

test('restart-new-primary', async (t) => {
  const fx = await liveFixture(t, null, async (fixture) => {
    const profile = await readFile(fixture.config, 'utf8');

    await writeFile(fixture.config, [
      profile,
      'RUNNERS_COVERAGE=required',
      'STAGE_SHIP_PRIMARY=gamma',
      'MODEL_DEFAULT_GAMMA_FAMILY=fixture',
      'MODEL_DEFAULT_GAMMA_VERSION=latest',
      'MODEL_DEFAULT_GAMMA_EFFORT=off', '',
    ].join('\n'));

    const preflight = fixture.shell([
      'source "$FACTORY_HOME/lib/profile-preflight.sh"',
      'profile_runner_host_preflight demo-profile',
    ].join('\n'));

    assert.equal(preflight.status, 0, preflight.stderr);
    assert.deepEqual(await fixture.captures(), [], 'coverage не вызывает модель');
  });

  await assertRestart(fx, {
    primary: 'gamma',
    parametersFor: 'gamma',
    model: '["route","model"]',
    effort: 'off',
  }, 'restart-new-primary');
});

test('stale-restart-no-signal', async (t) => {
  const fx = await liveFixture(t);
  const other = spawn('sleep', ['30']);

  t.after(() => other.kill());
  await fx.seed(selection('alpha-model', 'high'));

  const previous = await readFile(fx.record);
  const current = cliJson(fx.cli('options', ['--provider', 'alpha']));
  const payload = applyPayload(current, selection(), 'restart', 'stale');
  const result = applyCli(fx, {
    ...payload, expectedRun: { id: fx.first.id, epoch: fx.first.epoch + 1 },
  });

  assert.equal(result.status, 75, result.stderr);
  assert.equal(fx.active.child.exitCode, null);
  assert.equal(other.exitCode, null);
  assert.equal((await fx.captures()).length, 1);
  assert.deepEqual(await readFile(fx.record), previous);

  const metaPath = `${fx.env.STATE_DIR}/logs/runs/t81/PLAN/${fx.first.id}/meta.env`;
  const meta = await readFile(metaPath, 'utf8');

  await writeFile(metaPath, meta
    .replace(/^PID=.*$/m, `PID=${other.pid}`)
    .replace(/^PGID=.*$/m, `PGID=${other.pid}`)
    .replace(/^STARTTIME=.*$/m, 'STARTTIME=1'));
  await assertRestart(fx, selection(), 'restart-trusted-source');
  assert.equal(other.exitCode, null, 'поддельная telemetry не направляет сигнал соседнему процессу');
});

test('restart-replay', async (t) => {
  const fx = await liveFixture(t);
  const { payload } = await assertRestart(fx, selection(), 'restart-replay');
  const saved = await readFile(fx.record);

  cliJson(applyCli(fx, payload), 'повтор после потери HTTP-ответа');
  assert.deepEqual(await readFile(fx.record), saved);
  assert.equal((await fx.captures()).length, 2);

  const changed = applyCli(fx, { ...payload, selection: selection('alpha-model', 'low') });

  assert.equal(changed.status, 75);
  assert.equal((await fx.captures()).length, 2);
});

test('restart-preflight-failure-finishes-receipt', async (t) => {
  const fx = await liveFixture(t, null, async (fixture) => {
    const file = path.join(fixture.env.FACTORY_RUNNERS_DIR, 'alpha.sh');
    const runner = await readFile(file, 'utf8');

    await writeFile(file, runner
      .replace("trap 'exit 143' TERM", "trap 'touch \"$TEST_ROOT/after-stop\"; exit 143' TERM")
      .replace('[[ "${SETTINGS_METADATA_UNAVAILABLE:-0}" != 1 ]] || return 4',
        '[[ "${SETTINGS_METADATA_UNAVAILABLE:-0}" != 1 && ! -e "$TEST_ROOT/after-stop" ]] || return 4'));
  });

  cliJson(applyCli(fx, applyPayload(fx.options, selection(), 'restart', 'metadata-after-stop')));

  const finished = await fx.active.finished;
  const current = cliJson(fx.cli('show'));

  assert.notEqual(finished.status, 0);
  assert.equal((await fx.captures()).length, 1, 'resolver отказал до нового launcher');
  assert.deepEqual(current.selection, selection());
  assert.equal(current.actual, null);
  assert.equal(current.receipt.state, 'failed');
  assert.match(current.receipt.reason, /launch|metadata|invalid_config/u);
});

test('restart-reserve-success-finishes-receipt', async (t) => {
  const fx = await liveFixture(t, null, async (fixture) => {
    const file = path.join(fixture.env.FACTORY_RUNNERS_DIR, 'alpha.sh');
    const runner = await readFile(file, 'utf8');

    await writeFile(file, runner
      .replace("trap 'exit 143' TERM", "trap 'touch \"$TEST_ROOT/after-stop\"; exit 143' TERM")
      .replace('case "${FAKE_ALPHA_RESULT:-limited}" in', [
        '[[ ! -e "$TEST_ROOT/after-stop" ]] || return 42',
        'case "${FAKE_ALPHA_RESULT:-limited}" in',
      ].join('\n'))
      .replace('limited:42)', 'limited:42|wait:42)'));
  });

  cliJson(applyCli(fx, applyPayload(fx.options, selection(), 'restart', 'restart-with-reserve')));

  const finished = await fx.active.finished;
  const current = cliJson(fx.cli('show'));
  const captures = await fx.captures();

  assert.equal(finished.status, 0, finished.output);
  assert.deepEqual(captures.map((capture) => capture.provider), ['alpha', 'alpha', 'beta']);
  assert.equal(captures.at(-1).model, 'beta-model');
  assert.equal(captures.at(-1).effort, 'high');
  assert.equal(current.receipt.state, 'started');
  assert.equal(current.receipt.reason, '');
});

test('restart-source-finishes-before-interrupt', async (t) => {
  const fx = await liveFixture(t, null, async (fixture) => {
    const file = path.join(fixture.env.FACTORY_RUNNERS_DIR, 'alpha.sh');
    const runner = await readFile(file, 'utf8');

    fixture.env.SETTINGS_RECORD = fixture.record;
    await writeFile(file, runner.replace('while true; do sleep 1; done', [
      'while true; do',
      '  if [[ -f "$SETTINGS_RECORD" ]] &&',
      '     jq -e \\',
      '       \'.pending.eventPublished == true and .pending.source.id == env.FACTORY_RUN_ID\' \\',
      '       "$SETTINGS_RECORD" >/dev/null 2>&1; then',
      '    return 0',
      '  fi',
      '  sleep 0.02',
      'done',
    ].join('\n')));
  });
  const bashEnv = path.join(fx.root, 'interrupt-barrier.sh');

  // Перестановка только управляющего вызова: новый capture появляется за штатным
  // launch barrier, поэтому interrupt наверняка увидит уже следующую trusted identity.
  await writeFile(bashEnv, [
    'set -T',
    'trap \'case "$BASH_COMMAND" in runtime_interrupt_trusted_active*)',
    '  for stop_wait in {1..400}; do',
    '    [[ "$(wc -l <"$TEST_ROOT/argv.tsv")" -lt 2 ]] || break',
    '    sleep 0.02',
    '  done',
    ';; esac\' DEBUG',
  ].join('\n'));
  fx.env.BASH_ENV = bashEnv;

  const result = applyCli(fx, applyPayload(fx.options, selection(), 'restart', 'source-finished'));

  delete fx.env.BASH_ENV;
  cliJson(result);

  const current = cliJson(fx.cli('show'));
  const captures = await fx.captures();

  assert.equal(captures.length, 2);
  assert.notEqual(current.actual.run.id, fx.first.id);
  assert.equal(current.actual.model, 'alpha-strong');
  assert.equal(current.actual.effort, 'max');
  assert.equal(current.receipt.state, 'consumed');
  assert.equal(current.receipt.reason, '');
});

test('show-saved-selection-without-coverage', async (t) => {
  const fx = await settingsFixture(t);

  await fx.seed(selection());
  await writeFile(fx.config, `${await readFile(fx.config, 'utf8')}RUNNERS_COVERAGE=required\n`);

  const bytes = await readFile(fx.record);
  const current = cliJson(fx.cli('show'));

  assert.deepEqual(current.selection, selection());
  assert.equal(fx.cli('options', ['--provider', 'alpha']).status, 75);
  assert.equal(applyCli(fx, applyPayload(current, selection(), 'next', 'coverage-required')).status, 75);
  assert.deepEqual(await readFile(fx.record), bytes);
  assert.deepEqual(await fx.captures(), []);
});

/**
 * Подменяет только системную файловую операцию Python в процессе fixture CLI.
 * Продуктовый storage остаётся настоящим, а место отказа фиксируется отдельным trace.
 */
async function injectIoFault(fx, fault) {
  const folder = path.join(fx.root, 'python-fault');

  await mkdir(folder);
  await writeFile(path.join(folder, 'sitecustomize.py'), [
    'import os',
    'original_replace = os.replace',
    'original_open = os.open',
    'import json',
    'record = os.environ["SETTINGS_RECORD"]',
    'fault = os.environ["SETTINGS_FAULT"]',
    'def resolved(file, descriptor=None):',
    '    file = os.fsdecode(file)',
    '    if descriptor is not None and not os.path.isabs(file):',
    '        file = os.path.join(os.readlink("/proc/self/fd/" + str(descriptor)), file)',
    '    return os.path.abspath(file)',
    'def is_consumed(value):',
    '    if isinstance(value, dict):',
    '        if value.get("consumed") is True or value.get("state") == "consumed":',
    '            return True',
    '        return any(is_consumed(item) for item in value.values())',
    '    if isinstance(value, list):',
    '        return any(is_consumed(item) for item in value)',
    '    return False',
    'def replace(source, target, *args, **kwargs):',
    '    target_path = resolved(target, kwargs.get("dst_dir_fd"))',
    '    if fault == "replace" and target_path == record:',
    '        raise OSError("fixture atomic replace denied")',
    '    consumed = False',
    '    if fault == "consume" and target_path == record:',
    '        source_path = resolved(source, kwargs.get("src_dir_fd"))',
    '        with open(source_path, encoding="utf-8") as pending:',
    '            consumed = is_consumed(json.load(pending))',
    '    result = original_replace(source, target, *args, **kwargs)',
    '    if consumed:',
    '        with open(record + ".fault", "w") as trace: trace.write("consumed")',
    '        os._exit(91)',
    '    return result',
    'def opened(file, flags, *args, **kwargs):',
    '    file_path = resolved(file, kwargs.get("dir_fd"))',
    '    writing = flags & (os.O_WRONLY | os.O_RDWR)',
    '    if fault == "lifecycle" and "/lifecycle/" in file_path and writing:',
    '        raise OSError("fixture lifecycle denied")',
    '    return original_open(file, flags, *args, **kwargs)',
    'os.replace = replace',
    'os.open = opened',
  ].join('\n'));
  Object.assign(fx.env, {
    PYTHONPATH: folder,
    SETTINGS_RECORD: fx.record,
    SETTINGS_FAULT: fault
  });
}

test('restart-commit-boundaries', async (t) => {
  await t.test('отказ atomic replace сохраняет прежние байты и процесс', async (sub) => {
    const fx = await liveFixture(sub);

    await fx.seed(selection('alpha-model', 'high'));

    const bytes = await readFile(fx.record);

    await injectIoFault(fx, 'replace');

    const current = cliJson(fx.cli('options', ['--provider', 'alpha']));
    const result = applyCli(fx, applyPayload(current, selection(), 'restart', 'replace-fault'));

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture atomic replace denied/);
    assert.deepEqual(await readFile(fx.record), bytes);
    assert.equal(fx.active.child.exitCode, null);
    assert.equal((await fx.captures()).length, 1);
  });

  await t.test('отказ lifecycle после accept сохраняет selection и объясняет receipt', async (sub) => {
    const fx = await liveFixture(sub);

    await injectIoFault(fx, 'lifecycle');

    const result = cliJson(applyCli(fx, applyPayload(fx.options, selection(), 'restart', 'event-fault')));

    assert.deepEqual(result.selection, selection());
    assert.ok(['pending', 'failed'].includes(result.receipt.state));
    assert.match(result.receipt.reason, /lifecycle|fixture/i);

    if (result.receipt.state === 'pending') {
      const legacy = fx.shell('"$FACTORY_HOME/bin/factory" 81 runner switch PLAN beta');

      assert.notEqual(legacy.status, 0, 'два pending intent взаимно исключены');
      assert.match(legacy.stderr, /pending|restart|settings|ожида|конфликт/i);
    }

    assert.equal(fx.active.child.exitCode, null);
    assert.equal((await fx.captures()).length, 1);
  });

  await t.test('падение после consume не позволяет повторно запустить запрос', async (sub) => {
    const fx = await liveFixture(sub, 'consume');
    const payload = applyPayload(fx.options, selection(), 'restart', 'consume-crash');

    cliJson(applyCli(fx, payload));
    await waitFor(() => readFile(`${fx.record}.fault`, 'utf8').catch(() => null), 'отказ после consume');

    delete fx.env.PYTHONPATH;
    cliJson(applyCli(fx, payload), 'повтор уже consumed запроса');
    assert.equal((await fx.captures()).length, 1, 'consume записан до падения, дубля нет');
    assert.deepEqual(cliJson(fx.cli('show')).selection, selection());
  });

  await t.test('отказ нового процесса после stop не объявляет его работающим', async (sub) => {
    const fx = await liveFixture(sub);

    await writeFile(path.join(fx.env.FACTORY_RUNNERS_DIR, 'alpha.sh'), [
      await readFile(path.join(fx.env.FACTORY_RUNNERS_DIR, 'alpha.sh'), 'utf8'),
      'runner_alpha_run() { return 41; }',
    ].join('\n'));
    cliJson(applyCli(fx, applyPayload(fx.options, selection(), 'restart', 'launch-fault')));

    const receipt = await waitFor(() => {
      const current = cliJson(fx.cli('show'));

      return current.receipt?.state === 'failed' ? current : null;
    }, 'receipt отказавшего restart');

    assert.deepEqual(receipt.selection, selection());
    assert.ok(receipt.receipt.reason);
    assert.equal(receipt.actual?.run ?? null, null);
  });
});
