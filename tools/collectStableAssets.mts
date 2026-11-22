import { createPublicKey } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../shared/lib/objects.ts';
import { withWorkDirectory } from '../shared/node/files.ts';
import { sha256 } from '../shared/node/hash.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../shared/runtime/releaseChannelContracts.ts';
import { offlinePackageFiles, zipStore } from './linuxOfflinePackage.mts';
import { verifyDistributionArtifacts } from './releaseArtifactVerification.mts';
import { readStableReleasePlan } from './stableReleasePlan.mts';
import { collectStableAssetProof, stableAssetNames, type StableAssetPart, type StablePlatform }
  from './stablePlatformRelease.mts';
import { publicReleaseFile, verifyOfflineZip, type PublicReleaseFile } from './verifyLinuxPackages.mts';

const hex = /^[a-f0-9]{64}$/u;
const positive = /^[1-9][0-9]*$/u;
const nativeProofName = 'stable-native-proof.json';
const groups = {
  'darwin-arm64': ['darwin-arm64'],
  'linux-arm64': ['linux-arm64'],
  'windows-x64': ['windows-x64'],
  'windows-arm64': ['windows-arm64'],
  android: ['android-arm64', 'android-x86_64'],
} as const;

type NativeGroup = keyof typeof groups;
type NativePlatform = Exclude<StablePlatform, 'linux-x64'>;
type Plan = Awaited<ReturnType<typeof readStableReleasePlan>>;

interface Artifact {
  id: string;
  digest: string;
}

interface Collection {
  plan: Plan;
  planDigest: string;
  linuxBuild: string;
  linuxProof: string;
  linuxBuildId: string;
  linuxProofId: string;
  nativeRoot: string;
  nativeArtifacts: Record<NativeGroup, Artifact>;
  output: string;
  publicKeyPem: string;
}

const windowsFiles = [
  'grigdesk-install.ps1', 'grigdesk-install.ps1.sha256', 'grigdesk-install.ps1.sig',
  'grigdesk-maintenance.exe', 'release.json', 'desktop.exe', 'server.zip',
];

const sourceFiles = (platform: NativePlatform) => platform.startsWith('android-') ? ['grigdesk.apk']
  : platform.startsWith('windows-') ? windowsFiles : offlinePackageFiles('release');

/**
 * Читает маленький обычный JSON из отдельного каталога артефакта.
 * Digest относится к исходным байтам, полученным от проверяющего job.
 */
async function readProof(directory: string, name: string) {
  const file = path.join(directory, name);
  const entry = await fs.lstat(file);

  if (!entry.isFile() || entry.size > 1024 * 1024) {
    throw new Error('stable_asset_source_invalid');
  }

  const bytes = await fs.readFile(file);
  const value: unknown = JSON.parse(bytes.toString('utf8'));

  if (!isRecord(value)) {
    throw new Error('stable_asset_source_invalid');
  }

  return {
    value,
    digest: sha256(bytes),
  };
}

/**
 * Сверяет порядок, имена, SHA и размер каждого файла с верифицированной описью.
 * В вычисление никогда не поступает путь, прочитанный из proof.
 */
async function checkedFiles(directory: string, names: readonly string[],
  recorded: unknown): Promise<PublicReleaseFile[]> {
  if (!Array.isArray(recorded) || recorded.length !== names.length) {
    throw new Error('stable_asset_inventory_mismatch');
  }

  const files: PublicReleaseFile[] = [];

  for (const [index, name] of names.entries()) {
    const expected: unknown = recorded[index];
    const file = await publicReleaseFile(directory, name);

    if (!isRecord(expected) || expected.name !== file.name
      || expected.size !== file.size || expected.sha256 !== file.sha256) {
      throw new Error(`stable_asset_bytes_mismatch: ${name}`);
    }

    files.push(file);
  }

  return files;
}

/**
 * Проверяет отдельную выдачу нативного verifier по общему плану и точной описи.
 * Две Android ABI проходят независимо, результаты одной ABI не заменяют соседнюю.
 */
