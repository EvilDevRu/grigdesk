// Резолвер цели показа и контракт профиля.
//
// Полномочия задают ДОВЕРЕННЫЕ серверные источники, а не рабочая копия задачи:
// адрес постоянного стенда приходит из dashboard.env, ручного — из реестра и
// журнала песочниц, стенда попытки — из её собственного реестра t<номер>.pipeline,
// а policy, экраны, селекторы и вход — из каталога профиля.
// Модель и текст задачи здесь не участвуют вовсе — они данные, и расширить набор
// разрешённого своим JSON не могут.
//
// Отпечатки считаются от того, что реально влияет на исполнение: содержимого
// контракта и состояния стенда. По ним задание перед каждым шагом отличает «та же
// цель» от «слот переиспользован под другую задачу», и это единственный способ
// не записать чужой стенд под именем прежней задачи.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { contractDecoders } from '../../../../shared/contractDecoders.ts';
import { parsePipeline } from '../pipelineParse.ts';
import { PROFILE_RE } from '../profiles.ts';
import { readPipelineHold, readSandboxRegistry } from '../sandboxes/registry.ts';
import { readLoginCredentials } from './loginCredentials.ts';
import type { LoginCredentials } from './loginCredentials.ts';
import type { PipelineHold, SandboxRegistryEntry } from '../sandboxes/registry.ts';
import type { SandboxEntry, SandboxOverview } from '../../../../shared/sandboxContracts.ts';
import type {
  ShowcaseCapability,
  ShowcaseScope,
  ShowcaseTarget,
  ShowcaseTargetOption,
  ShowcaseTargetRef,
} from '../../../../shared/showcaseContracts.ts';
import { ShowcaseError } from './errors.ts';

export class ShowcaseProfileError extends Error {
  constructor(path: string) {
    super(`Профиль объявил раздел «Презентации» неверно: поле ${path}`);
    this.name = 'ShowcaseProfileError';
  }
}

const {
  listOf,
  nullable,
  objectOf,
  oneOf,
  optional,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new ShowcaseProfileError(path);
});

const CONTRACT_VERSION = 1;

// Старые адресные поля читаются только совместимым profile-based резолвером.
// Новый selected-путь получает адрес из server-owned каталога целей.
const addressPair = objectOf({
  record: text,
  view: nullable(text),
});

const targetContract = objectOf({
  version: wholeNumber,
  environment: oneOf('isolated-demo', 'read-only'),
  // Шаблон адреса стенда задаёт профиль: ни наличие FE_PORT, ни успешный
  // TCP-connect сами по себе не доказывают, что открыт нужный стенд.
  project: optional(nullable(addressPair)),
  sandbox: optional(nullable(objectOf({
    recordTemplate: text,
    viewTemplate: nullable(text),
  }))),
  allowedOrigins: listOf(text),
  // Методы, которыми экраны читают данные. По умолчанию запись пропускает только
  // GET и HEAD; POST профиль объявляет явно — сводки и поиск многих SPA читают
  // именно им. PUT, PATCH и DELETE объявить нельзя: контракт их не принимает.
  allowedMethods: optional(listOf(oneOf('GET', 'HEAD', 'POST'))),
  capabilities: listOf(oneOf('record', 'login', 'seed', 'mutations')),
});

// Методы записи по умолчанию — только чтение.
const READ_METHODS = ['GET', 'HEAD'];

function methodsOf(target: ShowcaseTargetContract | null | undefined): string[] {
  return [...new Set([...READ_METHODS, ...(target?.allowedMethods ?? [])])];
}

const screenContract = objectOf({
  version: wholeNumber,
  screens: listOf(objectOf({
    id: text,
    title: text,
    path: text,
    readySelector: text,
    elements: listOf(objectOf({
      id: text,
      selector: text,
    })),
  })),
});

// Вход описывает только селекторы, адрес и ССЫЛКУ на учётку. Секрет по этой ссылке
// достаёт сервер: пароль не проходит через модель, сценарий и ответы ручек.
const loginContract = objectOf({
  version: wholeNumber,
  url: text,
  userSelector: text,
  passwordSelector: text,
  submitSelector: text,
  readySelector: text,
  credentialsRef: text,
});

export type ShowcaseTargetContract = ReturnType<typeof targetContract>;
export type ShowcaseScreenContract = ReturnType<typeof screenContract>;
export type ShowcaseLoginContract = ReturnType<typeof loginContract>;

