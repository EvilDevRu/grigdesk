import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { fixture, expectedBuildCalls } from './helpers/ctlBuildFixture.js';

const sourceMarkers = ['server/src/app.ts', 'web/package.json', 'desktop/package.json'];

test('build: явный путь исполнителя передаётся проверке пары при установке сервера', async (t) => {
  const box = await fixture(t);
  const binary = path.join(box.root, 'custom executor');
  const result = await box.run(['build', 'server'], { GRIGDESK_DEEPSEEK_BIN: binary });
  const install = (await box.calls()).find((call) => call.args.includes('install:binary'));

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(install.args.slice(-2), ['--deepseek-binary', binary]);
});

test('build: исходники с установленным ELF сохраняют путь разработчика', async (t) => {
  const box = await fixture(t);
  const result = await box.run(['build', 'web']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await box.calls()).map((call) => call.args), [
    ['run', '--silent', 'deepseek:prepare'],
    ['run', 'build'],
  ]);
});

test('build: исходники без ELF сохраняют прежнюю сборку web', async (t) => {
  const box = await fixture(t, { binary: false });

  assert.equal((await box.run(['build', 'web'])).code, 0);
  assert.equal((await box.calls()).at(-1).cwd, path.join(box.root, 'web'));
});

test('build: без каждого признака исходников ELF сохраняет прежний отказ байт в байт', async (t) => {
  for (const marker of sourceMarkers) {
    const box = await fixture(t);

    await fs.rm(path.join(box.root, marker));

    for (const command of ['dev', 'build', 'deps', 'mobile', 'release']) {
      const result = await box.run([command]);

      assert.equal(result.code, 1);
      assert.equal(result.stderr, `Команда ${command} доступна в установке из исходников.\n`);
      assert.deepEqual(await box.calls(), []);
    }
  }
});

test('build: release.json сохраняет отказ готовой поставки даже с признаками исходников', async (t) => {
  for (const binary of [false, true]) {
    const box = await fixture(t, { binary, release: true });
    const result = await box.run(['build']);

    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'Команда build доступна в установке из исходников.\n');
    assert.deepEqual(await box.calls(), []);
  }
});

test('build: --help и -h в исходниках не вызывают сборку и установку', async (t) => {
  for (const binary of [false, true]) {
    const box = await fixture(t, { binary });

    for (const flag of ['--help', '-h']) {
      const result = await box.run(['build', 'window', flag]);

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /СПРАВКА/);
      assert.deepEqual(await box.calls(), []);
    }
  }
});

test('build: deps/mobile/release в исходниках обходят установленный ELF', async (t) => {
  for (const command of ['deps', 'mobile', 'release']) {
    const box = await fixture(t);
    const result = await box.run([command, 'probe']);

    assert.equal(result.code, 0, result.stderr);
    assert.ok((await box.calls()).length > 0);
  }
});

test('build: all по умолчанию и отдельные цели соблюдают точный порядок и argv', async (t) => {
  for (const target of [undefined, 'all', 'server', 'web', 'window']) {
    const box = await fixture(t);
    const result = await box.run(['build', ...target ? [target] : []]);

    assert.equal(result.code, 0, `${target}: ${result.stderr}`);
    assert.deepEqual(await box.calls(), expectedBuildCalls(box, target));

    if (target === 'web') {
      assert.match(result.stdout, /Окно покажет новый веб после grigdesk-ctl build window/);
      assert.doesNotMatch(result.stdout, /Закройте окно/);
    } else if (target === 'server') {
      assert.match(result.stdout, /Окно сохраняет выбор другой установки сервера/);
      assert.doesNotMatch(result.stdout, /откройте снова — запустится новый код/);
    } else {
      assert.match(result.stdout, /Закройте окно и откройте снова — запустится новый код/);
    }
  }
});

