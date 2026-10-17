import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const root = path.resolve(new URL('../../', import.meta.url).pathname);

/**
 * Fake-инструменты проверяют порядок/cwd/отказы сборки в отдельном разрешённом дереве.
 * Тест не создаёт реальный ключ подписи и не заменяет существующий Android SDK.
 */
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cockpit-mobile-build-'));
  const project = path.join(directory, 'project');
  const dataHome = path.join(directory, 'data');
  const signing = path.join(directory, 'signing');
  const sdk = path.join(directory, 'sdk');
  const jdk = path.join(directory, 'jdk');
  const commands = path.join(directory, 'commands');
  const logs = path.join(directory, 'calls.log');
  const lock = JSON.parse(await readFile(path.join(root, 'mobile/toolchain.lock.json'), 'utf8'));
  const distribution = BigInt(
    '0x' + createHash('md5').update(lock.gradleDistribution.url).digest('hex'),
  ).toString(36);
  const cachedGradle = path.join(
    project,
    '.state/android-gradle/wrapper/dists/gradle-8.14.3-bin',
    distribution,
    'gradle-8.14.3/bin/gradle',
  );

  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true,
    }),
  );

  for (const file of [
    'deploy/lib/runtime-env.sh',
    'shared/runtime/dataHome.ts',
    'shared/package.json',
    'server/scripts/dataHomeCheck.mts',
    'server/src/lib/dataHomeBoot.ts',
    'tools/mobile',
    'tools/mobile-phone/release.mts',
    'mobile/toolchain.lock.json',
    'mobile/android/gradle/wrapper/gradle-wrapper.jar',
  ]) {
    const target = path.join(project, file);

    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
  }

  await mkdir(signing, { recursive: true });
  await mkdir(commands, { recursive: true });
  await mkdir(path.join(dataHome, 'state/mobile-apk'), { recursive: true });
  await writeFile(path.join(project, 'mobile/package.json'), '{"version":"0.1.0"}');
  await writeFile(path.join(signing, 'release.jks'), 'existing-private-key');
  await writeFile(
    path.join(signing, 'release.properties'),
    'storePassword=test-only\nkeyPassword=test-only\nkeyAlias=cockpit\n',
  );
  await writeFile(path.join(dataHome, 'state/mobile-apk/cockpit-mobile.apk'), 'previous-apk');
  await writeFile(path.join(dataHome, 'state/mobile-apk/cockpit-mobile-debug.apk'), 'previous-debug');
  await writeFile(path.join(dataHome, 'state/mobile-apk/cockpit-mobile.json'), '{"versionCode":99}');

  for (const [file, script] of [
    [
      path.join(jdk, 'bin/java'),
      'printf \'openjdk version "21.0.12"\\n\' >&2\n' +
        'if [[ "$COCKPIT_FAKE_FAIL" == doctor ]]; then printf \'version "11.0"\\n\' >&2; exit 7; fi',
    ],
    [path.join(sdk, 'platform-tools/adb'), 'exit 0'],
    [path.join(sdk, 'build-tools/36.0.0/aapt2'), 'exit 0'],
    [path.join(sdk, 'cmdline-tools/latest/bin/sdkmanager'), 'exit 0'],
    [
      path.join(project, 'mobile/node_modules/.bin/cap'),
      'if [[ "$1" == --version ]]; then echo 8.5.3; exit 0; fi\n' +
        'printf "cap:%s\\n" "$PWD" >> "$COCKPIT_FAKE_LOG"',
    ],
    [
      path.join(commands, 'npm'),
      'printf "npm:%s\\n" "$PWD" >> "$COCKPIT_FAKE_LOG"\n' +
        'if [[ "$COCKPIT_FAKE_FAIL" == npm ]]; then exit 17; fi',
    ],
    [path.join(commands, 'keytool'), 'echo keytool >> "$COCKPIT_FAKE_LOG"\nexit 23'],
    [cachedGradle, 'exit 0'],
    [
      path.join(project, 'mobile/android/gradlew'),
      'printf "gradle:%s\\n" "$PWD" >> "$COCKPIT_FAKE_LOG"\n' +
      'if [[ "$COCKPIT_FAKE_FAIL" != success ]]; then exit 19; fi\n' +
      'mkdir -p app/build/outputs/apk/debug\nprintf debug-apk > app/build/outputs/apk/debug/app-debug.apk',
    ],
  ]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '#!/usr/bin/env bash\n' + script + '\n');
    await chmod(file, 0o755);
  }

  await mkdir(path.join(sdk, 'platforms/android-36'), { recursive: true });
  await writeFile(path.join(sdk, 'platforms/android-36/android.jar'), 'test-only');

  return {
    project,
    signing,
    logs,
    env: {
      HOME: directory,
      COCKPIT_HOME: dataHome,
      NODE_ENV: 'test',
      npm_config_cache: process.env.npm_config_cache,
      PATH: commands + ':' + process.env.PATH,
      COCKPIT_ANDROID_HOME: sdk,
      COCKPIT_ANDROID_JDK: jdk,
      COCKPIT_ANDROID_SIGNING_DIR: signing,
      COCKPIT_FAKE_LOG: logs,
      // sha256sum пишет OK/FAILED на языке машины; проверки ждут вывод без перевода.
      LC_ALL: 'C',
    },
  };
}

