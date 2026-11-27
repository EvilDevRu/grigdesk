import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { launchBuild, terminalBuildFixture } from './helpers/buildFixture.mts';
import { down, enterGroup, exitMenus } from './helpers/menuFixture.mts';
import { assertRestored } from './helpers/pty.mts';

/**
 * Сборка и smoke работают с отметками в тестовом HOME.
 * Проверка видит новый допуск только после следующей сборки.
 */
async function harnessFixture(t: TestContext, admitted: string[] = [], applicablePatch = false) {
  const box = await terminalBuildFixture(t, true);
  const npm = path.join(box.env.PATH.split(':')[0]!, 'npm');
  const original = await readFile(npm, 'utf8');
  const anchor = 'const failed = failure.command === command && args.includes(failure.argument);';
  const next = path.join(box.env.HOME, 'next-admission');
  const current = path.join(box.env.HOME, 'built-admission');
  const patches = path.join(box.env.HOME, 'built-patches');

  if (applicablePatch) {
    const manifest = path.join(box.root, 'deepseek/vendor/deepseek-harness/upstream.lock.json');

    await writeFile(manifest, JSON.stringify({
      version: '0.1.5-rc.2',
      commit: 'c291e7961a515f6d7af9304e7fd1d257929aef26',
    }));
  }

  assert.ok(original.includes(anchor));
  await writeFile(next, admitted.join('\n') + '\n');
  await writeFile(npm, original.replace(anchor, [
    anchor,
    `const next = ${JSON.stringify(next)};`,
    `const current = ${JSON.stringify(current)};`,
    'if (!failed && args[0] === "--prefix" && args[1].endsWith("/deepseek") && args.includes("build")) {',
    '  fs.copyFileSync(next, current);',
    `  const patches = ${JSON.stringify(patches)};`,
    '  fs.appendFileSync(patches, process.env.GRIGDESK_DEEPSEEK_GLM_54_BACKPORT + "\\n");',
    '}',
    'if (!failed && args.includes("admission:check")) {',
    '  const mode = args[args.indexOf("--mode") + 1];',
    '  process.exit(fs.readFileSync(current, "utf8").split("\\n").includes(mode) ? 0 : 3);',
    '}',
  ].join('\n')));
  await writeFile(path.join(box.root, 'server/scripts/glmLiveSmoke.mts'), [
    'import assert from "node:assert/strict";',
    'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
    'import { setTimeout as delay } from "node:timers/promises";',
    'assert.ok(process.argv.includes("--confirm-live") && process.argv.includes("--admit"));',
    'const mode = process.argv[process.argv.indexOf("--mode") + 1];',
    'if (process.env.STUB_SMOKE_CONCURRENT) {',
    '  const other = mode === "api" ? "coding-plan" : "api";',
    '  const marker = process.env.STUB_HOME + "/smoke-";',
    '  const deadline = Date.now() + 3000;',
    '  writeFileSync(marker + mode, "");',
    '  while (!existsSync(marker + other) && Date.now() < deadline) await delay(20);',
    '  assert.ok(existsSync(marker + other), "Второй smoke должен стартовать до завершения первого");',
    '}',
    'if (mode === process.env.STUB_SMOKE_FAIL_MODE) process.exit(21);',
    `appendFileSync(${JSON.stringify(next)}, mode + "\\n");`,
  ].join('\n'));

  return {
    ...box,
    current,
    next,
    patches,
    installed: path.join(box.root, 'bin/deepseek'),
  };
}

for (const fail of [false, true]) {
  test(`DeepSeek Harness: два режима проверяются параллельно, отказ=${fail}`, async (t) => {
    const box = await harnessFixture(t);
    const session = launchBuild(t, box, 'deepseek', false, {
      inputTTY: false,
      env: {
        ...box.env,
        GRIGDESK_DEEPSEEK_SMOKE: 'both',
        STUB_SMOKE_CONCURRENT: '1',
        STUB_SMOKE_FAIL_MODE: fail ? 'api' : '',
      },
    });
    const result = await session.done;
    const modes = (await readFile(box.next, 'utf8')).trim().split('\n').sort();

    assert.equal(result.code, fail ? 21 : 0, session.output());
    assert.deepEqual(modes, fail ? ['coding-plan'] : ['api', 'coding-plan']);
    assert.equal((await box.calls()).filter((call) => call.args.includes('verify')).length, fail ? 1 : 2);

    if (fail) {
      await assert.rejects(access(box.installed), { code: 'ENOENT' });
    } else {
      const installedModes = (await readFile(box.current, 'utf8')).trim().split('\n').sort();

      assert.deepEqual(installedModes, ['api', 'coding-plan']);
      await access(box.installed);
    }
  });
}