test('build: неизвестная цель и лишний аргумент дают код 2 до эффектов', async (t) => {
  for (const tail of [['unknown'], ['--unknown'], [''], ['server', 'web'], ['all', 'extra']]) {
    const box = await fixture(t);
    const result = await box.run(['build', ...tail]);

    assert.equal(result.code, 2, `${JSON.stringify(tail)}: ${result.stderr}`);
    assert.match(result.stderr, /build \[all\|server\|web\|window\|deepseek\]/);
    assert.deepEqual(await box.calls(), []);
  }
});

test('build deepseek: отдельная цель собирает, проверяет и ставит поставку', async (t) => {
  const box = await fixture(t);
  const result = await box.run(['build', 'deepseek']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await box.calls(), expectedBuildCalls(box, 'deepseek'));
  assert.match(result.stdout, /Поставлен DeepSeek: .*bin\/deepseek/u);
  assert.match(result.stdout, /Новый ELF получит следующий ход DeepSeek/u);
  assert.doesNotMatch(result.stdout, /Закройте окно/u);
});

test('build deepseek: установленные зависимости не переустанавливаются', async (t) => {
  const box = await fixture(t);

  await fs.mkdir(path.join(box.root, 'deepseek/node_modules'), { recursive: true });

  const result = await box.run(['build', 'deepseek']);
  const calls = await box.calls();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.length, 6);
  assert.ok(!calls.some((call) => call.args.includes('install') && call.args.includes('--no-fund')));
  assert.ok(calls[0].args.includes('prepare:runtime'));
});

test('build deepseek: без допуска и без smoke сборка зелёная, установка отложена', async (t) => {
  const box = await fixture(t);

  await box.fail('npm', 'admission:check', 3);

  const result = await box.run(['build', 'deepseek']);
  const calls = await box.calls();

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Установка не выполнена: не хватает живого допуска GLM \(api\)/u);
  assert.match(result.stdout, /Повторите сборку, выбрав живой smoke/u);
  assert.match(result.stdout, /glmLiveSmoke\.mts --mode api --admit/u);
  assert.doesNotMatch(result.stdout, /Поставлен DeepSeek/u);
  assert.doesNotMatch(result.stdout, /Новый ELF получит следующий ход/u);
  assert.ok(!calls.some((call) => call.args.includes('install:binary')));
  assert.ok(!calls.some((call) => call.args.includes('prune:cache')));
});

test('build deepseek: выбранный smoke запускается для режима без допуска', async (t) => {
  const box = await fixture(t);

  await box.fail('npm', 'admission:check', 3);

  const result = await box.run(['build', 'deepseek'], { GRIGDESK_DEEPSEEK_SMOKE: 'consumer' });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /не удалось: deepseek/u);
  assert.match(result.stderr, /Живой smoke GLM \(api\) не пройден/u);
  assert.ok((await box.calls()).some((call) => call.args.includes('admission:check')));
});

test('build deepseek: отказ установки сохраняет путь кандидата и код стадии', async (t) => {
  const box = await fixture(t);

  await box.fail('npm', 'install:binary', 26);

  const result = await box.run(['build', 'deepseek']);

  assert.equal(result.code, 26, result.stderr);
  assert.match(result.stderr, /не удалось: deepseek/u);
  assert.match(result.stderr, /DeepSeek собран и проверен: /u);
  assert.match(result.stderr, /Установка не выполнена/u);
  assert.doesNotMatch(result.stdout, /Поставлен DeepSeek/u);
  assert.ok(!(await box.calls()).some((call) => call.args.includes('prune:cache')));
});

test('build deepseek: отказ чистки не отменяет успешную установку', async (t) => {
  const box = await fixture(t);

  await box.fail('npm', 'prune:cache', 31);

  const result = await box.run(['build', 'deepseek']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Чистка кэша DeepSeek не выполнена/u);
  assert.match(result.stdout, /Поставлен DeepSeek: .*bin\/deepseek/u);
  assert.deepEqual(await box.calls(), expectedBuildCalls(box, 'deepseek'));
});

