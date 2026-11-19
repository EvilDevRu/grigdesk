import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readTargetNodeRuntime, seaHostTarget, serverNodeRuntimeManifest }
  from '../../shared/node/nodeRuntime.ts';
import { buildReleaseIdentity } from '../../shared/runtime/productReleaseVersion.ts';
import { decodeRecipe, requireBuildOutcomes, runStages } from '../releasePipeline.mts';
import { candidateOrigin } from '../platformCandidate.mts';
import { prepareDarwinFactoryEnvironment } from '../../server/src/lib/factoryDarwinRuntime.ts';

const execute = promisify(execFile);
const [root, output, part] = process.argv.slice(2);

if (!root || !output || !path.isAbsolute(root) || !path.isAbsolute(output)
  || !['current', 'previous'].includes(part ?? '')) {
  throw new Error('candidate_stage_arguments_invalid');
}

const platform = seaHostTarget();
const darwin = platform === 'darwin-arm64';
const pin = await readTargetNodeRuntime(path.join(root, serverNodeRuntimeManifest(platform)), platform);

if (process.versions.node !== pin.version) {
  throw new Error('release_toolchain_invalid');
}

const version = part === 'current' ? process.env.CANDIDATE_VERSION : process.env.CANDIDATE_PREVIOUS_VERSION;
const sourceDigest = process.env.CANDIDATE_SOURCE_DIGEST;
const recipeDigest = process.env.CANDIDATE_RECIPE_DIGEST;
const commit = process.env.GITHUB_SHA;

if (!version || !commit || !sourceDigest || !recipeDigest) {
  throw new Error('candidate_stage_identity_invalid');
}

const identity = buildReleaseIdentity('dev', version, commit);
const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-cand-'));
const home = path.join(output, 'home');
const cache = path.join(home, 'cache');
const receipts = path.join(output, 'receipts');
const tools = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['GRIGDESK_BUILD_PROCESS_HELPER', 'GRIGDESK_BUILD_PROCESS_HELPER_SHA256',
    'GRIGDESK_TEST_SETSID_BIN', 'GRIGDESK_BUILD_SETSID_SHA256'].includes(key)));
const builtIn = [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const env: NodeJS.ProcessEnv = {
  ...tools,
  PATH: builtIn.join(':'),
  HOME: home,
  LANG: 'C.UTF-8',
  TMPDIR: tmp,
  PLAYWRIGHT_BROWSERS_PATH: path.join(home, 'browsers'),
  XDG_CACHE_HOME: cache,
  XDG_DATA_HOME: path.join(home, 'share'),
  XDG_CONFIG_HOME: path.join(home, 'config'),
  GRIGDESK_HOME: path.join(home, 'data'),
  GRIGDESK_RELEASE_VERSION: identity.version,
  GRIGDESK_RELEASE_CHANNEL: identity.channel,
  GRIGDESK_RELEASE_COMMIT: identity.commit,
  GRIGDESK_RELEASE_ID: identity.releaseId,
  GRIGDESK_RELEASE_ORIGIN: candidateOrigin,
  GRIGDESK_RELEASE_NOTES_JSON: process.env.CANDIDATE_NOTES_JSON,
  GRIGDESK_DEEPSEEK_NODE_CACHE: path.join(output, 'pinned-deepseek'),
  GRIGDESK_TEST_DEEPSEEK_ROOT: path.join(output, 'deepseek-tests'),
  GRIGDESK_ARTIFACTS_DIR: path.join(output, 'deepseek-tests'),
  GRIGDESK_BUNDLE_STAGE: path.join(output, 'unsigned'),
  GRIGDESK_BUNDLE_RECEIPT: path.join(output, 'unsigned.sha256'),
};

for (const directory of [home, cache, env.XDG_DATA_HOME!, env.XDG_CONFIG_HOME!, env.GRIGDESK_HOME!,
  env.GRIGDESK_DEEPSEEK_NODE_CACHE!, env.GRIGDESK_TEST_DEEPSEEK_ROOT!]) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

if (darwin) {
  const engine = await prepareDarwinFactoryEnvironment({
    root,
    packaged: false,
    controlRoot: path.join(home, 'factory'),
    node: process.execPath,
    env,
  });

  env.PATH = [path.dirname(process.execPath), engine.PATH, '/opt/homebrew/bin'].join(':');
}

const npmVersion = (await execute('npm', ['--version'], { env, timeout: 8000 })).stdout.trim();
const recipeFile = path.join(root, 'tools/releaseRecipe.json');
const recipe = decodeRecipe(JSON.parse(await fs.readFile(recipeFile, 'utf8')));
const groups = darwin ? ['mac-prepare', ...(part === 'current' ? ['mac-check'] : []), 'mac-build']
  : ['prepare-build', 'build', 'candidate-build'];
let cleanupConfirmed = false;

try {
  const result = await runStages({
    recipe,
    cwd: root,
    env,
    groups,
    sourceDigest,
    candidateRecipe: true,
    sourceReceiptIdentity: {
      commit,
      sourceDigest,
      recipeDigest,
    },
    darwinToolchain: darwin ? { nodeVersion: process.version, npmVersion } : undefined,
    logFile: path.join(output, 'build.log'),
    receiptDir: receipts,
  });

  cleanupConfirmed = result.cleanupConfirmed;

  if (result.code === 0) {
    requireBuildOutcomes(recipe, groups, result);
  }

  process.exitCode = result.code;
} finally {
  if (cleanupConfirmed) {
    await fs.rm(tmp, { recursive: true, force: true });
  } else {
    process.stderr.write(`Staging: ${tmp}\n`);
  }
}
