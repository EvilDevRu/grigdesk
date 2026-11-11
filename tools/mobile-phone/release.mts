import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { dataHome, dataPath } from '../../shared/runtime/dataHome.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const mobile = path.join(root, 'mobile');
const output = process.env.GRIGDESK_MOBILE_APK_DIR
  || dataPath(dataHome({ env: process.env, home: homedir() }), 'mobileApk');
const signing =
  process.env.GRIGDESK_ANDROID_SIGNING_DIR ||
  path.join(homedir(), '.config/grigdesk/android-signing');

// Имя ключа для нового хранилища; у существующего имя берётся из release.properties.
const KEY_ALIAS = 'grigdesk';

/**
 * Пароли передаются только через environment и private properties, не через argv или журнал.
 * Частичная старая установка подписи не считается отсутствующей и не получает новый ключ автоматически.
 */
async function identity() {
  const keyFile = path.join(signing, 'release.jks');
  const propertiesFile = path.join(signing, 'release.properties');
  const keyExists = await stat(keyFile).catch((error) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });
  const propertiesExist = await stat(propertiesFile).catch((error) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (Boolean(keyExists) !== Boolean(propertiesExist)) {
    throw new Error('Ключ подписи неполон. Восстановите каталог из резервной копии.');
  }
  if (!keyExists) {
    if (await stat(path.join(output, 'grigdesk-mobile.apk')).catch(() => null)) {
      throw new Error(
        'Предыдущий APK существует, а ключ подписи утрачен. Восстановите прежний ключ.',
      );
    }

    const password = randomBytes(48).toString('base64url');
    const stage = path.join(signing, `.create-${randomBytes(8).toString('hex')}`);

    await mkdir(stage, { mode: 0o700 });

    try {
      await execute(
        'keytool',
        [
          '-genkeypair',
          '-keyalg',
          'RSA',
          '-keysize',
          '3072',
          '-validity',
          '10000',
          '-alias',
          KEY_ALIAS,
          '-dname',
          'CN=GrigDesk',
          '-keystore',
          path.join(stage, 'release.jks'),
          '-storepass:env',
          'GRIGDESK_SIGNING_PASSWORD',
          '-keypass:env',
          'GRIGDESK_SIGNING_PASSWORD',
        ],
        {
          env: {
            ...process.env,
            GRIGDESK_SIGNING_PASSWORD: password,
          },
        },
      );
      await durable(
        path.join(stage, 'release.properties'),
        `storePassword=${password}\nkeyPassword=${password}\nkeyAlias=${KEY_ALIAS}\n`,
      );
      await chmod(path.join(stage, 'release.jks'), 0o600);
      await rename(path.join(stage, 'release.jks'), keyFile);
      await rename(path.join(stage, 'release.properties'), propertiesFile);
      await syncDirectory(signing);
    } finally {
      await rm(stage, {
        recursive: true,
        force: true,
      });
    }

    process.stdout.write(
      `Ключ подписи создан: ${signing}\nСохраните резервную копию каталога. ` +
        'Потеря ключа потребует переустановки приложения с нуля.\n',
    );
  }

  await chmod(keyFile, 0o600);
  await chmod(propertiesFile, 0o600);

  const properties = Object.fromEntries(
    (await readFile(propertiesFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');

        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

  // Проверенный alias отдаётся строкой: в аргументах keytool необязательное значение недопустимо.
  const alias = properties.keyAlias || '';
  const aliasValid = /^[A-Za-z0-9._-]{1,64}$/u.test(alias);

  if (!properties.storePassword || !properties.keyPassword || !aliasValid) {
    throw new Error('Настройки подписи повреждены. Восстановите резервную копию.');
  }

  return {
    ...process.env,
    GRIGDESK_ANDROID_STORE_FILE: keyFile,
    GRIGDESK_ANDROID_STORE_PASSWORD: properties.storePassword,
    GRIGDESK_ANDROID_KEY_PASSWORD: properties.keyPassword,
    GRIGDESK_ANDROID_KEY_ALIAS: alias,
  };
}

/**
 * Сборочная команда сохраняет свой ненулевой код; следующая публикация после ошибки не запускается.
 * Gradle/cap используют свой cwd, не пользовательский текущий каталог команды.
 */
async function run(command: string, args: string[], cwd: string, env = process.env) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
    });

    child.once('error', () => reject(new Error('Не удалось запустить инструмент сборки.')));
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Сборочная команда завершилась с кодом ${code ?? 1}.`));
      }
    });
  });
}

/**
 * Содержимое fsync предшествует rename; JSON выпуска публикуется последним.
 * Поэтому конкурирующая загрузка видит согласованный выпуск или проверяемый hash mismatch.
 */
async function durable(file: string, body: string) {
  const handle = await open(file, 'wx', 0o600);

  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Выпуск сверяет signature/package/version до замены прежнего файла, сохраняя монотонный versionCode.
 * Ключ подписи всегда находится вне репозитория, в том числе при явном переопределении пути.
 */
async function release() {
  const relative = path.relative(root, path.resolve(signing));

  if (
    !path.isAbsolute(signing) ||
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    throw new Error('Ключ подписи должен храниться вне дерева проекта.');
  }

  const { version } = JSON.parse(await readFile(path.join(mobile, 'package.json'), 'utf8'));
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);

  if (!parts || parts.length !== 3 || parts[1]! > 99 || parts[2]! > 99) {
    throw new Error('Версия требует major.minor.patch с minor/patch от 0 до 99.');
  }

  const versionCode = parts[0]! * 10000 + parts[1]! * 100 + parts[2]!;
  let previous;

  // Рост номера сверяется только с выпусками GrigDesk: у прежнего приложения другой
  // applicationId, Android ставит новый пакет отдельно, и его номер ни с чем не конфликтует.
  try {
    previous = JSON.parse(await readFile(path.join(output, 'grigdesk-mobile.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Метаданные прежнего выпуска повреждены.');
    }
  }

  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode < 1 ||
    versionCode > 2100000000 ||
    (previous &&
      (!Number.isSafeInteger(previous.versionCode) || versionCode <= previous.versionCode))
  ) {
    throw new Error('Номер версии должен быть больше предыдущего выпуска и в пределах Android.');
  }

  await mkdir(signing, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(signing, 0o700);

  const lockFile = path.join(signing, '.release-lock');
  const lock = await open(lockFile, 'wx', 0o600).catch(() => {
    throw new Error(
      'Выпуск уже занят. После аварии проверьте и удалите старый .release-lock вручную.',
    );
  });
  const stage = path.join(output, `.release-${randomBytes(8).toString('hex')}`);

  try {
    const env = await identity();

    await run('npm', ['--prefix', mobile, 'run', 'build'], root, env);
    await run(path.join(mobile, 'node_modules/.bin/cap'), ['sync', 'android'], mobile, env);
    await run(
      path.join(mobile, 'android/gradlew'),
      ['--no-daemon', '--max-workers=2', 'assembleRelease'],
      path.join(mobile, 'android'),
      env,
    );
    await mkdir(stage, {
      recursive: true,
      mode: 0o700,
    });

    const apk = path.join(stage, 'grigdesk-mobile.apk');

    await copyFile(path.join(mobile, 'android/app/build/outputs/apk/release/app-release.apk'), apk);

    const tools = path.join(process.env.ANDROID_HOME!, 'build-tools/36.0.0');
    const verified = await execute(path.join(tools, 'apksigner'), ['verify', '--print-certs', apk]);
    const certificateSha256 = /^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})$/m.exec(
      verified.stdout,
    )?.[1];

    await execute(
      'keytool',
      [
        '-exportcert',
        '-alias',
        env.GRIGDESK_ANDROID_KEY_ALIAS,
        '-keystore',
        env.GRIGDESK_ANDROID_STORE_FILE,
        '-storepass:env',
        'GRIGDESK_ANDROID_STORE_PASSWORD',
        '-file',
        path.join(stage, 'certificate.der'),
      ],
      { env },
    );

    const expectedCert = createHash('sha256')
      .update(await readFile(path.join(stage, 'certificate.der')))
      .digest('hex');
    const badging = await execute(path.join(tools, 'aapt2'), ['dump', 'badging', apk]);
    const info = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(
      badging.stdout,
    );

    if (
      !certificateSha256 ||
      certificateSha256 !== expectedCert ||
      !info ||
      info[1] !== 'local.grigdesk.mobile' ||
      info[2] !== String(versionCode) ||
      info[3] !== version ||
      (previous?.certificateSha256 && previous.certificateSha256 !== certificateSha256)
    ) {
      throw new Error('APK не прошёл проверку подписи, пакета или версии.');
    }

    const bytes = await readFile(apk);

    if (!bytes.length || bytes.length > 268435456) {
      throw new Error('Размер APK вне допустимого диапазона.');
    }

    const handle = await open(apk, 'r');

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    const metadata = {
      version,
      versionCode,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      builtAt: Date.now(),
      certificateSha256,
    };

    await durable(path.join(stage, 'grigdesk-mobile.json'), JSON.stringify(metadata) + '\n');
    await rename(apk, path.join(output, 'grigdesk-mobile.apk'));
    await rename(path.join(stage, 'grigdesk-mobile.json'), path.join(output, 'grigdesk-mobile.json'));
    await syncDirectory(output);
    process.stdout.write(`APK опубликован в ${path.join(output, 'grigdesk-mobile.apk')}\n`);
  } finally {
    await rm(stage, {
      recursive: true,
      force: true,
    });
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

release().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : 'Выпуск не завершён.') + '\n');
  process.exitCode = 1;
});
