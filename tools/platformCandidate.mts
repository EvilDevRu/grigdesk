import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { promisify } from 'node:util';

import { canonicalJson } from '../shared/lib/canonicalJson.ts';
import { sha256, sha256File } from '../shared/node/hash.ts';
import { buildReleaseIdentity, parseProductVersion } from '../shared/runtime/productReleaseVersion.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../shared/runtime/releaseChannelContracts.ts';
import type { ReleasePayload } from '../shared/runtime/installedUpdateContracts.ts';
import { sourceFingerprint } from './distributionSnapshot.mts';
import { decodeRecipe, recipeDigest, recipeImplementationBytes } from './releasePipeline.mts';
import { verifyDistributionArtifacts } from './releaseArtifactVerification.mts';
import { checkRuntimePinOutcomes, readRuntimePinJson } from './ci/runtimePinEvidence.mts';
import { apiContractFingerprint } from './api-version.mjs';

export const candidatePlatforms = ['linux-x64', 'darwin-arm64'] as const;

export type CandidatePlatform = typeof candidatePlatforms[number];
type ReleaseIdentity = ReturnType<typeof buildReleaseIdentity>;

const execute = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, '..');
const ordinaryFiles = ['grigdesk-install', 'grigdesk-install.sha256', 'grigdesk-install.sig',
  'grigdesk-maintenance.gz', 'dev.json', 'desktop.tar.gz', 'server.tar.gz', 'control.tar.gz',
  'local-build.json', 'release-acceptance.json'];
const hex = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const positive = /^[1-9][0-9]*$/u;
const filesEqual = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

export interface CandidatePlanInput {
  platforms: string;
  channel: string;
  publish: boolean;
  testMode: string;
  reason: string;
  validationRun: string;
  ref: string;
  runNumber: string;
  attempt: string;
  commit: string;
  sourceDigest: string;
  recipeDigest: string;
  baseVersion: string;
}

/**
 * Единственный dispatch получает общую identity и номер соседнего QA выпуска.
 * Публикация, повтор run и пропуск проверок отвергаются до доступа к ключу.
 */
export function resolveCandidatePlan(input: CandidatePlanInput) {
  if (!['macos', 'linux-and-macos'].includes(input.platforms)
    || input.channel !== 'dev' || input.publish || input.testMode !== 'full'
    || input.reason !== '' || input.validationRun !== ''
    || !['refs/heads/main', 'refs/heads/dev'].includes(input.ref)
    || !positive.test(input.runNumber) || input.attempt !== '1' || !commitPattern.test(input.commit)
    || !hex.test(input.sourceDigest) || !hex.test(input.recipeDigest)) {
    throw new Error('dual_candidate_input_invalid');
  }

  const base = parseProductVersion(input.baseVersion);
  const number = Number(input.runNumber) * 2;
  const platforms: readonly CandidatePlatform[] = input.platforms === 'macos'
    ? ['darwin-arm64'] : candidatePlatforms;

  if (!base || base.dev !== null || !Number.isSafeInteger(number)) {
    throw new Error('dual_candidate_version_invalid');
  }

  return {
    format: 1 as const,
    platforms,
    ref: input.ref,
    sourceDigest: input.sourceDigest,
    recipeDigest: input.recipeDigest,
    candidate: buildReleaseIdentity('dev', `${input.baseVersion}-dev.${number}`, input.commit),
    previous: buildReleaseIdentity('dev', `${input.baseVersion}-dev.${number - 1}`, input.commit),
  };
}

export interface CandidatePlan {
  runId: string;
  attempt: 1;
  plan: ReturnType<typeof resolveCandidatePlan>;
}

interface CandidateInfo {
  publicKeyBase64: string;
  signerFingerprint: string;
  manifestDigest: string;
  fileDigest: string;
}

interface SourceRuntimePin {
  id: string;
  sha256: string;
}

export interface CandidateVerification {
  installModes: ['local', 'remote', 'server'];
  runtime: Record<string, unknown>;
  passed: string[];
}

