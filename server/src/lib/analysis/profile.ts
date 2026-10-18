// Чтение переменных профиля фабрики (bash) для триажа: стек-контекст, каталоги агента,
// корни git-репозиториев, проектные маркеры риска, файлы правил продукта. GrigDesk проектных
// путей не знает — всё приходит из профиля. Fail-soft: профиль не читается → пустые значения,
// триаж работает «вслепую» (без контекста и маркеров), но работает.
import { execFile } from 'node:child_process';
import path from 'node:path';

const SEP = '\x1e'; // record separator — в значениях профиля не встречается

export interface TriageRepo {
  key: string;
  dir: string;
}

export interface TriageRulesFile {
  key: string;
  path: string;
}

export interface TriageProfile {
  ctx: string;
  cwd: string;
  dirs: string[];
  repos: TriageRepo[];
  markers: string;
  routeMap: string;
  // Записанные решения владельца о видимом поведении продукта: «ключ:путь от корня репозитория».
  // Триаж читает их в своём снимке кода, поэтому правило действует с той ревизии, где оно влито.
  rules: TriageRulesFile[];
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
    rules: [],
    workspaceMode: null,
  };
  if (!name || !factoryHome || !profilesDir) return empty;
  const file = path.join(profilesDir, name, 'profile.sh');
  const script = `source "${file}" >/dev/null 2>&1 || exit 1
__triage_mode=$(declare -F profile_workspace_mode >/dev/null && profile_workspace_mode 2>/dev/null)
printf '%s${SEP}' "$PROFILE_CTX" "$PROFILE_AGENT_CWD" "$PROFILE_AGENT_DIRS" "$PROFILE_TRIAGE_REPOS" \
  "$PROFILE_TRIAGE_MARKERS" "$PROFILE_TRIAGE_ROUTES" "$__triage_mode" "$PROFILE_TRIAGE_RULES"`;
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
    rulesRaw = '',
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
    rules: parseRulesFiles(rulesRaw),
    // От режима зависит, какой код читает триаж (lib/analysis/triageSource.ts).
    workspaceMode: mode === 'isolated' || mode === 'shared' ? mode : null,
  };
}

/**
 * Разбирает PROFILE_TRIAGE_RULES: «be:.claude/rules.md fe:docs/ui.md» → пары ключ/путь.
 * Абсолютный путь и выход из корня («..») отбрасываются: правило живёт в репозитории
 * и читается в том же снимке, что и код, — файл снаружи сломал бы эту связь.
 */
export function parseRulesFiles(raw: string): TriageRulesFile[] {
  const files: TriageRulesFile[] = [];

  for (const pair of raw.split(/\s+/).filter(Boolean)) {
    const i = pair.indexOf(':');
    const key = i > 0 ? pair.slice(0, i) : '';
    const rel = i > 0 ? pair.slice(i + 1) : '';
    const outside = !rel || rel.startsWith('/') || rel.split('/').includes('..');

    if (key && !outside) {
      files.push({ key, path: rel });
    }
  }

  return files;
}
