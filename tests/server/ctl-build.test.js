import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { fixture, expectedBuildCalls, expectedAllPhases, assertInterleavedPhases } from './helpers/ctlBuildFixture.js';

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
    ['install', '--no-audit', '--no-fund'],
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

    for (const [target, flag] of [['window', '--help'], ['window', '-h'], ['apk', '--help']]) {
      const result = await box.run(['build', target, flag]);

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

test('build: all собирает сервер, окно и tasks параллельными цепочками', async (t) => {
  for (const target of [undefined, 'all']) {
    const box = await fixture(t);
    const result = await box.run(['build', ...target ? [target] : []]);

    assert.equal(result.code, 0, `${target}: ${result.stderr}`);
    assertInterleavedPhases(await box.calls(), expectedAllPhases(box));
    assert.match(result.stdout, /Закройте окно и откройте снова — запустится новый код/u);
  }
});

test('build: отдельные цели соблюдают точный порядок и argv', async (t) => {
  for (const target of ['server', 'web', 'window', 'apk']) {
    const box = await fixture(t);
    const result = await box.run(['build', target]);

    assert.equal(result.code, 0, `${target}: ${result.stderr}`);
    assert.deepEqual(await box.calls(), expectedBuildCalls(box, target));

    if (target === 'apk') {
      assert.ok(result.stdout.includes(path.join(box.env.GRIGDESK_HOME,
        'state/mobile-apk/grigdesk-mobile-debug.apk')));
      assert.doesNotMatch(result.stdout, /Закройте окно|use-server/u);
    } else if (target === 'web') {
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
  for (const tail of [['unknown'], ['--unknown'], [''], ['server', 'web'], ['all', 'extra'],
    ['apk', 'extra']]) {
    const box = await fixture(t);
    const result = await box.run(['build', ...tail]);

    assert.equal(result.code, 2, `${JSON.stringify(tail)}: ${result.stderr}`);
    assert.match(result.stderr, /build \[all\|server\|web\|window\|deepseek\|apk\]/);
    assert.deepEqual(await box.calls(), []);
  }
});

test('build: отказ подготовки зависимостей останавливает server и all до сборки', async (t) => {
  for (const target of ['server', 'all']) {
    const box = await fixture(t);

    await box.fail('npm', 'install', 28);

    const result = await box.run(['build', target]);

    assert.equal(result.code, 28, result.stderr);
    assert.deepEqual(await box.calls(), [{
      command: 'npm',
      cwd: path.join(box.root, 'server'),
      args: ['install', '--no-audit', '--no-fund'],
    }]);
    assert.doesNotMatch(result.stdout, /Поставлен|Поставлены/u);
  }
});

test('build apk: каталог результата переопределяется, ошибка сборщика сохраняет код', async (t) => {
  const box = await fixture(t);
  const directory = path.join(box.env.HOME, 'custom apk directory');
  const result = await box.run(['build', 'apk'], { GRIGDESK_MOBILE_APK_DIR: directory });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(path.join(directory, 'grigdesk-mobile-debug.apk')));
  await box.fail('mobile', 'build', 29);

  const failed = await box.run(['build', 'apk']);

  assert.equal(failed.code, 29, failed.stderr);
  assert.match(failed.stderr, /не удалось: apk/u);
  assert.doesNotMatch(failed.stdout, /Собран APK|Закройте окно/u);
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

test('build: отказ цепочки в all не отменяет параллельные, код — первой отказавшей', async (t) => {
  const failures = [
    ['npm', 'build:binary', 21, 'server'],
    ['npm', 'install:binary', 22, 'server'],
    ['npm', 'build', 23, 'web'],
    ['npm', 'dist', 24, 'window'],
    ['desktop', 'install', 25, 'window'],
  ];

  for (const [command, argument, code, step] of failures) {
    const box = await fixture(t);

    await box.fail(command, argument, code);

    const result = await box.run(['build']);
    const calls = await box.calls();
    const installed = calls.some((call) => call.command === 'desktop'
      && call.args.includes('install'));

    assert.equal(result.code, code, result.stderr);
    assert.match(result.stderr, new RegExp(`не удалось: ${step}`));
    assert.ok(calls.some((call) => call.command === 'npm'
      && call.args.includes(path.join(box.root, 'tracker'))), 'tasks не собирался параллельно');
    assert.equal(installed, argument === 'install');
    assert.doesNotMatch(result.stdout, /Закройте окно/);
  }
});

test('build: отказ tasks оставляет установку окна несостоявшейся, код сохранён', async (t) => {
  const box = await fixture(t);

  await box.fail('npm', path.join(box.root, 'tracker'), 27);

  const result = await box.run(['build']);
  const calls = await box.calls();

  assert.equal(result.code, 27, result.stderr);
  assert.match(result.stderr, /не удалось: tasks/u);
  assert.ok(calls.some((call) => call.args.includes('install:binary')),
    'сервер не собирался параллельно');
  assert.ok(!calls.some((call) => call.command === 'desktop' && call.args.includes('install')));
  assert.doesNotMatch(result.stdout, /Закройте окно/);
});

test('build all: без node_modules tasks ставит зависимости перед сборкой', async (t) => {
  const box = await fixture(t);

  await fs.rm(path.join(box.root, 'tracker/node_modules'), { recursive: true });

  const result = await box.run(['build']);
  const calls = await box.calls();
  const deps = calls.find((call) => call.args.includes('install')
    && call.args.includes('--no-audit') && call.args.includes(path.join(box.root, 'tracker')));

  assert.equal(result.code, 0, result.stderr);
  assert.ok(deps, 'зависимости tasks не ставились');
  assert.ok(deps.args.includes('--no-fund'));

  const build = calls.findIndex((call) => call.args.includes(path.join(box.root, 'tracker'))
    && call.args.includes('build'));

  assert.ok(calls.indexOf(deps) < build, 'сборка tasks началась до зависимостей');
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

test('build server: отказ подготовки Node валит только серверную цепочку all', async (t) => {
  const box = await fixture(t);

  await fs.writeFile(path.join(box.root, 'server/build/node-runtime.json'), '{}');

  const result = await box.run(['build']);
  const calls = await box.calls();

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Некорректный.*node-runtime/);
  assert.match(result.stderr, /не удалось: server/);
  assert.ok(!calls.some((call) => call.args.includes('build:binary')
    || call.args.includes('install:binary')), 'серверная цепочка не должна дойти до npm');
  assert.ok(calls.some((call) => call.args.includes(path.join(box.root, 'tracker'))),
    'параллельная цепочка tasks должна собираться');
  assert.ok(!calls.some((call) => call.command === 'desktop' && call.args.includes('install')),
    'установка окна не выполняется без успеха всех цепочек');
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
  assertInterleavedPhases(await box.calls(), expectedAllPhases(box));
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