export const macPackagedChecks = [
  'MAC-VERIFY-BYTES', 'MAC-VERIFY-MODES', 'MAC-VERIFY-PROBES', 'MAC-VERIFY-ENGINE',
  'MAC-VERIFY-RUNTIME-PIN', 'MAC-VERIFY-DRAIN', 'MAC-VERIFY-EXIT', 'MAC-VERIFY-UPDATE',
  'MAC-VERIFY-ROLLBACK-PAIR', 'MAC-VERIFY-RECOVERY-PAIR', 'MAC-VERIFY-ROLLBACK-SERVER',
  'MAC-VERIFY-LAUNCHER', 'MAC-VERIFY-MISSING',
];
export const linuxPackagedChecks = ['LINUX-VERIFY-MODES', 'LINUX-VERIFY-OFFLINE-UPDATE'];
export const candidateOrigin = 'https://candidate.invalid';

function platformDescriptor(platform: CandidatePlatform): ReleasePayload['platform'] {
  return platform === 'linux-x64'
    ? {
      os: 'linux',
      arch: 'x64',
      glibc: '2.28',
    } : {
      os: 'darwin',
      arch: 'arm64',
      minMacOS: '15.0',
    };
}

/**
 * Обязательная опись разрешает только обычные файлы. Ни marker, ни режим
 * исполняемости после скачивания не заменяют проверку подписанных байтов.
 */
export async function assertCandidateFiles(
  directory: string, platform: CandidatePlatform, phase: 'input' | 'verified',
) {
  if (!candidatePlatforms.includes(platform) || !['input', 'verified'].includes(phase)) {
    throw new Error('candidate_files_invalid');
  }

  const expected = [...ordinaryFiles];

  if (phase === 'verified') {
    expected.push(`${platform}-acceptance.json`, `README-${platform}.md`);
  }

  const actual = (await fs.readdir(directory)).sort();

  if (!actual.includes('local-build.json')) {
    throw new Error('candidate_marker_missing');
  }

  if (!filesEqual(expected.sort(), actual)) {
    throw new Error('candidate_files_invalid');
  }

  for (const name of actual) {
    const item = await fs.lstat(path.join(directory, name));

    if (!item.isFile() || item.nlink !== 1) {
      throw new Error('candidate_file_type_invalid:' + name);
    }
  }

  return actual;
}

/**
 * Опись привязывает размеры и SHA каждого из разрешённых имён.
 * Артефакты GitHub могут сбрасывать mode при скачивании.
 */
async function candidateFilesDigest(directory: string, files: string[]): Promise<string> {
  const entries = [];

  for (const name of files) {
    const file = path.join(directory, name);

    entries.push({
      name,
      size: (await fs.lstat(file)).size,
      sha256: await sha256File(file),
    });
  }

  return sha256(canonicalJson(entries));
}

/**
 * Ключ идёт из trusted job outputs, а не из файла пакета. Проверяется
 * каноничность PEM, точный Base64 и отдельно закреплённый fingerprint.
 */
export function candidateKey(publicKeyBase64: string, expected?: string) {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  const pem = raw.toString('utf8');
  const key = createPublicKey(pem);
  const fingerprint = sha256(raw);

  if (raw.toString('base64') !== publicKeyBase64
    || String(key.export({ type: 'spki', format: 'pem' })) !== pem
    || key.asymmetricKeyType !== 'ed25519' || expected !== undefined && fingerprint !== expected) {
    throw new Error('candidate_public_key_invalid');
  }

  return { pem, fingerprint };
}

const identityFields = (identity: ReleaseIdentity) => ({
  channel: identity.channel,
  version: identity.version,
  commit: identity.commit,
  releaseId: identity.releaseId,
});

function candidateMarker(plan: CandidatePlan, platform: CandidatePlatform, identity: ReleaseIdentity) {
  return {
    format: 1,
    target: platform,
    runId: plan.runId,
    version: identity.version,
    sourceDigest: plan.plan.sourceDigest,
    recipeDigest: plan.plan.recipeDigest,
  };
}

/**
 * Shared gate подтверждает package identity, marker и подписи по pinned trust.
 * Verify и сборщик пары используют один контракт без запуска бинарников.
 */
