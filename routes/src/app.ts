// Управление черновиками маршрутов и конфигурацией профиля для агентов:
// те же данные сервера GrigDesk, что в интерфейсе. Вывод — JSON.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

type FlagValue = string | true | Array<string | true>;
type Flags = Record<string, FlagValue | undefined>;
type JsonObject = Record<string, unknown>;

interface RouteContent {
  routes: Record<string, { route: JsonObject; prompts: JsonObject }>;
  bootstrap: JsonObject | null;
  bootstrapPrompts: JsonObject;
  presentation: JsonObject;
  provenance: JsonObject;
}

interface DraftResponse extends RouteContent {
  id: string;
  revision: number;
}

interface ProfileConfig {
  variables: {
    profileSh: ProfileVariable[];
    dashboard: ProfileVariable[];
  };
}

interface ProfileVariable {
  name: string;
  value: string | null;
  editable: boolean;
}

interface PublicationPayload {
  expectedRevision: number;
  expectedCatalogHash: string | null;
  expectedSourceRevision: number;
  operationId: string;
}

type Command = (args: string[], flags: Flags) => Promise<void>;

const EXIT_USAGE = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_NETWORK = 3;
const EXIT_CONFLICT = 4;
const EXIT_SERVER = 5;

const USAGE = `Использование:
  routes --help | --version | --license
  routes list <профиль>
  routes show <профиль> --draft <id>
  routes editor <профиль>
  routes source <профиль> --mode <editor|profile-script> --yes
    --expected-source-revision <N> --expected-catalog-hash <hash|none>
  routes new <профиль> [--from <empty|catalog>] [--title <текст>]
  routes apply <профиль> --draft <id> --file <JSON> --expected-revision <N>
  routes validate <профиль> --draft <id> --expected-revision <N>
  routes publish <профиль> --draft <id> --expected-revision <N> --yes
    --expected-source-revision <N> --expected-catalog-hash <hash|none>
  routes rollback <профиль> --hash <hash> --yes
    --expected-source-revision <N> --expected-catalog-hash <hash|none>
  routes publications <профиль> <operationId>
  routes export <профиль> --draft <id>
  routes import <профиль> --file <JSON> [--title <текст>]
  routes profile-config get <профиль>
  routes profile-config set <профиль> [--file profile.sh|dashboard.env] --set NAME=VALUE…
Флаги: --token, --token-file, --base <url>, --timeout <мс>.
GRIGDESK_CLI_TOKEN, GRIGDESK_CLI_TOKEN_PATH, GRIGDESK_BASE_URL, GRIGDESK_PORT.
none означает отсутствие current. validate exit 0 — отчёт получен; проверяйте issues/severity.
После конфликта сопоставьте снимки, не подставляйте свежую ревизию автоматически.
После обрыва publish/rollback выполните publications из hint с прежними --base/токеном.
Если потерян ответ создания rollback-копии, проверьте list, не повторяйте создание.`;

/**
 * Разбирает флаги вида --ключ значение, --ключ=значение и одиночные --да/нет.
 * Повторённый флаг (например --set) накапливается в список.
 */
function parseFlags(argv: string[]): Flags {
  const flags: Flags = Object.create(null);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (!argument.startsWith('--')) {
      continue;
    }

    const equals = argument.indexOf('=');

    if (equals > 0) {
      const key = argument.slice(2, equals);
      const value = argument.slice(equals + 1);

      if (Array.isArray(flags[key])) {
        flags[key].push(value);
      } else if (flags[key] !== undefined) {
        flags[key] = [flags[key], value];
      } else {
        flags[key] = value;
      }

      continue;
    }

    const key = argument.slice(2);

    if (index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) {
      const value = argv[index + 1]!;

      index += 1;

      if (Array.isArray(flags[key])) {
        flags[key].push(value);
      } else if (flags[key] !== undefined) {
        flags[key] = [flags[key], value];
      } else {
        flags[key] = value;
      }

      continue;
    }

    flags[key] = true;
  }

  return flags;
}

/**
 * Токен локального CLI: --token, окружение или файл на диске машины-мозга.
 * Чтение файла не раскрывает токен в диагностике при отсутствии доступа.
 */
