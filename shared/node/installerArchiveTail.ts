import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';

import type { ReleaseArtifact } from '../runtime/installedUpdateContracts.ts';

type Component = 'server' | 'desktop';
type Archives = Record<Component, Pick<ReleaseArtifact, 'size' | 'sha256'>>;

/**
 * Большие архивы идут за готовым ELF в фиксированном порядке server, desktop.
 * Их подписанные размеры задают границы; blob postject остаётся маленьким.
 */
export async function appendInstallerArchives(binary: string, sources: Record<Component, string>): Promise<void> {
  const output = await fs.open(binary, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);

  try {
    if (!(await output.stat()).isFile()) {
      throw new Error('installer_binary_not_regular');
    }

    for (const component of ['server', 'desktop'] as const) {
      const input = await fs.open(sources[component],
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);

      try {
        const stat = await input.stat();
        let copied = 0;

        if (!stat.isFile() || stat.size <= 0) {
          throw new Error('installer_archive_not_regular');
        }

        for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
          await output.writeFile(chunk);
          copied += chunk.length;
        }

        if (copied !== stat.size) {
          throw new Error('installer_archive_source_changed');
        }
      } finally {
        await input.close();
      }
    }

    await output.sync();
  } finally {
    await output.close();
  }
}

/**
 * Чтение хвоста ограничено подписанными размерами и SHA без загрузки всего архива в RAM.
 * Изменение размера ELF, обрыв или порча архива дают отказ до передачи его установщику.
 */
async function consumeInstallerArchive(
  binary: string,
  archives: Archives,
  component: Component,
  write?: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  const input = await fs.open(binary, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);

  try {
    const stat = await input.stat();

    for (const archive of [archives.server, archives.desktop]) {
      if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || !/^[a-f0-9]{64}$/u.test(archive.sha256)) {
        throw new Error('installer_archive_description_invalid');
      }
    }

    const total = archives.server.size + archives.desktop.size;
    const base = stat.size - total;

    if (!stat.isFile() || !Number.isSafeInteger(total) || base < 64) {
      throw new Error('installer_archive_tail_invalid');
    }

    const archive = archives[component];
    const start = base + (component === 'desktop' ? archives.server.size : 0);
    const stream = input.createReadStream({
      start,
      end: start + archive.size - 1,
      highWaterMark: 1024 * 1024,
      autoClose: false,
    });
    const hash = createHash('sha256');
    let size = 0;

    for await (const chunk of stream) {
      hash.update(chunk);
      size += chunk.length;
      await write?.(chunk);
    }

    if (size !== archive.size || hash.digest('hex') !== archive.sha256) {
      throw new Error('installer_archive_integrity_invalid');
    }
  } finally {
    await input.close();
  }
}

/**
 * Публичная проверка установщика сверяет каждый байт встроенного архива без распаковки.
 * Она не читает пользовательское состояние и не запускает компоненты приложения.
 */
export async function verifyInstallerArchive(binary: string, archives: Archives, component: Component) {
  await consumeInstallerArchive(binary, archives, component);
}

/**
 * Архив создаётся эксклюзивно в приватной временной папке и сохраняется только после SHA.
 * Ошибка не удаляет существующий чужой target и не оставляет свой повреждённый результат.
 */
export async function copyInstallerArchive(
  binary: string,
  archives: Archives,
  component: Component,
  target: string,
): Promise<void> {
  const output = await fs.open(target, 'wx', 0o600);
  let complete = false;

  try {
    await consumeInstallerArchive(binary, archives, component, async (chunk) => {
      await output.writeFile(chunk);
    });
    await output.sync();
    complete = true;
  } finally {
    await output.close();

    if (!complete) {
      await fs.rm(target, { force: true });
    }
  }
}
