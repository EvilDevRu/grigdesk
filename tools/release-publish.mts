import { execFile } from 'node:child_process';
import { createPublicKey, verify as verifyBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  RELEASE_SIGNING_PUBLIC_KEY, decodeChannelIndex,
} from '../shared/runtime/releaseChannelContracts.ts';
import { sha256File } from '../shared/node/hash.ts';

const execute = promisify(execFile);

interface SiteTarget {
  host: string;
  user: string;
  port: string;
  key: string;
  dir: string;
  origin: string;
}

/**
 * Цели собираются из RELEASE_SITE_* и необязательных наборов RELEASE_SITE_MIRROR*_*
 * (до трёх): основной хост обязателен, зеркала добавляются по заполненным наборам.
 */
function targets(): SiteTarget[] {
  const list: SiteTarget[] = [{
    host: process.env.RELEASE_SITE_HOST ?? '',
    user: process.env.RELEASE_SITE_USER ?? '',
    port: process.env.RELEASE_SITE_PORT ?? '22',
    key: process.env.RELEASE_SITE_KEY ?? '',
    dir: process.env.RELEASE_SITE_DIR ?? '',
    origin: process.env.RELEASE_SITE_PUBLIC_ORIGIN ?? '',
  }];

  for (const prefix of ['RELEASE_SITE_MIRROR_', 'RELEASE_SITE_MIRROR2_',
    'RELEASE_SITE_MIRROR3_']) {
    const host = process.env[`${prefix}HOST`] ?? '';

    if (host) {
      list.push({
        host,
        user: process.env[`${prefix}USER`] ?? '',
        port: process.env[`${prefix}PORT`] ?? '22',
        key: process.env[`${prefix}KEY`] ?? '',
        dir: process.env[`${prefix}DIR`] ?? '',
        origin: process.env[`${prefix}PUBLIC_ORIGIN`] ?? '',
      });
    }
  }

  return list;
}

/**
 * Пути конфигурации передаются удалённой оболочке как один буквальный аргумент.
 * Экранирование сохраняет пробелы и запрещает интерпретацию shell-подстановок.
 */
function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Публикация проверяет выпуск локально до отправки: подпись файла сумм, потоковый
 * SHA256 архива и согласованность channel.json; заполняет archiveUrl и только затем
 * ходит по SSH во временную папку с атомарным переименованием на каждой цели.
 */
