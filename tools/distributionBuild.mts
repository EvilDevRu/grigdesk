import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createPrivateKey, sign } from 'node:crypto';

import { artifactsPath, dataHome, dataPath } from '../shared/runtime/dataHome.ts';
import type { createDistributionProgress } from '../cli/distributionProgress.ts';
import { buildReleaseIdentity } from '../shared/runtime/productReleaseVersion.ts';
import { sha256, sha256File } from '../shared/node/hash.ts';
import { releaseSignedBytes } from '../shared/node/releaseTrust.ts';
import { createSourceSnapshot } from './distributionSnapshot.mts';
import { createRunRecord, completeRunRecord } from './distributionRuns.mts';
import { publishDistributionOutput } from './distributionOutput.mts';
import {
  runStages, decodeRecipe, recipeDigest, recipeImplementationBytes, requireBuildOutcomes,
} from './releasePipeline.mts';
import {
  prepareReleaseToolchain, requireDarwinBuildHost, resolveReleaseGoDirectory, selectDistributionTarget,
} from './releaseEnvironment.mts';
import { apiContractFingerprint } from './api-version.mjs';
import { prepareDarwinBuildTools } from './darwinBuildTools.mts';
import { configureDarwinBuildProcessHelper } from '../shared/node/processIdentity.ts';

const pipelines = [
  ['server', ['prepare-server', 'prepare-build', 'server']],
  ['web', ['prepare-web', 'prepare-build', 'web']],
  ['build', ['prepare-build', 'prepare-web', 'build']],
] as const;
const darwinPipelines = [['build', ['mac-prepare', 'mac-check', 'mac-build']]] as const;

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
 * Рабочие копии живут в artifacts, а Linux-кандидат публикуется после реальной установки.
 */
