import { contractDecoders } from '../lib/contractDecoders.ts';

const decoders = contractDecoders(invalidMetadata);
const {
  boolean,
  listOf,
  nullable,
  objectOf,
  oneOf,
  text,
  wholeNumber,
} = decoders;

const capabilities = {
  web: boolean,
  acp: boolean,
  settingsWeb: boolean,
  settingsAcp: boolean,
};
const decodeInfo = objectOf({
  format: oneOf(1),
  binaryVersion: nonemptyText,
  upstreamVersion: nonemptyText,
  packageId: sha256Text,
  buildId: sha256Text,
  runtimeVersion: nonemptyText,
  hostContract: oneOf(1),
  journal: objectOf({
    write: wholeNumber,
    read: listOf(wholeNumber),
  }),
  platform: nonemptyText,
  arch: nonemptyText,
  workerNode: objectOf({
    version: nonemptyText,
    abi: nonemptyText,
    sha256: sha256Text,
  }),
  capabilities: objectOf(capabilities),
  glm: objectOf({
    inputs: objectOf({
      source: objectOf({ commit: text }),
      inputIdentity: objectOf({
        composition: nonemptyText,
        dependencyLock: sha256Text,
      }),
      llmPiAi: nullable(objectOf({
        piAi: objectOf({
            version: nonemptyText,
            integrity: nonemptyText,
        }),
        sourceHash: sha256Text,
        patches: listOf(objectOf({
          path: nonemptyText,
          sha256: sha256Text,
        })),
      })),
    }),
    profileRevision: nonemptyText,
    policyRevision: nonemptyText,
    admission: listOf(objectOf({
      mode: oneOf('api', 'coding-plan'),
      compatibility: sha256Text,
    })),
  }),
});
const decodeHost = objectOf({
  format: oneOf(1),
  runtimeInfoFormat: positiveInteger,
  hostContract: positiveInteger,
  requiredCapabilities: listOf(oneOf('web', 'acp', 'settingsWeb', 'settingsAcp')),
  glm: objectOf({
    mode: oneOf('api', 'coding-plan'),
    profileRevision: nonemptyText,
    policyRevision: nonemptyText,
  }),
});

type BaseRuntimeInfo = ReturnType<typeof decodeInfo>;

export type DeepSeekRuntimeInfo = Omit<BaseRuntimeInfo, 'capabilities'> & {
  capabilities: BaseRuntimeInfo['capabilities'] & { toolPermissions?: boolean; glmNativeGate?: boolean };
};
export type DeepSeekHostContract = ReturnType<typeof decodeHost>;

/**
 * Ошибка называет только публичное поле контракта.
 * Недоверенное значение и пути файловой системы в сообщение не включаются.
 */
function invalidMetadata(path: string): never {
  throw Object.assign(new Error(`Некорректное описание DeepSeek: ${path}`), {
    code: 'deepseek_metadata_invalid',
  });
}

/**
 * Идентификаторы и версии должны содержать текст, а не пустой placeholder.
 * Точная upstream-версия при этом не является ограничением совместимости.
 */
function nonemptyText(value: unknown, path: string): string {
  const result = text(value, path);

  if (result.trim() === '') {
    invalidMetadata(path);
  }

  return result;
}

/**
 * Публичные SHA256 записываются полным lowercase hex.
 * Проверка фактических байтов payload выполняется отдельно от чтения metadata.
 */
function sha256Text(value: unknown, path: string): string {
  const result = text(value, path);

  if (!/^[a-f0-9]{64}$/u.test(result)) {
    invalidMetadata(path);
  }

  return result;
}

/**
 * Major публичного host contract начинается с единицы, в отличие от codec журнала v0.
 * Общий декодер также отвергает дробные и небезопасные целые числа.
 */
function positiveInteger(value: unknown, path: string): number {
  const result = wholeNumber(value, path);

  if (result === 0) {
    invalidMetadata(path);
  }

  return result;
}

/**
 * Проверяет известные поля совместимого format общими декодерами.
 * Дополнительные поля не ограничивают совместимые upstream-версии и ABI worker.
 */
export function decodeDeepSeekRuntimeInfo(value: unknown): DeepSeekRuntimeInfo {
  const result: DeepSeekRuntimeInfo = decodeInfo(value, 'runtime-info');
  const source = decoders.record(value, 'runtime-info');
  const sourceCapabilities = decoders.record(source.capabilities, 'runtime-info.capabilities');

  if (Object.hasOwn(sourceCapabilities, 'toolPermissions')) {
    result.capabilities.toolPermissions = boolean(
      sourceCapabilities.toolPermissions, 'runtime-info.capabilities.toolPermissions',
    );
  }

  if (Object.hasOwn(sourceCapabilities, 'glmNativeGate')) {
    result.capabilities.glmNativeGate = boolean(
      sourceCapabilities.glmNativeGate, 'runtime-info.capabilities.glmNativeGate',
    );
  }

  if (!result.journal.read.includes(result.journal.write)) {
    invalidMetadata('runtime-info.journal');
  }

  return result;
}

/**
 * Сопоставляет поставку требованиям установленного потребителя.
 * Candidate не может подменить требования своей собственной декларацией.
 */
export function assertDeepSeekHostCompatibility(infoValue: unknown, hostValue: unknown): void {
  const info = decodeDeepSeekRuntimeInfo(infoValue);
  const host = decodeDeepSeekHostContract(hostValue);
  const compatible = info.format === host.runtimeInfoFormat
    && info.hostContract === host.hostContract
    && host.requiredCapabilities.every((name) => info.capabilities[name])
    && info.glm.profileRevision === host.glm.profileRevision
    && info.glm.policyRevision === host.glm.policyRevision;

  if (!compatible) {
    throw Object.assign(new Error('Поставка DeepSeek несовместима с установленным GrigDesk'), {
      code: 'deepseek_host_incompatible',
    });
  }
}

/**
 * Требования host читаются из отдельного переданного документа.
 * Чтение не открывает файлы и не заимствует ограничения у candidate.
 */
export function decodeDeepSeekHostContract(value: unknown): DeepSeekHostContract {
  return decodeHost(value, 'host-contract');
}
