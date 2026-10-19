import type { ApiVersion } from '../../../shared/client/clientShell.ts';

export type VersionFailure = 'client_upgrade_required' | 'server_upgrade_required';

/**
 * Совместимость проверяется до передачи тела ответа окну; 101 не содержит контракта.
 * Major меняется целиком, а minor сервера должен покрывать minor приложения.
 */
export function versionFailure(app: ApiVersion, header: unknown, status = 200): VersionFailure | null {
  if (status === 101) {
    return null;
  }

  const match = typeof header === 'string' ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(header) : null;

  if (!match) {
    return 'server_upgrade_required';
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);

  if (major > app.major) {
    return 'client_upgrade_required';
  }

  return major < app.major || minor < app.minor ? 'server_upgrade_required' : null;
}
