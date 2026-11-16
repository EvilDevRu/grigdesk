import { isRecord } from '../../../shared/lib/objects.ts';
import { decodeInstallChecks, decodeInstallJob, PluginInstallProtocolError } from './pluginInstallApi.ts';
import type { PluginInstallInfo, PluginInstallJob } from '../../../shared/plugins/pluginInstallContracts.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);


export type DriverInstallJob = Omit<PluginInstallJob, 'pluginId'> & {
  driverId: string | null;
  payloadDigest: string | null;
};

/**
 * Ответ удаления подтверждает конкретный id, а не прежнюю job установки.
 * Флаг рестарта остаётся явным серверным фактом и проверяется до смены UI.
 */
export function decodeDriverRemoval(raw: unknown): { id: string; restartRequired: boolean } {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.restartRequired !== 'boolean') {
    throw new PluginInstallProtocolError();
  }

  return { id: raw.id, restartRequired: raw.restartRequired };
}

/**
 * Каталог содержит только ярлыки HTTP(S) репозиториев, без ожидаемого id или версии.
 * Проверенный URL позволяет диалогу безопасно показать домен без сетевого обращения.
 */
export function decodeDriverSources(raw: unknown): { title: string; url: string }[] {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) {
    throw new PluginInstallProtocolError();
  }

  return raw.sources.map((source) => {
    if (!isRecord(source) || typeof source.title !== 'string' || !source.title.trim()
      || typeof source.url !== 'string' || !URL.canParse(source.url)
      || !['http:', 'https:'].includes(new URL(source.url).protocol)) {
      throw new PluginInstallProtocolError();
    }

    return { title: source.title, url: source.url };
  });
}

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
    throw new Error(t('core.coreNekorrektnyyOtvetUstanovkiDrayvera'));
  }

  if (raw.job === null) {
    return {
      job: null,
      restartRequired: false,
      recoveryError: isRecord(raw.recoveryError) ? String(raw.recoveryError.message ?? '') : '',
    };
  }

  if (!isRecord(raw.job)) {
    throw new Error(t('core.coreNekorrektnoeZadanieUstanovki'));
  }

  const { driverId, ...fields } = raw.job;
  const decoded = decodeInstallJob({ ...fields, pluginId: driverId });
  const { pluginId, ...job } = decoded;
  const digest = isRecord(fields.preview) ? fields.preview.payloadDigest : null;

  if (digest != null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) {
    throw new Error(t('core.coreNekorrektnyyDigestDrayvera'));
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
    throw new Error(t('core.coreNekorrektnyyKatalogUstanovlennyhDrayverov'));
  }

  const records = decodeInstallChecks({ plugins: raw.drivers });

  return Object.fromEntries(Object.entries(records)
    .filter((entry): entry is [string, PluginInstallInfo] => entry[1] !== null));
}
