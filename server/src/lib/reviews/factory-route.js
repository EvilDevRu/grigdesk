// Read-only привязка review-run к настоящему маршруту Factory.
//
// Источник runtime-маршрутов — PROFILE_ROUTE_STAGES_* из profile.sh, а не
// редакторская база routes/<project>. PROFILE_REVIEW_ROUTE только указывает,
// какой из уже существующих маршрутов профиль разрешает использовать для PR.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const ROUTE_ID = /^[a-z][a-z0-9_]{0,40}$/;
const STAGE_ID = /^[A-Z][A-Z0-9_]{0,63}$/;
const REVISION_PREFIX = 'factory-review-route:v1:';
const DEFAULT_TIMEOUT_MS = 10_000;

// NUL-framing не позволяет тексту из значения переменной подделать соседнюю
// запись. Сам profile.sh доверенный, но битая конфигурация должна падать закрыто.
const INSPECT_PROFILE = String.raw`
set +e
set +u
source "$1" >/dev/null 2>&1
source_rc=$?
(( source_rc == 0 )) || exit 70
set +e
set +u
IFS=$' \t\n'

printf 'COCKPIT_FACTORY_REVIEW_V1\0%s\0' "${'$'}{PROFILE_REVIEW_ROUTE-}"

dump_factory_routes() {
  local variable route declaration stage
  local -a variables=()
  local -a stages=()
  mapfile -t variables < <(compgen -A variable | LC_ALL=C sort)
  for variable in "${'$'}{variables[@]}"; do
    [[ "$variable" == PROFILE_ROUTE_STAGES_* ]] || continue
    route=${'$'}{variable#PROFILE_ROUTE_STAGES_}
    declaration=$(declare -p "$variable" 2>/dev/null)
    if [[ ! "$declaration" =~ ^declare\ -[^[:space:]]*a[^[:space:]]*\  ]]; then
      printf 'INVALID\0%s\0' "$route"
      continue
    fi
    local -n route_stages="$variable"
    stages=("${'$'}{route_stages[@]}")
    printf 'ROUTE\0%s\0%s\0' "$route" "${'$'}{#stages[@]}"
    for stage in "${'$'}{stages[@]}"; do
      printf '%s\0' "$stage"
    done
    unset -n route_stages
  done
}

dump_factory_routes
printf 'END\0'
`;

export class FactoryReviewRouteError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FactoryReviewRouteError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new FactoryReviewRouteError(code, message, details);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseInspection(stdout, profileId) {
  const fields = String(stdout ?? '').split('\0');
  let index = 0;
  if (fields[index++] !== 'COCKPIT_FACTORY_REVIEW_V1') {
    fail(
      'FACTORY_PROFILE_RESPONSE_INVALID',
      `Профиль Factory ${profileId} вернул некорректное описание маршрутов`,
    );
  }
  const selectedRoute = fields[index++] ?? '';
  const routes = new Map();
  while (index < fields.length) {
    const record = fields[index++];
    if (record === 'END') break;
    if (record === 'INVALID') {
      const routeId = fields[index++] ?? '';
      fail(
        'FACTORY_ROUTE_DECLARATION_INVALID',
        `Маршрут Factory ${routeId || '(без имени)'} объявлен не массивом этапов`,
      );
    }
    if (record !== 'ROUTE') {
      fail(
        'FACTORY_PROFILE_RESPONSE_INVALID',
        `Профиль Factory ${profileId} вернул некорректное описание маршрутов`,
      );
    }
    const routeId = fields[index++] ?? '';
    const rawCount = fields[index++] ?? '';
    if (!/^(?:0|[1-9]\d*)$/.test(rawCount)) {
      fail('FACTORY_PROFILE_RESPONSE_INVALID', 'Некорректное число этапов Factory route');
    }
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count > 256 || index + count > fields.length) {
      fail('FACTORY_PROFILE_RESPONSE_INVALID', 'Некорректный размер Factory route');
    }
    const stages = fields.slice(index, index + count);
    index += count;
    if (routes.has(routeId)) {
      fail('FACTORY_ROUTE_DUPLICATE', `Маршрут Factory ${routeId} объявлен дважды`);
    }
    routes.set(routeId, stages);
  }
  if (fields[index - 1] !== 'END'
      || fields.slice(index).some((field) => field !== '')) {
    fail(
      'FACTORY_PROFILE_RESPONSE_INVALID',
      `Профиль Factory ${profileId} вернул незавершённое описание маршрутов`,
    );
  }
  return { selectedRoute, routes };
}

function validateSelectedRoute({ profileId, selectedRoute, routes }) {
  if (!selectedRoute) {
    fail(
      'REVIEW_ROUTE_NOT_CONFIGURED',
      `Профиль Factory ${profileId} не задаёт PROFILE_REVIEW_ROUTE`,
    );
  }
  if (!ROUTE_ID.test(selectedRoute)) {
    fail(
      'REVIEW_ROUTE_ID_INVALID',
      `Профиль Factory ${profileId} задаёт некорректный review route`,
    );
  }
  const stages = routes.get(selectedRoute);
  if (!stages) {
    fail(
      'REVIEW_ROUTE_NOT_FOUND',
      `Review route ${selectedRoute} не объявлен в профиле Factory ${profileId}`,
    );
  }
  if (!stages.length
      || stages.some((stage) => !STAGE_ID.test(stage))
      || new Set(stages).size !== stages.length) {
    fail(
      'REVIEW_ROUTE_STAGES_INVALID',
      `Review route ${selectedRoute} содержит некорректные или повторные этапы`,
    );
  }
  const buildIndex = stages.indexOf('BUILD');
  const acceptIndex = stages.indexOf('GATE_ACCEPT');
  if (buildIndex < 0) {
    fail(
      'REVIEW_ROUTE_BUILD_REQUIRED',
      `Review route ${selectedRoute} не содержит обязательный этап BUILD`,
    );
  }
  if (acceptIndex < 0) {
    fail(
      'REVIEW_ROUTE_ACCEPT_GATE_REQUIRED',
      `Review route ${selectedRoute} не содержит обязательные ворота GATE_ACCEPT`,
    );
  }
  if (acceptIndex <= buildIndex) {
    fail(
      'REVIEW_ROUTE_ORDER_INVALID',
      `В review route ${selectedRoute} ворота GATE_ACCEPT должны идти после BUILD`,
    );
  }
  return stages;
}

