import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import {
  PACKAGE_ID,
  RUNTIME_TOKEN,
  privateRuntimeDirectory,
  readRuntimeJson,
  runtimeError,
  syncRuntimeDirectory,
  withPackageLock,
  withRuntimeGcLock,
  writeRuntimeJson,
} from '../binary/leases.ts';

export interface FactoryRuntimePin {
  format: 1;
  scope: string;
  task: string;
  attempt: string;
  reservationToken: string | null;
  packageId: string | null;
  runtimeRoot: string;
  engineHome: string;
  engineBin: string;
  node: string;
  protocol: 'route-v2';
}

export interface FactoryRuntimeRoots {
  controlRoot: string;
  stateRoot: string;
  profileRoot: string;
}

export interface FactoryRuntimeSelection {
  packageId: string | null;
  runtimeRoot: string;
  engineHome: string;
  engineBin: string;
  node: string;
}

export interface FactoryRuntimeReservation extends FactoryRuntimeRoots, FactoryRuntimeSelection {
  format: 1;
  token: string;
  scope: string;
  task: string;
}

interface RegistryRoot extends FactoryRuntimeRoots {
  references: {
    scope: string;
    packageId: string | null;
    token: string | null;
    task?: string;
    attempt?: string;
  }[];
}

export interface RuntimeRootRegistry {
  format: 1;
  roots: RegistryRoot[];
}

export type PinCheckpoint = (phase: 'registry' | 'reservation' | 'authority' | 'index') => Promise<void>;

const ATTEMPT = /^a_[a-f0-9]{32}$/u;
const TASK = /^[1-9][0-9]{0,18}$/u;
const ROOT_KEYS = ['controlRoot', 'stateRoot', 'profileRoot'] as const;
const RUNTIME_KEYS = ['runtimeRoot', 'engineHome', 'engineBin', 'node'] as const;
const PIN_KEYS = ['format', 'scope', 'task', 'attempt', 'reservationToken', 'packageId',
  ...RUNTIME_KEYS, 'protocol'];
const RESERVATION_KEYS = ['format', 'token', 'scope', 'task', 'packageId', ...ROOT_KEYS, ...RUNTIME_KEYS];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...keys].sort().join();
}

/**
 * Scope строится по именованным физическим roots, поэтому соседние профили и control
 * не сталкиваются даже при одинаковых task ID и случайно одинаковых attempt ID.
 */
export function factoryRuntimeScope(roots: FactoryRuntimeRoots): string {
  return sha256(canonicalJson({
    controlRoot: roots.controlRoot,
    stateRoot: roots.stateRoot,
    profileRoot: roots.profileRoot,
  }));
}

/**
 * Физические roots сравниваются целиком, без раскрытия ссылок в пользу вызывающего.
 * Provider-writable state никогда не становится источником authority runtime pin.
 */
export async function assertPhysicalRuntimePath(file: string, directory = true): Promise<void> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
    || await fs.realpath(file) !== file) {
    throw runtimeError('factory_runtime_pin_invalid');
  }

  const stat = await fs.lstat(file);

  if (directory ? !stat.isDirectory() : !stat.isFile() || (stat.mode & 0o111) === 0) {
    throw runtimeError('factory_runtime_pin_invalid');
  }
}

/**
 * Scope принимает только физические roots; alias не может создать вторую authority того же attempt.
 * Control не пересекается с provider state, иначе sidecar перестал бы быть host-owned.
 */
async function validateFactoryRuntimeRoots(roots: FactoryRuntimeRoots): Promise<void> {
  for (const key of ROOT_KEYS) {
    await assertPhysicalRuntimePath(roots[key]);
  }

  await privateRuntimeDirectory(roots.controlRoot, false);

  if (roots.controlRoot === roots.stateRoot
    || roots.controlRoot.startsWith(`${roots.stateRoot}${path.sep}`)
    || roots.stateRoot.startsWith(`${roots.controlRoot}${path.sep}`)) {
    throw runtimeError('factory_runtime_pin_invalid');
  }
}

