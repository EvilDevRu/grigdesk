// Чтение переменных профиля фабрики (bash) для триажа: стек-контекст, каталоги агента,
// корни git-репозиториев, проектные маркеры риска. Кокпит проектных путей не знает —
// всё приходит из профиля. Fail-soft: профиль не читается → пустые значения, триаж
// работает «вслепую» (без контекста и маркеров), но работает.
import { execFile } from 'node:child_process';
import path from 'node:path';

const SEP = '\x1e'; // record separator — в значениях профиля не встречается

export interface TriageRepo {
  key: string;
  dir: string;
}

export interface TriageProfile {
  ctx: string;
  cwd: string;
  dirs: string[];
  repos: TriageRepo[];
  markers: string;
  routeMap: string;
  // Где конвейер профиля работает с кодом: isolated — в новом worktree от ветки origin,
  // shared — прямо в рабочей копии; null — профиль хук не объявил.
  workspaceMode: 'isolated' | 'shared' | null;
}

export interface TriageProfilePaths {
  factoryHome?: string;
  profilesDir?: string;
}

/**
 * Читает переменные профиля фабрики. Профиль не читается — возвращаются пустые
 * значения: триаж работает вслепую, но работает.
 */
export async function loadTriageProfile(
  { factoryHome, profilesDir }: TriageProfilePaths,
  name?: string,
): Promise<TriageProfile> {
  const empty: TriageProfile = {
    ctx: '',
    cwd: '',
    dirs: [],
    repos: [],
    markers: '',
    routeMap: '',
    workspaceMode: null,
  };
  if (!name || !factoryHome || !profilesDir) return empty;
  const file = path.join(profilesDir, name, 'profile.sh');
  const script = `source "${file}" >/dev/null 2>&1 || exit 1
__triage_mode=$(declare -F profile_workspace_mode >/dev/null && profile_workspace_mode 2>/dev/null)
printf '%s${SEP}' "$PROFILE_CTX" "$PROFILE_AGENT_CWD" "$PROFILE_AGENT_DIRS" "$PROFILE_TRIAGE_REPOS" \
  "$PROFILE_TRIAGE_MARKERS" "$PROFILE_TRIAGE_ROUTES" "$__triage_mode"`;
  const out = await new Promise<string | null>((resolve) => {
    execFile('bash', ['-c', script], {
      env: { ...process.env, FACTORY_HOME: factoryHome, FACTORY_PROFILES_DIR: profilesDir },
      timeout: 10000,
    }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (out === null) return empty;

  const [
    ctx = '',
    cwd = '',
    dirsRaw = '',
    reposRaw = '',
    markers = '',
    routeMap = '',
    modeRaw = '',
  ] = out.split(SEP);
  const mode = modeRaw.trim();
  return {
    ctx,
    cwd,
    dirs: dirsRaw.split(/\s+/).filter(Boolean),
    // "be:/path/to/be/html fe:/path/to/fe" → [{key:'be', dir:'/path/to/be/html'}, …]
    repos: reposRaw.split(/\s+/).filter(Boolean).map((pair) => {
      const i = pair.indexOf(':');
      return i > 0 ? { key: pair.slice(0, i), dir: pair.slice(i + 1) } : null;
    }).filter((repo): repo is TriageRepo => repo !== null),
    markers,
    // «род:глубина=маршрут» — соответствие оценки триажа маршрутам ЭТОГО проекта.
    // Профиль без карты работает по-старому: род должен совпасть с именем маршрута.
    routeMap,
    // От режима зависит, какой код читает триаж (lib/analysis/triageSource.ts).
    workspaceMode: mode === 'isolated' || mode === 'shared' ? mode : null,
  };
}
