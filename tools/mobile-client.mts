import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareClientUi } from './client-ui.mts';

type Runner = (command: string, args: string[], options: {
  cwd: string;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * Полный UI публикуется в assets атомарно общим сборщиком с Electron.
 * Gradle собирает только :client; прежнее приложение и web/dist не участвуют.
 */
export async function buildClient(options: {
  root: string;
  destination: string;
  release?: boolean;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const run = options.run || promisify(execFile);
  const env = options.env || process.env;
  const root = path.resolve(options.root);
  const destination = path.resolve(options.destination);
  const android = path.join(root, 'mobile/android');
  const mode = options.release ? 'release' : 'debug';
  const name = `grigdesk-mobile-${mode}`;

  if (options.release) {
    for (const key of ['GRIGDESK_ANDROID_STORE_FILE', 'GRIGDESK_ANDROID_STORE_PASSWORD',
      'GRIGDESK_ANDROID_KEY_PASSWORD', 'GRIGDESK_ANDROID_KEY_ALIAS']) {
      if (!env[key]) {
        throw new Error('Для выпуска укажите прежний ключ через GRIGDESK_ANDROID_STORE_FILE '
          + 'и параметры подписи.');
      }
    }

    await access(env.GRIGDESK_ANDROID_STORE_FILE!);
  }

  await prepareClientUi({
    root,
    destination: path.join(android, 'client/src/main/assets/ui'),
    run,
  });

  const built = await run(path.join(android, 'gradlew'), [
    '--no-daemon', '--max-workers=2', `:client:assemble${options.release ? 'Release' : 'Debug'}`,
  ], {
    cwd: android,
    maxBuffer: 64 * 1024 * 1024,
    env,
  });

  process.stdout.write(built.stdout);
  process.stderr.write(built.stderr);
  await mkdir(destination, { recursive: true });

  const staging = await mkdtemp(path.join(destination, '.client-apk-'));

  try {
    const apk = path.join(staging, name + '.apk');

    await copyFile(path.join(android, `client/build/outputs/apk/${mode}/client-${mode}.apk`), apk);

    if (options.release) {
      await verifyRelease({
        apk,
        staging,
        root,
        env,
        run,
      });
    }

    await rename(apk, path.join(destination, name + '.apk'));

    if (options.release) {
      await rename(path.join(staging, 'metadata.json'), path.join(destination, name + '.json'));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Подпись сравнивается с переданным прежним ключом, версия — с package.json без bump.
 * Выпуск остаётся файлом сборки и не публикуется через сервер или API обновлений.
 */
async function verifyRelease(options: {
  apk: string;
  staging: string;
  root: string;
  env: NodeJS.ProcessEnv;
  run: Runner;
}): Promise<void> {
  const { apk, staging, root, env, run } = options;
  const tools = path.join(env.ANDROID_HOME!, 'build-tools/36.0.0');
  const commandOptions = {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
    env,
  };
  const signature = await run(path.join(tools, 'apksigner'),
    ['verify', '--print-certs', apk], commandOptions);
  const certificate = path.join(staging, 'certificate.der');

  await run('keytool', [
    '-exportcert', '-alias', env.GRIGDESK_ANDROID_KEY_ALIAS!,
    '-keystore', env.GRIGDESK_ANDROID_STORE_FILE!, '-storepass:env', 'GRIGDESK_ANDROID_STORE_PASSWORD',
    '-file', certificate,
  ], commandOptions);

  const expected = createHash('sha256').update(await readFile(certificate)).digest('hex');
  const actual = /^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})$/m
    .exec(String(signature.stdout))?.[1];
  const badging = await run(path.join(tools, 'aapt2'), ['dump', 'badging', apk], commandOptions);
  const info = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m
    .exec(String(badging.stdout));
  const { version } = JSON.parse(await readFile(path.join(root, 'mobile/package.json'), 'utf8'));
  const parts = String(version).split('.').map(Number);
  const code = parts[0]! * 10000 + parts[1]! * 100 + parts[2]!;

  if (!actual || actual !== expected || info?.[1] !== 'local.grigdesk.mobile'
    || info?.[2] !== String(code) || info?.[3] !== version) {
    throw new Error('APK не прошёл проверку подписи, пакета или версии.');
  }

  const bytes = await readFile(apk);

  await writeFile(path.join(staging, 'metadata.json'), JSON.stringify({
    version,
    versionCode: code,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    certificateSha256: actual,
  }) + '\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!['build', 'release'].includes(process.argv[2] || '') || !process.env.GRIGDESK_MOBILE_APK_DIR) {
    throw new Error('Нужны mobile-client.mts build|release и GRIGDESK_MOBILE_APK_DIR.');
  }

  await buildClient({
    root: fileURLToPath(new URL('..', import.meta.url)),
    destination: process.env.GRIGDESK_MOBILE_APK_DIR,
    release: process.argv[2] === 'release',
  });
}