/**
 * У cache generation пути Node и engine принадлежат ровно указанному package ID.
 * Nullable legacy/source проверяет physical paths, но не попадает под удаление GC.
 */
export async function validateFactoryRuntime(
  input: FactoryRuntimeSelection, cacheDir: string,
): Promise<void> {
  if (input.packageId !== null && (!PACKAGE_ID.test(input.packageId)
    || input.runtimeRoot !== path.join(cacheDir, 'packages', input.packageId)
    || input.node !== path.join(input.runtimeRoot, 'runtime/node/bin/node'))) {
    throw runtimeError('factory_runtime_pin_invalid');
  }

  await assertPhysicalRuntimePath(input.runtimeRoot);
  await assertPhysicalRuntimePath(input.engineHome);
  await assertPhysicalRuntimePath(input.engineBin, false);
  await assertPhysicalRuntimePath(input.node, false);
}

/**
 * Registry хранит все когда-либо зарегистрированные roots и generation references.
 * Потерянный или повреждённый registry не превращается в пустой список pin-ов.
 */
export async function readRuntimeRootRegistry(cacheDir: string): Promise<RuntimeRootRegistry> {
  const value = await readRuntimeJson(path.join(cacheDir, 'state/control-roots.json')) as RuntimeRootRegistry;

  if (!exactKeys(value, ['format', 'roots']) || value.format !== 1 || !Array.isArray(value.roots)) {
    throw runtimeError('factory_runtime_registry_invalid');
  }

  for (const root of value.roots) {
    if (!exactKeys(root, [...ROOT_KEYS, 'references']) || !Array.isArray(root.references)
      || !ROOT_KEYS.every((key) => typeof root[key] === 'string' && path.isAbsolute(root[key]))) {
      throw runtimeError('factory_runtime_registry_invalid');
    }

    for (const ref of root.references) {
      const keys = ref.token === null ? ['scope', 'packageId', 'token', 'task', 'attempt']
        : ['scope', 'packageId', 'token'];

      if (!exactKeys(ref, keys) || ref.scope !== factoryRuntimeScope(root)
        || (ref.packageId !== null && !PACKAGE_ID.test(ref.packageId))
        || (ref.token === null ? !TASK.test(ref.task ?? '') || !ATTEMPT.test(ref.attempt ?? '')
          : !RUNTIME_TOKEN.test(ref.token))) {
        throw runtimeError('factory_runtime_registry_invalid');
      }
    }
  }

  return value;
}

/**
 * Маркер инициализации позволяет отличить первую регистрацию от потери готового registry.
 * После первой публикации отсутствие registry даёт отказ, вместо забывания старого control root.
 */
async function registryForRegistration(cacheDir: string): Promise<RuntimeRootRegistry> {
  try {
    return await readRuntimeRootRegistry(cacheDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    const marker = path.join(cacheDir, 'state/control-roots.initialized.json');
    const initialized = await fs.lstat(marker).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== 'ENOENT') {
        throw failure;
      }

      return null;
    });

    if (initialized) {
      throw runtimeError('factory_runtime_registry_invalid');
    }

    await privateRuntimeDirectory(path.join(cacheDir, 'state'));
    await writeRuntimeJson(marker, { format: 1 });

    return { format: 1, roots: [] };
  }
}

/**
 * Host резервирует поколение до spawn, не генерируя attempt ID за движок.
 * Durable registry публикуется первым; crash в любой следующей фазе оставляет keep/unknown.
 */
