// Резолвер цели показа и контракт профиля.
//
// Полномочия задаёт ДОВЕРЕННЫЙ каталог профилей из config, а не рабочая копия
// задачи: адреса, экраны, селекторы и вход приходят оттуда и проходят декодер.
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
import { PROFILE_RE } from '../profiles.js';
import { readSandboxRegistry } from '../sandboxes/registry.ts';
import type { SandboxRegistryEntry } from '../sandboxes/registry.ts';
import type {
  ShowcaseCapability,
  ShowcaseScope,
  ShowcaseTarget,
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
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new ShowcaseProfileError(path);
});

const CONTRACT_VERSION = 1;

// Адрес показа объявляется дважды намеренно: `record` — то, куда ходит сервер,
// `view` — то, что открывает человек. Для локального стенда это разные вещи, и
// подставлять одно вместо другого нельзя: сервер и браузер человека находятся
// в разных сетях даже на одной машине.
const addressPair = objectOf({
  record: text,
  view: nullable(text),
});

const targetContract = objectOf({
  version: wholeNumber,
  environment: oneOf('isolated-demo', 'read-only'),
  // Шаблон адреса стенда задаёт профиль: ни наличие FE_PORT, ни успешный
  // TCP-connect сами по себе не доказывают, что открыт нужный стенд.
  project: nullable(addressPair),
  sandbox: nullable(objectOf({
    recordTemplate: text,
    viewTemplate: nullable(text),
  })),
  allowedOrigins: listOf(text),
  capabilities: listOf(oneOf('record', 'login', 'seed', 'mutations')),
});

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
  // Ревизия данных живёт в настройках ролика: внешнюю правку демо-данных плагин
  // сам обнаружить не обещает, её отмечает человек кнопкой «Данные обновлены».
  dataRevisionOf: (ref: ShowcaseTargetRef) => Promise<string>;
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
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
): BlockedTarget {
  return { status: 'blocked', ref, reason, nextAction };
}

export function createShowcaseTargets(options: ShowcaseTargetsOptions) {
  const { profilesDir, stateDir } = options;

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
    } catch {
      return null;
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

      if (sandbox.pipeline) {
        return blocked(ref, `Стендом ${ref.id} владеет попытка конвейера.`, {
          kind: 'open-sandboxes',
          label: 'Открыть «Песочницы»',
          hint: 'Показ снимается только со стенда, поднятого человеком.',
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
          ownership: sandbox.standOwnership,
        },
      }),
      policyRevision: hashOf({ target: target.raw, screens: screens.raw, login: login?.raw ?? null }),
      dataRevision,
      // Ревизия сборки на стенде подтверждается, только если профиль её публикует.
      buildRevision: null,
    };

    return { status: 'ready', scope };
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

  return {
    contractDir,
    internalScope,
    readContract,
    resolve,
  };
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
