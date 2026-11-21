import { execFile } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { stageDarwinProcessAssets } from '../shared/node/processIdentity.ts';
import { RELEASE_DISTRIBUTION_SOURCE, RELEASE_SIGNING_PUBLIC_KEY }
  from '../shared/runtime/releaseChannelContracts.ts';

const execute = promisify(execFile);
const goVersion = 'go1.27.4';
const packages = {
  tracker: 'tracker',
  pipeline: 'pipeline',
  routes: 'routes',
  voice: 'voice',
  'grigdesk-relay': 'relay',
  'grigdesk-ctl': 'ctl',
  'grigdesk-maintenance': 'maintenance',
} as const;

interface ReleaseUtilityInput {
  root: string;
  output: string;
  cache: string;
  version: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Берёт ключ из исходников подготовленной копии сборки, как и остальные
 * потребители канала. Параметры запущенной программы ключ не меняют.
 */
export async function buildReleaseUtility(
  name: keyof typeof packages, input: ReleaseUtilityInput,
): Promise<void> {
  const source = packages[name];
  const root = path.resolve(input.root);
  const env = {
    ...input.env,
    GOCACHE: input.env.GOCACHE ?? path.join(input.cache, 'build'),
    GOPATH: input.env.GOPATH ?? path.join(input.cache, 'modules'),
    GOOS: process.platform,
    GOARCH: process.arch === 'x64' ? 'amd64' : process.arch,
    GOENV: 'off',
    GOFLAGS: '',
    GOWORK: 'off',
    GOTOOLCHAIN: 'local',
    CGO_ENABLED: '0',
  };
  const options = {
    env,
    cwd: root,
    timeout: 300_000,
  };
  const version = await execute('go', ['version'], options);

  if (!version.stdout.startsWith('go version ' + goVersion + ' ')) {
    throw new Error('release_go_version_invalid');
  }

  const key = createPublicKey(RELEASE_SIGNING_PUBLIC_KEY);

  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('release_signing_key_invalid');
  }

  const trust = key.export({ format: 'der', type: 'spki' }).toString('base64');
  const installation = 'grigdesk.local/tools/utilities/internal/installation';
  const flags = ['-s', '-w', '-X main.version=' + input.version,
    '-X ' + installation + '.releaseKeyBase64=' + trust,
    '-X ' + installation + '.releaseDistributionSource=' + RELEASE_DISTRIBUTION_SOURCE].join(' ');

  let overlay: string[] = [];

  if (process.platform === 'darwin' && name === 'grigdesk-maintenance') {
    await fs.mkdir(input.cache, { recursive: true });

    const stage = await fs.mkdtemp(path.join(input.cache, 'darwin-process-'));

    await stageDarwinProcessAssets(stage, env);

    const description = path.join(stage, 'overlay.json');
    const embedded = path.join(root, 'utilities/internal/processidentity/darwin-process-identity.asset');

    await fs.writeFile(description, JSON.stringify({
      Replace: { [embedded]: path.join(stage, 'process-identity') },
    }));
    overlay = ['-overlay', description];
  }

  await execute('go', ['build', ...overlay, '-trimpath', '-buildvcs=false', '-ldflags', flags,
    '-o', input.output, './utilities/' + source + '/cmd/' + source], options);

  const result = await execute(input.output, ['--runtime-info', '--json'], options);
  const runtime = JSON.parse(result.stdout);
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;

  if (result.stderr || runtime.kind !== name || runtime.version !== input.version
    || runtime.runtime !== 'go' || runtime.go !== goVersion
    || runtime.os !== process.platform || runtime.arch !== arch) {
    throw new Error('release_go_runtime_invalid');
  }

  await fs.chmod(input.output, 0o555);
}