export async function inspectPlatformCandidate(
  directory: string, plan: CandidatePlan, platform: CandidatePlatform,
  identity: ReleaseIdentity, info: Omit<CandidateInfo, 'fileDigest'> & { fileDigest?: string },
  phase: 'input' | 'verified',
) {
  if (!plan.plan.platforms.includes(platform)) {
    throw new Error('candidate_platform_not_selected');
  }

  const list = await assertCandidateFiles(directory, platform, phase);
  const key = candidateKey(info.publicKeyBase64, info.signerFingerprint);
  const marker = JSON.parse(await fs.readFile(path.join(directory, 'local-build.json'), 'utf8'));

  if (!filesEqual(marker, candidateMarker(plan, platform, identity))) {
    throw new Error('candidate_marker_invalid');
  }

  const trust = {
    purpose: 'candidate' as const,
    publicKeyPem: key.pem,
    expectedCommit: identity.commit,
    expectedManifestDigest: info.manifestDigest,
  };
  const verified = await verifyDistributionArtifacts(directory, trust);
  const payload = verified.envelope.payload;
  const artifactOrigins = Object.values(payload.artifacts).map(({ url }) => new URL(url).origin);

  if (verified.bootstrap.origin !== candidateOrigin
    || artifactOrigins.some((origin) => origin !== candidateOrigin)) {
    throw new Error('candidate_origin_invalid');
  }

  const expectedPlatform = platformDescriptor(platform);
  const build = JSON.parse(await fs.readFile(path.join(directory, 'release-acceptance.json'), 'utf8'));

  if (!filesEqual(identityFields(identity), identityFields(payload))
    || !filesEqual(payload.platform, expectedPlatform) || !filesEqual(build.identity, identity)
    || build.manifestDigest !== info.manifestDigest) {
    throw new Error('candidate_identity_invalid');
  }

  const fileDigest = await candidateFilesDigest(directory, list);

  if (info.fileDigest && fileDigest !== info.fileDigest) {
    throw new Error('candidate_file_digest_invalid');
  }

  return {
    trust,
    list,
    fileDigest,
  };
}

/**
 * Для Linux и Mac набор доказательств закрыт. У Mac исходный runtime receipt
 * передаётся отдельно от packaged acceptance и сверяется с outputs.
 */
function checkVerification(platform: CandidatePlatform, verification: CandidateVerification,
  sourceRuntimePin: SourceRuntimePin | null) {
  const expected = platform === 'darwin-arm64' ? macPackagedChecks : linuxPackagedChecks;

  if (!Array.isArray(verification.passed)
    || !filesEqual([...verification.passed].sort(), [...expected].sort())
    || !filesEqual(verification.installModes, ['local', 'remote', 'server'])
    || !verification.runtime || typeof verification.runtime !== 'object'
    || (platform === 'darwin-arm64') !== Boolean(sourceRuntimePin)
    || sourceRuntimePin && (!positive.test(sourceRuntimePin.id) || !hex.test(sourceRuntimePin.sha256))) {
    throw new Error('candidate_acceptance_incomplete');
  }

  if (platform === 'darwin-arm64') {
    checkRuntimePinOutcomes('packaged', verification.runtime.runtimePin);
  }
}

/**
 * Платформенный verifier вызывается только после подписанных байтов A/B.
 * Новый каталог создаётся лишь после полного успеха проверок.
 */
export async function verifyAndCopyCandidate(input: {
  plan: CandidatePlan;
  platform: CandidatePlatform;
  currentDir: string;
  previousDir: string;
  output: string;
  current: CandidateInfo;
  previous: CandidateInfo;
  sourceRuntimePin: SourceRuntimePin | null;
  verify(): Promise<CandidateVerification>;
}) {
  const { plan, platform, currentDir, previousDir, output, current, previous, sourceRuntimePin } = input;
  const checked = await inspectPlatformCandidate(
    currentDir, plan, platform, plan.plan.candidate, current, 'input');

  await inspectPlatformCandidate(previousDir, plan, platform, plan.plan.previous, previous, 'input');

  if (current.signerFingerprint !== previous.signerFingerprint) {
    throw new Error('candidate_signer_mismatch');
  }

  const verification = await input.verify();

  checkVerification(platform, verification, sourceRuntimePin);

  const marker = candidateMarker(plan, platform, plan.plan.candidate);
  const acceptance = {
    ...marker,
    commit: plan.plan.candidate.commit,
    manifestDigest: current.manifestDigest,
    signerFingerprint: current.signerFingerprint,
    sourceRuntimePin,
    verification,
  };

  await fs.mkdir(output, { mode: 0o700 });

  for (const name of checked.list) {
    await fs.copyFile(path.join(currentDir, name), path.join(output, name));
  }

  await fs.writeFile(path.join(output, `${platform}-acceptance.json`), canonicalJson(acceptance) + '\n');

  const mac = platform === 'darwin-arm64'
    ? 'Сборка подписана ad hoc. Нотариализация Apple выполняется отдельно.\n'
    : '';
  const installerSha256 = await sha256File(path.join(output, 'grigdesk-install'));
  const readme = '# GrigDesk ' + plan.plan.candidate.version + '\n\n'
    + `Платформа ${platform}. Коммит ${plan.plan.candidate.commit}.\n\n`
    + `Сверьте SHA-256 установщика с итогом Actions. Полученный SHA-256 ${installerSha256}.\n\n`
    + 'Запустите `sh ./grigdesk-install --source-dir "$PWD"` из распакованного каталога.\n\n'
    + mac;

  await fs.writeFile(path.join(output, `README-${platform}.md`), readme);

  return candidateFilesDigest(output, await assertCandidateFiles(output, platform, 'verified'));
}

