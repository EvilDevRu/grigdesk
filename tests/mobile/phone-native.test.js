import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const state = process.env.GRIGDESK_TEST_ARTIFACTS_DIR || tmpdir();
const javaDigests = {
  'mobile/android/client/src/test/java/local/grigdesk/client/pipe/PhoneDirectFixture.java':
    'fced48eb0fa7225ceba6e6d1d3126571de365934304eac838fd41113c1440899',
  'mobile/android/client/src/test/java/local/grigdesk/client/pipe/PhonePairingTest.java':
    '58b672e61606baabbc5a6c2fbdf83dc3dbca64678b8b1ab33f8ba86148987629',
  'mobile/android/client/src/test/java/local/grigdesk/client/pipe/PhoneRelayFixture.java':
    'fa24c7a2a6ce8ab13fb128cdac51cbd275e95e93edc8e5562144adbc78b12f8c',
  'mobile/android/client/src/test/java/local/grigdesk/client/pipe/PhoneRouteRecoveryTest.java':
    '8c7be484c3fc4b187316a5ed02fdf6e3a58f9e49fef8c252f396b405418df2c2',
  'mobile/android/client/src/test/java/local/grigdesk/client/pipe/RoutedUpstreamTest.java':
    '244324f125172ec54ff4251b4e19c9ebe290790de4eec40e2451e69e203ecaf7',
  'mobile/android/client/src/test/java/local/grigdesk/client/pipe/UpstreamTest.java':
    'ad54b9c70829815054a4dcac353716b654235e93c3999de7ff66368911f36c8c',
  'mobile/android/client/src/test/java/local/grigdesk/client/shell/PhonePairingPayloadTest.java':
    'a60645c3a32d2828cf74a870965d410115c59522df0309b59389bd27c4cf2ca4',
  'mobile/android/client/src/test/java/local/grigdesk/client/shell/ProfileStoreTest.java':
    'ca916d6745bdb885174ea41a5252e81fc1b0805d93d5b9afe6aa882645f37e47',
  'mobile/android/client/src/test/java/local/grigdesk/client/shell/ShellLocaleTest.java':
    '57750c31cd0f82e20ba5f09a24a14255613660f94a0b1162a6777c8819bd5b23',
};
// Сверка исполняется и без Android SDK: BUILD не вправе ослаблять Java assertions.
// Manifest движка закрепляет этот launcher, а он закрепляет Java-файлы задачи.
test('PHONE-JAVA: Java-тесты совпадают с закреплёнными контрольными суммами', async () => {
  assert.ok(Object.keys(javaDigests).length > 0, 'Java-тесты должны быть закреплены');

  for (const [file, expected] of Object.entries(javaDigests)) {
    const bytes = await readFile(new URL(file, root));

    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
  }
});
test('PHONE-NATIVE: JVM-барьеры и телефонные сценарии без установки APK', {
  timeout: 240000,
}, async (t) => {
  const jdk = process.env.GRIGDESK_ANDROID_JDK;
  const sdk = process.env.GRIGDESK_ANDROID_HOME;
  const cache = process.env.GRIGDESK_ANDROID_GRADLE_HOME;

  if (!jdk || !sdk) {
    t.skip('NOT RUN: JVM не исполнялась; нужны GRIGDESK_ANDROID_JDK и GRIGDESK_ANDROID_HOME');

    return;
  }

  assert.ok(cache, 'Нужен прогретый GRIGDESK_ANDROID_GRADLE_HOME');
  await Promise.all([access(path.join(jdk, 'bin/java')), access(path.join(sdk, 'platforms'))]);

  const directory = await mkdtemp(path.join(state, 'phone-native-'));
  const init = path.join(directory, 'isolated.gradle');

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(init, `allprojects {
  layout.buildDirectory.set(new File(${JSON.stringify(directory)}, name + '-build'))
}
`);

  const args = [
    'gradlew', '--offline', '--no-daemon', '--max-workers=2', '-Dorg.gradle.jvmargs=-Xmx768m',
    '--gradle-user-home', cache, '--project-cache-dir', path.join(directory, 'project-cache'),
    '--init-script', init, ':client:testDebugUnitTest',
  ];

  for (const name of [
    'pipe.UpstreamTest', 'pipe.StreamingTest', 'pipe.PairingTest', 'shell.PairingPayloadTest',
    'shell.ShellApiTest', 'shell.ProfileStoreTest', 'shell.ShellLocaleTest',
    'AppLifecycleTest', 'UnlockSessionTest', 'KeyFailureTest', 'WebPolicyTest',
    'shell.PhonePairingPayloadTest', 'pipe.PhonePairingTest', 'pipe.RoutedUpstreamTest',
    'pipe.PhoneRouteRecoveryTest',
  ]) {
    args.push('--tests', `local.grigdesk.client.${name}`);
  }

  const child = spawn('bash', args, {
    cwd: new URL('../../mobile/android/', import.meta.url),
    env: {
      ...process.env,
      GRADLE_USER_HOME: cache,
      JAVA_HOME: jdk,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      ANDROID_USER_HOME: path.join(directory, 'android-home'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';

  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  t.after(() => child.kill());

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  assert.equal(code, 0, output.slice(-18000));
  assert.match(output, /BUILD SUCCESSFUL/);
});
