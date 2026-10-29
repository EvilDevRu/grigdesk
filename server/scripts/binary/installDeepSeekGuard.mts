import fs from 'node:fs/promises';
import path from 'node:path';

import type { DeepSeekHostContract } from '../../../shared/chat/deepSeekBinary.ts';
import { acquireInstallLock, lstatOrNull } from '../../../shared/node/binaryInstall.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import {
  prepareServerBinary,
  releaseServerPreparation,
  type ServerBinaryProbeOptions,
} from '../../../shared/node/serverBinaryRuntime.ts';
import { assertDeepSeekBinaryReady } from '../../src/lib/deepseek/binaryReadiness.ts';

interface GuardOptions {
  binary: string;
  serverBinary: string;
  packageId: string;
  home: string;
  required: boolean;
  glmMode?: DeepSeekHostContract['glm']['mode'];
  run?: ServerBinaryProbeOptions['run'];
}

/**
 * Требования читаются из проверенного кандидата сервера, а не соседнего checkout.
 * Preparation освобождается при любом исходе, личные данные для проб не используются.
 */
async function checkPair(options: GuardOptions): Promise<string> {
  const probe = {
    home: options.home,
    expectPackageId: options.packageId,
    timeoutMs: 120000,
    run: options.run,
  };
  const prepared = await prepareServerBinary(options.serverBinary, probe);

  try {
    const root = await fs.realpath(prepared.root);
    const home = await fs.realpath(options.home);

    if (!root.startsWith(`${home}${path.sep}`)) {
      throw new Error('Кандидат сервера подготовлен вне одноразовой папки проверки');
    }

    const result = await assertDeepSeekBinaryReady(
      options.binary, path.join(root, 'server/deepseek-host-contract.json'), {
        glmMode: options.glmMode,
      },
    );

    return result.sha256;
  } finally {
    await releaseServerPreparation(options.serverBinary, {
      ...probe,
      packageId: options.packageId,
      token: prepared.preparationToken,
    });
  }
}

/**
 * Установка сервера удерживает lock исполнителя до публикации согласованной пары.
 * Отсутствие optional ELF допустимо, но его появление или подмена во время проб — отказ.
 */
export async function guardInstalledDeepSeek(options: GuardOptions) {
  const lock = await acquireInstallLock(options.binary);

  try {
    const present = await lstatOrNull(options.binary);

    if ((!present && options.required) || present && !present.isFile()) {
      throw new Error('Установленный DeepSeek должен быть доступным обычным ELF');
    }

    const stamp = present ? await fs.lstat(options.binary, { bigint: true }) : null;
    const digest = present ? await checkPair(options) : null;

    /**
     * Повторная сверка ловит прямую запись в обход lock перед публикацией сервера.
     * Даже появившийся optional ELF требует новой полной проверки совместимости.
     */
    const assertUnchanged = async () => {
      const current = await lstatOrNull(options.binary);

      if (!stamp && !current) {
        return;
      }

      if (stamp && current?.isFile()) {
        const checked = await fs.lstat(options.binary, { bigint: true });
        const fields = ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'] as const;

        if (fields.every((field) => checked[field] === stamp[field])
          && await sha256File(options.binary) === digest) {
          return;
        }
      }

      throw new Error('DeepSeek изменился во время установки сервера; повторите установку');
    };

    await assertUnchanged();

    return { assertUnchanged, release: lock.release };
  } catch (cause) {
    await lock.release();

    throw new Error('Совместимость сервера с установленными DeepSeek/GLM не подтверждена. '
      + 'Сервер сохранён. Подготовьте совместимую пару и установите исполнитель через '
      + 'npm --prefix deepseek run install:binary с --host-contract целевого сервера '
      + 'и --glm-mode фактического режима потребителя.', { cause });
  }
}