export async function runDistributionBuild(
  root: string, channel: string, runsDir: string, progress?: ReturnType<typeof createDistributionProgress>,
): Promise<number> {
  if (!['release', 'dev'].includes(channel)) {
    throw new Error('dist_channel_invalid');
  }

  const darwin = selectDistributionTarget(process.platform, process.arch) === 'darwin-arm64';
  const controller = new AbortController();
  const interrupt = () => controller.abort(130);
  const terminate = () => controller.abort(143);

  if (darwin) {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }

  try {
    return await buildDistribution(root, channel, runsDir, darwin, controller.signal, progress);
  } catch (error) {
    if (controller.signal.aborted) {
      return controller.signal.reason as number;
    }

    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

/**
 * Собирает из одного снимка и сохраняет квитанции.
 * Публикует запись запуска после проверки байтов и готовой установки.
 */
async function buildDistribution(root: string, channel: string, runsDir: string, darwin: boolean,
  signal: AbortSignal, progress?: ReturnType<typeof createDistributionProgress>): Promise<number> {
  const home = { env: process.env, home: os.homedir() };
  const artifacts = artifactsPath(home);
  const ancestor = await fs.stat(artifacts).then(() => artifacts, () => root);

  if (darwin) {
    await requireDarwinBuildHost(ancestor);
  }

  signal.throwIfAborted();
  progress?.phase('snapshot');

  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });

  const runDir = await fs.mkdtemp(path.join(await fs.realpath(artifacts), 'dist-build-'));
  const snapshot = await createSourceSnapshot({
    root,
    runDir,
    signal,
  });
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
  const digest = recipeDigest(recipe, await recipeImplementationBytes(snapshot.cloneRoot, darwin));
  const artifactsRoot = path.join(runDir, 'release-artifacts');
  let candidate = artifactsRoot;

  if (!darwin) {
    const dists = dataPath(dataHome(home), 'dists');

    await fs.mkdir(dists, { recursive: true, mode: 0o700 });
    candidate = path.join(await fs.realpath(dists), path.basename(runDir), path.basename(artifactsRoot));
  }

  const created = await createRunRecord(runsDir, {
    realArtifactsRoot: candidate,
    sourceCommit: snapshot.commit,
    sourceDigest: snapshot.sourceDigest,
    recipeDigest: digest,
    manifestDigest: '',
  });
  let verified = false;
  const temporaryDirectories = new Map<string, boolean>();

  /**
   * Scratch удаляется только после завершения собственных процессов всех scope.
   * Ошибка очистки до verified сохраняет failed; журналы и receipts остаются в artifacts.
   */
  const removeScratchDirectories = async (): Promise<void> => {
    for (const [directory, safe] of temporaryDirectories) {
      if (safe) {
        await fs.rm(directory, { recursive: true, force: true });
      } else {
        process.stderr.write(`Сохранён временный каталог ${directory}. Журналы ${runDir}\n`);
      }
    }

    temporaryDirectories.clear();
  };

  // Четыре собственные фазы, упаковка bundle и deb плюс выбранные стадии рецепта каждой копии.
  const selectedPipelines = darwin ? darwinPipelines : pipelines;

  progress?.plan(selectedPipelines.reduce((count, [, groups]) =>
    count + recipe.stages.filter((stage) => groups.some((group) => group === stage.group)).length,
  darwin ? 4 : 6));
  progress?.close();
  process.stdout.write(`Запуск: ${created.runId}\nЖурналы: ${runDir}\n`
    + `sourceDigest: ${snapshot.sourceDigest}\nrecipeDigest: ${digest}\n`);

  try {
    progress?.completed();
    progress?.phase('setup');

    const toolchain = await prepareReleaseToolchain(snapshot.cloneRoot, runDir,
      process.env.GRIGDESK_DIST_NODE_CACHE ?? path.join(artifacts, 'dist-node-cache'), signal);
    const scopes = new Map<string, { root: string; env: NodeJS.ProcessEnv }>();
    const toolsRoot = path.join(runsDir, created.runId, 'verification-tools');

    if (darwin) {
      await fs.mkdir(toolsRoot, { mode: 0o700 });
    }

    const darwinTools = darwin ? await prepareDarwinBuildTools({
      sourceRoot: snapshot.cloneRoot,
      toolsRoot: await fs.realpath(toolsRoot),
      signal,
    }) : null;

    const buildPath = darwin ? toolchain.bin : [toolchain.bin, await resolveReleaseGoDirectory()].join(':');

    for (const name of darwin ? ['build', 'verify'] : ['server', 'web', 'build', 'verify']) {
      signal.throwIfAborted();

      const scope = path.join(runDir, name);
      const scopeRoot = path.join(scope, 'source');

      await fs.mkdir(scope, { mode: 0o700 });
      await fs.cp(snapshot.cloneRoot, scopeRoot, { recursive: true });

      const contractsFile = path.join(scopeRoot, 'shared/runtime/releaseChannelContracts.ts');
      const contracts = await fs.readFile(contractsFile, 'utf8');
      let substituted = contracts.replace(/export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u,
        `export const RELEASE_SIGNING_PUBLIC_KEY = ${JSON.stringify(created.record.publicKeyPem)};`);

      if (substituted === contracts) {
        throw new Error('dist_test_key_anchor_missing');
      }

      if (darwin) {
        const sourceAnchor = /RELEASE_DISTRIBUTION_SOURCE: ReleaseDistributionSource = 'channel';/u;

        if (!sourceAnchor.test(substituted)) {
          throw new Error('dist_test_source_anchor_missing');
        }

        substituted = substituted.replace(sourceAnchor,
          "RELEASE_DISTRIBUTION_SOURCE: ReleaseDistributionSource = 'local-test';");
      }

      await fs.writeFile(contractsFile, substituted);

      // Временный ключ входит в отпечаток API. Версия API в копии остаётся прежней.
      const scopedFingerprint = `API_CONTRACT_FINGERPRINT = '${apiContractFingerprint(scopeRoot)}';`;

      await fs.writeFile(path.join(scopeRoot, apiVersionPath),
        originalApiVersion.replace(originalFingerprint, scopedFingerprint));

      // Постоянные выходы живут в artifacts; короткий scratch нужен Unix IPC.
      const temporary = await fs.mkdtemp(darwin ? '/private/tmp/gd-dist-' : '/tmp/gd-dist-');

      temporaryDirectories.set(temporary, true);

      const env = await stageEnvironment(scope, buildPath, version, channel, snapshot.commit, temporary);

      if (darwinTools) {
        const { prepareDarwinFactoryEnvironment } = await import('../server/src/lib/factoryDarwinRuntime.ts');

        env.GRIGDESK_BUILD_PROCESS_HELPER = darwinTools.processIdentity.path;
        env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256 = darwinTools.processIdentity.sha256;
        env.GRIGDESK_TEST_SETSID_BIN = darwinTools.setsid.path;
        env.GRIGDESK_BUILD_SETSID_SHA256 = darwinTools.setsid.sha256;
        env.GRIGDESK_BUNDLE_STAGE = path.join(scope, 'unsigned');
        env.GRIGDESK_BUNDLE_RECEIPT = path.join(scope, 'unsigned.sha256');

        await configureDarwinBuildProcessHelper(env);

        const engine = await prepareDarwinFactoryEnvironment({
          root: scopeRoot,
          packaged: false,
          controlRoot: path.join(scope, 'factory'),
          node: toolchain.node,
          env,
        });

        env.PATH = [toolchain.bin, engine.PATH, '/opt/homebrew/bin'].join(':');
      }

      scopes.set(name, {
        root: scopeRoot,
        env,
      });
    }

    progress?.completed();

    const sourceReceiptIdentity = {
      commit: snapshot.commit,
      sourceDigest: snapshot.sourceDigest,
      recipeDigest: digest,
    };

    for (const [name, groups] of selectedPipelines) {
      signal.throwIfAborted();

      const scope = scopes.get(name)!;
      const logFile = path.join(runDir, `pipeline-${name}.log`);

      temporaryDirectories.set(scope.env.TMPDIR!, false);

      const pipeline = await runStages({
        recipe,
        sourceDigest: snapshot.sourceDigest,
        cwd: scope.root,
        env: scope.env,
        groups: [...groups],
        logFile,
        receiptDir: path.join(runDir, 'receipts'),
        observer: progress?.observer(logFile, name),
        candidateRecipe: darwin,
        sourceReceiptIdentity: darwin ? sourceReceiptIdentity : undefined,
        darwinToolchain: darwin ? {
          nodeVersion: toolchain.nodeVersion,
          npmVersion: toolchain.npmVersion,
        } : undefined,
        signal,
      });

      temporaryDirectories.set(scope.env.TMPDIR!, pipeline.cleanupConfirmed);

      if (pipeline.code !== 0) {
        progress?.close();
        process.stderr.write(`Этап ${name} отказал (${pipeline.code}); журнал: ${runDir}\n`);

        return pipeline.code;
      }

      if (darwin) {
        requireBuildOutcomes(recipe, groups, pipeline);
      }
    }

    const build = scopes.get('build')!;

    signal.throwIfAborted();

    if (darwin) {
      const { sealInstalledBundle } = await import(pathToFileURL(path.join(build.root,
        'tools/installedBundle.mts')).href) as typeof import('./installedBundle.mts');
      const stagingDigest = (await fs.readFile(build.env.GRIGDESK_BUNDLE_RECEIPT!, 'utf8')).trim();

      const privateKeyFile = path.join(runsDir, created.runId, 'private.pem');
      const staging = build.env.GRIGDESK_BUNDLE_STAGE!;

      await sealInstalledBundle(staging, artifactsRoot, stagingDigest, async (text) => {
        signal.throwIfAborted();

        const key = createPrivateKey(await fs.readFile(privateKeyFile, 'utf8'));

        return sign(null, Buffer.from(text), key).toString('base64');
      });
    } else {
      const bundleLog = path.join(runDir, 'bundle.log');

      temporaryDirectories.set(build.env.TMPDIR!, false);

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
        logFile: bundleLog,
        receiptDir: path.join(runDir, 'receipts'),
        observer: progress?.observer(bundleLog),
      });

      temporaryDirectories.set(build.env.TMPDIR!, bundle.cleanupConfirmed);

      if (bundle.code !== 0) {
        return bundle.code;
      }

      await fs.rename(path.join(build.root, 'release-artifacts'), artifactsRoot);
    }

    signal.throwIfAborted();
    progress?.phase('acceptance');

    const index = JSON.parse(await fs.readFile(path.join(artifactsRoot, `${channel}.json`), 'utf8'));
    const manifestDigest = sha256(releaseSignedBytes(index.latest));
    const verify = scopes.get('verify')!;
    const verifier = await import(pathToFileURL(path.join(verify.root,
      'tools/verifyInstallation.mts')).href);
    const installRoot = path.join(runDir, 'acceptance');

    const proofs = await verifier.verifyInstallation(artifactsRoot, snapshot.commit, {
      trust: {
        purpose: 'local',
        publicKeyPem: created.record.publicKeyPem,
        expectedCommit: snapshot.commit,
        expectedManifestDigest: manifestDigest,
      },
      installRoot,
      signal,
      nativeTools: darwin ? verify.env : undefined,
      onScopeState: (state: import('./verifyInstallation.mts').VerificationScopeState) => {
        const clean = state === 'idle' || state === 'clean';

        temporaryDirectories.set(verify.env.TMPDIR!, clean);

        if (state === 'unknown') {
          process.stderr.write(`Сохранена временная установка ${installRoot}\n`);
        }
      },
    });

    progress?.completed();
    progress?.phase('record');

    signal.throwIfAborted();

    await fs.writeFile(path.join(artifactsRoot, 'local-build.json'), JSON.stringify({
      runId: created.runId,
      sourceDigest: snapshot.sourceDigest,
      recipeDigest: digest,
      testTrustFingerprint: sha256(created.record.publicKeyPem),
      toolchain,
      installation: proofs,
      guiAcceptance: 'not-performed',
    }, null, 2) + '\n', { mode: 0o600 });

    signal.throwIfAborted();

    const inventory = [];

    for (const name of await fs.readdir(artifactsRoot)) {
      signal.throwIfAborted();

      const file = path.join(artifactsRoot, name);

      inventory.push({
        name,
        size: (await fs.stat(file)).size,
        sha256: await sha256File(file, signal)
      });
    }

    signal.throwIfAborted();
    await removeScratchDirectories();

    if (!darwin) {
      signal.throwIfAborted();
      await publishDistributionOutput(artifactsRoot, candidate);
    }

    await completeRunRecord(runsDir, created.runId, 'verified', inventory, {
      manifestDigest,
      signal,
      verificationTools: darwinTools ? {
        processIdentity: darwinTools.processIdentity.sha256,
        setsid: darwinTools.setsid.sha256,
      } : undefined,
    });
    verified = true;
    progress?.success();
    process.stdout.write(`Кандидат: ${candidate}\nТолько локальное тестовое доверие.\n`
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