export async function reserveFactoryRuntime(input: FactoryRuntimeRoots & FactoryRuntimeSelection & {
  cacheDir: string;
  task: string;
  checkpoint?: PinCheckpoint;
}): Promise<{
  token: string;
  scope: string;
  reservation: string;
}> {
  if (!TASK.test(input.task) || input.packageId === null) {
    throw runtimeError('factory_runtime_reservation_invalid');
  }

  await validateFactoryRuntimeRoots(input);

  const packageId = input.packageId;

  return withRuntimeGcLock(input.cacheDir, () => withPackageLock(input.cacheDir, packageId, async () => {
    await validateFactoryRuntime(input, input.cacheDir);

    const registry = await registryForRegistration(input.cacheDir);
    const token = randomUUID();
    const scope = factoryRuntimeScope(input);
    let root = registry.roots.find((entry) => factoryRuntimeScope(entry) === scope);

    if (!root) {
      root = {
        controlRoot: input.controlRoot,
        stateRoot: input.stateRoot,
        profileRoot: input.profileRoot,
        references: [],
      };
      registry.roots.push(root);
    }

    root.references.push({
      scope,
      packageId: input.packageId,
      token,
    });
    await writeRuntimeJson(path.join(input.cacheDir, 'state/control-roots.json'), registry);
    await input.checkpoint?.('registry');

    const reservation = path.join(input.controlRoot, 'server-runtimes/reservations', `${token}.json`);
    const value: FactoryRuntimeReservation = {
      format: 1,
      token,
      scope,
      task: input.task,
      packageId: input.packageId,
      controlRoot: input.controlRoot,
      stateRoot: input.stateRoot,
      profileRoot: input.profileRoot,
      runtimeRoot: input.runtimeRoot,
      engineHome: input.engineHome,
      engineBin: input.engineBin,
      node: input.node,
    };

    await privateRuntimeDirectory(path.join(input.controlRoot, 'server-runtimes'));
    await writeRuntimeJson(reservation, value);
    await writeRuntimeJson(path.join(input.cacheDir, 'attempt-pins/reservations', `${token}.json`), value);
    await input.checkpoint?.('reservation');

    return {
      token,
      scope,
      reservation,
    };
  }));
}

/**
 * Trusted engine files читаются только как regular owner файлы с immutable mode 0400.
 * Helper проверяет checksum/identity read-only, не захватывая повторно родительский attempt lock.
 */
async function readTrustedFile(file: string): Promise<Buffer> {
  await assertPhysicalRuntimePath(path.dirname(file));

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o400
      || stat.size > 1024 * 1024) {
      throw runtimeError('factory_runtime_attempt_invalid');
    }

    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Отдельный sidecar может ссылаться только на exact engine directory и trusted attempt.
 * Ни stdout begin, ни provider state не участвуют в установлении task/profile/attempt identity.
 */
export async function readFactoryRuntimeAttempt(roots: FactoryRuntimeRoots, task: string,
  attempt: string, attemptDir?: string): Promise<{
    profile: string;
    bytes: string;
    directory: string;
  }> {
  if (!TASK.test(task) || !ATTEMPT.test(attempt)) {
    throw runtimeError('factory_runtime_attempt_invalid');
  }

  const directory = path.join(roots.controlRoot, 'protocol-v2/tasks', `t${task}`, 'attempts', attempt);

  if (attemptDir !== undefined && attemptDir !== directory) {
    throw runtimeError('factory_runtime_attempt_invalid');
  }

  await assertPhysicalRuntimePath(directory);

  const protocol = JSON.parse((await readTrustedFile(path.join(roots.controlRoot,
    'protocol-v2/tasks', `t${task}`, 'protocol.json'))).toString()) as Record<string, unknown>;

  if (!exactKeys(protocol, ['schema', 'protocolVersion']) || protocol.schema !== 1
    || protocol.protocolVersion !== 2) {
    throw runtimeError('factory_runtime_attempt_invalid');
  }

  const bytes = await readTrustedFile(path.join(directory, 'attempt.json'));
  const hash = (await readTrustedFile(path.join(directory, 'attempt.sha256'))).toString().trim();
  const metadata = JSON.parse(bytes.toString()) as Record<string, unknown>;

  if (sha256(bytes) !== hash || metadata.protocolVersion !== 2 || ![1, 2].includes(Number(metadata.schema))
    || metadata.taskId !== task || metadata.attemptId !== attempt
    || typeof metadata.profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(metadata.profile)
    || typeof metadata.routesDir !== 'string' || !path.isAbsolute(metadata.routesDir)
    || !PACKAGE_ID.test(String(metadata.catalogHash))) {
    throw runtimeError('factory_runtime_attempt_invalid');
  }

  return {
    profile: metadata.profile,
    bytes: bytes.toString(),
    directory,
  };
}

