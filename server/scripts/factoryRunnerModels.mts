import { readFileSync } from 'node:fs';
import path from 'node:path';

import { contractDecoders } from '../../shared/lib/contractDecoders.ts';
import {
  configureDarwinProcessHelper, readDarwinProcessIdentity,
} from '../../shared/node/processIdentity.ts';
import { collectFactoryRunnerModels } from '../src/lib/factoryRunnerModels.ts';
import { executableIdentity } from '../src/lib/providerInstall/executableIdentity.ts';
import { acquireCliLease } from '../src/lib/providerInstall/leases.ts';

const decode = contractDecoders(() => {
  throw new Error('metadata_unavailable: неверный descriptor CLI');
});

const externalMetadataFields = {
  executable: decode.text,
  executableIdentity: decode.text,
  resourceKey: decode.text,
  providerId: decode.text,
  leaseDirectory: decode.text,
};
const externalMetadata = decode.objectOf(externalMetadataFields);

/**
 * Получает реальную сессию Go, которую reader удерживает до её закрытия.
 * На Darwin используется тот же проверенный порт, которым Go подтвердил запуск.
 */
async function metadataSessionId(): Promise<number> {
  if (process.platform === 'darwin') {
    await configureDarwinProcessHelper(
      process.env.FACTORY_DARWIN_PROCESS_HELPER ?? '',
      process.env.FACTORY_DARWIN_PROCESS_HELPER_SHA256 ?? '',
    );

    const owner = await readDarwinProcessIdentity(process.pid);

    if (owner.state === 'alive') {
      return owner.identity.sid;
    }
  } else {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const sessionId = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[3]);

    if (Number.isSafeInteger(sessionId) && sessionId > 0) {
      return sessionId;
    }
  }

  throw new Error('metadata_unavailable: сессия CLI не подтверждена');
}

/**
 * Метаданные используют reader закреплённой копии на всю Go-owned сессию.
 * После завершения сессии штатная проверка lease освобождает эту запись.
 */
async function reserveMetadataCli(raw: string, provider: string, cli: string | undefined) {
  const source = decode.record(JSON.parse(raw), 'CLI');

  if (Object.keys(source).some((key) => !Object.hasOwn(externalMetadataFields, key))) {
    throw new Error('metadata_unavailable: лишнее поле descriptor CLI');
  }

  const entry = externalMetadata(source, 'CLI');
  const digest = /^[a-f0-9]{64}$/u;

  if (!['codex', 'claude'].includes(provider) || entry.providerId !== provider
    || entry.executable !== cli || !path.isAbsolute(entry.executable)
    || !path.isAbsolute(entry.leaseDirectory) || path.normalize(entry.leaseDirectory) !== entry.leaseDirectory
    || !digest.test(entry.executableIdentity) || !digest.test(entry.resourceKey)) {
    throw new Error('metadata_unavailable: неверная identity CLI');
  }

  await acquireCliLease({
    directory: entry.leaseDirectory,
    providerId: provider,
    resourceKey: entry.resourceKey,
    mode: 'reader',
    sessionId: await metadataSessionId(),
  });

  if (await executableIdentity(entry.executable) !== entry.executableIdentity) {
    throw new Error('metadata_unavailable: выбранная копия CLI изменилась');
  }
}

try {
  const [provider, catalog, cli, ...extra] = process.argv.slice(2);

  if (!provider || catalog === undefined || extra.length > 1) {
    throw new Error('metadata_unavailable: требуется исполнитель и каталог раннера');
  }

  if (extra[0] !== undefined) {
    await reserveMetadataCli(extra[0], provider, cli);
  }

  console.log(JSON.stringify({
    schema: 1,
    models: await collectFactoryRunnerModels(provider, catalog === '--native' ? null : catalog, cli),
  }));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 4;
}
