import type { ChatSpeed } from '../../../shared/chat/chatSpeed.ts';
import { contractDecoders } from '../../../shared/lib/contractDecoders.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';

import { api } from './apiClient.ts';
import { uiLocalePort } from './uiLocalePort.ts';

export type ProfileConfigFile = 'profile.sh' | 'dashboard.env';

export interface ProfileVariableView {
  name: string;
  value: string | null;
  literal: boolean;
  editable: boolean;
  present: boolean;
  reason: string | null;
}

export interface ProfileConfigView {
  profile: string;
  variables: { profileSh: ProfileVariableView[]; dashboard: ProfileVariableView[] };
  runners: Record<string, string>;
  capabilities: string[];
}

export interface ProfileVariableChangeView {
  name: string;
  from: string | null;
  to: string;
}

export interface ModelConfigOperationView {
  kind: 'model';
  role: string;
  provider: string;
  family?: string;
  familyFailover?: string;
  version?: string;
  variant?: string;
  effort?: string;
  speed?: ChatSpeed | '';
  exact?: string;
}

export type RunnerConfigOperationView = ModelConfigOperationView | {
  kind: 'runner';
  role?: string;
  primary: string;
  failover?: string;
};

const t = localeTranslator(uiLocalePort);
const decode = contractDecoders(() => {
  throw new Error(t('core.projectConfigInvalidResponse'));
});
const variableDecoder = decode.objectOf({
  name: decode.text,
  value: decode.nullable(decode.text),
  literal: decode.boolean,
  editable: decode.boolean,
  present: decode.boolean,
  reason: decode.nullable(decode.text),
});
const configDecoder = decode.objectOf({
  profile: decode.text,
  variables: decode.objectOf({
    profileSh: decode.listOf(variableDecoder),
    dashboard: decode.listOf(variableDecoder),
  }),
  runners: decode.mapOf(decode.text),
  capabilities: decode.listOf(decode.text),
});

/**
 * Читает проверенный снимок указанного профиля. Чужой профиль в ответе
 * не должен стать основанием последующих операций формы.
 */
export async function fetchProfileConfig(profile: string): Promise<ProfileConfigView> {
  const raw = await api.get(`/api/profiles/${encodeURIComponent(profile)}/config`);
  const result = configDecoder(raw, 'config');

  if (result.profile !== profile) {
    throw new Error(t('core.projectConfigInvalidResponse'));
  }

  return result;
}

/**
 * Передаёт прежнее значение каждой переменной без подмены свежим GET.
 * Ответ остаётся серверным фактом, локальное намерение живёт отдельно.
 */
export async function patchProfileVariables(
  profile: string,
  file: ProfileConfigFile,
  changes: ProfileVariableChangeView[],
): Promise<ProfileVariableView[]> {
  const raw = await api.patch(`/api/profiles/${encodeURIComponent(profile)}/variables`, {
    file,
    changes,
  });
  const response = decode.objectOf({ variables: decode.listOf(variableDecoder) })(raw, 'result');

  return response.variables;
}

/**
 * Исполнители и модели изменяются только штатным серверным endpoint.
 * Ошибка API сохраняет status/data, в том числе appliedOperations.
 */
export async function patchProfileRunners(
  profile: string,
  operations: RunnerConfigOperationView[],
): Promise<Record<string, string>> {
  const raw = await api.patch(`/api/profiles/${encodeURIComponent(profile)}/runners`, {
    operations,
  });
  const response = decode.objectOf({ runners: decode.mapOf(decode.text) })(raw, 'result');

  return response.runners;
}