/**
 * Закрытая схема authority не допускает provider полей и случайных дополнительных прав.
 * Paths проверяются при использовании; GC сохраняет поколение при любой неопределённости.
 */
export function decodeFactoryRuntimePin(value: unknown): FactoryRuntimePin {
  const pin = value as FactoryRuntimePin;

  if (!exactKeys(pin, PIN_KEYS) || pin.format !== 1 || pin.protocol !== 'route-v2'
    || !PACKAGE_ID.test(pin.scope) || !TASK.test(pin.task) || !ATTEMPT.test(pin.attempt)
    || (pin.packageId !== null && !PACKAGE_ID.test(pin.packageId))
    || (pin.reservationToken !== null && !RUNTIME_TOKEN.test(pin.reservationToken))
    || !RUNTIME_KEYS.every((key) => typeof pin[key] === 'string' && path.isAbsolute(pin[key]))) {
    throw runtimeError('factory_runtime_pin_invalid');
  }

  return pin;
}

/**
 * CAS публикует готовый fsync temp через link без замены существующего authority.
 * Разные package locks также не могут перезаписать один scope/attempt другим поколением.
 */
async function publishAuthority(file: string, pin: FactoryRuntimePin): Promise<void> {
  await privateRuntimeDirectory(path.dirname(file));

  const temporary = path.join(path.dirname(file), `.pin-${randomUUID()}`);

  await writeRuntimeJson(temporary, pin);

  try {
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      const previous = decodeFactoryRuntimePin(await readRuntimeJson(file));

      if (canonicalJson(previous) !== canonicalJson(pin)) {
        throw runtimeError('factory_runtime_pin_conflict');
      }
    }

    await syncRuntimeDirectory(path.dirname(file));
  } finally {
    await fs.unlink(temporary);
    await syncRuntimeDirectory(path.dirname(file));
  }
}

/**
 * Reservation проверяется целиком, включая путь, token и scope именованных roots.
 * Перенос либо подмена файла не разрешает привязать runtime к чужому control/state.
 */
async function readReservation(file: string): Promise<FactoryRuntimeReservation> {
  const value = await readRuntimeJson(file) as FactoryRuntimeReservation;

  if (!exactKeys(value, RESERVATION_KEYS) || value.format !== 1 || !RUNTIME_TOKEN.test(value.token)
    || !TASK.test(value.task) || !PACKAGE_ID.test(value.packageId ?? '')
    || !ROOT_KEYS.every((key) => typeof value[key] === 'string' && path.isAbsolute(value[key]))
    || value.scope !== factoryRuntimeScope(value)
    || file !== path.join(value.controlRoot, 'server-runtimes/reservations', `${value.token}.json`)) {
    throw runtimeError('factory_runtime_reservation_invalid');
  }

  return value;
}

/**
 * Повтор после удаления reservation ищет только exact token/attempt authority.
 * Registry подтверждает roots и исходную ссылку; случайный чужой pin не даёт success.
 */
