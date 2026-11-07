import { GLM_FACTORY_POLICY_REVISION, GLM_FACTORY_PROFILE_REVISION } from './contract.ts';

export interface GlmFactoryModel {
  id: string;
  efforts: readonly string[];
}

// Каталог этапа фабрики — проверенные на настоящей generation модели маршрута zai и их уровни
// (docs/grigdesk/chat/glm-runtime-facts.md). Metadata helper отдаёт его без ключа и процесса DSH.
export const GLM_FACTORY_MODELS: readonly GlmFactoryModel[] = Object.freeze([
  { id: '["zai","glm-5.3"]', efforts: ['low', 'high', 'max'] },
  { id: '["zai","glm-5.3-flash"]', efforts: ['low', 'high', 'max'] },
  { id: '["zai","glm-5.3-highspeed"]', efforts: ['low', 'high', 'max'] },
  { id: '["zai","glm-5.2"]', efforts: ['off', 'high', 'max'] },
  { id: '["zai","glm-5.2-highspeed"]', efforts: ['off', 'high', 'max'] },
  { id: '["zai","glm-4.7"]', efforts: ['high'] },
  { id: '["zai","glm-5-turbo"]', efforts: ['high'] },
].map((entry) => Object.freeze({ ...entry, efforts: Object.freeze([...entry.efforts]) })));

/**
 * Версия раннера этапа различает поставку DSH по packageId и ревизии профиля и политики
 * Factory GLM. Дефис перед grigdesk сохраняет suffix в semver-parser движка.
 */
export function glmFactoryRunnerVersion(runtimeVersion: string, packageId: string): string {
  return `${runtimeVersion.replace('.grigdesk.', '-grigdesk.')}.p${packageId}`
    + `.${GLM_FACTORY_PROFILE_REVISION}.${GLM_FACTORY_POLICY_REVISION}`;
}

/**
 * Модель и уровень принимаются только из каталога этапа; пустой уровень — штатный high.
 * Пара другого маршрута или неизвестная модель не получает запасного выбора.
 */
export function glmFactoryModel(model: string, effort: string): GlmFactoryModel | null {
  const entry = GLM_FACTORY_MODELS.find((item) => item.id === model);

  return entry && (effort === '' || entry.efforts.includes(effort)) ? entry : null;
}