async function checkedNativeGroup(directory: string, group: NativeGroup,
  plan: Plan, planDigest: string, publicKeyPem: string, expectedDigest?: string) {
  const { value, digest } = await readProof(directory, nativeProofName);
  const platforms: readonly NativePlatform[] = groups[group];
  const expectedEntries = [...platforms, nativeProofName].sort();
  const key = createPublicKey(publicKeyPem);
  const fingerprint = sha256(key.export({ type: 'spki', format: 'der' }));
  const parts = [];

  if (expectedDigest !== undefined && digest !== expectedDigest
    || JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(expectedEntries)
    || value.format !== 1 || !Array.isArray(value.parts) || value.parts.length !== platforms.length
    || key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`stable_native_proof_invalid: ${group}`);
  }

  for (const [index, platform] of platforms.entries()) {
    const part: unknown = value.parts[index];

    if (!isRecord(part) || part.platform !== platform || part.version !== plan.current.version
      || part.commit !== plan.current.commit || part.releaseId !== plan.current.releaseId
      || part.channel !== 'release'
      || part.runId !== plan.runId || part.planDigest !== planDigest || part.signerFingerprint !== fingerprint
      || typeof part.manifestDigest !== 'string' || !hex.test(part.manifestDigest)) {
      throw new Error(`stable_native_proof_invalid: ${platform}`);
    }

    const source = path.join(directory, platform);
    const names = sourceFiles(platform);

    if (!(await fs.lstat(source)).isDirectory()
      || JSON.stringify((await fs.readdir(source)).sort()) !== JSON.stringify([...names].sort())) {
      throw new Error(`stable_native_inventory_invalid: ${platform}`);
    }

    const files = await checkedFiles(source, names, part.files);

    parts.push({
      platform,
      source,
      files,
    });
  }

  return { digest, parts };
}

/**
 * Собирает одну выдачу из проверенной сборки Linux и пяти нативных verify jobs.
 * Каталог появляется целиком после сверки файлов, отдельно от исходных артефактов.
 */