async function completedBinding(input: {
  reservation: string;
  task: string;
  attempt: string;
  attemptDir: string;
}): Promise<FactoryRuntimePin> {
  const controlRoot = path.dirname(path.dirname(path.dirname(input.reservation)));
  const token = path.basename(input.reservation, '.json');

  if (!RUNTIME_TOKEN.test(token)
    || input.reservation !== path.join(controlRoot, 'server-runtimes/reservations', `${token}.json`)) {
    throw runtimeError('factory_runtime_reservation_invalid');
  }

  for (const scope of await fs.readdir(path.join(controlRoot, 'server-runtimes'))) {
    if (!PACKAGE_ID.test(scope)) {
      continue;
    }

    const file = path.join(controlRoot, 'server-runtimes', scope, `${input.attempt}.json`);
    const pin = await readRuntimeJson(file)
      .then(decodeFactoryRuntimePin).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }

        return null;
      });

    if (!pin || pin.reservationToken !== token || pin.task !== input.task || pin.packageId === null) {
      continue;
    }

    const cacheDir = path.dirname(path.dirname(pin.runtimeRoot));
    const registry = await readRuntimeRootRegistry(cacheDir);
    const root = registry.roots.find((entry) => entry.controlRoot === controlRoot
      && factoryRuntimeScope(entry) === pin.scope && entry.references.some((ref) => ref.token === token
        && ref.packageId === pin.packageId));

    if (!root) {
      throw runtimeError('factory_runtime_registry_invalid');
    }

    await readFactoryRuntimeAttempt(root, input.task, input.attempt, input.attemptDir);
    await validateFactoryRuntime(pin, cacheDir);

    return pin;
  }

  throw runtimeError('factory_runtime_reservation_missing');
}

/**
 * Bind вызывается движком после final directory и до active pointer/provider.
 * Authority → index → removal reservation сохраняют защиту при crash между фазами.
 */
export async function bindFactoryRuntime(input: {
  reservation: string;
  task: string;
  attempt: string;
  attemptDir: string;
  checkpoint?: PinCheckpoint;
}): Promise<FactoryRuntimePin> {
  let reservation: FactoryRuntimeReservation;

  try {
    reservation = await readReservation(input.reservation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return completedBinding(input);
    }

    throw error;
  }

  const cacheDir = path.dirname(path.dirname(reservation.runtimeRoot));

  return withPackageLock(cacheDir, reservation.packageId!, async () => {
    const current = await readReservation(input.reservation).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    });

    if (!current) {
      return completedBinding(input);
    }

    if (canonicalJson(current) !== canonicalJson(reservation)) {
      throw runtimeError('factory_runtime_reservation_invalid');
    }

    if (reservation.task !== input.task) {
      throw runtimeError('factory_runtime_pin_conflict');
    }

    const registry = await readRuntimeRootRegistry(cacheDir);

    if (!registry.roots.some((root) => factoryRuntimeScope(root) === reservation.scope
      && root.references.some((ref) => ref.token === reservation.token
        && ref.packageId === reservation.packageId))) {
      throw runtimeError('factory_runtime_registry_invalid');
    }

    for (const key of ROOT_KEYS) {
      await assertPhysicalRuntimePath(reservation[key]);
    }

    await validateFactoryRuntime(reservation, cacheDir);
    await readFactoryRuntimeAttempt(reservation, input.task, input.attempt, input.attemptDir);

    const pin: FactoryRuntimePin = {
      format: 1,
      scope: reservation.scope,
      task: input.task,
      attempt: input.attempt,
      reservationToken: reservation.token,
      packageId: reservation.packageId,
      runtimeRoot: reservation.runtimeRoot,
      engineHome: reservation.engineHome,
      engineBin: reservation.engineBin,
      node: reservation.node,
      protocol: 'route-v2',
    };

    await publishAuthority(path.join(reservation.controlRoot, 'server-runtimes',
      pin.scope, `${pin.attempt}.json`), pin);
    await input.checkpoint?.('authority');
    await writeRuntimeJson(path.join(cacheDir, 'attempt-pins', pin.scope, `${pin.attempt}.json`), pin);
    await input.checkpoint?.('index');
    await fs.unlink(input.reservation);
    await syncRuntimeDirectory(path.dirname(input.reservation));

    return pin;
  });
}

/**
 * Время terminal повторяет закрытый UTC формат движка без timezone aliases и миллисекунд.
 * Обратное ISO-преобразование также отвергает невозможные календарные даты.
 */