for (const explicit of [false, true]) {
  test(`DeepSeek Harness: живой допуск из меню, отдельный пункт=${explicit}`, async (t) => {
    const box = await harnessFixture(t, explicit ? ['api'] : [], true);
    const session = launchBuild(t, box, '', true);

    await enterGroup(session, 5, /DeepSeek Harness/u);
    session.write(down.repeat(4) + '\r');
    await session.wait(/Получить допуск GLM/u);
    session.write((explicit ? down : '') + '\r');

    await session.wait(/Включить патч GLM-5\.4\?/u);
    assert.deepEqual(await box.calls(), []);
    session.write(down + '\r');

    const mode = explicit ? 'coding-plan' : 'api';

    await session.wait(new RegExp(`Нет живого допуска GLM для ${mode}`, 'u'));
    assert.ok(!(await readFile(box.next, 'utf8')).includes(mode));
    await assert.rejects(access(box.installed), { code: 'ENOENT' });
    session.write('\r');
    await session.wait(/Поставлен DeepSeek Harness/u);
    await session.wait(/Enter \/ Esc — назад/u);

    assert.ok((await readFile(box.current, 'utf8')).includes(mode));
    await access(box.installed);
    assert.equal((await box.calls()).filter((call) => call.args.includes('verify')).length, 2);
    assert.equal(await readFile(box.patches, 'utf8'), '1\n1\n');
    assert.equal((await exitMenus(session)).code, 0);
    assert.equal(session.output().match(/\x1b\[\?1049h/gu)?.length, 1);
  });
}

for (const [scenario, code] of [
  ['admitted', 0], ['deferred', 0], ['noninteractive', 0], ['cancelled', 130], ['error', 7],
] as const) {
  test(`DeepSeek Harness: прямая сборка, сценарий ${scenario}`, async (t) => {
    const box = await harnessFixture(t, scenario === 'admitted' ? ['api'] : []);

    if (scenario === 'error') {
      await box.fail('npm', 'admission:check', 7);
    }

    const session = launchBuild(t, box, 'deepseek', false, {
      inputTTY: scenario !== 'noninteractive',
    });

    if (scenario === 'deferred' || scenario === 'cancelled') {
      await session.wait(/Нет живого допуска GLM для api/u);
      session.write(scenario === 'deferred' ? '\x1b' : '\x03');
    }

    const result = await session.done;

    assert.equal(result.code, code, session.output());
    assert.equal((await readFile(box.next, 'utf8')).trim(), scenario === 'admitted' ? 'api' : '');

    if (scenario === 'admitted') {
      await access(box.installed);
      assert.match(session.output(), /Поставлен DeepSeek Harness/u);
    } else {
      await assert.rejects(access(box.installed), { code: 'ENOENT' });
    }
    if (scenario !== 'deferred' && scenario !== 'cancelled') {
      assert.doesNotMatch(session.output(), /Запустить живую проверку/u);
    }

    assert.doesNotMatch(session.output(), /Включить патч GLM-5\.4/u);
    assertRestored(result, session.output());
  });
}

for (const [input, code] of [['\r', 0], ['\x1b', 130]] as const) {
  test(`DeepSeek Harness: отказ от патча или отмена прямой сборки, код ${code}`, async (t) => {
    const box = await harnessFixture(t, ['api'], true);
    const session = launchBuild(t, box, 'deepseek');

    await session.wait(/Включить патч GLM-5\.4\?/u);
    assert.deepEqual(await box.calls(), []);
    session.write(input);

    const result = await session.done;

    assert.equal(result.code, code, session.output());

    if (code === 0) {
      assert.equal(await readFile(box.patches, 'utf8'), '0\n');
      await access(box.installed);
    } else {
      assert.deepEqual(await box.calls(), []);
      await assert.rejects(access(box.installed), { code: 'ENOENT' });
    }

    assertRestored(result, session.output());
  });
}

for (const [inputTTY, flag] of [[true, '1'], [true, '0'], [false, undefined], [false, '1']] as const) {
  test(`DeepSeek Harness: сборка без вопроса при TTY=${inputTTY}, флаг=${flag}`, async (t) => {
    const box = await harnessFixture(t, ['api'], true);
    const env = { ...box.env, ...(flag === undefined ? {} : { GRIGDESK_DEEPSEEK_GLM_54_BACKPORT: flag }) };
    const session = launchBuild(t, box, 'deepseek', false, { inputTTY, env });
    const result = await session.done;

    assert.equal(result.code, 0, session.output());
    assert.doesNotMatch(session.output(), /Включить патч GLM-5\.4/u);
    assert.equal(await readFile(box.patches, 'utf8'), `${flag ?? '0'}\n`);
  });
}
