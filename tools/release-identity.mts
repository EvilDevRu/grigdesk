import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildReleaseIdentity, parseProductVersion } from '../shared/runtime/productReleaseVersion.ts';

const execute = promisify(execFile);

/**
 * Единственный CI-вход проверяет ref, VERSION и номер запуска до сборщиков.
 * Ни release, ни dev не могут незаметно получить identity противоположного канала.
 */
export async function resolveReleaseIdentity(input: {
  root: string;
  channel: string;
  ref: string;
  runNumber: string;
}) {
  const base = (await fs.readFile(path.join(input.root, 'VERSION'), 'utf8')).trim();
  const parsed = parseProductVersion(base);
  const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: input.root })).stdout.trim();

  if (!parsed || parsed.dev !== null || !['release', 'dev'].includes(input.channel)) {
    throw new Error('release_identity_invalid');
  }

  if (input.channel === 'dev') {
    if (input.ref !== 'refs/heads/dev' || !/^[1-9][0-9]*$/u.test(input.runNumber)) {
      throw new Error('dev_release_requires_dev_branch');
    }

    return buildReleaseIdentity('dev', `${base}-dev.${input.runNumber}`, commit);
  }

  if (input.ref !== 'refs/heads/main' && input.ref !== `refs/tags/v${base}`) {
    throw new Error('release_requires_main_or_matching_version_tag');
  }

  if (input.ref !== 'refs/heads/main') {
    const tagCommit = (await execute('git', ['rev-parse', `v${base}^{commit}`], {
      cwd: input.root,
    })).stdout.trim();

    if (tagCommit !== commit) {
      throw new Error('release_tag_commit_mismatch');
    }
  }

  return buildReleaseIdentity('release', base, commit);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const identity = await resolveReleaseIdentity({
    root: path.resolve(import.meta.dirname, '..'),
    channel: process.env.RELEASE_CHANNEL ?? '',
    ref: process.env.GITHUB_REF ?? '',
    runNumber: process.env.GITHUB_RUN_NUMBER ?? '',
  });

  if (process.env.GITHUB_SHA && identity.commit !== process.env.GITHUB_SHA) {
    throw new Error('release_checkout_commit_mismatch');
  }

  const lines = [
    `GRIGDESK_RELEASE_VERSION=${identity.version}`,
    `GRIGDESK_RELEASE_CHANNEL=${identity.channel}`,
    `GRIGDESK_RELEASE_COMMIT=${identity.commit}`,
    `GRIGDESK_RELEASE_ID=${identity.releaseId}`,
  ].join('\n') + '\n';

  if (!process.env.GITHUB_ENV) {
    throw new Error('release_ci_environment_missing');
  }

  await fs.appendFile(process.env.GITHUB_ENV, lines);
}