/**
 * Внутренний снимок области показа. От публичного отличается тем, ради чего он
 * и нужен: адресом серверной записи, списком разрешённых origins и ссылкой на
 * учётку. Наружу уходит только проекция `toPublicScope`.
 */
export interface ShowcaseResolvedScope {
  ref: ShowcaseTargetRef;
  profile: string;
  targetLabel: string;
  environment: ShowcaseScope['environment'];
  recordUrl: string;
  viewUrl: string | null;
  allowedOrigins: string[];
  allowedMethods: string[];
  capabilities: ShowcaseCapability[];
  screens: ShowcaseScreenContract['screens'];
  login: ShowcaseLoginContract | null;
  sandbox: SandboxRegistryEntry | null;
  targetFingerprint: string;
  policyRevision: string;
  dataRevision: string;
  buildRevision: string | null;
}

export interface ShowcaseTargetsOptions {
  profilesDir: string;
  stateDir: string;
  listProjects: () => Promise<string[]>;
  // Профиль ручного стенда знает журнал раздела «Песочницы», а не t<task>.env.
  // Инъекция его обзора не заводит второй источник владельца и живости.
  sandboxOverview?: () => Promise<Pick<SandboxOverview, 'sandboxes'>>;
  // Ревизия данных живёт в настройках ролика: внешнюю правку демо-данных плагин
  // сам обнаружить не обещает, её отмечает человек кнопкой «Данные обновлены».
  dataRevisionOf: (ref: ShowcaseTargetRef) => Promise<string>;
}

const DEFAULT_SCREEN: ShowcaseScreenContract['screens'][number] = {
  id: 'root',
  title: 'Главная',
  path: '/',
  readySelector: 'body',
  elements: [],
};

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(?:"([^"]*)"|'([^']*)')$/.exec(trimmed);

  return quoted ? String(quoted[1] ?? quoted[2] ?? '') : trimmed;
}

/** Принимаются только обычные HTTP(S)-адреса без встроенной учётки. */
function checkedHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);

    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

type BlockedTarget = Extract<ShowcaseTarget, { status: 'blocked' }>;

/**
 * Отказ всегда называет причину и следующий шаг: «не получилось» без действия
 * оставляет человека гадать, чего не хватает — стенда, объявления профиля или
 * другого выбора цели.
 */
function blocked(
  ref: ShowcaseTargetRef,
  reason: string,
  nextAction: BlockedTarget['nextAction'],
  profile: string | null = null,
): BlockedTarget {
  return { status: 'blocked', ref, profile, reason, nextAction };
}

