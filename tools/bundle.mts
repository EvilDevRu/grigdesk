import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { materializeDeepSeekSnapshot } from '../deepseek/scripts/deepseekVendorManifest.ts';
import { prepareRuntimeDependencies } from '../deepseek/scripts/prepareRuntimeDeps.mts';
import {
  assertDeepSeekHostCompatibility, decodeDeepSeekHostContract, decodeDeepSeekRuntimeInfo,
} from '../shared/chat/deepSeekBinary.ts';
import { assertDeepSeekGlmApiAdmission } from '../shared/node/glmCompatibility.ts';
import { writeBuildStepEvent } from '../shared/node/buildStepEvents.ts';
import { configureDarwinBuildProcessHelper } from '../shared/node/processIdentity.ts';
import { buildDesktopRelease } from './buildDesktopRelease.mts';
import { executeInstalledBundle, stageInstalledBundle } from './installedBundle.mts';
import type { BundleBuildInput, BundleOptions } from './bundleSteps.mts';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Реальные команды сборки получают только изолированное окружение своего этапа.
 * Сборщик не вызывает install, управление службами или выбор сервера окна.
 */
export async function run(command: string, args: string[], input: BundleBuildInput): Promise<void> {
  if (process.env.GRIGDESK_CTL_BUILD_OBSERVED === '1') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        env: input.env,
        stdio: 'inherit',
      });

      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(Object.assign(new Error(`Сборщик завершился: ${code ?? signal}`), { code: code ?? 1 }));
        }
      });
    });

    return;
  }

  const result = await execute(command, args, {
    cwd: root,
    env: input.env,
    maxBuffer: 16 * 1024 * 1024,
  });

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

/**
 * Metadata и verify DeepSeek используют отдельную D без доступа к ключам сборщика.
 * Публичный ответ проверяется теми же decoder и admission, что установщиком.
 */
async function deepSeekInfo(binary: string, env: NodeJS.ProcessEnv) {
  const result = await execute(binary, ['--runtime-info', '--json'], {
    cwd: '/',
    env,
    timeout: 30000,
    maxBuffer: 65536,
  });

  if (result.stderr !== '') {
    throw new Error('Проба DeepSeek записала ошибку');
  }

  return decodeDeepSeekRuntimeInfo(JSON.parse(result.stdout));
}

/**
 * Вход запускается только явной командой bundle из checkout.
 * Подготовка vendor вынесена в дочерний процесс с тем же синтетическим HOME.
 */