test('build: сервер и DeepSeek получают фактический режим GLM потребителя', async (t) => {
  const envFile = async (box, content) => {
    await fs.mkdir(box.env.GRIGDESK_HOME, { recursive: true });
    await fs.writeFile(path.join(box.env.GRIGDESK_HOME, '.env'), content);
  };
  const installMode = async (box) => {
    const install = (await box.calls()).find((call) => call.args.includes('install:binary'));
    const flag = install.args.indexOf('--glm-mode');

    return install.args[flag + 1];
  };

  for (const target of ['server', 'all', 'deepseek']) {
    await t.test(target, async (t) => {
      const fromEnv = await fixture(t);
      const fromEnvResult = await fromEnv.run(['build', target], {
        GRIGDESK_GLM_API_MODE: 'coding-plan',
      });

      assert.equal(fromEnvResult.code, 0, fromEnvResult.stderr);
      assert.equal(await installMode(fromEnv), 'coding-plan');

      const fromFile = await fixture(t);

      await envFile(fromFile, 'GRIGDESK_GLM_API_MODE=coding-plan\n');

      const fromFileResult = await fromFile.run(['build', target]);

      assert.equal(fromFileResult.code, 0, fromFileResult.stderr);
      assert.equal(await installMode(fromFile), 'coding-plan');

      const overrideBeatsFile = await fixture(t);

      await envFile(overrideBeatsFile, 'GRIGDESK_GLM_API_MODE=coding-plan\n');

      const overrideResult = await overrideBeatsFile.run(['build', target], {
        GRIGDESK_GLM_API_MODE: 'api',
      });

      assert.equal(overrideResult.code, 0, overrideResult.stderr);
      assert.equal(await installMode(overrideBeatsFile), 'api');

      const unknownFallsBack = await fixture(t);

      await envFile(unknownFallsBack, 'GRIGDESK_GLM_API_MODE=experimental\n');

      const unknownResult = await unknownFallsBack.run(['build', target]);

      assert.equal(unknownResult.code, 0, unknownResult.stderr);
      assert.equal(await installMode(unknownFallsBack), 'api');
    });
  }
});

test('build: первая ошибка обрывает all и сохраняет код отказавшей стадии', async (t) => {
  const failures = [
    ['npm', 'build:binary', 21, 1, 'server'],
    ['npm', 'install:binary', 22, 2, 'server'],
    ['npm', 'build', 23, 4, 'web'],
    ['npm', 'dist', 24, 5, 'window'],
    ['desktop', 'install', 25, 6, 'window'],
  ];

  for (const [command, argument, code, count, step] of failures) {
    const box = await fixture(t);

    await box.fail(command, argument, code);

    const result = await box.run(['build']);

    assert.equal(result.code, code, result.stderr);
    assert.match(result.stderr, new RegExp(`не удалось: ${step}`));
    assert.deepEqual(await box.calls(), expectedBuildCalls(box).slice(0, count));
    assert.doesNotMatch(result.stdout, /Закройте окно/);
  }
});

test('build server: D и кэш по умолчанию вычисляются из временного HOME', async (t) => {
  const box = await fixture(t);
  const result = await box.run(['build', 'server'], {
    GRIGDESK_HOME: undefined,
    XDG_CACHE_HOME: undefined,
  });
  const expected = expectedBuildCalls({
    ...box,
    env: {
      ...box.env,
      GRIGDESK_HOME: path.join(box.env.HOME, '.grigdesk'),
      XDG_CACHE_HOME: path.join(box.env.HOME, '.cache'),
    },
  }, 'server');

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await box.calls(), expected);
});

test('build server: отказ подготовки Node останавливает all до npm и установщиков', async (t) => {
  const box = await fixture(t);

  await fs.writeFile(path.join(box.root, 'server/build/node-runtime.json'), '{}');

  const result = await box.run(['build']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Некорректный.*node-runtime/);
  assert.match(result.stderr, /не удалось: server/);
  assert.deepEqual(await box.calls(), []);
});