export function createShowcaseTargets(options: ShowcaseTargetsOptions) {
  const { profilesDir, stateDir } = options;
  // Привязка профиля доказана для конкретного mtime raw registry. Метаданные не
  // уходят в API: WeakMap живёт ровно столько же, сколько серверный снимок каталога.
  const sandboxRegistryTimes = new WeakMap<ShowcaseTargetOption, string | null>();

  function contractDir(profile: string): string {
    return path.join(profilesDir, profile, 'showcase');
  }

  /**
   * Один файл контракта профиля. Отсутствие файла и неверная форма — разные
   * события: первое означает «профиль не умеет показ», второе — ошибку объявления,
   * и молча считать их одинаковыми нельзя.
   */
  async function readContract<Value>(
    profile: string,
    name: string,
    decode: (value: unknown, path: string) => Value,
  ): Promise<{ value: Value; raw: string } | null> {
    let raw = '';

    try {
      raw = await fs.readFile(path.join(contractDir(profile), name), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null;
      }

      throw new ShowcaseError(
        'profile_contract',
        `Файл ${name} профиля ${profile} не удалось прочитать.`,
        500,
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ShowcaseError(
        'profile_contract',
        `Файл ${name} профиля ${profile} не является JSON.`,
        500,
      );
    }

    const value = decode(parsed, name);
    const version = (value as { version: number }).version;

    if (version !== CONTRACT_VERSION) {
      throw new ShowcaseError(
        'profile_contract',
        `Файл ${name} профиля ${profile} объявлен версией ${version}, поддерживается ${CONTRACT_VERSION}.`,
        500,
      );
    }

    return { value, raw };
  }

  /** Постоянный стенд объявляется тем же dashboard.env, который читает фабрика. */
  async function permanentUrl(profile: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(path.join(profilesDir, profile, 'dashboard.env'), 'utf8');
      const value = unquote(parsePipeline(raw).FACTORY_STAND_URL ?? '');

      return value ? checkedHttpUrl(value) : null;
    } catch {
      return null;
    }
  }

  /**
   * Хост ручной песочницы читается как простое присваивание, без исполнения
   * profile.sh. Динамическое выражение здесь не вычисляется и даёт loopback.
   */
  async function sandboxHost(profile: string): Promise<string> {
    try {
      const raw = await fs.readFile(path.join(profilesDir, profile, 'profile.sh'), 'utf8');
      const match = /^PROFILE_SERVICE_HOST=(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/m.exec(raw);
      const value = String(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');

      return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/.test(value)
        ? value
        : '127.0.0.1';
    } catch {
      return '127.0.0.1';
    }
  }

  /** Сколько экранов профиль объявил явно; отсутствующая карта допустима. */
  async function declaredScreens(profile: string) {
    return readContract(profile, 'screens.json', screenContract);
  }

  /**
   * Подстановка номера стенда и портов в шаблон профиля. Подставляются только
   * известные величины реестра: любая другая скобка остаётся как есть и делает
   * адрес заведомо неверным, вместо того чтобы молча собрать чужой.
   */
  function applyTemplate(template: string, entry: SandboxRegistryEntry): string {
    return template
      .replaceAll('{task}', entry.task)
      .replaceAll('{fePort}', String(entry.fePort ?? ''))
      .replaceAll('{apiPort}', String(entry.apiPort ?? ''))
      .replaceAll('{slot}', String(entry.slot ?? ''));
  }

  async function resolveSandbox(task: string): Promise<SandboxRegistryEntry | null> {
    const registry = await readSandboxRegistry(stateDir);

    return registry.find((entry) => entry.task === task) ?? null;
  }

  /** Ошибка необязательного policy-файла блокирует цель, отсутствие — нет. */
  async function profileChoiceState(profile: string): Promise<{
    reason: string;
    screenCount: number;
  }> {
    try {
      await readContract(profile, 'target.json', targetContract);
      const screens = await readContract(profile, 'screens.json', screenContract);
      // Любой присутствующий extension обязан быть валиден уже в каталоге.
      // Иначе пункт выглядит готовым, а создание ролика неожиданно падает только
      // при повторном чтении effective policy.
      await readContract(profile, 'login.json', loginContract);

      return { reason: '', screenCount: screens?.value.screens.length ?? 0 };
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : 'Настройки показа не читаются.',
        screenCount: 0,
      };
    }
  }

  /**
   * Каталог уже связанных целей. Профиль песочницы приходит из server-owned
   * журнала раздела «Песочницы», поэтому браузер не может подменить эту связь.
   */
  async function choices(): Promise<ShowcaseTargetOption[]> {
    const [profiles, sandboxSnapshot] = await Promise.all([
      options.listProjects(),
      options.sandboxOverview?.().catch(() => ({ sandboxes: [] }))
        ?? Promise.resolve({ sandboxes: [] }),
    ]);
    const result: ShowcaseTargetOption[] = [];

    for (const profile of profiles) {
      if (!PROFILE_RE.test(profile)) {
        continue;
      }

      const url = await permanentUrl(profile);

      if (!url) {
        continue;
      }

      const policy = await profileChoiceState(profile);

      result.push({
        ref: { kind: 'project', id: profile },
        profile,
        profileBinding: 'verified',
        label: `${profile} · постоянный стенд`,
        viewUrl: url,
        viewPort: null,
        status: policy.reason ? 'blocked' : 'ready',
        reason: policy.reason,
        screenCount: policy.screenCount,
      });
    }

    for (const sandbox of sandboxSnapshot.sandboxes) {
      result.push(await sandboxChoice(sandbox, await holdOf(sandbox)));
    }

    return result;
  }

  /**
   * Стенд попытки читается только через её собственный реестр: профиль там пишет
   * движок, а не браузер и не журнал кокпита. Ручной стенд такого реестра не имеет
   * и живёт по правилам раздела «Песочницы».
   */
  async function holdOf(sandbox: SandboxEntry): Promise<PipelineHold | null> {
    if (sandbox.owner !== 'pipeline') {
      return null;
    }

    return readPipelineHold(stateDir, sandbox.task);
  }

  /**
   * Подпись стенда в списке. Человек выбирает не «песочницу вообще», а стенд
   * задачи, поэтому состояние попытки стоит прямо в подписи: от него зависит,
   * доступна цель сейчас или её придётся ждать.
   */
  function labelOf(sandbox: SandboxEntry, hold: PipelineHold | null, profile: string): string {
    const base = profile ? `${profile} · стенд ${sandbox.task}` : `Стенд ${sandbox.task}`;

    if (!hold) {
      return base;
    }

    if (!hold.stalledHuman) {
      return `${base} · идёт попытка`;
    }

    return `${base} · ${hold.gate === 'accept' ? 'ждёт приёмки' : 'ждёт решения'}`;
  }

  /**
   * Карточка стенда в каталоге целей. Стенд попытки конвейера доступен ровно в том
   * окне, когда попытка стоит на человеке: движок вышел, состояние стенда не
   * меняется, и именно этот стенд человек смотрит перед решением. Пока попытка
   * исполняется, цель остаётся видимой, но заблокированной — иначе задача, ради
   * которой ролик и снимают, просто исчезала бы из списка без объяснения.
   */
  async function sandboxChoice(
    sandbox: SandboxEntry,
    hold: PipelineHold | null = null,
  ): Promise<ShowcaseTargetOption> {
    const ref: ShowcaseTargetOption['ref'] = { kind: 'sandbox', id: sandbox.task };
    const profile = hold ? hold.profile : sandbox.profile ?? '';
    // Профиль попытки пишет движок в свой реестр, поэтому связь доказана так же,
    // как у собственного up кокпита: подменить её из браузера нечем.
    const profileBinding = hold ? 'verified' : sandbox.profileBinding ?? 'inferred';
    const label = labelOf(sandbox, hold, profile);
    let reason = '';

    if (hold && !hold.stalledHuman) {
      reason = 'Стендом сейчас распоряжается идущая попытка конвейера.';
    } else if (sandbox.removableReason === 'job_running') {
      reason = 'По стенду сейчас идёт подъём или снос.';
    } else if (!PROFILE_RE.test(profile)) {
      reason = 'Профиль этого стенда не удалось определить.';
    } else if (!sandbox.fePort) {
      reason = 'Стенд ещё не объявил готовый адрес интерфейса.';
    } else if (sandbox.feAlive !== true) {
      reason = 'Интерфейс стенда сейчас не отвечает.';
    }

    // Недоказанная связь оставляет стенд доступным для безопасной записи root,
    // но не даёт потенциально чужому профилю расширить policy, login и мутации.
    const policy = PROFILE_RE.test(profile) && profileBinding === 'verified'
      ? await profileChoiceState(profile)
      : { reason: '', screenCount: 0 };

    const choice: ShowcaseTargetOption = {
      ref,
      profile,
      profileBinding,
      label,
      // localhost здесь относится к машине сервера и не является ссылкой для
      // удалённого браузера. Клиент построит её из порта и своего cockpit host.
      viewUrl: null,
      viewPort: sandbox.fePort,
      status: reason || policy.reason ? 'blocked' : 'ready',
      reason: reason || policy.reason,
      screenCount: policy.screenCount,
    };

    sandboxRegistryTimes.set(choice, sandbox.updatedAt);

    return choice;
  }

  /**
   * Собирает область показа из контракта профиля и состояния цели. Возвращает
   * либо готовую область, либо причину с конкретным следующим шагом: раздел не
   * предлагает «попробовать ещё раз» там, где нужно поднять стенд или дописать
   * объявление профиля.
   */
  async function resolveInternal(
    ref: ShowcaseTargetRef,
    profile: string,
  ): Promise<{ status: 'ready'; scope: ShowcaseResolvedScope } | BlockedTarget> {
    if (!PROFILE_RE.test(profile)) {
      return blocked(ref, 'Профиль показа выбран неверно.', {
        kind: 'configure-profile',
        label: 'Выбрать профиль',
        hint: 'Раздел показывает только проекты, объявившие контракт презентаций.',
      });
    }

    const target = await readContract(profile, 'target.json', targetContract);

    if (!target) {
      return blocked(ref, `Профиль ${profile} не объявил контракт презентаций.`, {
        kind: 'configure-profile',
        label: 'Как объявить показ',
        hint: 'Нужны showcase/target.json и showcase/screens.json в каталоге профиля.',
      });
    }

    const screens = await readContract(profile, 'screens.json', screenContract);

    if (!screens || screens.value.screens.length === 0) {
      return blocked(ref, `Профиль ${profile} не объявил экраны показа.`, {
        kind: 'configure-profile',
        label: 'Как объявить экраны',
        hint: 'Пока карта экранов пуста, сценарий остаётся черновиком и браузер не запускается.',
      });
    }

    const login = await readContract(profile, 'login.json', loginContract);
    let recordUrl = '';
    let viewUrl: string | null = null;
    let sandbox: SandboxRegistryEntry | null = null;

    if (ref.kind === 'project') {
      if (!target.value.project) {
        return blocked(ref, `Профиль ${profile} не объявил адрес показа проекта.`, {
          kind: 'choose-project-url',
          label: 'Выбрать адрес показа',
          hint: 'Для показа проекта профиль обязан назвать проверенный адрес.',
        });
      }

      recordUrl = target.value.project.record;
      viewUrl = target.value.project.view;
    } else {
      sandbox = await resolveSandbox(ref.id);

      if (!sandbox) {
        // Задача без стенда НЕ переключается на адрес проекта сама: человек либо
        // поднимает стенд, либо выбирает другой допустимый адрес осознанно.
        return blocked(ref, `Стенд ${ref.id} не найден в реестре.`, {
          kind: 'open-sandboxes',
          label: 'Открыть «Песочницы»',
          hint: 'Поднимите стенд задачи или выберите подготовленный адрес проекта.',
        });
      }

      // Старому пути каталог целей не передают, а состояние попытки без него
      // недоказуемо: он видит только факт её реестра. Окно «попытка стоит на
      // человеке» открывает resolveSelected, который перечитывает это состояние
      // вместе со стендом.
      if (sandbox.pipeline) {
        return blocked(ref, `Стендом ${ref.id} владеет попытка конвейера.`, {
          kind: 'open-sandboxes',
          label: 'Открыть «Песочницы»',
          hint: 'Выберите стенд заново в списке целей раздела.',
        });
      }

      if (!target.value.sandbox) {
        return blocked(ref, `Профиль ${profile} не объявил адрес стенда.`, {
          kind: 'configure-profile',
          label: 'Как объявить адрес стенда',
          hint: 'Нужен шаблон адреса: порт из реестра сам по себе адресом не является.',
        });
      }

      recordUrl = applyTemplate(target.value.sandbox.recordTemplate, sandbox);
      viewUrl = target.value.sandbox.viewTemplate
        ? applyTemplate(target.value.sandbox.viewTemplate, sandbox)
        : null;
    }

    if (!/^https?:\/\//.test(recordUrl) || recordUrl.includes('{')) {
      return blocked(ref, 'Адрес показа собрался неполным.', {
        kind: 'configure-profile',
        label: 'Проверить объявление',
        hint: 'В шаблоне остались неизвестные подстановки или отсутствует схема адреса.',
      });
    }

    const capabilities = target.value.capabilities.filter(
      (item) => item !== 'login' || login !== null,
    );
    const dataRevision = await options.dataRevisionOf(ref);
    const scope: ShowcaseResolvedScope = {
      ref,
      profile,
      targetLabel: ref.kind === 'project' ? profile : `стенд ${ref.id}`,
      environment: target.value.environment,
      recordUrl,
      viewUrl,
      allowedOrigins: [...new Set([new URL(recordUrl).origin, ...target.value.allowedOrigins])],
      allowedMethods: methodsOf(target.value),
      capabilities,
      screens: screens.value.screens,
      login: login?.value ?? null,
      sandbox,
      // Отпечаток цели включает состояние стенда: смена портов, репозиториев или
      // владельца делает прежний отпечаток недействительным, и задание остановится.
      targetFingerprint: hashOf({
        ref,
        profile,
        recordUrl,
        sandbox: sandbox && {
          slot: sandbox.slot,
          fePort: sandbox.fePort,
          apiPort: sandbox.apiPort,
          repos: sandbox.repos,
          updatedAt: sandbox.updatedAt,
          workspaceMode: sandbox.workspaceMode,
          ownership: sandbox.standOwnership,
          pipeline: sandbox.pipeline,
        },
      }),
      policyRevision: hashOf({ target: target.raw, screens: screens.raw, login: login?.raw ?? null }),
      dataRevision,
      // Ревизия сборки на стенде подтверждается, только если профиль её публикует.
      buildRevision: null,
    };

    return { status: 'ready', scope };
  }

  function selectedNextAction(ref: ShowcaseTargetRef): BlockedTarget['nextAction'] {
    return ref.kind === 'project'
      ? {
          kind: 'retry',
          label: 'Обновить список целей',
          hint: 'Проверьте адрес постоянного стенда в профиле и обновите раздел.',
        }
      : {
          kind: 'open-sandboxes',
          label: 'Открыть «Песочницы»',
          hint: 'Проверьте состояние стенда: у стенда попытки его ведёт «Конвейер».',
        };
  }

  /** Находит server-owned связь цели с профилем; task поддержан для старых роликов. */
  async function selectedChoice(
    ref: ShowcaseTargetRef,
    catalog?: readonly ShowcaseTargetOption[],
  ): Promise<ShowcaseTargetOption | null> {
    const kind = ref.kind === 'task' ? 'sandbox' : ref.kind;

    return (catalog ?? await choices()).find((item) => (
      item.ref.kind === kind && item.ref.id === ref.id
    )) ?? null;
  }

  /**
   * Новый путь резолвинга: адрес и профиль берутся из каталога, а showcase-файлы
   * лишь уточняют безопасную политику. Без карты доступен корневой экран без
   * элементов — ролик можно завести и писать обычный проход по главной.
   */
  async function resolveSelectedInternal(
    ref: ShowcaseTargetRef,
    fallbackProfile = '',
    catalog?: readonly ShowcaseTargetOption[],
  ): Promise<{ status: 'ready'; scope: ShowcaseResolvedScope } | BlockedTarget> {
    let choice = await selectedChoice(ref, catalog);

    if (!choice) {
      // Прямые библиотечные вызовы старого контракта остаются рабочими. HTTP
      // профиль больше не принимает, поэтому браузер этим обходом воспользоваться
      // не может.
      if (!options.sandboxOverview && PROFILE_RE.test(fallbackProfile)) {
        return resolveInternal(ref, fallbackProfile);
      }

      return blocked(
        ref,
        'Цель больше не найдена среди доступных стендов.',
        selectedNextAction(ref),
        PROFILE_RE.test(fallbackProfile) ? fallbackProfile : null,
      );
    }

    // Каталог overview уже является единым снимком для всех карточек. Живое
    // действие вызывает резолвер без каталога и тогда перечитывает состояние:
    // под shared activity-lock этот снимок атомарен относительно up/down.
    if (choice.ref.kind === 'sandbox' && options.sandboxOverview && !catalog) {
      let refreshed: Pick<SandboxOverview, 'sandboxes'>;

      try {
        refreshed = await options.sandboxOverview();
      } catch {
        return blocked(
          ref,
          'Не удалось перепроверить состояние ручного стенда.',
          selectedNextAction(ref),
          choice.profile || null,
        );
      }

      const sandbox = refreshed.sandboxes.find((item) => item.task === ref.id);

      if (!sandbox) {
        return blocked(
          ref,
          `Стенд ${ref.id} больше не поднят.`,
          selectedNextAction(ref),
          choice.profile || null,
        );
      }

      // Реестр попытки перечитывается вместе со стендом: между выбором цели и
      // самим действием движок мог снова взяться за задачу, и тогда стенд уже не
      // тот, который человек видел в списке.
      const current = await sandboxChoice(sandbox, await holdOf(sandbox));

      if (
        current.status === 'ready'
        && (
          current.profile !== choice.profile
          || current.profileBinding !== choice.profileBinding
          || current.viewPort !== choice.viewPort
          || sandboxRegistryTimes.get(current) !== sandboxRegistryTimes.get(choice)
        )
      ) {
        return blocked(
          ref,
          'Стенд изменился после загрузки списка целей.',
          selectedNextAction(ref),
          choice.profile || null,
        );
      }

      choice = current;
    }

    if (PROFILE_RE.test(fallbackProfile) && choice.profile !== fallbackProfile) {
      return blocked(
        ref,
        'Цель теперь связана с другим профилем и требует нового выбора.',
        selectedNextAction(ref),
        fallbackProfile,
      );
    }

    const hasAddress = choice.ref.kind === 'project'
      ? Boolean(choice.viewUrl)
      : choice.viewPort !== null;

    if (choice.status === 'blocked' || !hasAddress) {
      return blocked(
        ref,
        choice.reason || 'Цель сейчас недоступна.',
        selectedNextAction(ref),
        choice.profile || null,
      );
    }

    const profile = choice.profile;
    const profilePolicyTrusted = choice.ref.kind === 'project'
      || choice.profileBinding === 'verified';

    try {
      const [target, declared, login] = await Promise.all([
        profilePolicyTrusted
          ? readContract(profile, 'target.json', targetContract)
          : Promise.resolve(null),
        profilePolicyTrusted ? declaredScreens(profile) : Promise.resolve(null),
        profilePolicyTrusted
          ? readContract(profile, 'login.json', loginContract)
          : Promise.resolve(null),
      ]);
      const sandbox = ref.kind === 'project' ? null : await resolveSandbox(ref.id);
      // Стенд попытки читается здесь второй раз намеренно: между каталогом и этим
      // местом движок мог снова взяться за задачу, а решение о доступе принимается
      // по состоянию на момент самого действия.
      const hold = sandbox?.pipeline ? await readPipelineHold(stateDir, ref.id) : null;

      if (sandbox?.pipeline && !hold?.stalledHuman) {
        return blocked(
          ref,
          `Стендом ${ref.id} сейчас распоряжается идущая попытка конвейера.`,
          selectedNextAction(ref),
          profile,
        );
      }

      if (sandbox?.workspaceMode === 'shared' || sandbox?.standOwnership === 'external') {
        return blocked(
          ref,
          `Стенд ${ref.id} не принадлежит песочнице этой машины.`,
          selectedNextAction(ref),
          profile,
        );
      }

      if (ref.kind !== 'project' && !sandbox) {
        return blocked(
          ref,
          `Стенд ${ref.id} не найден в реестре.`,
          selectedNextAction(ref),
          profile,
        );
      }

      if (sandbox && !sandbox.fePort) {
        return blocked(
          ref,
          'Стенд не объявил порт интерфейса.',
          selectedNextAction(ref),
          profile,
        );
      }

      let recordUrl = choice.viewUrl ?? '';
      let viewUrl = choice.viewUrl;

      if (sandbox) {
        if (choice.viewPort !== sandbox.fePort) {
          return blocked(
            ref,
            'Порт стенда изменился после загрузки списка целей.',
            selectedNextAction(ref),
            profile,
          );
        }

        if (sandboxRegistryTimes.get(choice) !== sandbox.updatedAt) {
          return blocked(
            ref,
            'Стенд изменился после загрузки списка целей.',
            selectedNextAction(ref),
            profile,
          );
        }

        // Недоказанный профиль не управляет даже hostname: базовая запись идёт
        // только на loopback. Проверенный profile.sh читается без исполнения.
        const host = profilePolicyTrusted ? await sandboxHost(profile) : 'localhost';

        recordUrl = `http://${host}:${sandbox.fePort}`;
        viewUrl = null;
      }

      const configuredScreens = declared?.value.screens ?? [];
      const screens = configuredScreens.length ? configuredScreens : [DEFAULT_SCREEN];
      const capabilities = (target?.value.capabilities ?? ['record']).filter(
        (item) => item !== 'login' || login !== null,
      );
      const dataRevision = await options.dataRevisionOf(ref);
      const scope: ShowcaseResolvedScope = {
        ref,
        profile,
        targetLabel: choice.label,
        environment: target?.value.environment ?? 'read-only',
        recordUrl,
        viewUrl,
        // Origins профиля тоже проходят подстановку: API песочницы живёт на своём
        // порту, и без «{apiPort}» объявить его в target.json было бы нечем.
        allowedOrigins: [
          ...new Set([
            new URL(recordUrl).origin,
            ...(target?.value.allowedOrigins ?? []).map(
              (origin) => (sandbox ? applyTemplate(origin, sandbox) : origin),
            ),
          ]),
        ],
        allowedMethods: methodsOf(target?.value),
        capabilities,
        screens,
        login: login?.value ?? null,
        sandbox,
        targetFingerprint: hashOf({
          ref,
          profile,
          profileBinding: choice.profileBinding,
          recordUrl,
          sandbox: sandbox && {
            slot: sandbox.slot,
            fePort: sandbox.fePort,
            apiPort: sandbox.apiPort,
            repos: sandbox.repos,
            updatedAt: sandbox.updatedAt,
            workspaceMode: sandbox.workspaceMode,
            ownership: sandbox.standOwnership,
            pipeline: sandbox.pipeline,
          },
        }),
        policyRevision: hashOf({
          target: target?.raw ?? null,
          screens: declared?.raw ?? null,
          login: login?.raw ?? null,
          profilePolicyTrusted,
          fallbackScreen: configuredScreens.length ? null : DEFAULT_SCREEN,
        }),
        dataRevision,
        buildRevision: null,
      };

      return { status: 'ready', scope };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Настройки показа не читаются.';

      return blocked(ref, reason, selectedNextAction(ref), profile);
    }
  }

  /**
   * Публичный ответ резолвера. Внутренняя область показа собирается один раз, а
   * наружу уходит её проекция: адрес записи, список назначений и описание входа
   * нужны исполнению, а не показу.
   */
  async function resolve(ref: ShowcaseTargetRef, profile: string): Promise<ShowcaseTarget> {
    const resolved = await resolveInternal(ref, profile);

    if (resolved.status !== 'ready') {
      return resolved;
    }

    return { status: 'ready', ref, scope: toPublicScope(resolved.scope) };
  }

  /** Публичный резолвер выбранной сервером цели; профиль от клиента не нужен. */
  async function resolveSelected(
    ref: ShowcaseTargetRef,
    fallbackProfile = '',
    catalog?: readonly ShowcaseTargetOption[],
  ): Promise<ShowcaseTarget> {
    const resolved = await resolveSelectedInternal(ref, fallbackProfile, catalog);

    if (resolved.status !== 'ready') {
      return resolved;
    }

    return { status: 'ready', ref, scope: toPublicScope(resolved.scope) };
  }

  /**
   * Внутренняя область для исполнения. Отказ здесь — исключение, а не значение:
   * вызывающий уже знает, что цель готова, и продолжать с половиной данных ему
   * нечем.
   */
  async function internalScope(
    ref: ShowcaseTargetRef,
    profile: string,
  ): Promise<ShowcaseResolvedScope> {
    const resolved = await resolveInternal(ref, profile);

    if (resolved.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', resolved.reason, 409);
    }

    return resolved.scope;
  }

  /** Внутренняя область той же server-owned цели для записи и сценария. */
  async function selectedInternalScope(
    ref: ShowcaseTargetRef,
    fallbackProfile = '',
    expectedFingerprint = '',
    catalog?: readonly ShowcaseTargetOption[],
  ): Promise<ShowcaseResolvedScope> {
    const resolved = await resolveSelectedInternal(ref, fallbackProfile, catalog);

    if (resolved.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', resolved.reason, 409);
    }

    if (
      expectedFingerprint
      && resolved.scope.targetFingerprint !== expectedFingerprint
    ) {
      throw new ShowcaseError(
        'target_changed',
        'Стенд изменился после проверки ролика. Выберите текущее поколение заново.',
        409,
      );
    }

    return resolved.scope;
  }

  return {
    choices,
    contractDir,
    internalScope,
    readContract,
    resolve,
    resolveSelected,
    selectedInternalScope,
    loginCredentialsOf,
  };

  /**
   * Учётка для входа по ссылке из объявления профиля. Читается в момент записи,
   * а не при резолве цели: секрет не должен жить в снимке области, который
   * кладётся в задание и переживает перезапуск.
   */
  async function loginCredentialsOf(scope: ShowcaseResolvedScope): Promise<LoginCredentials | null> {
    if (!scope.login) {
      return null;
    }

    return readLoginCredentials(path.join(profilesDir, scope.profile), scope.login.credentialsRef);
  }
}

/**
 * Публичная проекция области: адрес серверной записи, разрешённые origins, селекторы
 * входа и данные стенда остаются на сервере. Наружу уходит то, что показывает
 * карточка ролика, и отпечатки, которые интерфейс возвращает обратно как есть.
 */
export function toPublicScope(scope: ShowcaseResolvedScope): ShowcaseScope {
  return {
    targetKind: scope.ref.kind,
    targetLabel: scope.targetLabel,
    profile: scope.profile,
    viewUrl: scope.viewUrl,
    environment: scope.environment,
    capabilities: scope.capabilities,
    screens: scope.screens.map((screen) => ({
      id: screen.id,
      title: screen.title,
      path: screen.path,
    })),
    targetFingerprint: scope.targetFingerprint,
    policyRevision: scope.policyRevision,
    dataRevision: scope.dataRevision,
    buildRevision: scope.buildRevision,
  };
}

export type ShowcaseTargets = ReturnType<typeof createShowcaseTargets>;
