import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { decodeReleaseChannelIndex } from '../shared/runtime/installedUpdateContracts.ts';

const execute = promisify(execFile);

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
  '  /usr/lib/grigdesk/grigdesk-install install local',
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
  'Terminal=false',
  'Categories=Network;',
  '',
].join('\n');

/**
 * Deb-пакет не заменяет файлы обновления: он доставляет только подписанный
 * installer и загрузчик. Версия и требование glibc берутся из подписанного
 * индекса канала, чтобы пакет не разошёлся с выпуском.
 */
export async function buildDeb(input: { root: string; artifacts: string }): Promise<string> {
  const names = (await fs.readdir(input.artifacts))
    .filter((name) => name === 'release.json' || name === 'dev.json');

  if (names.length !== 1) {
    throw new Error('deb_release_index_missing');
  }

  const index = decodeReleaseChannelIndex(JSON.parse(
    await fs.readFile(path.join(input.artifacts, names[0]!), 'utf8'),
  ));

  if (!index.latest) {
    throw new Error('deb_release_index_empty');
  }

  const payload = index.latest.payload;
  const control = [
    'Package: grigdesk',
    `Version: ${payload.version}`,
    'Section: net',
    'Priority: optional',
    'Architecture: amd64',
    `Depends: libc6 (>= ${payload.platform.glibc})`,
    `Maintainer: EvilDevRu <3668960+EvilDevRu@users.noreply.github.com>`,
    'Description: GrigDesk — рабочее место с локальным сервером',
    ' Пакет ставит загрузчик GrigDesk; при первом запуске подписанный installer',
    ' разворачивает комплект в пределах пользователя (~/.local), дальше приложение',
    ' обновляет себя само без прав администратора.',
    '',
  ].join('\n');

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-deb-'));

  try {
    await fs.mkdir(path.join(work, 'DEBIAN'), { mode: 0o755 });
    await fs.writeFile(path.join(work, 'DEBIAN/control'), control, { mode: 0o644 });
    await fs.mkdir(path.join(work, 'usr/lib/grigdesk'), { recursive: true, mode: 0o755 });
    await fs.copyFile(path.join(input.artifacts, 'grigdesk-install'),
      path.join(work, 'usr/lib/grigdesk/grigdesk-install'));
    await fs.chmod(path.join(work, 'usr/lib/grigdesk/grigdesk-install'), 0o755);
    await fs.mkdir(path.join(work, 'usr/bin'), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(work, 'usr/bin/grigdesk'), BOOTSTRAP, { mode: 0o755 });
    await fs.mkdir(path.join(work, 'usr/share/applications'), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(work, 'usr/share/applications/grigdesk.desktop'),
      DESKTOP_ENTRY, { mode: 0o644 });

    const output = path.join(input.artifacts, `grigdesk_${payload.version}_amd64.deb`);

    await execute('dpkg-deb', ['--build', '--root-owner-group', work, output]);

    return output;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

  await buildDeb({ root, artifacts: path.join(root, 'release-artifacts') })
    .then((output) => {
      process.stdout.write(`${path.relative(process.cwd(), output)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'deb_build_failed'}\n`);
      process.exitCode = 1;
    });
}
