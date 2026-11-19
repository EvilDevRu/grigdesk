import fs from 'node:fs/promises';
import path from 'node:path';

import { assertReleasePlatform } from '../../shared/node/releaseChannel.ts';
import { prepareDarwinBuildTools } from '../darwinBuildTools.mts';
import { sha256File } from '../../shared/node/hash.ts';

const [action, directory] = process.argv.slice(2);

if (!directory || process.argv.length !== 4 || !path.isAbsolute(directory)
  || !['compile', 'adopt'].includes(action ?? '')) {
  throw new Error('candidate_mac_bootstrap_invalid');
}

await assertReleasePlatform({
  os: 'darwin',
  arch: 'arm64',
  minMacOS: '15.0',
});

const physicalParent = await fs.realpath(path.dirname(directory));
const toolsRoot = path.join(physicalParent, path.basename(directory));
let processSha: string;
let setsidSha: string;

if (action === 'compile') {
  await fs.mkdir(toolsRoot, { mode: 0o700 });

  const tools = await prepareDarwinBuildTools({ sourceRoot: await fs.realpath(process.cwd()), toolsRoot });

  processSha = tools.processIdentity.sha256;
  setsidSha = tools.setsid.sha256;
} else {
  await fs.chmod(toolsRoot, 0o700);

  const processFile = path.join(toolsRoot, 'process-identity');
  const setsidFile = path.join(toolsRoot, 'setsid');
  const names = (await fs.readdir(toolsRoot)).sort();

  if (names.join(',') !== 'process-identity,setsid') {
    throw new Error('candidate_verify_tools_invalid');
  }

  for (const file of [processFile, setsidFile]) {
    const entry = await fs.lstat(file);

    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid!()) {
      throw new Error('candidate_verify_tools_invalid');
    }
  }

  processSha = await sha256File(processFile);
  setsidSha = await sha256File(setsidFile);

  if (processSha !== process.env.MAC_PROCESS_IDENTITY_SHA256 || setsidSha !== process.env.MAC_SETSID_SHA256) {
    throw new Error('candidate_verify_tools_integrity_invalid');
  }

  await fs.chmod(processFile, 0o500);
  await fs.chmod(setsidFile, 0o500);
}

await fs.appendFile(process.env.GITHUB_OUTPUT!, `process_sha=${processSha}\nsetsid_sha=${setsidSha}\n`);
await fs.appendFile(process.env.GITHUB_ENV!, [
  `GRIGDESK_BUILD_PROCESS_HELPER=${path.join(toolsRoot, 'process-identity')}`,
  `GRIGDESK_BUILD_PROCESS_HELPER_SHA256=${processSha}`,
  `GRIGDESK_TEST_SETSID_BIN=${path.join(toolsRoot, 'setsid')}`,
  `GRIGDESK_BUILD_SETSID_SHA256=${setsidSha}`,
].join('\n') + '\n');
