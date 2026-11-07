import type { ReleasePayload } from './installedUpdateContracts.ts';

export interface ServerApi {
  major: number;
  minor: number;
}

export interface ClientRequirement {
  major: number;
  minMinor: number;
}

/**
 * Сохраняет существующее правило API: тот же major и достаточный minor сервера.
 * Неизвестная версия не становится разрешением на замену исполняемого компонента.
 */
export function checkReleaseCompatibility(input: {
  candidate: ReleasePayload;
  scope: 'pair' | 'desktop' | 'server';
  remoteApi?: ServerApi | null;
  installedRequirement?: ClientRequirement;
}): { compatible: boolean; reason: string | null } {
  const requires = input.candidate.desktopRequiresServerApi;
  const api = input.scope === 'desktop' ? input.remoteApi : input.candidate.serverApi;
  const prior = input.installedRequirement;
  const offlineSafe = input.scope === 'desktop' && !api && prior
    && prior.major === requires.major && requires.minMinor <= prior.minMinor;
  const compatible = Boolean(offlineSafe || api && api.major === requires.major
    && api.minor >= requires.minMinor);
  const oldClients = input.scope !== 'server' || input.candidate.serverApi.major === 0
    && input.candidate.serverApi.minor >= 1;

  return {
    compatible: compatible && oldClients,
    reason: compatible && oldClients ? null : api ? 'release_api_incompatible' : 'release_api_unknown',
  };
}