function resolveToken(flags: Flags): string | null {
  if (typeof flags.token === 'string') {
    return flags.token;
  }
  if (process.env.GRIGDESK_CLI_TOKEN) {
    return process.env.GRIGDESK_CLI_TOKEN;
  }

  const file = typeof flags['token-file'] === 'string'
    ? flags['token-file']
    : process.env.GRIGDESK_CLI_TOKEN_PATH
      ?? path.join(process.env.GRIGDESK_HOME || path.join(homedir(), '.grigdesk'),
        'state', 'cli-token');

  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Разрешает адрес сервера из флага, окружения и локального порта.
 * Пустой override не превращает запрос в относительный URL.
 */
function baseUrl(flags: Flags): string {
  if (typeof flags.base === 'string' && flags.base) {
    return flags.base.replace(/\/$/, '');
  }

  // Пустая строка из окружения — не адрес: без этой проверки тесты с
  // GRIGDESK_BASE_URL='' уходили бы на относительный fetch и падали.
  const fromEnv = process.env.GRIGDESK_BASE_URL?.trim();
  const port = process.env.GRIGDESK_PORT || '8140';

  return fromEnv ? fromEnv.replace(/\/$/, '') : `http://127.0.0.1:${port}`;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Нетеловый ответ (прокси, HTML-страница) не должен ронять CLI необработанным
 * исключением: печатаем сырой текст в теле ошибки.
 */
function safeParse(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

class CliError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/**
 * Ошибка возвращается верхнему обработчику. Естественное завершение процесса
 * даёт stdout/stderr дописать JSON, включая подсказку неизвестного исхода.
 */
function fail(message: string, code: number): never {
  throw new CliError(message, code);
}

/**
 * Один HTTP-вызов к серверу GrigDesk с CLI-токеном. Зависший сервер прерывается
 * по таймауту (--timeout, умолчание 30 с). Ошибки сервера печатаются телом
 * и превращаются в стабильный код возврата.
 */
async function call<T = unknown>(
  method: string, pathname: string, body: unknown, flags: Flags,
): Promise<T> {
  const token = resolveToken(flags);

  if (!token) {
    fail('CLI-токен не найден: --token, GRIGDESK_CLI_TOKEN или файл cli-token', EXIT_USAGE);
  }

  const timeoutMs = Number(flags.timeout) > 0 ? Number(flags.timeout) : 30_000;
  let response: Response;
  let text = '';

  try {
    response = await fetch(`${baseUrl(flags)}${pathname}`, {
      method,
      headers: {
        'x-grigdesk-token': token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Тело читается здесь же: обрыв после заголовков — та же недоступность,
    // а не необработанное исключение с чужим кодом возврата.
    text = await response.text();
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? `таймаут ${timeoutMs} мс` : error instanceof Error ? error.message : String(error);

    fail(`Сервер GrigDesk недоступен (${baseUrl(flags)}): ${reason}`, EXIT_NETWORK);
  }

  const json = safeParse(text);

  if (response.status === 404) {
    print(json);
    fail('не найдено', EXIT_NOT_FOUND);
  }
  if (response.status === 409) {
    print(json);
    fail('конфликт ревизии: перечитайте документ и повторите', EXIT_CONFLICT);
  }
  if (!response.ok) {
    print(json);
    fail(`сервер вернул ${response.status}`, EXIT_SERVER);
  }

  return json as T;
}

/**
 * Читает авторский JSON до отправки запроса серверу.
 * Ошибки файла и синтаксиса имеют код использования без побочного эффекта.
 */
function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`не удалось прочитать JSON: ${error instanceof Error ? error.message : String(error)}`, EXIT_USAGE);
  }
}

function requiredString(flags: Flags, key: string): string {
  if (typeof flags[key] !== 'string' || !flags[key]) {
    fail(`нужен --${key}`, EXIT_USAGE);
  }

  return flags[key];
}

/**
 * Проверяет исходную ревизию как безопасное целое с заданным минимумом.
 * Значение не повышается автоматически после чтения свежего снимка.
 */
function expectedInteger(flags: Flags, key: string, minimum: number): number {
  const raw = requiredString(flags, key);
  const value = Number(raw);

  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    fail(`неверный --${key}`, EXIT_USAGE);
  }

  return value;
}

/**
 * Проверяет исходный хеш current или явное отсутствие каталога.
 * null передаётся только для подтверждённого значения none.
 */
function expectedCatalog(flags: Flags): string | null {
  const value = requiredString(flags, 'expected-catalog-hash');

  if (value !== 'none' && !/^[a-f0-9]{64}$/.test(value)) {
    fail('нужен --expected-catalog-hash <hash|none>', EXIT_USAGE);
  }

  return value === 'none' ? null : value;
}

function requireYes(flags: Flags): void {
  if (flags.yes !== true) {
    fail('действие меняет каталог: добавьте --yes', EXIT_USAGE);
  }
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Полная форма контента не превращает опечатку/пропуск поля в его очистку.
 * Схему каждого узла и ограничения размера дополнительно проверяет штатный сервер.
 */
function readContent(file: string): RouteContent {
  const value = readJsonFile(file);

  if (!isRecord(value) || !isRecord(value.routes) || !isRecord(value.bootstrapPrompts)
    || !isRecord(value.presentation) || !isRecord(value.provenance)
    || !(value.bootstrap === null || isRecord(value.bootstrap))) {
    fail('нужны все пять полей авторского контента', EXIT_USAGE);
  }

  for (const bundle of Object.values(value.routes)) {
    if (!isRecord(bundle) || !isRecord(bundle.route) || !isRecord(bundle.prompts)) {
      fail('маршрут должен содержать route и prompts', EXIT_USAGE);
    }
  }

  return value as unknown as RouteContent;
}

/**
 * Доступная до эффекта запись позволяет проверить неизвестный исход после обрыва.
 * stdout остаётся одним JSON-ответом; stderr содержит JSON-hint и затем диагностику.
 */
async function publishPrepared(
  profile: string, draftId: string, payload: PublicationPayload, flags: Flags,
): Promise<void> {
  const hint = {
    operationId: payload.operationId,
    draftId,
    recovery: ['publications', profile, payload.operationId]
  };

  await new Promise<void>((resolve, reject) => {
    process.stderr.write(`${JSON.stringify(hint)}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  print(await call('POST',
    `/api/routes/${encodeURIComponent(profile!)}/drafts/${encodeURIComponent(draftId)}/publish`,
    payload, flags));
}

/**
 * Фиксирует исходные ожидания и новый идентификатор до отправки публикации.
 * Один payload используется только для одной попытки записи без повторов.
 */
function publicationPayload(flags: Flags, revision: number): PublicationPayload {
  return {
    expectedRevision: revision,
    expectedCatalogHash: expectedCatalog(flags),
    expectedSourceRevision: expectedInteger(flags, 'expected-source-revision', 0),
    operationId: randomUUID(),
  };
}

const COMMANDS: Record<string, Command> = {
  // Форма вызова: profile-config <get|set> <профиль> — порядок аргументов
  // закреплён тестом RE-C3-01 и строкой USAGE.
  async 'profile-config'([action, profile], flags) {
    const base = `/api/profiles/${encodeURIComponent(profile!)}`;

    if (action === 'get') {
      print(await call('GET', `${base}/config`, null, flags));

      return;
    }

    if (action !== 'set') {
      fail('profile-config <get|set> <профиль> [--file profile.sh|dashboard.env] [--set NAME=VALUE…]',
        EXIT_USAGE);
    }

    if (flags.file !== undefined
      && !(typeof flags.file === 'string' && ['profile.sh', 'dashboard.env'].includes(flags.file))) {
      fail('--file: profile.sh или dashboard.env', EXIT_USAGE);
    }

    const file = flags.file ?? 'profile.sh';
    const config = await call<ProfileConfig>('GET', `${base}/config`, null, flags);
    const current = new Map(config.variables[file === 'profile.sh' ? 'profileSh' : 'dashboard']
      .map((item) => [item.name, item]));
    const pairs = (Array.isArray(flags.set) ? flags.set : [flags.set]).filter(Boolean);
    const changes = pairs.map((pair) => {
      const equals = String(pair).indexOf('=');

      if (equals <= 0) {
        fail(`ожидается NAME=VALUE: ${pair}`, EXIT_USAGE);
      }

      const name = String(pair).slice(0, equals);

      const variable = current.get(name);

      if (!variable?.editable) {
        fail(`переменная недоступна для записи: ${name}`, EXIT_USAGE);
      }

      return {
        name,
        from: variable.value,
        to: String(pair).slice(equals + 1)
      };
    });

    if (!changes.length) {
      fail('нужен хотя бы один --set NAME=VALUE', EXIT_USAGE);
    }

    print(await call('PATCH', `${base}/variables`, { file, changes }, flags));
  },

  async editor([profile], flags) {
    print(await call('GET', `/api/routes/${encodeURIComponent(profile!)}/editor`, null, flags));
  },
  /**
   * Отдельно подтверждает передачу владения каталогом с двумя CAS-ожиданиями.
   * Публикация не меняет этот источник скрытым действием.
   */
  async source([profile], flags) {
    requireYes(flags);

    const mode = requiredString(flags, 'mode');

    if (!['editor', 'profile-script'].includes(mode)) {
      fail('режим: editor или profile-script', EXIT_USAGE);
    }

    const body = {
      mode,
      expectedSourceRevision: expectedInteger(flags, 'expected-source-revision', 0),
      expectedCatalogHash: expectedCatalog(flags)
    };

    print(await call('PUT', `/api/routes/${encodeURIComponent(profile!)}/editor/source`, body, flags));
  },
  /**
   * Создаёт пустой черновик или копию конкретного прочитанного current.
   * Отсутствующий опубликованный каталог требует явного выбора empty.
   */
  async new([profile], flags) {
    const title = typeof flags.title === 'string' ? flags.title : 'cli-draft';

    if (flags.from !== undefined
      && !(typeof flags.from === 'string' && ['empty', 'catalog'].includes(flags.from))) {
      fail('--from: empty или catalog', EXIT_USAGE);
    }

    const body: {
      kind: string;
      title: string;
      catalogHash?: string;
    } = {
      kind: flags.from === 'empty' ? 'empty' : 'catalog',
      title,
    };

    if (body.kind === 'catalog') {
      const info = await call<{ currentCatalogHash: string | null }>(
        'GET', `/api/routes/${encodeURIComponent(profile!)}/editor`, null, flags);

      if (!info.currentCatalogHash) {
        fail('нет опубликованного каталога: используйте --from empty', EXIT_USAGE);
      }

      body.catalogHash = info.currentCatalogHash;
    }

    print(await call('POST', `/api/routes/${encodeURIComponent(profile!)}/drafts`, body, flags));
  },
  /**
   * Заменяет все пять полей контента одним CAS PATCH.
   * Свежий GET нужен для удалений, исходная ревизия остаётся прежней.
   */
  async apply([profile], flags) {
    const draftId = requiredString(flags, 'draft');
    const revision = expectedInteger(flags, 'expected-revision', 1);
    const content = readContent(requiredString(flags, 'file'));
    const base = `/api/routes/${encodeURIComponent(profile!)}/drafts/${encodeURIComponent(draftId)}`;
    const current = await call<DraftResponse>('GET', base, null, flags);

    if (current.revision !== revision) {
      print({
        error: 'routes_revision_conflict',
        expectedRevision: revision,
        currentRevision: current.revision
      });
      fail('конфликт ревизии: сопоставьте правки с новым снимком', EXIT_CONFLICT);
    }

    const operations: JsonObject[] = Object.keys(current.routes)
      .filter((id) => !Object.hasOwn(content.routes, id))
      .map((routeId) => ({ kind: 'removeRoute', routeId }));

    for (const [routeId, bundle] of Object.entries(content.routes)) {
      operations.push({
        kind: 'putRoute',
        routeId,
        route: bundle.route,
        prompts: bundle.prompts
      });
    }

    operations.push({
      kind: 'putBootstrap',
      bootstrap: content.bootstrap,
      prompts: content.bootstrapPrompts
    });
    operations.push({ kind: 'putPresentation', presentation: content.presentation });
    operations.push({ kind: 'putProvenance', provenance: content.provenance });
    print(await call('PATCH', base, { expectedRevision: revision, operations }, flags));
  },
  async validate([profile], flags) {
    const draftId = requiredString(flags, 'draft');
    const expectedRevision = expectedInteger(flags, 'expected-revision', 1);

    print(await call('POST',
      `/api/routes/${encodeURIComponent(profile!)}/drafts/${encodeURIComponent(draftId)}/validate`,
      { expectedRevision }, flags));
  },
  /**
   * Публикует только явно подтверждённый исходный снимок.
   * Идентификатор и recovery выдаются до возможного сетевого эффекта.
   */
  async publish([profile], flags) {
    requireYes(flags);

    const draftId = requiredString(flags, 'draft');
    const revision = expectedInteger(flags, 'expected-revision', 1);

    await publishPrepared(profile!, draftId, publicationPayload(flags, revision), flags);
  },
  async publications([profile, operationId], flags) {
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(operationId)) {
      fail('нужен корректный operationId', EXIT_USAGE);
    }

    print(await call('GET',
      `/api/routes/${encodeURIComponent(profile!)}/publications/${operationId}`, null, flags));
  },
  /**
   * Создаёт копию сохранённой ревизии и публикует её штатным API.
   * Неизвестный исход не запускает автоматическую повторную мутацию.
   */
  async rollback([profile], flags) {
    requireYes(flags);

    const hash = requiredString(flags, 'hash');

    if (!/^[a-f0-9]{64}$/.test(hash)) {
      fail('нужен --hash <хеш ревизии>', EXIT_USAGE);
    }

    // Все пользовательские ожидания проверяются до создания копии. Если позднее
    // публикация отказала, созданная копия сохраняется; hint содержит её ID.
    const payload = publicationPayload(flags, 1);
    const draft = await call<DraftResponse>('POST', `/api/routes/${encodeURIComponent(profile!)}/drafts`, {
      kind: 'catalog',
      title: `rollback-${hash.slice(0, 8)}`,
      catalogHash: hash,
    }, flags);

    payload.expectedRevision = draft.revision;
    await publishPrepared(profile!, draft.id, payload, flags);
  },
  async export([profile], flags) {
    const draftId = requiredString(flags, 'draft');

    print(await call('GET',
      `/api/routes/${encodeURIComponent(profile!)}/drafts/${encodeURIComponent(draftId)}/transfer`,
      null, flags));
  },
  async import([profile], flags) {
    const bundle = readJsonFile(requiredString(flags, 'file'));

    print(await call('POST', `/api/routes/${encodeURIComponent(profile!)}/editor/import`, {
      title: typeof flags.title === 'string' ? flags.title : 'cli-import', bundle,
    }, flags));
  },

  async list([profile], flags) {
    print(await call('GET', `/api/routes/${encodeURIComponent(profile!)}/drafts`, null, flags));
  },
  async show([profile], flags) {
    if (!flags.draft) {
      fail('нужен --draft <id>', EXIT_USAGE);
    }

    print(await call('GET',
      `/api/routes/${encodeURIComponent(profile!)}/drafts/${flags.draft}`, null, flags));
  },
};

/**
 * Проверяет имя команды и обязательный профиль до первого запроса.
 * Системные ошибки не маскируются успешным exit, буферы вывода не обрываются.
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    console.error(USAGE);
    process.exitCode = command ? 0 : EXIT_USAGE;

    return;
  }

  if (!Object.hasOwn(COMMANDS, command)) {
    fail(`неизвестная команда: ${command}`, EXIT_USAGE);
  }

  const profile = rest[command === 'profile-config' ? 1 : 0];

  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(profile)) {
    fail('нужен корректный профиль', EXIT_USAGE);
  }

  await COMMANDS[command]!(rest, parseFlags(rest));
}

/**
 * Завершает команду естественно, сохраняя прежние коды и диагностику.
 * Отсутствие принудительного exit позволяет дописать JSON перед завершением.
 */
export async function runRoutes(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CliError ? error.code : EXIT_SERVER;
  }
}