function safeTimeout(value) {
  const timeout = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
    fail('FACTORY_PROFILE_TIMEOUT_INVALID', 'Некорректный timeout чтения Factory profile');
  }
  return timeout;
}

/**
 * Загружает единственный review route Factory-профиля.
 *
 * Возвращаемый descriptor намеренно не содержит абсолютных путей или prefs:
 * его можно безопасно сохранить в durable review-run и показать через API.
 *
 * @param {{
 *   profilesDir: string,
 *   projectId: string,
 *   factoryHome?: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<Readonly<{
 *   schemaVersion: 1,
 *   source: 'factory-profile',
 *   profileId: string,
 *   routeId: string,
 *   stages: readonly string[],
 *   revision: string,
 * }>>}
 */
export async function loadFactoryReviewRoute({
  profilesDir,
  projectId,
  factoryHome = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const root = String(profilesDir || '');
  const profileId = String(projectId || '');
  if (!path.isAbsolute(root)) {
    fail('FACTORY_PROFILES_DIR_INVALID', 'Каталог Factory profiles должен быть абсолютным');
  }
  if (!PROFILE_ID.test(profileId)) {
    fail('FACTORY_PROFILE_ID_INVALID', 'Некорректный id Factory profile');
  }
  if (factoryHome && !path.isAbsolute(factoryHome)) {
    fail('FACTORY_HOME_INVALID', 'FACTORY_HOME должен быть абсолютным');
  }
  const timeout = safeTimeout(timeoutMs);
  const profileDir = path.join(root, profileId);
  const profileFile = path.join(profileDir, 'profile.sh');
  const graphFile = path.join(profileDir, 'graph.json');

  let profileBefore;
  let graphBefore;
  try {
    [profileBefore, graphBefore] = await Promise.all([
      fs.readFile(profileFile, 'utf8'),
      fs.readFile(graphFile, 'utf8'),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      fail(
        'FACTORY_PROFILE_NOT_FOUND',
        `Project ${profileId} не связан с существующим Factory profile`,
      );
    }
    fail(
      'FACTORY_PROFILE_READ_FAILED',
      `Не удалось прочитать Factory profile ${profileId}`,
      { reason: error?.code || 'read_failed' },
    );
  }
  try {
    const graph = JSON.parse(graphBefore);
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new TypeError();
  } catch {
    fail('FACTORY_PROFILE_GRAPH_INVALID', `graph.json профиля Factory ${profileId} повреждён`);
  }

  let stdout;
  try {
    ({ stdout } = await exec('bash', [
      '-c',
      INSPECT_PROFILE,
      'cockpit-factory-review-route',
      profileFile,
    ], {
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || '/',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        FACTORY_PROFILES_DIR: root,
        ...(factoryHome && { FACTORY_HOME: factoryHome }),
      },
    }));
  } catch (error) {
    fail(
      'FACTORY_PROFILE_INSPECTION_FAILED',
      `Не удалось получить review route из Factory profile ${profileId}`,
      {
        reason: error?.killed ? 'timeout' : error?.code || 'inspection_failed',
      },
    );
  }

  // Не принимаем descriptor, если profile/graph менялись одновременно с чтением:
  // revision обязан описывать именно тот снимок, который был проверен.
  const [profileAfter, graphAfter] = await Promise.all([
    fs.readFile(profileFile, 'utf8').catch(() => null),
    fs.readFile(graphFile, 'utf8').catch(() => null),
  ]);
  if (profileAfter !== profileBefore || graphAfter !== graphBefore) {
    fail(
      'FACTORY_PROFILE_CHANGED',
      `Factory profile ${profileId} изменился во время чтения; повтори попытку`,
    );
  }

  const inspection = parseInspection(stdout, profileId);
  const stages = validateSelectedRoute({ profileId, ...inspection });
  const revision = `${REVISION_PREFIX}${digest(JSON.stringify({
    schemaVersion: 1,
    profileId,
    routeId: inspection.selectedRoute,
    stages,
    profileDigest: digest(profileBefore),
  }))}`;
  return Object.freeze({
    schemaVersion: 1,
    source: 'factory-profile',
    profileId,
    routeId: inspection.selectedRoute,
    stages: Object.freeze([...stages]),
    revision,
  });
}

/**
 * Fail-soft представление для Project/UI. Ожидаемые ошибки конфигурации не
 * роняют чтение PR, но `ready:false` нельзя превращать в разрешение на run.
 */
export async function inspectFactoryReviewRoute(options = {}) {
  try {
    return Object.freeze({
      ready: true,
      descriptor: await loadFactoryReviewRoute(options),
      error: null,
    });
  } catch (error) {
    if (!(error instanceof FactoryReviewRouteError)) throw error;
    return Object.freeze({
      ready: false,
      descriptor: null,
      error: Object.freeze({
        code: error.code,
        message: error.message,
      }),
    });
  }
}
