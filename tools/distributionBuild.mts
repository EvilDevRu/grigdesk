import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { artifactsPath } from '../shared/runtime/dataHome.ts';
import { buildReleaseIdentity } from '../shared/runtime/productReleaseVersion.ts';
import { sha256, sha256File } from '../shared/node/hash.ts';
import { releaseSignedBytes } from '../shared/node/releaseTrust.ts';
import { createSourceSnapshot } from './distributionSnapshot.mts';
import { createRunRecord, completeRunRecord } from './distributionRuns.mts';
import { runStages, decodeRecipe, recipeDigest, recipeImplementationBytes } from './releasePipeline.mts';
import { prepareReleaseToolchain } from './releaseEnvironment.mts';
import { apiContractFingerprint } from './api-version.mjs';

/**
 * Каждый scope получает собственные HOME/XDG/cache и фиксированный PATH toolchain.
 * TMPDIR короткий и приватный: путь Unix-сокета Linux ограничен 108 байтами.
 * Кэш pinned Node находится вне дерева уборки тестов, чтобы GC не блокировал runtime.
 * Из родительского окружения не переносятся ключи провайдеров, SSH и настройки Node.
 */
async function stageEnvironment(scope: string, toolchain: string, version: string,
  channel: string, commit: string, temporary: string): Promise<NodeJS.ProcessEnv> {
  const home = path.join(scope, 'home');
  const env: NodeJS.ProcessEnv = {
    PATH: `${toolchain}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    GRIGDESK_HOME: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'share'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_RUNTIME_DIR: path.join(home, 'runtime'),
    TMPDIR: temporary,
    PLAYWRIGHT_BROWSERS_PATH: path.join(home, 'browsers'),
    GRIGDESK_RELEASE_VERSION: version,
    GRIGDESK_RELEASE_CHANNEL: channel,
    GRIGDESK_RELEASE_COMMIT: commit,
    GRIGDESK_TEST_DEEPSEEK_ROOT: path.join(scope, 'deepseek-tests'),
    GRIGDESK_ARTIFACTS_DIR: path.join(scope, 'artifacts'),
    GRIGDESK_DEEPSEEK_NODE_CACHE: path.join(scope, 'deepseek-node-cache'),
  };

  for (const key of ['HOME', 'GRIGDESK_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH',
    'GRIGDESK_TEST_DEEPSEEK_ROOT', 'GRIGDESK_ARTIFACTS_DIR', 'GRIGDESK_DEEPSEEK_NODE_CACHE']) {
    await fs.mkdir(env[key]!, { recursive: true, mode: 0o700 });
  }

  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/absent-bus`;

  return env;
}

/**
 * Исходный снимок остаётся неизменным; временный ключ подставляется только в копии scope.
 * Вся сборка живёт в artifacts, а verified появляется лишь после реальной установки.
 */
export async function runDistributionBuild(root: string, channel: string, runsDir: string): Promise<number> {
  if (!['release', 'dev'].includes(channel)) {
    throw new Error('dist_channel_invalid');
  }

  const artifacts = artifactsPath({ env: process.env, home: os.homedir() });

  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });

  const runDir = await fs.mkdtemp(path.join(artifacts, 'dist-build-'));
  const snapshot = await createSourceSnapshot({ root, runDir });
  const apiVersionPath = 'shared/client/apiVersion.ts';
  const originalApiVersion = await fs.readFile(path.join(snapshot.cloneRoot, apiVersionPath), 'utf8');
  const originalFingerprint = `API_CONTRACT_FINGERPRINT = '${apiContractFingerprint(snapshot.cloneRoot)}';`;

  if (!originalApiVersion.includes(originalFingerprint)) {
    throw new Error('dist_source_api_fingerprint_mismatch');
  }

  const baseVersion = (await fs.readFile(path.join(snapshot.cloneRoot, 'VERSION'), 'utf8')).trim();
  const version = channel === 'dev' ? `${baseVersion}-dev.${Date.now()}` : baseVersion;

  buildReleaseIdentity(channel as 'release' | 'dev', version, snapshot.commit);

  const recipe = decodeRecipe(JSON.parse(await fs.readFile(
    path.join(snapshot.cloneRoot, 'tools/releaseRecipe.json'), 'utf8')));
  const digest = recipeDigest(recipe, await recipeImplementationBytes(snapshot.cloneRoot));
  const artifactsRoot = path.join(runDir, 'release-artifacts');
  const created = await createRunRecord(runsDir, {
    realArtifactsRoot: artifactsRoot,
    sourceCommit: snapshot.commit,
    sourceDigest: snapshot.sourceDigest,
    recipeDigest: digest,
    manifestDigest: '',
  });
  let verified = false;
  const temporaryDirectories: string[] = [];

  /**
   * Scratch удаляется только после завершения собственных процессов всех scope.
   * Ошибка очистки до verified сохраняет failed; журналы и receipts остаются в artifacts.
   */
  const removeScratchDirectories = async (): Promise<void> => {
    while (temporaryDirectories.length > 0) {
      await fs.rm(temporaryDirectories[0]!, { recursive: true, force: true });
      temporaryDirectories.shift();
    }
  };

  process.stdout.write(`Запуск: ${created.runId}\nЖурналы: ${runDir}\n`
    + `sourceDigest: ${snapshot.sourceDigest}\nrecipeDigest: ${digest}\n`);

  try {
    const toolchain = await prepareReleaseToolchain(snapshot.cloneRoot, runDir,
      process.env.GRIGDESK_DIST_NODE_CACHE ?? path.join(artifacts, 'dist-node-cache'));
    const scopes = new Map<string, { root: string; env: NodeJS.ProcessEnv }>();

    for (const name of ['server', 'web', 'build', 'verify']) {
      const scope = path.join(runDir, name);
      const scopeRoot = path.join(scope, 'source');

      await fs.mkdir(scope, { mode: 0o700 });
      await fs.cp(snapshot.cloneRoot, scopeRoot, { recursive: true });

      const contractsFile = path.join(scopeRoot, 'shared/runtime/releaseChannelContracts.ts');
      const contracts = await fs.readFile(contractsFile, 'utf8');
      const substituted = contracts.replace(/export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u,
        `export const RELEASE_SIGNING_PUBLIC_KEY = ${JSON.stringify(created.record.publicKeyPem)};`);

      if (substituted === contracts) {
        throw new Error('dist_test_key_anchor_missing');
      }

      await fs.writeFile(contractsFile, substituted);

      // Временный ключ входит в отпечаток API. Версия API в копии остаётся прежней.
      const scopedFingerprint = `API_CONTRACT_FINGERPRINT = '${apiContractFingerprint(scopeRoot)}';`;

      await fs.writeFile(path.join(scopeRoot, apiVersionPath),
        originalApiVersion.replace(originalFingerprint, scopedFingerprint));

      // Постоянные выходы живут в artifacts; короткий scratch нужен Unix IPC.
      const temporary = await fs.mkdtemp('/tmp/gd-dist-');

      temporaryDirectories.push(temporary);
      scopes.set(name, {
        root: scopeRoot,
        env: await stageEnvironment(scope, toolchain.bin, version, channel, snapshot.commit, temporary),
      });
    }

    for (const [name, groups] of [
      ['server', ['prepare-server', 'prepare-build', 'server']],
      ['web', ['prepare-web', 'prepare-build', 'web']],
      ['build', ['prepare-build', 'prepare-web', 'build']],
    ] as const) {
      const scope = scopes.get(name)!;
      const pipeline = await runStages({
        recipe,
        sourceDigest: snapshot.sourceDigest,
        cwd: scope.root,
        env: scope.env,
        groups: [...groups],
        logFile: path.join(runDir, `pipeline-${name}.log`),
        receiptDir: path.join(runDir, 'receipts'),
      });

      if (pipeline.code !== 0) {
        process.stderr.write(`Этап ${name} отказал (${pipeline.code}); журнал: ${runDir}\n`);

        return pipeline.code;
      }
    }

    const build = scopes.get('build')!;
    const bundle = await runStages({
      recipe: { format: 1, stages: [
        {
          id: 'bundle',
          group: 'candidate',
          argv: [toolchain.node, 'tools/bundle.mts'],
          env: {
            GRIGDESK_RELEASE_SIGNING_KEY: path.join(runsDir, created.runId, 'private.pem'),
            GRIGDESK_CTL_BUILD_OBSERVED: '1',
          },
        },
        {
          id: 'deb',
          group: 'deb',
          needs: ['candidate'],
          argv: [toolchain.node, 'tools/buildDeb.mts', build.root],
        },
      ] },
      cwd: build.root,
      env: build.env,
      logFile: path.join(runDir, 'bundle.log'),
      receiptDir: path.join(runDir, 'receipts'),
    });

    if (bundle.code !== 0) {
      return bundle.code;
    }

    await fs.rename(path.join(build.root, 'release-artifacts'), artifactsRoot);

    const index = JSON.parse(await fs.readFile(path.join(artifactsRoot, `${channel}.json`), 'utf8'));
    const manifestDigest = sha256(releaseSignedBytes(index.latest));
    const verifier = await import(pathToFileURL(path.join(scopes.get('verify')!.root,
      'tools/verifyInstallation.mts')).href);
    const proofs = await verifier.verifyInstallation(artifactsRoot, snapshot.commit, {
      trust: {
        purpose: 'local',
        publicKeyPem: created.record.publicKeyPem,
        expectedCommit: snapshot.commit,
        expectedManifestDigest: manifestDigest,
      },
      installRoot: path.join(runDir, 'acceptance'),
    });

    await fs.writeFile(path.join(artifactsRoot, 'local-build.json'), JSON.stringify({
      runId: created.runId,
      sourceDigest: snapshot.sourceDigest,
      recipeDigest: digest,
      testTrustFingerprint: sha256(created.record.publicKeyPem),
      toolchain,
      installation: proofs,
      guiAcceptance: 'not-performed',
    }, null, 2) + '\n', { mode: 0o600 });

    const inventory = [];

    for (const name of await fs.readdir(artifactsRoot)) {
      const file = path.join(artifactsRoot, name);

      inventory.push({
        name,
        size: (await fs.stat(file)).size,
        sha256: await sha256File(file)
      });
    }

    await removeScratchDirectories();
    await completeRunRecord(runsDir, created.runId, 'verified', inventory, manifestDigest);
    verified = true;
    process.stdout.write(`Кандидат: ${artifactsRoot}\nТолько локальное тестовое доверие.\n`
      + `Проверка: dist check --local-run ${created.runId}\n`);

    return 0;
  } finally {
    try {
      if (!verified) {
        await completeRunRecord(runsDir, created.runId, 'failed', []);
      }
    } finally {
      await removeScratchDirectories();
    }
  }
}
