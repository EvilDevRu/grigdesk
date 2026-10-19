import { failureText } from '../../shared/apiClient.ts';
import { decodeResourceWriteResult, resourceWriteFailure } from './contracts.ts';
import type {
  ApplyFailure,
  ApplyResult,
  FieldChange,
  FieldConflict,
  FieldIntent,
  JsonValue,
  ResourceAdapter,
  ResourceWriteResult,
  SavedFieldChange,
  SessionField,
  SessionFieldState,
  SessionClock,
  SessionSnapshot,
  ValidationIssue,
} from './contracts.ts';

interface ApplyRun {
  id: number;
  sessionId: number;
  delayed: boolean;
  promise: Promise<ApplyResult> | null;
  stop?: () => void;
}

interface ResourceState {
  adapter: ResourceAdapter;
  fields: Map<string, SessionField>;
  baseline: Record<string, JsonValue>;
  latest: Record<string, JsonValue>;
  intents: Map<string, FieldIntent>;
  conflicts: Map<string, FieldConflict>;
  errors: Map<string, string>;
  loaded: boolean;
  pending?: Promise<boolean>;
}

/**
 * JSON-объекты сравниваются по значениям, независимо от порядка их свойств.
 * Отсутствие ключа отличается от null, а порядок элементов массива сохраняется.
 */
function sameValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) {
    return true;
  }

  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }

  const keys = Object.keys(left);

  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/**
 * Сессия владеет копией снимка и никогда не читает обратно реальные секреты.
 * Метаданные поля исключают секрет и из baseline, и из последнего внешнего снимка.
 */
function publicValues(resource: ResourceState, values: Record<string, JsonValue>): Record<string, JsonValue> {
  return structuredClone(Object.fromEntries(
    Object.entries(values).filter(([key]) => !resource.fields.get(key)?.secret),
  ));
}

/**
 * Ключ поля непрозрачен и может совпасть с именем свойства Object.prototype.
 * Явное собственное свойство сохраняет такой ключ без изменения прототипа записи.
 */