async function main(): Promise<void> {
  const directory = process.argv[2];

  if (!directory || !path.isAbsolute(directory)) {
    throw new Error('Использование: node tools/release-publish.mts <каталог выпуска>');
  }

  const targetList = targets();
  const primary = targetList[0]!;
  const missing = ['RELEASE_SITE_HOST', 'RELEASE_SITE_USER', 'RELEASE_SITE_KEY',
    'RELEASE_SITE_DIR', 'RELEASE_SITE_PUBLIC_ORIGIN'].filter((name) => {
      return !process.env[name];
    });

  if (missing.length) {
    process.stderr.write(`Не заданы переменные: ${missing.join(', ')}\n`);
    process.exitCode = 2;

    return;
  }

  process.exitCode = 3;

  // Отсутствующие файлы выпуска — ошибка целостности (код 3), а не сбой команды (4).
  let checksum: string;
  let signature: string;

  try {
    checksum = await fs.readFile(path.join(directory, 'release.tar.gz.sha256'), 'utf8');
    signature = (await fs.readFile(
      path.join(directory, 'release.tar.gz.sha256.sig'), 'utf8')).trim();
  } catch {
    process.stderr.write('Выпуск не содержит файла сумм или подписи\n');
    process.exitCode = 3;

    return;
  }

  const publicKeyPem = process.env.RELEASE_SIGNING_PUBLIC_KEY_FILE
    ? await fs.readFile(process.env.RELEASE_SIGNING_PUBLIC_KEY_FILE, 'utf8')
    : RELEASE_SIGNING_PUBLIC_KEY;

  if (!publicKeyPem.trim()) {
    process.stderr.write('release_signing_key_missing: публичный ключ подписи не задан\n');
    process.exitCode = 3;

    return;
  }

  const archivePath = path.join(directory, 'release.tar.gz');
  const archiveHash = await sha256File(archivePath);
  const archiveLine = checksum.split('\n').find((line) => {
    return line.includes('release.tar.gz');
  });

  if (!archiveLine || archiveLine.split(' ')[0] !== archiveHash) {
    process.stderr.write('Фактический SHA256 архива не совпал с файлом сумм\n');
    process.exitCode = 3;

    return;
  }
  if (!verifyBytes(null, Buffer.from(checksum, 'utf8'), createPublicKey(publicKeyPem),
    Buffer.from(signature, 'base64'))) {
    process.stderr.write('Подпись выпуска не прошла проверку\n');
    process.exitCode = 3;

    return;
  }

  const channelPath = path.join(directory, 'channel.json');
  const index = decodeChannelIndex(JSON.parse(await fs.readFile(channelPath, 'utf8')));
  const entry = index.latest;

  const bundleLine = checksum.split('\n').find((line) => {
    return line.endsWith('  release/bin/bundle.json');
  });

  if (!entry || entry.archiveSha256 !== archiveHash || entry.signature !== signature
    || entry.bundleSha256 !== bundleLine?.split(' ')[0]
    || entry.archiveSize !== (await fs.stat(archivePath)).size) {
    process.stderr.write('channel.json расходится с файлом сумм или подписью\n');
    process.exitCode = 3;

    return;
  }

  const archiveUrl = `${primary.origin.replace(/\/$/, '')}/releases/${entry.version}/release.tar.gz`;

  decodeChannelIndex({
    ...index,
    latest: {
    ...entry,
    archiveUrl
  }
  });
  process.exitCode = 0;

  const version = entry.version;
  const upload = ['release.tar.gz', 'release.tar.gz.sha256', 'release.tar.gz.sha256.sig',
    'channel.json'];
  const tmp = `.grigdesk-publish-${version}-${Date.now()}`;

  // dry-run печатает план до мутации channel.json: пробный запуск ничего не меняет.
  if (process.argv.includes('--dry-run')) {
    process.stdout.write(`План: ${upload.join(', ')} → ${tmp} → releases/${version}\n`);

    return;
  }

  await fs.writeFile(channelPath, `${JSON.stringify({
    ...index,
    latest: {
      ...entry,
      archiveUrl
    },
  }, null, 2)}\n`, { mode: 0o644 });

  let mirrorFailed = false;

  for (const target of targetList) {
    if (!target.host || !target.user || !target.key || !target.dir || !target.origin) {
      continue;
    }

    const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
      '-o', 'StrictHostKeyChecking=accept-new'];
    const remote = (command: string) => {
      return execute('ssh', [...sshOptions, '-i', target.key, '-p', target.port,
        `${target.user}@${target.host}`, command], { maxBuffer: 16 * 1024 * 1024 });
    };
    const staging = quoteShell(`${target.dir}/${tmp}`);
    const published = quoteShell(`${target.dir}/releases/${version}`);
    const channel = quoteShell(`${target.dir}/api/releases/v1/channel.json`);
    const pendingChannel = quoteShell(`${target.dir}/api/releases/v1/channel.json.new`);

    try {
      await remote(`mkdir -p ${quoteShell(`${target.dir}/releases`)} ${staging}`);
      await execute('scp', [...sshOptions, '-i', target.key, '-P', target.port,
        ...upload.map((name) => {
          return path.join(directory, name);
        }),
        `${target.user}@${target.host}:${target.dir}/${tmp}/`]);
      await remote(`cp ${staging}/channel.json ${pendingChannel}`);
      // Каталог версии неизменяем: повтор допускается только с теми же суммами.
      // Канал переключается последним, когда архив уже доступен по постоянному URL.
      await remote(`if test -e ${published}; then cmp ${staging}/release.tar.gz.sha256`
        + ` ${published}/release.tar.gz.sha256 && rm -rf ${staging};`
        + ` else mv ${staging} ${published}; fi`);
      await remote(`mv ${pendingChannel} ${channel}`);
      process.stdout.write(`Опубликовано на ${target.host}: releases/${version}\n`);
    } catch (error) {
      if (target === primary) {
        process.stderr.write(`Публикация на ${target.host} не удалась:`
          + ` ${(error as Error).message}\n`);
        process.exitCode = 4;

        return;
      }

      mirrorFailed = true;
      process.stderr.write(`Зеркало ${target.host} не опубликовано:`
        + ` ${(error as Error).message}\n`);
    }
  }

  if (mirrorFailed) {
    process.stderr.write('Часть зеркал не опубликована; основной хост обновлён.\n');
  }
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = process.exitCode === 3 ? 3 : 4;
  });
}