function canonicalEngineTime(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
    || value.startsWith('0000-')) {
    return false;
  }

  const time = Date.parse(value);

  return Number.isFinite(time) && new Date(time).toISOString() === value.replace(/Z$/u, '.000Z');
}

/**
 * Canonical terminal доказывается checksum имени, закрытой формой и exact identity.
 * Mutable active pointer и возраст файлов не считаются доказательством завершения.
 */
async function terminalState(roots: FactoryRuntimeRoots, pin: FactoryRuntimePin)
  : Promise<'terminal' | 'active' | 'unknown'> {
  try {
    const { directory } = await readFactoryRuntimeAttempt(roots, pin.task, pin.attempt);
    const files = (await fs.readdir(directory)).filter((name) => name.startsWith('terminal.'));

    if (files.length === 0) {
      return 'active';
    }

    if (files.length !== 1 || !/^terminal\.[a-f0-9]{64}\.json$/u.test(files[0]!)) {
      return 'unknown';
    }

    const bytes = await readTrustedFile(path.join(directory, files[0]!));
    const value = JSON.parse(bytes.toString()) as Record<string, unknown>;

    if (`terminal.${sha256(bytes)}.json` !== files[0]
      || !exactKeys(value, ['schema', 'protocolVersion', 'taskId', 'attemptId',
        'state', 'closedAt', 'reason'])
      || value.schema !== 1 || value.protocolVersion !== 2 || value.taskId !== pin.task
      || value.attemptId !== pin.attempt || !['finished', 'abandoned'].includes(String(value.state))
      || !canonicalEngineTime(value.closedAt)
      || (value.state === 'finished' ? value.reason !== null : typeof value.reason !== 'string'
        || value.reason.length === 0 || [...value.reason].length > 20000
        || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value.reason))) {
      return 'unknown';
    }

    return 'terminal';
  } catch {
    return 'unknown';
  }
}

/**
 * Индекс служит только подсказкой: неизвестная запись удерживает поколения, а не даёт delete.
 * Валидный индекс обязан ссылаться на уже durable registry; его отсутствие проверяется authority.
 */
