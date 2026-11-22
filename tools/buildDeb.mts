import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseReleaseChannelIndex } from '../shared/runtime/installedUpdateContracts.ts';

import { offlinePackageFiles } from './linuxOfflinePackage.mts';

const execute = promisify(execFile);
const installerCommand = '  exec /usr/lib/grigdesk/grigdesk-install install local --launch';

/**
 * Загрузчик deb выполняет установку в пределах пользователя и передаёт управление
 * её лаунчеру. Обновления после бутстрапа идут штатным механизмом без root.
 */
const BOOTSTRAP = [
  '#!/bin/sh',
  '# GrigDesk deb-бутстрап: при первом запуске ставит комплект в пределах пользователя',
  '# и передаёт управление его лаунчеру; дальше обновления идут штатно без root.',
  'set -e',
  '',
  'if [ -z "$HOME" ]; then',
  '  echo "grigdesk: HOME не задан — установка в пределах пользователя невозможна" >&2',
  '  exit 1',
  'fi',
  '',
  'if [ ! -f "$HOME/.local/lib/grigdesk/current.json" ] || [ ! -x "$HOME/.local/bin/grigdesk" ]; then',
  installerCommand,
  'fi',
  '',
  'exec "$HOME/.local/bin/grigdesk" "$@"',
  '',
].join('\n');

const DESKTOP_ENTRY = [
  '[Desktop Entry]',
  'Type=Application',
  'Name=GrigDesk',
  'Exec=/usr/bin/grigdesk',
  'Terminal=true',
  'Categories=Network;',
  '',
].join('\n');

export const OFFLINE_DEB_BOOTSTRAP = BOOTSTRAP.replace(installerCommand,
  installerCommand + ' --source-dir /usr/lib/grigdesk');
export const DEB_DESKTOP_ENTRY = DESKTOP_ENTRY;

type DebBuildInput = {
  root: string;
  artifacts: string;
  offline?: boolean;
};

/**
 * Пакует подписанный установщик и, для стабильной офлайн-поставки, локальный комплект.
 * Версия и требование glibc берутся из индекса канала.
 */
export async function buildDeb(input: DebBuildInput): Promise<string> {
  const names = (await fs.readdir(input.artifacts))
    .filter((name) => name === 'release.json' || name === 'dev.json');

  if (names.length !== 1) {
    throw new Error('deb_release_index_missing');
  }

  const index = parseReleaseChannelIndex(
    await fs.readFile(path.join(input.artifacts, names[0]!), 'utf8'),
  );

  if (!index.latest) {
    throw new Error('deb_release_index_empty');
  }

  const payload = index.latest.payload;

  if (payload.platform.os !== 'linux' || payload.platform.arch !== 'x64') {
    throw new Error('deb_release_platform_unsupported');
  }

  if (input.offline && (names[0] !== 'release.json' || payload.channel !== 'release')) {
    throw new Error('deb_offline_channel_invalid');
  }

  const script = await fs.readFile(path.join(input.artifacts, 'grigdesk-install'));

  if (script.length > 64 * 1024 || script.includes(0)
    || !script.subarray(0, 10).equals(Buffer.from('#!/bin/sh\n'))) {
    throw new Error('deb_installer_not_script');
  }

  const control = [
    'Package: grigdesk',
    `Version: ${payload.version}`,
    'Section: net',
    'Priority: optional',
    'Architecture: amd64',
    `Depends: libc6 (>= ${payload.platform.glibc}), curl, gzip, coreutils`,
    `Maintainer: EvilDevRu <3668960+EvilDevRu@users.noreply.github.com>`,
    'Description: GrigDesk — рабочее место с локальным сервером',
    input.offline
      ? ' При первом запуске подписанный установщик использует локальные файлы пакета и'
      : ' Пакет ставит загрузчик GrigDesk; при первом запуске подписанный installer',
    ' разворачивает комплект в пределах пользователя (~/.local), дальше приложение',
    ' обновляет себя само без прав администратора.',
    '',
  ].join('\n');

  const files = input.offline ? offlinePackageFiles('release') : ['grigdesk-install'];

  for (const name of files) {
    const stat = await fs.lstat(path.join(input.artifacts, name)).catch(() => null);

    if (!stat?.isFile()) {
      throw new Error(`offline_input_invalid: ${name}`);
    }
  }

  const work = await fs.mkdtemp(path.join(input.artifacts, '.deb-build-'));

  try {
    const tree = path.join(work, 'package');
    const payloadRoot = path.join(tree, 'usr/lib/grigdesk');

    await fs.mkdir(path.join(tree, 'DEBIAN'), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(tree, 'DEBIAN/control'), control, { mode: 0o644 });
    await fs.mkdir(payloadRoot, { recursive: true, mode: 0o755 });

    for (const name of files) {
      const target = path.join(payloadRoot, name);

      await fs.copyFile(path.join(input.artifacts, name), target);
      await fs.chmod(target, name === 'grigdesk-install' ? 0o755 : 0o644);
    }

    await fs.mkdir(path.join(tree, 'usr/bin'), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(tree, 'usr/bin/grigdesk'),
      input.offline ? OFFLINE_DEB_BOOTSTRAP : BOOTSTRAP, { mode: 0o755 });
    await fs.mkdir(path.join(tree, 'usr/share/applications'), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(tree, 'usr/share/applications/grigdesk.desktop'),
      DESKTOP_ENTRY, { mode: 0o644 });

    for (const directory of [
      '.', 'DEBIAN', 'usr', 'usr/bin', 'usr/lib', 'usr/lib/grigdesk', 'usr/share', 'usr/share/applications',
    ]) {
      await fs.chmod(path.join(tree, directory), 0o755);
    }

    for (const file of ['DEBIAN/control', 'usr/share/applications/grigdesk.desktop']) {
      await fs.chmod(path.join(tree, file), 0o644);
    }

    await fs.chmod(path.join(tree, 'usr/bin/grigdesk'), 0o755);

    const name = `grigdesk_${payload.version}_amd64.deb`;
    const output = path.join(input.artifacts, name);
    const partial = path.join(work, name);

    await execute('dpkg-deb', ['--build', '--root-owner-group', '-Znone', tree, path.resolve(partial)],
      { timeout: 180_000 });
    await fs.rename(partial, output);

    return output;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

  if (process.argv.length > 4 || (process.argv[3] !== undefined && process.argv[3] !== '--offline')) {
    throw new Error('deb_arguments_invalid');
  }

  await buildDeb({
    root,
    artifacts: path.join(root, 'release-artifacts'),
    offline: process.argv[3] === '--offline',
  })
    .then((output) => {
      process.stdout.write(`${path.relative(process.cwd(), output)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'deb_build_failed'}\n`);
      process.exitCode = 1;
    });
}