/**
 * Все выбранные платформы проверяются до создания выходного каталога.
 * Для Mac сохраняется связь с source receipt в любом режиме.
 */
export async function collectVerifiedCandidates(input: {
  plan: CandidatePlan;
  output: string;
  directories: Partial<Record<CandidatePlatform, string>>;
  info: Partial<Record<CandidatePlatform, CandidateInfo>>;
  sourceRuntimePin: SourceRuntimePin;
  sourceReceipt: string;
}) {
  const { plan, directories, info, sourceRuntimePin, output } = input;
  const platforms = [...plan.plan.platforms].sort();

  if (!filesEqual(Object.keys(directories).sort(), platforms)
    || !filesEqual(Object.keys(info).sort(), platforms)) {
    throw new Error('candidate_platform_selection_mismatch');
  }

  await verifyMacSourcePin(input.sourceReceipt, plan, sourceRuntimePin.sha256);

  if (info['linux-x64'] && info['linux-x64'].signerFingerprint !== info['darwin-arm64']?.signerFingerprint) {
    throw new Error('candidate_signer_mismatch');
  }

  const all = [];

  for (const platform of plan.plan.platforms) {
    const directory = directories[platform]!;
    const expected = info[platform]!;
    const result = await inspectPlatformCandidate(directory, plan, platform, plan.plan.candidate, expected,
      'verified');
    const proof = JSON.parse(await fs.readFile(path.join(directory, `${platform}-acceptance.json`), 'utf8'));
    const source = platform === 'darwin-arm64' ? sourceRuntimePin : null;

    if (!filesEqual(proof, {
      ...candidateMarker(plan, platform, plan.plan.candidate),
      commit: plan.plan.candidate.commit,
      manifestDigest: expected.manifestDigest,
      signerFingerprint: expected.signerFingerprint,
      sourceRuntimePin: source,
      verification: proof.verification,
    })) {
      throw new Error('candidate_acceptance_invalid');
    }

    checkVerification(platform, proof.verification, source);
    all.push({
      platform,
      directory,
      files: result.list,
      fileDigest: expected.fileDigest,
    });
  }

  await fs.mkdir(output, { mode: 0o700 });

  for (const entry of all) {
    const target = path.join(output, entry.platform);

    await fs.mkdir(target, { mode: 0o700 });

    for (const name of entry.files) {
      await fs.copyFile(path.join(entry.directory, name), path.join(target, name));
    }

    if (await candidateFilesDigest(target, entry.files) !== entry.fileDigest) {
      throw new Error('candidate_file_digest_invalid');
    }
  }
}

/**
 * Идентичность snapshot вычисляется до подстановки candidate key.
 * Linux и Mac используют один digest реализации парного рецепта.
 */
export async function candidateRecipeDigest(root: string) {
  const recipeFile = path.join(root, 'tools/releaseRecipe.json');
  const recipe = decodeRecipe(JSON.parse(await fs.readFile(recipeFile, 'utf8')));

  return recipeDigest(recipe, await recipeImplementationBytes(root, true));
}

function environment(name: string): string {
  const value = process.env[name];

  if (!value || /[\r\n]/u.test(value)) {
    throw new Error('candidate_environment_missing:' + name);
  }

  return value;
}

/**
 * Все job outputs имеют однострочные фиксированные поля.
 * Переданные значения не могут открыть новый workflow output.
 */