async function validateRuntimeIndexes(cacheDir: string, registry: RuntimeRootRegistry): Promise<void> {
  const directory = path.join(cacheDir, 'attempt-pins');

  try {
    await privateRuntimeDirectory(directory, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  for (const scope of await fs.readdir(directory)) {
    if (scope !== 'reservations' && !PACKAGE_ID.test(scope)) {
      throw runtimeError('factory_runtime_index_invalid');
    }

    const entries = path.join(directory, scope);

    await privateRuntimeDirectory(entries, false);

    for (const name of await fs.readdir(entries)) {
      const value = await readRuntimeJson(path.join(entries, name));

      if (scope === 'reservations') {
        const reservation = value as FactoryRuntimeReservation;

        if (!exactKeys(value, RESERVATION_KEYS) || reservation.format !== 1
          || !RUNTIME_TOKEN.test(reservation.token) || `${reservation.token}.json` !== name
          || !TASK.test(reservation.task) || reservation.scope !== factoryRuntimeScope(reservation)
          || !registry.roots.some((root) => factoryRuntimeScope(root) === reservation.scope
            && root.references.some((ref) => ref.token === reservation.token
              && ref.packageId === reservation.packageId))) {
          throw runtimeError('factory_runtime_index_invalid');
        }
      } else {
        const pin = decodeFactoryRuntimePin(value);

        if (pin.scope !== scope || `${pin.attempt}.json` !== name
          || !registry.roots.some((root) => factoryRuntimeScope(root) === scope
            && root.references.some((ref) => ref.packageId === pin.packageId
              && (pin.reservationToken === null ? ref.token === null && ref.task === pin.task
                && ref.attempt === pin.attempt : ref.token === pin.reservationToken)))) {
          throw runtimeError('factory_runtime_index_invalid');
        }
      }
    }
  }
}

/**
 * GC перечитывает зарегистрированные authority roots даже при потере derived index.
 * Reservation без PID/возраста остаётся защитой; отсутствие обеих форм означает unknown.
 */
export async function inspectFactoryRuntimePins(input: { cacheDir: string; packageId: string })
  : Promise<{ state: 'protected' | 'unprotected' | 'unknown'; reasons: string[] }> {
  const reasons: string[] = [];

  try {
    const registry = await readRuntimeRootRegistry(input.cacheDir);

    await validateRuntimeIndexes(input.cacheDir, registry);

    for (const root of registry.roots) {
      const refs = root.references.filter((ref) => ref.packageId === input.packageId);

      if (refs.length === 0) {
        continue;
      }

      await privateRuntimeDirectory(root.controlRoot, false);

      for (const ref of refs) {
        if (ref.token === null) {
          const file = path.join(root.controlRoot, 'server-runtimes', ref.scope, `${ref.attempt}.json`);
          const pin = decodeFactoryRuntimePin(await readRuntimeJson(file));

          if (pin.scope !== ref.scope || pin.task !== ref.task || pin.attempt !== ref.attempt
            || pin.packageId !== ref.packageId || pin.reservationToken !== null) {
            throw runtimeError('factory_runtime_pin_invalid');
          }

          const state = await terminalState(root, pin);

          if (state === 'unknown') {
            throw runtimeError('factory_runtime_terminal_unknown');
          }

          if (state === 'active') {
            reasons.push('attempt-pin');
          }

          continue;
        }

        const reservationFile = path.join(root.controlRoot,
          'server-runtimes/reservations', `${ref.token}.json`);
        const reserved = await readReservation(reservationFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }

          return null;
        });

        if (reserved) {
          if (reserved.scope !== ref.scope || reserved.packageId !== input.packageId) {
            throw runtimeError('factory_runtime_reservation_invalid');
          }

          reasons.push('reservation');
          continue;
        }

        const directory = path.join(root.controlRoot, 'server-runtimes', ref.scope);

        await privateRuntimeDirectory(directory, false);

        let matched = false;

        for (const name of await fs.readdir(directory)) {
          if (!/^a_[a-f0-9]{32}\.json$/u.test(name)) {
            throw runtimeError('factory_runtime_pin_invalid');
          }

          const pin = decodeFactoryRuntimePin(await readRuntimeJson(path.join(directory, name)));

          if (pin.reservationToken !== ref.token) {
            continue;
          }

          if (pin.scope !== ref.scope || pin.packageId !== input.packageId
            || `${pin.attempt}.json` !== name) {
            throw runtimeError('factory_runtime_pin_invalid');
          }

          matched = true;

          const state = await terminalState(root, pin);

          if (state === 'unknown') {
            throw runtimeError('factory_runtime_terminal_unknown');
          }

          if (state === 'active') {
            reasons.push('attempt-pin');
          }
        }

        if (!matched) {
          throw runtimeError('factory_runtime_reservation_unresolved');
        }
      }
    }

    return { state: reasons.length > 0 ? 'protected' : 'unprotected', reasons };
  } catch {
    return { state: 'unknown', reasons: ['authority-unknown'] };
  }
}

/**
 * Existing attempt получает runtime только из authority, до любого вызова gate/resume.
 * Legacy без sidecar мигрирует под host CAS после проверки trusted protocol/identity.
 */