test('MB-24: shell синтаксис и явные команды сборки/подписи', async () => {
  await execute('bash', ['-n', path.join(root, 'tools/mobile')]);

  const script = await readFile(path.join(root, 'tools/mobile'), 'utf8');
  const release = await readFile(path.join(root, 'tools/mobile-phone/release.mts'), 'utf8');

  for (const command of ['deps', 'doctor', 'check', 'build', 'release']) {
    assert.match(script, new RegExp(command + '\\)'));
  }

  assert.doesNotMatch(script, /^\s*sudo\b/m);
  assert.match(release, /android-signing/);
  assert.match(release, /apksigner/);
});

test('MB-24: сбой Gradle сохраняет прежний APK/ключ и запускает cap из mobile', async (t) => {
  const fx = await fixture(t);

  await assert.rejects(
    execute('bash', ['tools/mobile', 'release'], {
      cwd: fx.project,
      env: {
        ...fx.env,
        COCKPIT_FAKE_FAIL: 'gradle',
      },
    }),
    (error) => error.code !== 0,
  );
  assert.equal(
    await readFile(path.join(fx.env.COCKPIT_HOME, 'state/mobile-apk/cockpit-mobile.apk'), 'utf8'),
    'previous-apk',
  );
  assert.equal(
    await readFile(path.join(fx.signing, 'release.jks'), 'utf8'),
    'existing-private-key',
  );

  const calls = await readFile(fx.logs, 'utf8');

  assert.match(calls, new RegExp('cap:' + fx.project + '/mobile\\n'));
  assert.match(calls, new RegExp('gradle:' + fx.project + '/mobile/android\\n'));
  assert.doesNotMatch(calls, /keytool/);
});

test('MB-24: незелёный doctor останавливает сборку до npm/cap/Gradle', async (t) => {
  const fx = await fixture(t);

  await assert.rejects(
    execute('bash', ['tools/mobile', 'build'], {
      cwd: fx.project,
      env: {
        ...fx.env,
        COCKPIT_FAKE_FAIL: 'doctor',
      },
    }),
    (error) => error.code !== 0,
  );
  assert.equal(await readFile(fx.logs, 'utf8').catch(() => ''), '');
  assert.equal(
    await readFile(path.join(fx.env.COCKPIT_HOME, 'state/mobile-apk/cockpit-mobile-debug.apk'), 'utf8'),
    'previous-debug',
  );
});

test('MB-24: doctor сверяет gradle-wrapper.jar с отпечатком из lock', async (t) => {
  const fx = await fixture(t);

  const { stdout } = await execute('bash', ['tools/mobile', 'doctor'], {
    cwd: fx.project,
    env: fx.env,
  });

  assert.match(stdout, /gradle-wrapper\.jar: OK/);
});

test('MB-24: подменённый gradle-wrapper.jar останавливает сборку до npm/cap/Gradle', async (t) => {
  const fx = await fixture(t);
  const jar = path.join(fx.project, 'mobile/android/gradle/wrapper/gradle-wrapper.jar');

  await writeFile(jar, 'tampered-wrapper');

  await assert.rejects(
    execute('bash', ['tools/mobile', 'build'], {
      cwd: fx.project,
      env: fx.env,
    }),
    (error) => error.code !== 0 && /gradle-wrapper\.jar: FAILED/.test(error.stdout),
  );
  assert.equal(await readFile(fx.logs, 'utf8').catch(() => ''), '');
  assert.equal(
    await readFile(path.join(fx.env.COCKPIT_HOME, 'state/mobile-apk/cockpit-mobile-debug.apk'), 'utf8'),
    'previous-debug',
  );
});


test('MB-DH успешная сборка публикует APK только в общей папке', async (t) => {
  const fx = await fixture(t);

  await execute('bash', ['tools/mobile', 'build'], {
    cwd: fx.project,
    env: { ...fx.env, COCKPIT_FAKE_FAIL: 'success' },
  });
  assert.equal(await readFile(path.join(fx.env.COCKPIT_HOME, 'state/mobile-apk/cockpit-mobile-debug.apk'),
    'utf8'), 'debug-apk');
  await assert.rejects(readFile(path.join(fx.project, '.state/mobile/cockpit-mobile-debug.apk')),
    (error) => error.code === 'ENOENT');
});
