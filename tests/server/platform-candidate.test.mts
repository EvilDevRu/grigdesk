import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { sha256, sha256File } from '../../shared/node/hash.ts';
import { macRuntimePinLeaves, type RuntimePinMode } from '../../tools/ci/runtimePinEvidence.mts';
import {
  assertCandidateFiles, candidateKey, candidateOrigin, collectVerifiedCandidates, linuxPackagedChecks,
  macPackagedChecks, resolveCandidatePlan, verifyAndCopyCandidate,
  type CandidatePlan, type CandidatePlatform, type CandidateVerification,
} from '../../tools/platformCandidate.mts';
import { renderBootstrap } from '../../tools/installBootstrap.mts';
import { archiveBytes } from '../helpers/installedUpdateFixture.mjs';
import { signedIndex, signedMacIndex } from '../helpers/releaseV2Fixture.mjs';

const checkout = path.resolve(import.meta.dirname, '../..');

function outcomes(mode: RuntimePinMode) {
  return macRuntimePinLeaves(mode).map(([id, barrier]) => ({
    barrier,
    id,
    outcome: 'passed',
  }));
}

/**
 * Writes signed fixture bytes for the artifact gate without running the files.
 * The package and installer signatures use the same throwaway key on both targets.
 */
async function signedCandidate(directory: string, platform: CandidatePlatform, tuple: CandidatePlan,
  variant: 'candidate' | 'previous', keys: { privateKey: KeyObject; publicKey: KeyObject }) {
  const identity = tuple.plan[variant];
  const darwin = platform === 'darwin-arm64';
  const release = (darwin ? signedMacIndex : signedIndex)({
    keys,
    channel: identity.channel,
    version: identity.version,
    origin: candidateOrigin,
  });
  const { publicKeyPem, envelope } = release;
  const entry = 'bin/grigdesk-ctl';
  const tool = Buffer.from('fixture control');
  const control = archiveBytes(entry, tool, '0', 0o555);
  const controlFiles = [{
    path: entry,
    size: tool.length,
    mode: 0o555,
    sha256: sha256(tool),
  }];

  const releasePath = darwin ? 'releases/darwin-arm64' : 'releases';

  envelope.payload.artifacts.control = {
    url: `${candidateOrigin}/${releasePath}/${identity.version}/control.tar.gz`,
    size: control.length,
    sha256: sha256(control),
    unpackedSize: tool.length,
    files: controlFiles,
    filesDigest: sha256(canonicalJson(controlFiles)),
    buildIdentity: identity,
  };

  const signedBytes = Buffer.from(`GrigDesk release v3\n${canonicalJson(envelope.payload)}\n`);
  const manifestDigest = sha256(signedBytes);
  const latest = {
    format: 3,
    payload: envelope.payload,
    signature: sign(null, signedBytes, keys.privateKey).toString('base64'),
  };
  const index = Buffer.from(canonicalJson({
    ...release.index,
    format: 3,
    latest,
  }) + '\n');
  const helper = Buffer.from('fixture helper');
  const compressed = gzipSync(helper);
  const archives = release.envelope.payload.artifacts;
  const overhead = index.length + compressed.length + control.length;
  const template = await fs.readFile(path.join(checkout, 'tools/installBootstrap.sh'), 'utf8');
  const messages = Object.fromEntries(await Promise.all(['ru', 'en'].map(async (locale) => [
    locale, JSON.parse(await fs.readFile(path.join(checkout, 'shared/i18n/assets/locales',
      locale, 'installer.json'), 'utf8')),
  ]))) as { en: Record<string, string>; ru: Record<string, string> };
  const installer = renderBootstrap({
    format: 1,
    channel: identity.channel,
    version: identity.version,
    origin: candidateOrigin,
    ...darwin ? { platform: 'darwin-arm64' as const } : {},
    delivery: 'candidate-file',
    manifestDigest,
    indexSha256: sha256(index),
    indexSize: index.length,
    helperSha256: sha256(helper),
    helperSize: helper.length,
    compressedSha256: sha256(compressed),
    compressedSize: compressed.length,
    downloadBytes: {
      local: overhead + archives.server.size + archives.desktop.size,
      remote: overhead + archives.desktop.size,
      server: overhead + archives.server.size,
    },
  }, template, messages);
  const proof = `GrigDesk installer v1\n${sha256(installer)}  grigdesk-install\n${manifestDigest}\n`;
  const files = {
    'local-build.json': JSON.stringify({
      format: 1,
      target: platform,
      runId: tuple.runId,
      version: identity.version,
      sourceDigest: tuple.plan.sourceDigest,
      recipeDigest: tuple.plan.recipeDigest,
    }),
    'release-acceptance.json': JSON.stringify({ identity, manifestDigest }),
    'grigdesk-install': installer,
    'grigdesk-install.sha256': proof,
    'grigdesk-install.sig': sign(null, Buffer.from(proof), keys.privateKey).toString('base64'),
    'grigdesk-maintenance.gz': compressed,
    'dev.json': index,
    'control.tar.gz': control,
    'server.tar.gz': 'server:' + identity.releaseId + '\n',
    'desktop.tar.gz': 'desktop:' + identity.releaseId + '\n',
  };

  await fs.mkdir(directory, { mode: 0o700 });

  for (const [name, bytes] of Object.entries(files)) {
    await fs.writeFile(path.join(directory, name), bytes);
  }

  const publicKeyBase64 = Buffer.from(publicKeyPem).toString('base64');

  return {
    publicKeyBase64,
    signerFingerprint: candidateKey(publicKeyBase64).fingerprint,
    manifestDigest,
    fileDigest: await inventory(directory, platform, 'input'),
  };
}

