import { isRecord } from '../../../shared/lib/objects.ts';
import { decodeInstallChecks, decodeInstallJob } from './pluginInstallApi.ts';
import type { PluginInstallInfo, PluginInstallJob } from '../../../shared/plugins/pluginInstallContracts.ts';

export type DriverInstallJob = Omit<PluginInstallJob, 'pluginId'> & {
  driverId: string | null;
  payloadDigest: string | null;
};

/**
 * Механизм job общий, имя внешнего ресурса остаётся драйверным.
 * Проверенный plugin decoder используется только как decoder формы, без plugin API или store.
 */
export function decodeDriverInstallResponse(raw: unknown): {
  job: DriverInstallJob | null;
  restartRequired: boolean;
  recoveryError: string;
} {
  if (!isRecord(raw) || !Object.hasOwn(raw, 'job')) {
    throw new Error('Некорректный ответ установки драйвера');
  }

  if (raw.job === null) {
    return {
      job: null,
      restartRequired: false,
      recoveryError: isRecord(raw.recoveryError) ? String(raw.recoveryError.message ?? '') : '',
    };
  }

  if (!isRecord(raw.job)) {
    throw new Error('Некорректное задание установки');
  }

  const { driverId, ...fields } = raw.job;
  const decoded = decodeInstallJob({ ...fields, pluginId: driverId });
  const { pluginId, ...job } = decoded;
  const digest = isRecord(fields.preview) ? fields.preview.payloadDigest : null;

  if (digest != null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) {
    throw new Error('Некорректный digest драйвера');
  }

  return {
    job: {
      ...job,
      driverId: pluginId,
      payloadDigest: digest ?? null,
    },
    restartRequired: raw.restartRequired === true || fields.restartRequired === true,
    recoveryError: isRecord(raw.recoveryError) ? String(raw.recoveryError.message ?? '') : '',
  };
}

/**
 * Снимок управляемых установок использует общий decoder формы, но отдельный ресурс.
 * CAS отката берётся из previous, даже когда current имеет другой digest.
 */
export function decodeDriverInstallChecks(raw: unknown): Record<string, PluginInstallInfo> {
  if (!isRecord(raw)) {
    throw new Error('Некорректный каталог установленных драйверов');
  }

  const records = decodeInstallChecks({ plugins: raw.drivers });

  return Object.fromEntries(Object.entries(records)
    .filter((entry): entry is [string, PluginInstallInfo] => entry[1] !== null));
}