async function emit(values: Record<string, string>,
  channel: 'GITHUB_OUTPUT' | 'GITHUB_ENV' = 'GITHUB_OUTPUT') {
  if (Object.values(values).some((value) => /[\r\n]/u.test(value))) {
    throw new Error('candidate_output_invalid');
  }

  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join('');

  await fs.appendFile(environment(channel), lines);
}

async function publishIdentity(identity: ReleaseIdentity) {
  await emit({
    GRIGDESK_RELEASE_VERSION: identity.version,
    GRIGDESK_RELEASE_CHANNEL: identity.channel,
    GRIGDESK_RELEASE_COMMIT: identity.commit,
    GRIGDESK_RELEASE_ID: identity.releaseId,
  }, 'GITHUB_ENV');
}

/**
 * План записывается один раз из checkout точного SHA. Build и verify
 * получают и digest файла, и отдельно ожидаемую identity.
 */
async function writePlan(destination: string) {
  const commit = await checkoutCommit(sourceRoot);
  const publish = environment('CANDIDATE_PUBLISH');
  const runId = environment('GITHUB_RUN_ID');

  if (!['true', 'false'].includes(publish) || !positive.test(runId)) {
    throw new Error('dual_candidate_input_invalid');
  }

  const plan = resolveCandidatePlan({
    platforms: environment('CANDIDATE_PLATFORMS'),
    channel: environment('CANDIDATE_CHANNEL'),
    publish: publish === 'true',
    testMode: environment('CANDIDATE_TEST_MODE'),
    reason: process.env.CANDIDATE_SKIP_REASON ?? '',
    validationRun: process.env.CANDIDATE_VALIDATION_RUN ?? '',
    ref: environment('GITHUB_REF'),
    runNumber: environment('GITHUB_RUN_NUMBER'),
    attempt: environment('GITHUB_RUN_ATTEMPT'),
    commit,
    sourceDigest: await sourceFingerprint(sourceRoot),
    recipeDigest: await candidateRecipeDigest(sourceRoot),
    baseVersion: (await fs.readFile(path.join(sourceRoot, 'VERSION'), 'utf8')).trim(),
  });
  const bytes = canonicalJson({
    runId,
    attempt: 1,
    plan,
  }) + '\n';

  await fs.writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
  await emit({
    digest: sha256(bytes),
    recipe_digest: plan.recipeDigest,
    source_digest: plan.sourceDigest,
    version: plan.candidate.version,
    previous_version: plan.previous.version,
    commit,
    release_id: plan.candidate.releaseId,
    run_id: runId,
  });
  await publishIdentity(plan.candidate);
}

/**
 * Read checks expected digest and the authoritative GitHub SHA before use.
 * Публичный пакет не назначает собственный ref, версию или run.
 */
async function readPlan(file: string): Promise<CandidatePlan> {
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.size > 32 * 1024) {
    throw new Error('candidate_plan_invalid');
  }

  const bytes = await fs.readFile(file, 'utf8');

  if (sha256(bytes) !== environment('CANDIDATE_PLAN_SHA256')) {
    throw new Error('candidate_plan_digest_invalid');
  }

  const value = JSON.parse(bytes) as CandidatePlan;
  const rebuilt = resolveCandidatePlan({
    platforms: environment('CANDIDATE_PLATFORMS'),
    channel: 'dev',
    publish: false,
    testMode: 'full',
    reason: '',
    validationRun: '',
    ref: environment('GITHUB_REF'),
    runNumber: environment('GITHUB_RUN_NUMBER'),
    attempt: environment('GITHUB_RUN_ATTEMPT'),
    commit: await checkoutCommit(sourceRoot),
    sourceDigest: environment('CANDIDATE_SOURCE_DIGEST'),
    recipeDigest: environment('CANDIDATE_RECIPE_DIGEST'),
    baseVersion: (await fs.readFile(path.join(sourceRoot, 'VERSION'), 'utf8')).trim(),
  });
  const expected = {
    runId: environment('GITHUB_RUN_ID'),
    attempt: 1,
    plan: rebuilt,
  };

  if (!filesEqual(value, expected) || rebuilt.candidate.version !== environment('CANDIDATE_VERSION')
    || rebuilt.previous.version !== environment('CANDIDATE_PREVIOUS_VERSION')) {
    throw new Error('candidate_plan_identity_invalid');
  }

  return value;
}

