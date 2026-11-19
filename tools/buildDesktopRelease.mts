import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { sha256File } from '../shared/node/hash.ts';
import { isArm64MachOExecutable } from '../shared/node/machO.ts';
import { MAC_APP_ARCHIVE, MAC_APP_TREE } from '../shared/runtime/installedUpdateContracts.ts';
import { buildMacDesktopTree, MAC_ARCHIVE_OPTIONS, verifyMacDesktopZip }
  from '../shared/node/macosAppArchive.ts';
import { seaHostTarget, type NodeRuntime } from '../shared/node/nodeRuntime.ts';
import type { BundleBuildInput } from './bundleSteps.mts';

type BuildRun = (file: string, args: string[], input: BundleBuildInput) => Promise<void>;

const execute = promisify(execFile);

/**
 * Распаковывает exact архив из lock версии Electron. Только проверенные bytes
 * доходят до ditto, а сборщик окна получает отдельный каталог этой подготовки.
 */
async function prepareDarwinElectron(root: string, input: BundleBuildInput, run: BuildRun): Promise<string> {
  const desktop = path.join(root, 'desktop');
  const electron = path.join(desktop, 'node_modules/electron');
  const source = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'));
  const installed = JSON.parse(await fs.readFile(path.join(electron, 'package.json'), 'utf8'));
  const version = installed.version;

  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)
    || version !== source.devDependencies.electron) {
    throw new Error('release_electron_version_invalid');
  }

  const name = `electron-v${version}-darwin-arm64.zip`;
  const expected = JSON.parse(await fs.readFile(path.join(electron, 'checksums.json'), 'utf8'))[name];

  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error('release_electron_checksum_missing');
  }

  const work = await fs.mkdtemp(path.join(input.cacheDir, 'electron-darwin-arm64-'));
  const archive = path.join(work, name);
  const dist = path.join(work, 'dist');
  const url = `https://github.com/electron/electron/releases/download/v${version}/${name}`;

  await run('/usr/bin/curl', ['-q', '-fLsS', '--proto', '=https', '--proto-redir', '=https',
    '--retry', '2', '--max-time', '300', '-o', archive, url], input);

  if (await sha256File(archive) !== expected) {
    throw new Error('release_electron_checksum_mismatch');
  }

  await run('/usr/bin/ditto', ['-x', '-k', archive, dist], input);
  await verifyArm64(path.join(dist, 'Electron.app/Contents/MacOS/Electron'));
  await fs.unlink(archive);

  return dist;
}

/**
 * Заголовок Mach-O сверяется до запуска Electron и до публикации ZIP.
 * Короткий файл и другая архитектура означают ошибку упаковки.
 */
async function verifyArm64(file: string): Promise<void> {
  const handle = await fs.open(file, 'r');

  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);

    if (bytesRead !== header.length || !isArm64MachOExecutable(header)) {
      throw new Error('release_electron_arch_invalid');
    }
  } finally {
    await handle.close();
  }
}

interface DesktopBuildPorts {
  run: BuildRun;
  prepareElectron?: typeof prepareDarwinElectron;
  probe?: (file: string, args: string[], input: BundleBuildInput) => Promise<string>;
}

/**
 * Нативная цель выбирает оконный упаковщик. Linux возвращает прежний AppImage,
 * macOS возвращает ZIP проверенного подписанного дерева приложения.
 */
export async function buildDesktopRelease(input: BundleBuildInput & {
  root: string;
  target?: NodeRuntime['platform'];
}, ports: DesktopBuildPorts): Promise<string> {
  const { root, outDir, cacheDir, env } = input;
  const target = input.target ?? seaHostTarget();
  const version = env.GRIGDESK_RELEASE_VERSION;
  const command = ['--prefix', path.join(root, 'desktop'), 'run'];

  if (target === 'linux-x64') {
    const prepared = process.env.GRIGDESK_APPIMAGE_TOOLS_PATH;
    const tools = prepared ?? path.join(cacheDir, 'appimage-tools');

    if (!prepared) {
      await ports.run('bash', ['tools/ci/prepare-release-desktop.sh', tools], input);
    }

    await ports.run('npm', [...command, 'dist', '--', `--config.directories.output=${outDir}`,
      `--config.extraMetadata.version=${version}`,
      `--config.electronDist=${path.join(root, 'desktop/node_modules/electron/dist')}`], {
      ...input, env: { ...env, APPIMAGE_TOOLS_PATH: tools },
    });

    const images = (await fs.readdir(outDir)).filter((name) => name.endsWith('.AppImage'));

    if (images.length !== 1) {
      throw new Error('Сборка окна должна вернуть ровно один свежий AppImage');
    }

    return path.join(outDir, images[0]!);
  }

  const base = (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();

  if (!/^\d+\.\d+\.\d+$/u.test(base) || !version || !env.GRIGDESK_RELEASE_ID) {
    throw new Error('release_electron_identity_invalid');
  }

  const electron = await (ports.prepareElectron ?? prepareDarwinElectron)(root, input, ports.run);

  await ports.run('npm', [...command, 'dist:mac', '--', `--config.directories.output=${outDir}`,
    `--config.extraMetadata.version=${version}`, `--config.electronDist=${electron}`,
    `--config.mac.bundleShortVersion=${base}`, `--config.mac.bundleVersion=${base}`], {
    ...input, env: { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });

  const app = path.join(outDir, 'mac-arm64', 'grigdesk.app');
  const binary = path.join(app, 'Contents/MacOS/grigdesk');
  const info = path.join(app, 'Contents/Info.plist');
  const normalized = path.join(cacheDir, 'built-Info.plist');

  const appDirectories = (await fs.readdir(path.dirname(app))).filter((name) => name.endsWith('.app'));

  if (appDirectories.join('\n') !== 'grigdesk.app'
    || await fs.realpath(app) !== app || await fs.realpath(binary) !== binary
    || await fs.realpath(info) !== info || !(await fs.lstat(app)).isDirectory()) {
    throw new Error('release_electron_output_invalid');
  }

  await verifyArm64(binary);
  await ports.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], input);
  await ports.run('/usr/bin/plutil', ['-convert', 'xml1', '-o', normalized, info], input);

  const plist = await fs.readFile(normalized, 'utf8');
  const expectedFields = [
    ['CFBundleExecutable', 'grigdesk'], ['CFBundleShortVersionString', base], ['CFBundleVersion', base],
  ];

  for (const [key, expected] of expectedFields) {
    if (new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'u').exec(plist)?.[1] !== expected) {
      throw new Error(`release_electron_info_invalid:${key}`);
    }
  }

  const probe = ports.probe ?? (async (file, args, build) => (await execute(file, args, {
    cwd: build.cacheDir,
    env: build.env,
    timeout: 30000,
    maxBuffer: 65536,
  })).stdout);
  const identity = JSON.parse(await probe(binary, ['--grigdesk-release-probe'], input));

  if (identity.version !== version || identity.releaseId !== env.GRIGDESK_RELEASE_ID) {
    throw new Error('release_electron_identity_invalid');
  }

  const output = path.join(outDir, MAC_APP_ARCHIVE);
  const { tree } = await buildMacDesktopTree(path.dirname(app), path.join(outDir, MAC_APP_TREE));

  await ports.run('/usr/bin/ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', ...MAC_ARCHIVE_OPTIONS, app, output], input);
  await verifyMacDesktopZip(output, tree);

  return output;
}