async function main(): Promise<void> {
  await configureDarwinBuildProcessHelper();

  if (process.argv[2] === '--prepare-deepseek' && process.argv.length === 4) {
    await materializeDeepSeekSnapshot(path.join(root, 'deepseek/vendor/deepseek-harness'));
    await prepareRuntimeDependencies(process.argv[3]!);

    return;
  }

  const stage = process.argv[2] === '--stage-installed' && process.argv.length === 5;

  if (!stage && process.argv.length !== 2) {
    throw new Error('Использование: grigdesk-ctl bundle');
  }

  if (stage && process.env.GRIGDESK_RELEASE_SIGNING_KEY) {
    throw new Error('release_signing_key_in_build_environment');
  }

  const options: BundleOptions = {
    root,
    ...(process.env.GRIGDESK_RELEASE_SIGNING_KEY
      ? {
        /**
         * Ключ читается только для явной подписи выпуска и не попадает в среду builders.
         * Подпись связывает точные байты файла сумм с архивом и описью.
         */
        async sign(content: string) {
          const { createPrivateKey, sign: signBytes } = await import('node:crypto');
          const pem = await readFile(process.env.GRIGDESK_RELEASE_SIGNING_KEY!, 'utf8');

          return signBytes(null, Buffer.from(content, 'utf8'),
            createPrivateKey(pem)).toString('base64');
        },
      }
      : {}),
    onStep: process.env.GRIGDESK_CTL_BUILD_OBSERVED === '1' ? writeBuildStepEvent : undefined,
    builders: {
      async server(input) {
        await run(process.execPath, [path.join(root, 'server/scripts/ctlBuild.mts'),
          'prepare-runtime', input.cacheDir], input);
        await run('npm', ['--prefix', path.join(root, 'server'), 'run', 'build:binary', '--',
          '--out-dir', input.outDir, '--cache-dir', input.cacheDir], {
            ...input,
            env: process.env.GRIGDESK_CTL_BUILD_OBSERVED === '1'
              ? { ...input.env, GRIGDESK_CTL_BUILD_OBSERVED: '1' } : input.env,
          });

        return path.join(input.outDir, 'grigdesk-server');
      },
      async tracker(input) {
        await run('npm', ['--prefix', path.join(root, 'tracker'), 'run', 'build', '--',
          '--out-dir', input.outDir, '--cache-dir', input.cacheDir], input);

        return path.join(input.outDir, 'tracker');
      },
      async pipeline(input) {
        await run('npm', ['--prefix', path.join(root, 'tracker'), 'run', 'build:pipeline', '--',
          '--out-dir', input.outDir, '--cache-dir', input.cacheDir], input);

        return path.join(input.outDir, 'pipeline');
      },
      async routes(input) {
        await run('npm', ['--prefix', path.join(root, 'routes'), 'run', 'build', '--',
          '--out-dir', input.outDir, '--cache-dir', input.cacheDir], input);

        return path.join(input.outDir, 'routes');
      },
      /**
       * Автономный voice собирается своим pinned Node в отдельный выход bundle.
       * Синтез, модели и установочные эффекты для сборки команды не требуются.
       */
      async voice(input) {
        await run('npm', ['--prefix', path.join(root, 'voice'), 'run', 'build', '--',
          '--out-dir', input.outDir, '--cache-dir', input.cacheDir], input);

        return path.join(input.outDir, 'voice');
      },
      async relay(input) {
        await run('npm', ['--prefix', path.join(root, 'relay'), 'run', 'build', '--',
          '--out-dir', input.outDir], input);

        return path.join(input.outDir, 'grigdesk-relay');
      },
      async deepseek(input) {
        await run(process.execPath, [fileURLToPath(import.meta.url),
          '--prepare-deepseek', input.cacheDir], input);
        await run('npm', ['--prefix', path.join(root, 'deepseek'), 'run', 'build', '--',
          '--out-dir', input.outDir, '--node-cache-dir', input.cacheDir], input);

        return path.join(input.outDir, 'deepseek');
      },
      async window(input) {
        return buildDesktopRelease({ ...input, root }, { run });
      },
    },
    /**
     * Полный verify обязателен даже после успешной сборки отдельного исполнителя.
     * Подтверждение связывается с packageId и проверкой GLM-плагина.
     */
    async verifyDeepSeek(binary, env) {
      const info = await deepSeekInfo(binary, env);
      const result = await execute(binary, ['--cache-dir', path.join(env.XDG_CACHE_HOME!, 'verify'),
        '--verify', '--json'], {
        cwd: '/',
        env,
        timeout: 120000,
        maxBuffer: 65536,
      });
      const proof = JSON.parse(result.stdout);

      if (result.stderr !== '' || proof.verified !== true || proof.packageId !== info.packageId
        || proof.glmPlugin !== true) {
        throw new Error('Полная проверка DeepSeek не подтвердила комплект');
      }
    },
    /**
     * Совместимость проверяется с контрактом именно текущего дерева сервера.
     * Декларации host и фактический admission GLM обязательны одновременно.
     */
    async verifyDeepSeekCompatibility(binary, env) {
      const info = await deepSeekInfo(binary, env);
      const host = decodeDeepSeekHostContract(JSON.parse(await readFile(
        path.join(root, 'server/deepseek-host-contract.json'), 'utf8',
      )));

      assertDeepSeekHostCompatibility(info, host);
      assertDeepSeekGlmApiAdmission(info, host);
    },
  };

  if (stage) {
    const directory = process.argv[3]!;
    const receipt = process.argv[4]!;

    if (!path.isAbsolute(directory) || !path.isAbsolute(receipt)) {
      throw new Error('release_staging_path_invalid');
    }

    await mkdir(directory, { mode: 0o700 });

    const digest = await stageInstalledBundle(options, directory);

    await writeFile(receipt, digest + '\n', { mode: 0o600, flag: 'wx' });

    return;
  }

  await executeInstalledBundle(options);

  process.stdout.write('Готовы установочные артефакты в release-artifacts/.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    const code = Number((error as { code?: unknown }).code);

    process.stderr.write(`Сборка комплекта не удалась: ${(error as Error).message}\n`);
    process.exitCode = process.env.GRIGDESK_CTL_BUILD_OBSERVED === '1'
      && Number.isInteger(code) && code > 0 ? code : 1;
  });
}