/**
 * Проверяет настоящий checkout без доверия к имени каталога.
 * В каждой фазе HEAD совпадает со значением из контекста текущего run.
 */
async function checkoutCommit(root: string): Promise<string> {
  const selected = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

  if (!commitPattern.test(selected) || selected !== environment('GITHUB_SHA')) {
    throw new Error('release_checkout_commit_mismatch');
  }

  return selected;
}

/**
 * Готовит только checkout с публичным ключом и source policy. Оригинал
 * сохраняет штатный канал, а private key появляется лишь при seal.
 */
async function makeScope(plan: CandidatePlan, output: string) {
  const { pem } = candidateKey(environment('CANDIDATE_PUBLIC_KEY_B64'));

  if (createPublicKey(RELEASE_SIGNING_PUBLIC_KEY).export({ type: 'spki', format: 'pem' }) === pem) {
    throw new Error('candidate_key_must_be_separate');
  }

  await execute('git', ['clone', '--shared', '--no-checkout', sourceRoot, output], { timeout: 120000 });
  await execute('git', ['checkout', '--detach', plan.plan.candidate.commit], {
    cwd: output,
    timeout: 120000,
  });

  if (await sourceFingerprint(output) !== plan.plan.sourceDigest
    || await candidateRecipeDigest(output) !== plan.plan.recipeDigest) {
    throw new Error('candidate_source_digest_invalid');
  }

  const file = path.join(output, 'shared/runtime/releaseChannelContracts.ts');
  const apiPath = path.join(output, 'shared/client/apiVersion.ts');
  const apiVersion = await fs.readFile(apiPath, 'utf8');
  const fingerprintBefore = `API_CONTRACT_FINGERPRINT = '${apiContractFingerprint(output)}';`;
  const stored = await fs.readFile(file, 'utf8');
  const key = /export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u;
  const policy = /RELEASE_DISTRIBUTION_SOURCE: ReleaseDistributionSource = 'channel';/u;

  if (!key.test(stored) || !policy.test(stored) || !apiVersion.includes(fingerprintBefore)) {
    throw new Error('candidate_signing_anchor_missing');
  }

  const newKey = `export const RELEASE_SIGNING_PUBLIC_KEY = ${JSON.stringify(pem)};`;
  const newPolicy = "RELEASE_DISTRIBUTION_SOURCE: ReleaseDistributionSource = 'candidate-file';";

  await fs.writeFile(file, stored.replace(key, newKey).replace(policy, newPolicy));

  const fingerprint = `API_CONTRACT_FINGERPRINT = '${apiContractFingerprint(output)}';`;

  await fs.writeFile(apiPath, apiVersion.replace(fingerprintBefore, fingerprint));
}

/**
 * Открывает ключ по одному FD и подтверждает тот же публичный PEM.
 * Этот порт вызывается только после проверки staging и identity.
 */
async function readCandidateSigner(pinnedPem: string): Promise<KeyObject> {
  const secret = environment('CANDIDATE_SIGNING_KEY_FILE');
  const handle = await fs.open(secret, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1
      || (stat.mode & 0o7777) !== 0o600 || stat.size > 16 * 1024) {
      throw new Error('candidate_signer_invalid');
    }

    const key = createPrivateKey(await handle.readFile('utf8'));
    const derived = createPublicKey(key).export({ type: 'spki', format: 'pem' });

    if (derived !== pinnedPem) {
      throw new Error('candidate_signer_mismatch');
    }

    return key;
  } finally {
    await handle.close();
  }
}

/**
 * Seal проверяет expected platform/identity до чтения ключа.
 * Один проверенный key object подписывает manifest и installer.
 */
