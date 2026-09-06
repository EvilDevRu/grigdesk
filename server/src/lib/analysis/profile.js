// Чтение переменных профиля фабрики (bash) для триажа: стек-контекст, каталоги агента,
// корни git-репозиториев, проектные маркеры риска. Кокпит проектных путей не знает —
// всё приходит из профиля. Fail-soft: профиль не читается → пустые значения, триаж
// работает «вслепую» (без контекста и маркеров), но работает.
import { execFile } from 'node:child_process';
import path from 'node:path';

const SEP = '\x1e'; // record separator — в значениях профиля не встречается

/**
 * @param {{factoryHome:string, profilesDir:string}} config пути движка и профилей
 * @param {string} name имя профиля (profiles/<name>/profile.sh)
 * @returns {Promise<{ctx:string, cwd:string, dirs:string[], repos:Array<{key:string,dir:string}>, markers:string, routeMap:string}>}
 */
export async function loadTriageProfile({ factoryHome, profilesDir }, name) {
  const empty = { ctx: '', cwd: '', dirs: [], repos: [], markers: '', routeMap: '' };
  if (!name || !factoryHome || !profilesDir) return empty;
  const file = path.join(profilesDir, name, 'profile.sh');
  const script = `source "${file}" >/dev/null 2>&1 || exit 1
printf '%s${SEP}' "$PROFILE_CTX" "$PROFILE_AGENT_CWD" "$PROFILE_AGENT_DIRS" "$PROFILE_TRIAGE_REPOS" "$PROFILE_TRIAGE_MARKERS" "$PROFILE_TRIAGE_ROUTES"`;
  const out = await new Promise((resolve) => {
    execFile('bash', ['-c', script], {
      env: { ...process.env, FACTORY_HOME: factoryHome, FACTORY_PROFILES_DIR: profilesDir },
      timeout: 10000,
    }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (out === null) return empty;
  const [ctx = '', cwd = '', dirsRaw = '', reposRaw = '', markers = '', routeMap = ''] = out.split(SEP);
  return {
    ctx,
    cwd,
    dirs: dirsRaw.split(/\s+/).filter(Boolean),
    // "be:/path/to/be/html fe:/path/to/fe" → [{key:'be', dir:'/path/to/be/html'}, …]
    repos: reposRaw.split(/\s+/).filter(Boolean).map((pair) => {
      const i = pair.indexOf(':');
      return i > 0 ? { key: pair.slice(0, i), dir: pair.slice(i + 1) } : null;
    }).filter(Boolean),
    markers,
    // «род:глубина=маршрут» — соответствие оценки триажа маршрутам ЭТОГО проекта.
    // Профиль без карты работает по-старому: род должен совпасть с именем маршрута.
    routeMap,
  };
}
