import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('I18N-A01: JVM ShellLocale/ShellApi/WebPolicy/ProfileStore с явными SDK и JDK', {
  timeout: 240000,
}, async (t) => {
  const jdk = process.env.GRIGDESK_ANDROID_JDK;
  const sdk = process.env.GRIGDESK_ANDROID_HOME;

  if (!jdk || !sdk) {
    t.skip('К6 native: не проверено; нужны GRIGDESK_ANDROID_JDK и GRIGDESK_ANDROID_HOME');

    return;
  }

  for (const file of [path.join(jdk, 'bin/java'), path.join(sdk, 'platforms')]) {
    assert.equal(await access(file).then(() => true, () => false), true, `Недоступен явно заданный ${file}`);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'i18n-android-jvm-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const init = path.join(directory, 'isolated.gradle');

  await writeFile(init, `allprojects {
  layout.buildDirectory.set(new File(${JSON.stringify(directory)}, name + '-build'))
}
`);

  const args = [
    'gradlew', '--no-daemon', '--max-workers=2',
    '-Dorg.gradle.jvmargs=-Xmx768m',
    '--project-cache-dir', path.join(directory, 'project-cache'),
    '--gradle-user-home', path.join(directory, 'gradle-home'),
    '--init-script', init,
    ':client:testDebugUnitTest',
  ];

  for (const name of [
    'shell.ShellLocaleTest', 'shell.ShellApiTest', 'WebPolicyTest', 'shell.ProfileStoreTest',
  ]) {
    args.push('--tests', `local.grigdesk.client.${name}`);
  }

  const child = spawn('bash', args, {
    cwd: new URL('../../mobile/android/', import.meta.url),
    env: {
      ...process.env,
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

  assert.equal(code, 0, output.slice(-12000));
  assert.match(output, /BUILD SUCCESSFUL/);
});