/** Recomputes transport metadata after one deliberately altered fixture file. */
async function inventory(directory: string, platform: CandidatePlatform, phase: 'input' | 'verified') {
  const files = await assertCandidateFiles(directory, platform, phase);
  const entries = await Promise.all(files.map(async (name) => ({
    name,
    size: (await fs.lstat(path.join(directory, name))).size,
    sha256: await sha256File(path.join(directory, name)),
  })));

  return sha256(canonicalJson(entries));
}

test('Verified pair binds the source receipt and the complete packaged Mac outcomes', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-pair-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const run = {
    channel: 'dev',
    publish: false,
    testMode: 'full',
    reason: '',
    validationRun: '',
    ref: 'refs/heads/dev',
    runNumber: '25',
    attempt: '1',
    commit: 'c'.repeat(40),
    sourceDigest: 'd'.repeat(64),
    recipeDigest: 'e'.repeat(64),
    baseVersion: '0.3.0',
  };
  const plan: CandidatePlan = {
    runId: '12',
    attempt: 1,
    plan: resolveCandidatePlan({ ...run, platforms: 'linux-and-macos' }),
  };
  const sourceReceipt = path.join(directory, 'source.json');
  const source = {
    format: 1,
    stage: 'mac-runtime-pin-source',
    code: 0,
    commit: plan.plan.candidate.commit,
    sourceDigest: plan.plan.sourceDigest,
    recipeDigest: plan.plan.recipeDigest,
    outcomes: outcomes('source'),
  };

  await fs.writeFile(sourceReceipt, JSON.stringify(source));

  const sourceRuntimePin = { id: '300', sha256: await sha256File(sourceReceipt) };
  const keys = generateKeyPairSync('ed25519');
  const directories = {
    'linux-x64': path.join(directory, 'linux'),
    'darwin-arm64': path.join(directory, 'macos'),
  };
  const info = await Promise.all((['linux-x64', 'darwin-arm64'] as const).map(async (platform) => {
    const currentDir = directories[platform] + '-B';
    const previousDir = directories[platform] + '-A';
    const current = await signedCandidate(currentDir, platform, plan, 'candidate', keys);
    const previous = await signedCandidate(previousDir, platform, plan, 'previous', keys);
    const darwin = platform === 'darwin-arm64';
    const marker = path.join(currentDir, 'local-build.json');
    const saved = currentDir + '.marker';
    let verifierStarts = 0;
    const inputs = {
      plan,
      platform,
      currentDir,
      previousDir,
      output: directories[platform],
      current,
      previous,
      sourceRuntimePin: darwin ? sourceRuntimePin : null,
      /**
       * Считает вызовы verifier. При нехватке обязательных байтов ни одна
       * платформа не переходит от проверки комплекта к установке.
       */
      async verify(): Promise<CandidateVerification> {
        verifierStarts++;

        return {
          installModes: ['local', 'remote', 'server'],
          passed: [...darwin ? macPackagedChecks : linuxPackagedChecks],
          runtime: darwin ? { runtimePin: outcomes('packaged') } : {},
        };
      },
    };

    await fs.rename(marker, saved);
    await assert.rejects(verifyAndCopyCandidate(inputs), /candidate_marker_missing/u);
    await assert.rejects(fs.lstat(inputs.output), { code: 'ENOENT' });
    await fs.symlink(saved, marker);
    await assert.rejects(verifyAndCopyCandidate(inputs), /candidate_file_type_invalid:local-build.json/u);
    await assert.rejects(fs.lstat(inputs.output), { code: 'ENOENT' });
    assert.equal(verifierStarts, 0);
    await fs.unlink(marker);
    await fs.rename(saved, marker);

    const fileDigest = await verifyAndCopyCandidate(inputs);

    assert.equal(verifierStarts, 1);

    return { ...current, fileDigest };
  }));
  const output = path.join(directory, 'output');
  const input = {
    plan,
    directories,
    sourceReceipt,
    sourceRuntimePin,
    output,
    info: {
      'linux-x64': info[0]!,
      'darwin-arm64': info[1]!,
    },
  };
  const macProof = path.join(directories['darwin-arm64'], 'darwin-arm64-acceptance.json');
  const proof = JSON.parse(await fs.readFile(macProof, 'utf8'));

  /**
   * Both proof edits update the outside inventory so the acceptance failure
   * comes from the violated source or packaged contract.
   */
  async function changeMacProof() {
    await fs.writeFile(macProof, JSON.stringify(proof));
    input.info['darwin-arm64'].fileDigest = await inventory(
      directories['darwin-arm64'], 'darwin-arm64', 'verified');
  }

  const omitted = proof.verification.runtime.runtimePin.pop();

  await changeMacProof();
  await assert.rejects(collectVerifiedCandidates(input), /mac_runtime_pin_outcomes_incomplete/u);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });

  const validLink = sourceRuntimePin.sha256;

  proof.verification.runtime.runtimePin.push(omitted);
  sourceRuntimePin.sha256 = proof.sourceRuntimePin.sha256 = 'a'.repeat(64);
  await changeMacProof();
  await assert.rejects(collectVerifiedCandidates(input), /mac_runtime_pin_source_digest_invalid/u);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });

  const removed = source.outcomes.pop()!;

  await fs.writeFile(sourceReceipt, JSON.stringify(source));
  sourceRuntimePin.sha256 = proof.sourceRuntimePin.sha256 = await sha256File(sourceReceipt);
  await changeMacProof();
  await assert.rejects(collectVerifiedCandidates(input), /mac_runtime_pin_outcomes_incomplete/u);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });

  source.outcomes.push(removed);
  await fs.writeFile(sourceReceipt, JSON.stringify(source));
  sourceRuntimePin.sha256 = proof.sourceRuntimePin.sha256 = validLink;
  await changeMacProof();

  await assert.rejects(collectVerifiedCandidates({
    ...input,
    directories: { 'darwin-arm64': input.directories['darwin-arm64'] },
  }), /candidate_platform_selection_mismatch/u);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  await collectVerifiedCandidates(input);
  assert.deepEqual((await fs.readdir(output)).sort(), ['darwin-arm64', 'linux-x64']);

  const macOnly: CandidatePlan = { ...plan, plan: resolveCandidatePlan({ ...run, platforms: 'macos' }) };
  const single = {
    ...input,
    plan: macOnly,
    output: path.join(directory, 'mac-only'),
  };

  assert.throws(() => resolveCandidatePlan({
    ...run,
    platforms: 'macos',
    publish: true,
  }), /dual_candidate_input_invalid/u);
  await assert.rejects(collectVerifiedCandidates(single), /candidate_platform_selection_mismatch/u);
  await assert.rejects(fs.lstat(single.output), { code: 'ENOENT' });
  await collectVerifiedCandidates({
    ...single,
    directories: { 'darwin-arm64': input.directories['darwin-arm64'] },
    info: { 'darwin-arm64': input.info['darwin-arm64'] },
  });
  assert.deepEqual(await fs.readdir(single.output), ['darwin-arm64']);
});