async function sealScope(plan: CandidatePlan, platform: CandidatePlatform, identity: ReleaseIdentity,
  stage: string, digestFile: string, output: string) {
  if (!plan.plan.platforms.includes(platform)) {
    throw new Error('candidate_platform_not_selected');
  }

  const { sealInstalledBundle } = await import('./installedBundle.mts');
  const digest = (await fs.readFile(digestFile, 'utf8')).trim();
  const publicKeyBase64 = environment('CANDIDATE_PUBLIC_KEY_B64');
  const key = candidateKey(publicKeyBase64);

  if (!hex.test(digest) || key.pem !== RELEASE_SIGNING_PUBLIC_KEY) {
    throw new Error('candidate_signer_mismatch');
  }

  let privateKey: KeyObject | undefined;

  await sealInstalledBundle(stage, output, digest, async (text) => {
    privateKey ??= await readCandidateSigner(key.pem);

    return sign(null, Buffer.from(text), privateKey).toString('base64');
  }, {
    identity,
    platform: platformDescriptor(platform),
    origin: candidateOrigin,
  });

  const marker = candidateMarker(plan, platform, identity);

  await fs.writeFile(path.join(output, 'local-build.json'), canonicalJson(marker) + '\n', { flag: 'wx' });

  const build = JSON.parse(await fs.readFile(path.join(output, 'release-acceptance.json'), 'utf8'));
  const manifestDigest = build.manifestDigest as string;
  const result = await inspectPlatformCandidate(output, plan, platform, identity, {
    publicKeyBase64,
    signerFingerprint: key.fingerprint,
    manifestDigest,
  }, 'input');
  const prefix = identity.version === plan.plan.candidate.version ? 'current' : 'previous';

  await emit({
    [prefix + '_digest']: manifestDigest,
    [prefix + '_file_digest']: result.fileDigest,
    public_key: publicKeyBase64,
    signer_fingerprint: key.fingerprint,
  });
}

/**
 * Source pin report доверяет identity плана и SHA job output. Пересчитанный
 * SHA подменённого receipt сам по себе не может изменить эти ожидания.
 */
export async function verifyMacSourcePin(file: string, plan: CandidatePlan, expectedSha256: string) {
  if (!hex.test(expectedSha256)) {
    throw new Error('mac_runtime_pin_source_digest_invalid');
  }

  const report = await readRuntimePinJson(file, false, expectedSha256) as Record<string, unknown>;

  if (!filesEqual(report, {
    format: 1,
    stage: 'mac-runtime-pin-source',
    code: 0,
    commit: plan.plan.candidate.commit,
    sourceDigest: plan.plan.sourceDigest,
    recipeDigest: plan.plan.recipeDigest,
    outcomes: report.outcomes,
  })) {
    throw new Error('mac_runtime_pin_source_identity_invalid');
  }

  return checkRuntimePinOutcomes('source', report.outcomes);
}

/**
 * Каждый Ubuntu job отдаёт один receipt из своей группы. Пакетный build
 * сверяет полный обязательный набор со своим pinned общим рецептом.
 */
async function verifySharedReceipt(directory: string, plan: CandidatePlan, job: 'server' | 'web') {
  const entries = (await fs.readdir(directory)).filter((name) => /^pipeline-[a-f0-9-]+\.json$/u.test(name));

  if (entries.length !== 1) {
    throw new Error('candidate_pipeline_receipt_missing:' + job);
  }

  const receipt = await readRuntimePinJson(path.join(directory, entries[0]!)) as {
    code: number;
    format: number;
    cleanupConfirmed: boolean;
    sourceDigest: string;
    recipeDigest: string;
    outcomes: Record<string, { status: string; exitCode: number }>;
  };
  const recipe = decodeRecipe(JSON.parse(await fs.readFile(path.join(sourceRoot, 'tools/releaseRecipe.json'),
    'utf8')));
  const mandatory = recipe.stages.filter((stage) =>
    [job, 'prepare-' + job, 'prepare-build'].includes(stage.group) && stage.required !== false);

  if (receipt.format !== 1 || receipt.code !== 0 || receipt.cleanupConfirmed !== true
    || receipt.sourceDigest !== plan.plan.sourceDigest || receipt.recipeDigest !== plan.plan.recipeDigest
    || mandatory.some(({ id }) => receipt.outcomes?.[id]?.status !== 'success'
      || receipt.outcomes[id]!.exitCode !== 0)) {
    throw new Error('candidate_pipeline_receipt_invalid:' + job);
  }
}

function infoFromEnvironment(prefix: string, version: 'current' | 'previous' = 'current'): CandidateInfo {
  const variant = prefix + (version === 'previous' ? 'PREVIOUS_' : '');

  return {
    publicKeyBase64: environment(prefix + 'PUBLIC_KEY'),
    signerFingerprint: environment(prefix + 'SIGNER_FINGERPRINT'),
    manifestDigest: environment(variant + 'MANIFEST_DIGEST'),
    fileDigest: environment(variant + 'FILE_DIGEST'),
  };
}

