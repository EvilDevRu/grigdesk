import type { KimiServerClient } from './serverClient.ts';

/**
 * Требует строковый список от нативного протокола без разрешающего fallback.
 * Undefined допускается только для optional allowlist самого профиля.
 */
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Читает фактические слои исходного Bash, не затрагивая наш глобальный disabled.
 * Неизвестная форма, недоступный RPC и неподтверждённый caller сохраняют запрет команды.
 */
export async function checkKimiNativeShellPolicy(
  client: Pick<KimiServerClient, 'settingsRequest'>,
  sessionId: string,
): Promise<boolean> {
  try {
    const base = `/api/v1/debug/session/${encodeURIComponent(sessionId)}`;

    await client.settingsRequest('GET', `${base}/externalHooksRunnerService/ready`);

    const rawState = await client.settingsRequest('GET', `${base}/sessionStateService/snapshot`);

    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
      return false;
    }

    const folds = (rawState as Record<string, unknown>)['sessionActivity.folds'];

    if (!folds || typeof folds !== 'object' || Array.isArray(folds)
      || Object.keys(folds).length !== 1 || !Object.hasOwn(folds, 'main')) {
      return false;
    }

    const [session, workspace, rawProfile, rules, hooks] = await Promise.all([
      client.settingsRequest('GET', `${base}/sessionToolPolicy/disabledTools`),
      client.settingsRequest('GET', `${base}/workspaceToolPolicy/disabledTools`),
      client.settingsRequest('GET', `${base}/agent/main/agentProfileService/data`),
      client.settingsRequest('GET', `${base}/agent/main/agentPermissionRulesService/rules`),
      client.settingsRequest('GET', `${base}/externalHooksRunnerService/summary`),
    ]);

    if (!stringList(session) || !stringList(workspace)
      || !rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
      return false;
    }

    if (!Array.isArray(rules) || rules.length !== 0
      || !hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
      return false;
    }

    const summary = hooks as Record<string, unknown>;

    if (Object.values(summary).some((count) => !Number.isSafeInteger(count) || Number(count) < 0)
      || (summary.PreToolUse !== undefined && summary.PreToolUse !== 0)) {
      return false;
    }

    const profile = rawProfile as Record<string, unknown>;
    const denied = profile.disallowedTools;
    const enabled = profile.activeToolNames;

    if (!stringList(denied) || (enabled !== undefined && !stringList(enabled))) {
      return false;
    }

    return !session.includes('Bash') && !workspace.includes('Bash') && !denied.includes('Bash')
      && (enabled === undefined || (enabled as string[]).includes('Bash'));
  } catch {
    return false;
  }
}
