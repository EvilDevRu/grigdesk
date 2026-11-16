import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const javaFile = 'mobile/android/client/src/test/java/local/grigdesk/client/pipe/RelayRouteUpdateTest.java';
const javaDigest = '51f57f8a3063992e9dbb6290e1c3a348655f695b1cf6ea4d69b4738dbb985d13';

test('RD-PHONE-01/02: route-only PATCH, прежние key1/key2 и атомарный профиль', {
  timeout: 240000,
}, async (t) => {
  const bytes = await readFile(new URL(`../../${javaFile}`, import.meta.url));

  assert.equal(createHash('sha256').update(bytes).digest('hex'), javaDigest, javaFile);

  const machineHome = homedir();
  const machineAndroid = path.join(machineHome, 'Workspace/cockpit/.state');
  const jdk = process.env.GRIGDESK_ANDROID_JDK || path.join(machineAndroid, 'android-jdk-21');
  const sdk = process.env.GRIGDESK_ANDROID_HOME || path.join(machineAndroid, 'android-sdk');
  const cache = process.env.GRIGDESK_ANDROID_GRADLE_HOME
    || path.join(machineHome, '.grigdesk/factory/state/android-jvm/gradle-home');

  // Без переменных используем стандартное окружение машины, описанное в docs/local.
  // Ошибочный явный путь и отказ доступа остаются ошибками, а отсутствие стандартного — skip.
  const prerequisites = [
    ['GRIGDESK_ANDROID_JDK', path.join(jdk, 'bin/java'), constants.X_OK],
    ['GRIGDESK_ANDROID_HOME', path.join(sdk, 'platforms'), constants.R_OK | constants.X_OK],
    ['GRIGDESK_ANDROID_GRADLE_HOME', path.join(cache, 'caches'),
      constants.R_OK | constants.W_OK | constants.X_OK],
  ];
  const missing = [];

  for (const [variable, entry, mode] of prerequisites) {
    try {
      await access(entry, mode);
    } catch (error) {
      if (error.code !== 'ENOENT' || process.env[variable]) {
        throw error;
      }

      missing.push(variable);
    }
  }

  if (missing.length) {
    t.skip(`не проверено: JVM не запускалась; подготовьте инструментарий или задайте ${missing.join(', ')}`);

    return;
  }

  const directory = await mkdtemp(path.join(process.env.GRIGDESK_TEST_ARTIFACTS_DIR || tmpdir(),
    'relay-route-jvm-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const init = path.join(directory, 'isolated.gradle');

  await writeFile(init, `allprojects {
  layout.buildDirectory.set(new File(${JSON.stringify(directory)}, name + '-build'))
}
`);

  const child = spawn('bash', [
    'gradlew', '--offline', '--no-daemon', '--max-workers=2', '-Dorg.gradle.jvmargs=-Xmx768m',
    '--gradle-user-home', cache, '--project-cache-dir', path.join(directory, 'project-cache'),
    '--init-script', init, ':client:testDebugUnitTest',
    '--tests', 'local.grigdesk.client.pipe.RelayRouteUpdateTest',
  ], {
    cwd: new URL('../../mobile/android/', import.meta.url),
    env: {
      ...process.env,
      JAVA_HOME: jdk,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      ANDROID_USER_HOME: path.join(directory, 'android-home'),
      GRADLE_USER_HOME: cache,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';

  child.stdout.on('data', (chunk) => output += chunk);
  child.stderr.on('data', (chunk) => output += chunk);
  t.after(() => child.kill());

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const results = path.join(directory, 'client-build/test-results/testDebugUnitTest',
    'TEST-local.grigdesk.client.pipe.RelayRouteUpdateTest.xml');
  const assertions = await readFile(results, 'utf8').catch(() => 'JUnit XML не создан');

  assert.equal(code, 0, output.slice(-18000) + '\n' + assertions.slice(0, 12000));
  assert.match(output, /BUILD SUCCESSFUL/u);
});