function sourcePinFromEnvironment(): SourceRuntimePin {
  return {
    id: environment('MAC_SOURCE_PIN_ID'),
    sha256: environment('MAC_SOURCE_PIN_SHA256'),
  };
}

function platformArgument(value: string | undefined): CandidatePlatform {
  if (value !== 'linux-x64' && value !== 'darwin-arm64') {
    throw new Error('candidate_platform_invalid');
  }

  return value;
}

/**
 * CLI ограничивает фазу и пути. Pair обходится без исполнения распакованных
 * файлов, а native verify получает только готовые пакеты и проверяющий код.
 */
async function main(args: string[]) {
  const [action, ...argv] = args;

  if (action === 'plan' && argv.length === 1) {
    return writePlan(argv[0]!);
  }

  if (action === 'identity' && argv.length === 0) {
    const identity = buildReleaseIdentity('dev', environment('CANDIDATE_VERSION'),
      await checkoutCommit(sourceRoot));

    await emit({ GRIGDESK_RELEASE_DUAL: '1' }, 'GITHUB_ENV');

    return publishIdentity(identity);
  }

  const runner = environment('RUNNER_TEMP');
  const plan = await readPlan(path.join(runner, 'candidate-plan/candidate-plan.json'));
  const sourcePin = path.join(runner, 'source-pin/mac-runtime-pin-source.json');

  if (action === 'scope' && argv.length === 1) {
    return makeScope(plan, argv[0]!);
  }

  if (action === 'receipts' && argv.length === 2) {
    await verifySharedReceipt(argv[0]!, plan, 'server');
    await verifySharedReceipt(argv[1]!, plan, 'web');

    return;
  }

  if (action === 'seal' && argv.length === 5 && ['current', 'previous'].includes(argv[1]!)) {
    const [target, release, stage, digest, output] = argv;
    const identity = release === 'current' ? plan.plan.candidate : plan.plan.previous;

    return sealScope(plan, platformArgument(target), identity, stage!, digest!, output!);
  }

  if (action === 'verify' && argv.length === 4) {
    const [target, currentDir, previousDir, output] = argv;
    const platform = platformArgument(target);
    const sourceRuntimePin = platform === 'darwin-arm64' ? sourcePinFromEnvironment() : null;
    const current = infoFromEnvironment('BUILD_');
    const previous = infoFromEnvironment('BUILD_', 'previous');

    if (sourceRuntimePin) {
      await verifyMacSourcePin(sourcePin, plan, sourceRuntimePin.sha256);
    }

    const fileDigest = await verifyAndCopyCandidate({
      plan,
      platform,
      currentDir: currentDir!,
      previousDir: previousDir!,
      output: output!,
      current,
      previous,
      sourceRuntimePin,
      async verify() {
        const { runPlatformAcceptance } = await import('./verifyPlatformCandidate.mts');

        return runPlatformAcceptance(platform, currentDir!, previousDir!, plan, current, previous);
      },
    });

    return emit({
      file_digest: fileDigest,
      manifest_digest: current.manifestDigest,
      public_key: current.publicKeyBase64,
      signer_fingerprint: current.signerFingerprint,
      ...(sourceRuntimePin ? {
        source_pin_id: sourceRuntimePin.id,
        source_pin_sha256: sourceRuntimePin.sha256,
      } : {}),
    });
  }

  if (action === 'collect' && argv.length === 3) {
    const sourceRuntimePin = sourcePinFromEnvironment();
    const [linux, macos, output] = argv as [string, string, string];
    const includeLinux = plan.plan.platforms.includes('linux-x64');

    await collectVerifiedCandidates({
      plan,
      output,
      directories: {
        ...(includeLinux ? { 'linux-x64': linux } : {}),
        'darwin-arm64': macos,
      },
      info: {
        ...(includeLinux ? { 'linux-x64': infoFromEnvironment('LINUX_') } : {}),
        'darwin-arm64': infoFromEnvironment('MAC_'),
      },
      sourceRuntimePin,
      sourceReceipt: sourcePin,
    });

    return emit({
      ...(includeLinux ? {
        linux_installer_sha256: await sha256File(path.join(output, 'linux-x64/grigdesk-install')),
      } : {}),
      macos_installer_sha256: await sha256File(path.join(output, 'darwin-arm64/grigdesk-install')),
    });
  }

  throw new Error('candidate_action_invalid');
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2));
}
