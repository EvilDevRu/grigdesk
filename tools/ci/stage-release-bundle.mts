import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

const directory = process.env.GRIGDESK_BUNDLE_STAGE ?? '';
const receipt = process.env.GRIGDESK_BUNDLE_RECEIPT ?? '';

if (!path.isAbsolute(directory) || !path.isAbsolute(receipt)) {
  throw new Error('release_staging_path_invalid');
}

const child = spawn(process.execPath, ['tools/bundle.mts', '--stage-installed', directory, receipt], {
  stdio: 'inherit',
});
const [code] = await once(child, 'exit');

process.exitCode = code ?? 1;