test('build server: подсказка выбора только для другого descriptor, файл не меняется', async (t) => {
  for (const kind of ['missing', 'v3', 'foreign', 'v4']) {
    const box = await fixture(t);
    const binary = path.join(box.root, 'bin/grigdesk-server');
    const descriptor = kind === 'v3' ? {
      version: 3,
      kind: 'sea',
      root: '/legacy',
      home: box.env.GRIGDESK_HOME,
    } : {
      version: 4,
      kind: 'binary',
      binary: kind === 'foreign' ? '/other/bin/grigdesk-server' : binary,
      home: box.env.GRIGDESK_HOME,
      cliPaths: [],
    };
    const file = path.join(box.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
    const text = JSON.stringify(descriptor);

    if (kind !== 'missing') {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }

    const result = await box.run(['build', 'server']);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await box.calls(), expectedBuildCalls(box, 'server'));

    if (kind === 'v4') {
      assert.doesNotMatch(result.stdout, /grigdesk-ctl desktop use-server/);
    } else {
      assert.match(result.stdout, /grigdesk-ctl desktop use-server /);
    }

    if (kind !== 'missing') {
      assert.equal(await fs.readFile(file, 'utf8'), text);
      assert.deepEqual(await fs.readdir(path.dirname(file)), ['runtime.json']);
    } else {
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    }
  }
});

test('build all: прежний release/bin заменяется отложенной привязкой после всей установки', async (t) => {
  const box = await fixture(t);
  const file = path.join(box.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
  const previous = JSON.stringify({
    version: 4,
    kind: 'binary',
    binary: path.join(box.root, 'release/bin/grigdesk-server'),
    home: box.env.GRIGDESK_HOME,
    cliPaths: ['/user/node/bin'],
  });

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, previous);

  const result = await box.run(['build', 'all']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await box.calls(), expectedBuildCalls(box));
  assert.equal(await fs.readFile(file, 'utf8'), previous);

  const pending = JSON.parse(await fs.readFile(`${file}.build-selection`, 'utf8'));

  assert.equal(pending.binary, path.join(box.root, 'bin/grigdesk-server'));
  assert.equal(pending.previous, previous);
  assert.equal((await fs.stat(`${file}.build-selection`)).mode & 0o777, 0o600);
  assert.match(result.stdout, /При следующем запуске окно выберет сервер этой сборки/);
  assert.doesNotMatch(result.stdout, /grigdesk-ctl desktop use-server/);
});

test('build all: отказ установки окна не публикует новую привязку', async (t) => {
  const box = await fixture(t);
  const file = path.join(box.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
  const previous = JSON.stringify({
    version: 1,
    root: box.root,
    node: process.execPath,
  });

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, previous);
  await box.fail('desktop', 'install', 25);

  const result = await box.run(['build', 'all']);

  assert.equal(result.code, 25, result.stderr);
  assert.equal(await fs.readFile(file, 'utf8'), previous);
  await assert.rejects(fs.stat(`${file}.build-selection`), { code: 'ENOENT' });
});

test('build all: другая установка сохраняется без обещания нового сервера после открытия', async (t) => {
  const box = await fixture(t);
  const file = path.join(box.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
  const previous = JSON.stringify({
    version: 4,
    kind: 'binary',
    binary: '/another/bin/grigdesk-server',
    home: box.env.GRIGDESK_HOME,
    cliPaths: [],
  });

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, previous);

  const result = await box.run(['build', 'all']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(file, 'utf8'), previous);
  await assert.rejects(fs.stat(`${file}.build-selection`), { code: 'ENOENT' });
  assert.match(result.stdout, /Окно сохраняет выбор другой установки сервера/);
  assert.doesNotMatch(result.stdout, /откройте снова — запустится новый код/);
});
