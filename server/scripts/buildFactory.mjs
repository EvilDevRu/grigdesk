import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'bin');

function buildWindowsFactory() {
  const env = { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off', CGO_ENABLED: '0', GOFLAGS: '' };
  const go = (args) => execFileSync('go', args, { env, encoding: 'utf8', windowsHide: true });
  const [version, arch] = go(['env', 'GOVERSION', 'GOHOSTARCH']).trim().split(/\r?\n/);

  if (version !== 'go1.27.4' || !['amd64', 'arm64'].includes(arch)) {
    throw new Error('Для сборки фабрики Windows нужен Go 1.27.4 для amd64 или arm64.');
  }

  env.GOOS = 'windows';
  env.GOARCH = arch;
  mkdirSync(output, { recursive: true });
  const stage = mkdtempSync(path.join(output, '.factory-build.'));
  const factory = path.join(stage, 'factory.exe');

  try {
    go(['-C', root, 'build', '-trimpath', '-buildvcs=false', '-o', factory, './utilities/factory/cmd/factory']);
    const probe = execFileSync(factory, ['capabilities', '--format', 'json'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });

    if (!JSON.parse(probe).features.includes('native-subcommands')) {
      throw new Error('Собранный движок не подтвердил native-subcommands.');
    }

    const destination = path.join(output, 'factory.exe');
    renameSync(factory, destination);
    console.log(destination);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.platform === 'win32') {
  buildWindowsFactory();
} else {
  execFileSync('bash', [path.join(root, 'tools/build-factory.sh'), output], { stdio: 'inherit' });
}