export async function resolveFactoryRuntimePin(input: FactoryRuntimeRoots & {
  cacheDir: string;
  task: string;
  attempt: string;
  profile: string;
  current: FactoryRuntimeSelection;
}): Promise<FactoryRuntimePin> {
  await validateFactoryRuntimeRoots(input);

  const scope = factoryRuntimeScope(input);
  const file = path.join(input.controlRoot, 'server-runtimes', scope, `${input.attempt}.json`);
  const identity = await readFactoryRuntimeAttempt(input, input.task, input.attempt);

  if (identity.profile !== input.profile) {
    throw runtimeError('factory_runtime_attempt_invalid');
  }

  let value: unknown;

  try {
    value = await readRuntimeJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw runtimeError('factory_runtime_pin_invalid');
    }
  }

  if (value !== undefined) {
    const pin = decodeFactoryRuntimePin(value);

    if (pin.scope !== scope || pin.task !== input.task || pin.attempt !== input.attempt) {
      throw runtimeError('factory_runtime_pin_invalid');
    }

    try {
      await validateFactoryRuntime(pin, input.cacheDir);
    } catch {
      throw runtimeError('factory_runtime_pin_missing');
    }

    return pin;
  }

  const index = path.join(input.cacheDir, 'attempt-pins', scope, `${input.attempt}.json`);

  if (await fs.lstat(index).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  })) {
    throw runtimeError('factory_runtime_pin_missing');
  }

  return withRuntimeGcLock(input.cacheDir, () => withPackageLock(input.cacheDir,
    input.current.packageId ?? scope, async () => {
      const raced = await readRuntimeJson(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }

        return undefined;
      });

      if (raced !== undefined) {
        const pin = decodeFactoryRuntimePin(raced);

        if (pin.scope !== scope || pin.task !== input.task || pin.attempt !== input.attempt) {
          throw runtimeError('factory_runtime_pin_conflict');
        }

        await validateFactoryRuntime(pin, input.cacheDir);

        return pin;
      }

      const registry = await registryForRegistration(input.cacheDir);
      const root = registry.roots.find((entry) => factoryRuntimeScope(entry) === scope);

      for (const reference of root?.references ?? []) {
        if (reference.token === null && reference.attempt === input.attempt) {
          throw runtimeError('factory_runtime_pin_missing');
        }

        if (reference.packageId && (await inspectFactoryRuntimePins({
          cacheDir: input.cacheDir,
          packageId: reference.packageId,
        })).state === 'unknown') {
          throw runtimeError('factory_runtime_pin_missing');
        }
      }

      await validateFactoryRuntime(input.current, input.cacheDir);

      const currentIdentity = await readFactoryRuntimeAttempt(input, input.task, input.attempt);

      if (currentIdentity.bytes !== identity.bytes) {
        throw runtimeError('factory_runtime_attempt_invalid');
      }

      const pin: FactoryRuntimePin = {
        format: 1,
        scope,
        task: input.task,
        attempt: input.attempt,
        reservationToken: null,
        packageId: input.current.packageId,
        runtimeRoot: input.current.runtimeRoot,
        engineHome: input.current.engineHome,
        engineBin: input.current.engineBin,
        node: input.current.node,
        protocol: 'route-v2',
      };
      const registered = root ?? {
        controlRoot: input.controlRoot,
        stateRoot: input.stateRoot,
        profileRoot: input.profileRoot,
        references: [],
      };

      if (!root) {
        registry.roots.push(registered);
      }

      if (!registered.references.some((ref) => ref.token === null && ref.task === pin.task
        && ref.attempt === pin.attempt && ref.packageId === pin.packageId)) {
        registered.references.push({
          scope,
          token: null,
          task: pin.task,
          attempt: pin.attempt,
          packageId: pin.packageId,
        });
      }

      await writeRuntimeJson(path.join(input.cacheDir, 'state/control-roots.json'), registry);
      await privateRuntimeDirectory(path.join(input.controlRoot, 'server-runtimes'));
      await publishAuthority(file, pin);
      await writeRuntimeJson(index, pin);

      return pin;
    }));
}

/**
 * Первый host usage объявляет пустой registry до появления любых authority pin-ов.
 * Утрата уже инициализированного registry остаётся ошибкой и не забывает прежние roots.
 */
export async function initializeFactoryRuntimeRegistry(cacheDir: string): Promise<void> {
  await withRuntimeGcLock(cacheDir, async () => {
    const registry = await registryForRegistration(cacheDir);

    await writeRuntimeJson(path.join(cacheDir, 'state/control-roots.json'), registry);
  });
}
