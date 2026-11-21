import fs from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../shared/lib/canonicalJson.ts';
import { isRecord } from '../shared/lib/objects.ts';
import { sha256 } from '../shared/node/hash.ts';
import { resolveReleaseIdentity } from './release-identity.mts';
import { resolveStablePlatformRelease, stablePlatforms } from './stablePlatformRelease.mts';

type StablePlan = ReturnType<typeof resolveStablePlatformRelease> & {
  format: 1;
  runId: string;
  runNumber: string;
};

interface PlanSource {
  commit: string;
  runId: string;
  digest: string;
}

/**
 * Читает план по хешу из job plan и повторно выводит identity всех платформ.
 * Поля плана нельзя заменить произвольными номерами версий и предшественников.
 */
export async function readStableReleasePlan(file: string, expected: PlanSource): Promise<StablePlan> {
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.size > 64 * 1024 || !/^[1-9][0-9]*$/u.test(expected.runId)) {
    throw new Error('stable_release_plan_invalid');
  }

  const bytes = await fs.readFile(file, 'utf8');
  const source: unknown = JSON.parse(bytes);

  if (sha256(bytes) !== expected.digest || !isRecord(source) || !isRecord(source.current)
    || typeof source.current.version !== 'string' || typeof source.runNumber !== 'string') {
    throw new Error('stable_release_plan_invalid');
  }

  const plan = {
    format: 1 as const,
    runId: expected.runId,
    runNumber: source.runNumber,
    ...resolveStablePlatformRelease({
      platforms: [...stablePlatforms],
      publish: false,
      testMode: 'full',
      reason: '',
      validationRun: '',
      attempt: '1',
      runNumber: source.runNumber,
      version: source.current.version,
      commit: expected.commit,
    }),
  };

  if (bytes !== canonicalJson(plan) + '\n') {
    throw new Error('stable_release_plan_invalid');
  }

  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [mode, file, ...extra] = process.argv.slice(2);
  const env = process.env;
  const runId = env.GITHUB_RUN_ID ?? '';
  const runNumber = env.GITHUB_RUN_NUMBER ?? '';

  if (!file || extra.length || !/^[1-9][0-9]*$/u.test(runId)) {
    throw new Error('stable_release_plan_arguments_invalid');
  }

  if (mode === 'check') {
    await readStableReleasePlan(file, {
      commit: env.GITHUB_SHA ?? '',
      runId,
      digest: env.STABLE_PLAN_SHA256 ?? '',
    });
  } else if (mode === 'write' && env.GITHUB_OUTPUT) {
    const current = await resolveReleaseIdentity({
      root: path.resolve(import.meta.dirname, '..'),
      channel: env.RELEASE_CHANNEL ?? '',
      ref: env.GITHUB_REF ?? '',
      runNumber,
    });

    if (current.channel !== 'release' || current.commit !== env.GITHUB_SHA || env.PUBLISH !== 'false') {
      throw new Error('stable_release_plan_identity_invalid');
    }

    const resolved = resolveStablePlatformRelease({
      platforms: [...stablePlatforms],
      publish: false,
      testMode: env.TEST_MODE ?? '',
      reason: env.TEST_SKIP_REASON ?? '',
      validationRun: env.VALIDATION_RUN ?? '',
      attempt: env.GITHUB_RUN_ATTEMPT ?? '',
      runNumber,
      version: current.version,
      commit: current.commit,
    });
    const plan = {
      format: 1,
      runId,
      runNumber,
      ...resolved,
    };
    const bytes = canonicalJson(plan) + '\n';

    await fs.writeFile(file, bytes, { flag: 'wx' });
    await fs.appendFile(env.GITHUB_OUTPUT, `digest=${sha256(bytes)}\n`);
  } else {
    throw new Error('stable_release_plan_arguments_invalid');
  }
}