export async function collectStableAssets(input: Collection) {
  const { plan, planDigest, publicKeyPem } = input;
  const { commit, version } = plan.current;
  const expected = {
    commit,
    version,
    runId: plan.runId,
    planDigest,
  };
  const nativeIds = Object.fromEntries(Object.keys(groups).map((group) => [
    group, input.nativeArtifacts[group as NativeGroup]?.id,
  ]));
  const ids = [input.linuxBuildId, input.linuxProofId, ...Object.values(nativeIds)];

  if (ids.some((id) => typeof id !== 'string' || !positive.test(id))
    || new Set(ids).size !== ids.length || !hex.test(planDigest)) {
    throw new Error('stable_asset_artifact_ids_invalid');
  }

  const { value: proof } = await readProof(input.linuxProof, 'verified-proof.json');
  const manifestDigest = proof.digest;

  if (proof.commit !== commit || proof.version !== version || proof.channel !== 'release'
    || proof.signatureValid !== true || proof.installerSignatureValid !== true
    || proof.archiveHashesValid !== true
    || proof.inventoriesValid !== true || typeof manifestDigest !== 'string' || !hex.test(manifestDigest)) {
    throw new Error('stable_linux_proof_invalid');
  }

  const { envelope } = await verifyDistributionArtifacts(input.linuxBuild, {
    purpose: 'official',
    publicKeyPem,
    expectedCommit: commit,
    expectedManifestDigest: manifestDigest,
  });

  if (envelope.payload.releaseId !== plan.current.releaseId
    || envelope.payload.platform.os !== 'linux' || envelope.payload.platform.arch !== 'x64') {
    throw new Error('stable_linux_proof_invalid');
  }

  const linuxNames = stableAssetNames('linux-x64', version);
  const records = await checkedFiles(input.linuxBuild, linuxNames, proof.publicAssets);

  return withWorkDirectory(path.dirname(input.output), async (work) => {
    const stage = path.join(work, 'assets');

    await fs.mkdir(stage, { mode: 0o700 });

    for (const file of records) {
      await fs.copyFile(path.join(input.linuxBuild, file.name), path.join(stage, file.name));
    }

    const parts: StableAssetPart[] = [{
      ...expected,
      platform: 'linux-x64',
      channel: 'release',
      assets: await checkedFiles(stage, linuxNames, records),
    }];

    for (const group of Object.keys(groups) as NativeGroup[]) {
      const artifact = input.nativeArtifacts[group];

      if (!hex.test(artifact.digest)) {
        throw new Error('stable_native_proof_digest_invalid');
      }

      const directory = path.join(input.nativeRoot, group);
      const native = await checkedNativeGroup(directory, group, plan, planDigest,
        publicKeyPem, artifact.digest);

      for (const part of native.parts) {
        const [name] = stableAssetNames(part.platform, version);
        const destination = path.join(stage, name!);

        if (part.platform.startsWith('android-')) {
          await fs.copyFile(path.join(part.source, 'grigdesk.apk'), destination);
        } else {
          await zipStore(part.source, destination, part.files.map((file) => file.name));
          await verifyOfflineZip(destination, part.files);
        }

        const asset = await publicReleaseFile(stage, name!);

        if (part.platform.startsWith('android-')
          && (asset.size !== part.files[0]!.size || asset.sha256 !== part.files[0]!.sha256)) {
          throw new Error('stable_native_apk_bytes_mismatch');
        }

        parts.push({
          ...expected,
          platform: part.platform,
          channel: 'release',
          assets: [asset],
        });
      }
    }

    const result = {
      ...collectStableAssetProof(expected, parts),
      linuxBuildArtifactId: input.linuxBuildId,
      linuxVerifyProofArtifactId: input.linuxProofId,
      linuxManifestDigest: manifestDigest,
      nativeArtifactIds: nativeIds,
    };

    await fs.writeFile(path.join(stage, 'stable-assets-proof.json'), JSON.stringify(result, null, 2) + '\n');
    await fs.rename(stage, input.output);

    return result;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [command, planFile, ...args] = process.argv.slice(2);
  const env = process.env;
  const publicKeyPem = RELEASE_SIGNING_PUBLIC_KEY;
  const planDigest = env.STABLE_PLAN_SHA256 ?? '';

  if (!planFile) {
    throw new Error('stable_asset_arguments_invalid');
  }

  const plan = await readStableReleasePlan(planFile, {
    commit: env.GITHUB_SHA ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    digest: planDigest,
  });

  if (command === 'check-native') {
    const [group, directory, ...extra] = args;

    if (!group || !Object.hasOwn(groups, group) || !directory || extra.length || !env.GITHUB_OUTPUT) {
      throw new Error('stable_asset_arguments_invalid');
    }

    const result = await checkedNativeGroup(directory, group as NativeGroup, plan, planDigest, publicKeyPem);

    await fs.appendFile(env.GITHUB_OUTPUT, `proof_sha256=${result.digest}\n`);
  } else if (command === 'collect') {
    const [linuxBuild, linuxProof, nativeRoot, output, ...extra] = args;

    if (!linuxBuild || !linuxProof || !nativeRoot || !output || extra.length) {
      throw new Error('stable_asset_arguments_invalid');
    }

    const proof = await collectStableAssets({
      plan,
      planDigest,
      linuxBuild,
      linuxProof,
      linuxBuildId: env.LINUX_BUILD_ARTIFACT_ID ?? '',
      linuxProofId: env.LINUX_VERIFY_PROOF_ARTIFACT_ID ?? '',
      nativeRoot,
      nativeArtifacts: JSON.parse(env.STABLE_NATIVE_ARTIFACTS ?? '{}'),
      output,
      publicKeyPem,
    });

    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  } else {
    throw new Error('stable_asset_arguments_invalid');
  }
}