function setRecordValue(record: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(record, key, {
    value: structuredClone(value),
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Даже ошибочное сообщение адаптера не должно вынести введённый секрет в state.
 * Контекст запроса передаётся явно, чтобы очистка успешного поля не убрала маскирование.
 */
function publicMessage(
  resource: ResourceState,
  message: string,
  intents: ReadonlyMap<string, FieldIntent> = resource.intents,
): string {
  let result = message;

  for (const [key, intent] of intents) {
    if (resource.fields.get(key)?.secret && intent.op === 'set'
        && typeof intent.value === 'string' && intent.value.length) {
      result = result.split(intent.value).join('[скрыто]');
    }
  }

  return result;
}

/**
 * Общая строка состояния не выдаёт частичный или неопределённый исход за успех.
 * Подробности сохраняются в публичном результате с адресами сохранённых и оставшихся полей.
 */
function applicationMessage(result?: ApplyResult): string {
  if (!result) {
    return '';
  }

  const messages = {
    unknown: 'Неизвестно, применены ли изменения',
    partial: 'Часть изменений сохранена',
    failed: 'Не удалось применить изменения',
    conflict: 'Настройки изменились снаружи',
    success: result.saved.length ? 'Изменения сохранены' : '',
  };

  return messages[result.status];
}

/**
 * Намерения, адаптеры и секретный ввод живут только в замыкании одного открытия.
 * Наружу для reactive state выдаются копии публичных снимков без значений секретов.
 */
export function createSettingsSession(options: { clock?: SessionClock } = {}) {
  const resources = new Map<string, ResourceState>();
  const listeners = new Set<() => void>();
  const clock: SessionClock = options.clock ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let sequence = 0;
  let active = false;
  let controller = new AbortController();
  let applicationSequence = 0;
  let currentRun: ApplyRun | null = null;
  let lastResult: ApplyResult | undefined;

  function assertNotApplying(): void {
    if (currentRun) {
      throw new Error('Настройки сохраняются. Дождитесь результата');
    }
  }

  /**
   * Освобождение очищает также объекты, на которые ещё ссылается ожидавшее чтение.
   * После закрытия прежний ResourceState не удерживает секретный ввод в Map намерений.
   */
  function releaseResources(): void {
    for (const resource of resources.values()) {
      resource.intents.clear();
      resource.errors.clear();
      resource.conflicts.clear();
    }

    resources.clear();
  }

  /**
   * Наблюдатель обновляет представление, но не управляет исходом действия.
   * Его ошибка не прерывает очистку сессии или подтверждённое изменение.
   */
  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Представление прочитает свежий публичный снимок при следующем обновлении.
      }
    }
  }

  /**
   * Порядок ресурсов задают адаптеры, а ID разрешает одинаковые позиции стабильно.
   * Тот же порядок определяет первое ошибочное поле и будущую очередь применения.
   */
  function orderedResources(): ResourceState[] {
    return [...resources.values()].sort((left, right) => {
      const order = left.adapter.order - right.adapter.order;

      if (order) {
        return order;
      }

      const leftKey = left.adapter.sortKey ?? [left.adapter.id];
      const rightKey = right.adapter.sortKey ?? [right.adapter.id];

      for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
        const comparison = (leftKey[index] ?? '').localeCompare(rightKey[index] ?? '', 'en');

        if (comparison) {
          return comparison;
        }
      }

      return left.adapter.id.localeCompare(right.adapter.id, 'en');
    });
  }

  /**
   * Изменение разрешено только в текущем открытии после чтения baseline.
   * Неизвестное поле не превращается в неадресуемый черновик.
   */
  function editableResource(id: string, key: string, operation = 'set'): ResourceState {
    assertNotApplying();

    const resource = resources.get(id);

    if (!active || !resource || !resource.loaded) {
      throw new Error('Сначала нужно загрузить настройки ресурса');
    }

    const field = resource.fields.get(key);

    if (!field || field.unavailable && !(operation === 'unset' && resource.adapter.supportsUnset)) {
      throw new Error(field?.unavailable ?? 'Поле настроек недоступно');
    }

    return resource;
  }

  /**
   * Начало нового открытия отменяет чтения прежнего и освобождает его ввод.
   * Монотонный номер не позволяет запоздалому ответу попасть в новую форму.
   */
  function begin(): number {
    controller.abort();
    controller = new AbortController();
    currentRun = null;
    lastResult = undefined;
    applicationSequence += 1;
    releaseResources();
    sequence += 1;
    active = true;
    notify();

    return sequence;
  }

  /**
   * Адаптер переживает размонтирование страницы и принадлежит сессии.
   * Смена схемы сохраняет недоступный dirty-ввод вместе с его прежним адресом.
   */
  function register(adapter: ResourceAdapter, fields: readonly SessionField[]): void {
    if (!active) {
      throw new Error('Сессия настроек закрыта');
    }

    const previous = resources.get(adapter.id);
    const nextFields = new Map(fields.map((field) => [field.key, structuredClone(field)]));

    if (previous) {
      for (const [key, field] of previous.fields) {
        if (!nextFields.has(key) && previous.intents.has(key)) {
          nextFields.set(key, { ...field, unavailable: 'Поле больше недоступно' });
        }
      }

      previous.adapter = adapter;
      previous.fields = nextFields;
      previous.baseline = publicValues(previous, previous.baseline);
      previous.latest = publicValues(previous, previous.latest);
    } else {
      resources.set(adapter.id, {
        adapter,
        fields: nextFields,
        baseline: {},
        latest: {},
        intents: new Map(),
        conflicts: new Map(),
        errors: new Map(),
        loaded: false,
      });
    }

    notify();
  }

  /**
   * Снимок обновляет нетронутые поля, сохраняя dirty-ввод и ошибки проверки.
   * Изменение dirty-поля относительно baseline требует явного решения человека.
   */
  function acceptSnapshot(id: string, values: Record<string, JsonValue>, sessionId = sequence): boolean {
    const resource = resources.get(id);

    if (!active || sessionId !== sequence || !resource) {
      return false;
    }

    const snapshot = publicValues(resource, values);
    const keys = new Set([...Object.keys(resource.baseline), ...Object.keys(snapshot)]);

    for (const key of keys) {
      const present = Object.hasOwn(snapshot, key);

      if (resource.intents.has(key)) {
        const changed = present !== Object.hasOwn(resource.baseline, key)
          || !sameValue(snapshot[key], resource.baseline[key]);

        if (changed) {
          resource.conflicts.set(key, {
            present,
            ...(present ? { serverValue: structuredClone(snapshot[key]) } : {}),
          });
        } else {
          resource.conflicts.delete(key);
        }
      } else if (present) {
        setRecordValue(resource.baseline, key, snapshot[key]!);
      } else {
        delete resource.baseline[key];
      }
    }

    resource.latest = snapshot;
    resource.loaded = true;
    notify();

    return true;
  }

  /**
   * Первое посещение читает ресурс один раз; параллельные посещения делят Promise.
   * Проверка номера открытия действует даже если транспорт проигнорировал abort.
   */
  async function load(id: string): Promise<boolean> {
    const resource = resources.get(id);

    if (!active || !resource) {
      return false;
    }

    if (resource.loaded) {
      return true;
    }

    if (resource.pending) {
      return resource.pending;
    }

    const sessionId = sequence;
    const pending = resource.adapter.read(controller.signal).then((values) =>
      acceptSnapshot(id, values, sessionId));

    resource.pending = pending;

    try {
      return await pending;
    } finally {
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
    }
  }

  /**
   * Ввод меняет только намерение и копируется до выхода к вызывающему коду.
   * Возврат к baseline убирает dirty; false, ноль и пустая строка не теряются.
   */
  function setField(id: string, key: string, value: JsonValue, confirmed?: true): void {
    const resource = editableResource(id, key);
    const secret = resource.fields.get(key)?.secret;

    lastResult = undefined;

    if (!secret && Object.hasOwn(resource.baseline, key) && sameValue(value, resource.baseline[key])) {
      discardField(id, key);

      return;
    } else {
      resource.intents.set(key, {
        op: 'set',
        value: structuredClone(value),
        ...(confirmed ? { confirmed } : {}),
      });
    }

    resource.errors.delete(key);
    notify();
  }

  /**
   * Сброс override является отдельным намерением, отличным от set(null).
   * Поддержку объявляет ресурс, поэтому произвольное поле не получает удаление.
   */
  function unsetField(id: string, key: string): void {
    const resource = editableResource(id, key, 'unset');

    lastResult = undefined;

    if (!resource.adapter.supportsUnset) {
      throw new Error('Сброс для этого ресурса не поддерживается');
    }

    if (!Object.hasOwn(resource.baseline, key) && !resource.fields.get(key)?.hasStoredValue) {
      discardField(id, key);

      return;
    }

    resource.intents.set(key, { op: 'unset' });
    resource.errors.delete(key);
    notify();
  }

  /**
   * Значение контрола возвращается копией, отдельно от reactive state.
   * Секретный ввод нельзя переносить отсюда в сериализуемые снимки или storage.
   */
  function getValue(id: string, key: string): JsonValue | undefined {
    const resource = resources.get(id);
    const intent = resource?.intents.get(key);
    const baseline = resource && Object.hasOwn(resource.baseline, key) ? resource.baseline[key] : undefined;
    const value = intent ? intent.op === 'set' ? intent.value : undefined : baseline;

    return value === undefined ? undefined : structuredClone(value);
  }

  function getIntent(id: string, key: string): FieldIntent | undefined {
    return structuredClone(resources.get(id)?.intents.get(key));
  }

  function getBaseline(id: string): Record<string, JsonValue> {
    return structuredClone(resources.get(id)?.baseline ?? {});
  }

  /**
   * Публичное состояние содержит адреса, статусы и только несекретные значения.
   * Map намерений остаётся в замыкании и не попадает в Pinia/devtools сериализацию.
   */
  function getSnapshot(): SessionSnapshot {
    const publicResources = orderedResources().map((resource) => ({
      id: resource.adapter.id,
      loaded: resource.loaded,
      fields: [...resource.fields.values()].map((field): SessionFieldState => ({
        ...structuredClone(field),
        dirty: resource.intents.has(field.key),
        hasSecretDraft: Boolean(field.secret && resource.intents.has(field.key)),
        ...(!field.secret ? {
          value: getValue(resource.adapter.id, field.key),
          intent: getIntent(resource.adapter.id, field.key),
          conflict: structuredClone(resource.conflicts.get(field.key)),
        } : {}),
        error: resource.errors.get(field.key),
      })),
    }));

    return {
      sessionId: sequence,
      active,
      dirtyCount: [...resources.values()].reduce((sum, resource) => sum + resource.intents.size, 0),
      resources: publicResources,
      applying: currentRun !== null,
      delayed: currentRun?.delayed ?? false,
      canClose: currentRun === null,
      statusMessage: currentRun ? currentRun.delayed ? 'Ответ задерживается' : 'Сохраняем…'
        : applicationMessage(lastResult),
      lastResult: structuredClone(lastResult),
    };
  }

  /**
   * Оба решения сначала принимают актуальный baseline; только одно отбрасывает ввод.
   * После «оставить мой» обычная валидация и защита CAS всё равно действуют.
   */
  function resolveConflict(id: string, key: string, choice: 'take-current' | 'keep-mine'): void {
    assertNotApplying();

    const resource = resources.get(id);
    const conflict = resource?.conflicts.get(key);

    if (!resource || !conflict) {
      return;
    }

    if (conflict.present) {
      setRecordValue(resource.baseline, key, conflict.serverValue!);
    } else {
      delete resource.baseline[key];
    }

    const intent = resource.intents.get(key);

    if (choice === 'take-current'
        || (intent?.op === 'set' && sameValue(intent.value, resource.baseline[key]))
        || (intent?.op === 'unset' && !Object.hasOwn(resource.baseline, key))) {
      resource.intents.delete(key);
      resource.errors.delete(key);
    }

    resource.conflicts.delete(key);
    notify();
  }

  /**
   * Валидируются все изменённые ресурсы, включая размонтированные страницы.
   * Адрес берётся из регистрации поля, а адаптер получает собственные копии данных.
   */
  function validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const resource of orderedResources()) {
      resource.errors.clear();

      if (!resource.intents.size) {
        continue;
      }

      const problems: Array<{ key: string; message: string }> = [];

      for (const key of resource.intents.keys()) {
        const field = resource.fields.get(key);

        const canUnset = resource.intents.get(key)?.op === 'unset' && resource.adapter.supportsUnset;

        if (field?.unavailable && !canUnset) {
          problems.push({ key, message: field.unavailable });
        } else if (resource.conflicts.has(key)) {
          problems.push({ key, message: 'Настройка изменилась снаружи. Выберите нужный вариант' });
        }
      }

      try {
        problems.push(...resource.adapter.validate(
          structuredClone(resource.intents),
          structuredClone(resource.baseline),
        ));
      } catch (error) {
        const key = resource.intents.keys().next().value;

        if (key !== undefined) {
          problems.push({
            key,
            message: failureText(error, 'Не удалось проверить настройки ресурса'),
          });
        }
      }

      for (const problem of problems) {
        const firstDirtyKey = resource.intents.keys().next().value;
        const field = resource.fields.get(problem.key)
          ?? (firstDirtyKey === undefined ? undefined : resource.fields.get(firstDirtyKey));

        if (field && !resource.errors.has(field.key)) {
          const message = publicMessage(resource, problem.message);

          resource.errors.set(field.key, message);
          issues.push({
            resourceId: resource.adapter.id,
            key: field.key,
            address: structuredClone(field.address),
            message,
          });
        }
      }
    }

    notify();

    return issues;
  }

  /**
   * Отдельный отказ от ввода доступен также для удалённого поля схемы.
   * Актуальное внешнее значение принимается без записи и без потери других правок.
   */
  function discardField(id: string, key: string): void {
    assertNotApplying();

    const resource = resources.get(id);

    if (!resource) {
      return;
    }

    if (Object.hasOwn(resource.latest, key)) {
      setRecordValue(resource.baseline, key, resource.latest[key]!);
    } else {
      delete resource.baseline[key];
    }

    resource.intents.delete(key);
    resource.errors.delete(key);
    resource.conflicts.delete(key);
    lastResult = undefined;

    if (resource.fields.get(key)?.unavailable) {
      resource.fields.delete(key);
    }

    notify();
  }

  /**
   * Отмена отбрасывает только неприменённое и временные секреты без записи.
   * Последний внешний снимок становится baseline вместо прежнего спорного значения.
   */
  function discard(): void {
    assertNotApplying();

    for (const resource of resources.values()) {
      resource.intents.clear();
      resource.errors.clear();
      resource.conflicts.clear();
      resource.baseline = structuredClone(resource.latest);
    }

    lastResult = undefined;
    notify();
  }

  /**
   * Закрытие владельца отзывает принадлежность поздних ответов этому открытию.
   * Неприменённые данные, секреты и адаптеры освобождаются вместе.
   */
  function dispose(_reason?: string): void {
    active = false;
    controller.abort();
    currentRun = null;
    lastResult = undefined;
    applicationSequence += 1;
    releaseResources();
    notify();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Список оставшегося ввода содержит только адреса, без значений и секретов.
   * Он включает также ресурсы, до которых очередь не дошла после отказа.
   */
  function remainingChanges(): FieldChange[] {
    return orderedResources().flatMap((resource) => [...resource.intents.keys()].map((key) => ({
      resourceId: resource.adapter.id,
      key,
      address: structuredClone(resource.fields.get(key)!.address),
    })));
  }

  /**
   * Итог различает частичную запись, конфликт и неизвестность вместо общего успеха.
   * Разрешение закрытия относится к исходному OK, а не к повторной кнопке во время записи.
   */
  function applicationResult(
    run: ApplyRun,
    mode: 'apply' | 'ok',
    saved: SavedFieldChange[],
    errors: ApplyFailure[],
    validation: ValidationIssue[] = [],
  ): ApplyResult {
    const belongs = active && sequence === run.sessionId;
    const remaining = belongs ? remainingChanges() : [];
    const status = !belongs || errors.some((error) => error.status === 'unknown') ? 'unknown'
      : !errors.length && !validation.length && !remaining.length ? 'success'
        : saved.length ? 'partial'
          : errors.some((error) => error.status === 'conflict') ? 'conflict' : 'failed';

    return {
      status,
      saved,
      remaining,
      errors,
      validation,
      shouldClose: belongs && mode === 'ok' && status === 'success',
    };
  }

  /**
   * Один запрос ждёт ответ либо явную отмену ожидания; двадцать секунд лишь меняют статус.
   * Гонка не подавляет поздний доменный ACK, но не даёт ему изменить сессию.
   */
  async function awaitWrite(
    resource: ResourceState,
    requested: ReadonlyMap<string, FieldIntent>,
    run: ApplyRun,
  ): Promise<ResourceWriteResult | null> {
    const ownerSignal = controller.signal;
    const writeController = new AbortController();
    let interrupt!: (result: ResourceWriteResult | null) => void;
    const interrupted = new Promise<ResourceWriteResult | null>((resolve) => {
      interrupt = resolve;
    });
    const onOwnerClosed = () => interrupt(null);
    const timer = clock.setTimeout(() => {
      if (currentRun === run && active && sequence === run.sessionId) {
        run.delayed = true;
        notify();
      }
    }, 20_000);

    ownerSignal.addEventListener('abort', onOwnerClosed, { once: true });
    run.stop = () => {
      interrupt({
        status: 'unknown',
        fields: [],
        message: 'Ожидание прекращено. Результат записи неизвестен',
      });
      writeController.abort();
      run.stop = undefined;
      run.delayed = false;
    };

    const operation = Promise.resolve().then(() => resource.adapter.write(
      structuredClone(requested),
      structuredClone(resource.baseline),
      AbortSignal.any([ownerSignal, writeController.signal]),
    )).then(decodeResourceWriteResult).catch(resourceWriteFailure);

    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      clock.clearTimeout(timer);
      ownerSignal.removeEventListener('abort', onOwnerClosed);
      run.stop = undefined;
      run.delayed = false;
    }
  }

  /**
   * Подтверждение поля обновляет baseline и последний снимок только после явного ACK.
   * Значение секрета не возвращается ни в baseline, ни в итог применения.
   */
  function acknowledgeField(
    resource: ResourceState,
    key: string,
    intent: FieldIntent,
    serverValue: JsonValue | undefined,
  ): SavedFieldChange {
    const field = resource.fields.get(key)!;

    if (!field.secret && serverValue !== undefined) {
      setRecordValue(resource.baseline, key, serverValue);
      setRecordValue(resource.latest, key, serverValue);
    } else {
      delete resource.baseline[key];
      delete resource.latest[key];
    }

    resource.intents.delete(key);
    resource.errors.delete(key);
    resource.conflicts.delete(key);

    return {
      resourceId: resource.adapter.id,
      key,
      address: structuredClone(field.address),
      normalized: !field.secret && intent.op === 'set' && !sameValue(intent.value, serverValue),
      ...(!field.secret && serverValue !== undefined ? { serverValue: structuredClone(serverValue) } : {}),
    };
  }

  /**
   * Один запрос подтверждает свои поля вместе; per-field допускает отдельные успехи.
   * Отсутствие подтверждения или принятого значения сохраняет dirty с ошибкой поля.
   */
  function acceptWriteResult(
    resource: ResourceState,
    requested: ReadonlyMap<string, FieldIntent>,
    response: ResourceWriteResult,
    saved: SavedFieldChange[],
  ): ApplyFailure | null {
    const fields = new Map(response.fields.map((field) => [field.key, field]));
    let status = response.status;
    let message = response.message === undefined ? undefined
      : publicMessage(resource, response.message, requested);

    if ([...fields.keys()].some((key) => !requested.has(key))) {
      status = 'unknown';
      message = 'Ответ содержит неизвестное подтверждение поля';
      fields.clear();
    }

    for (const [key, intent] of requested) {
      const field = fields.get(key);
      const canConfirm = response.status === 'success' || resource.adapter.body === 'per-field';
      const hasValue = intent.op === 'unset' || resource.fields.get(key)?.secret
        || Boolean(field && Object.hasOwn(field, 'serverValue'));

      if (canConfirm && field?.status === 'success' && hasValue) {
        saved.push(acknowledgeField(resource, key, intent, field.serverValue));
      } else {
        const outcome = field?.status !== 'success' ? field?.status ?? response.status : 'failed';
        const failure = outcome === 'success' ? 'failed' : outcome;

        message = field?.message === undefined ? message ?? 'Сервер не принял значение'
          : publicMessage(resource, field.message, requested);
        resource.errors.set(key, message);

        if (status !== 'unknown') {
          status = failure === 'unknown' || status === 'success' ? failure
            : failure === 'conflict' ? 'conflict' : status;
        }
      }
    }

    notify();

    return status === 'success' ? null : {
      resourceId: resource.adapter.id,
      status,
      message: message ?? 'Не удалось сохранить настройки',
      ...(response.httpStatus === undefined ? {} : { httpStatus: response.httpStatus }),
    };
  }

  /**
   * Unknown запускает одно чтение для сверки, без повторной записи и без удержания закрытия.
   * Поздняя сверка не влияет на новое открытие или следующий явный Apply.
   */
  function refreshUnknown(resource: ResourceState, run: ApplyRun): void {
    const signal = controller.signal;

    void Promise.resolve().then(() => resource.adapter.read(signal, true)).then((values) => {
      if (active && sequence === run.sessionId && applicationSequence === run.id) {
        acceptSnapshot(resource.adapter.id, values, run.sessionId);
      }
    }).catch(() => {
      // Неудачная сверка не превращает неизвестный исход в известный отказ.
    });
  }

  /**
   * Весь dirty-набор проверяется до первой записи; записи идут строго последовательно.
   * Обычный отказ блокирует цепочку, неизвестность или потеря входа — всю очередь.
   */
  async function runApplication(run: ApplyRun, mode: 'apply' | 'ok'): Promise<ApplyResult> {
    const saved: SavedFieldChange[] = [];
    const errors: ApplyFailure[] = [];
    const blockedChains = new Set<string>();

    if (!active || sequence !== run.sessionId || currentRun !== run) {
      return applicationResult(run, mode, saved, errors);
    }

    const validation = validate();

    if (validation.length) {
      return applicationResult(run, mode, saved, errors, validation);
    }

    for (const resource of orderedResources()) {
      if (!active || sequence !== run.sessionId || currentRun !== run) {
        break;
      }

      if (!resource.intents.size || blockedChains.has(resource.adapter.chain)) {
        continue;
      }

      const requested = structuredClone(resource.intents);
      const response = await awaitWrite(resource, requested, run);

      if (!response || !active || sequence !== run.sessionId || currentRun !== run) {
        break;
      }

      const failure = acceptWriteResult(resource, requested, response, saved);

      if (failure) {
        errors.push(failure);
        blockedChains.add(resource.adapter.chain);

        if (failure.status === 'unknown') {
          refreshUnknown(resource, run);

          break;
        }

        if (failure.httpStatus === 401) {
          break;
        }
      }
    }

    return applicationResult(run, mode, saved, errors);
  }

  /**
   * Один Promise принадлежит одному применению, включая фазу проверки всего набора.
   * Повторная кнопка получает тот же исход и не меняет исходное намерение закрытия.
   */
  function apply(mode: 'apply' | 'ok' = 'apply'): Promise<ApplyResult> {
    if (currentRun?.promise) {
      return currentRun.promise;
    }

    applicationSequence += 1;

    const run: ApplyRun = {
      id: applicationSequence,
      sessionId: sequence,
      delayed: false,
      promise: null,
    };

    run.promise = Promise.resolve().then(() => runApplication(run, mode)).then((result) => {
      if (active && sequence === run.sessionId && currentRun === run) {
        lastResult = structuredClone(result);
      }

      return result;
    }).finally(() => {
      if (currentRun === run) {
        currentRun = null;
        notify();
      }
    });
    currentRun = run;
    notify();

    return run.promise;
  }

  function stopWaiting(): boolean {
    if (!currentRun?.delayed || !currentRun.stop) {
      return false;
    }

    currentRun.stop();

    return true;
  }

  return {
    begin,
    register,
    load,
    setField,
    unsetField,
    getValue,
    getIntent,
    getBaseline,
    getSnapshot,
    acceptSnapshot,
    resolveConflict,
    validate,
    discardField,
    discard,
    dispose,
    subscribe,
    apply,
    stopWaiting,
  };
}
